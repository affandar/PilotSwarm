import nodeCrypto from "node:crypto";
import { isSessionLockAcquireTimeoutError, type SessionManager } from "./session-manager.js";
import { extractCanvasAppManifest, canvasAppCard, normalizeCanvasResponseContract } from "./canvas-app-manifest.js";
import { readCanvasKv, writeCanvasKv } from "./canvas-kv.js";
import { publishCanvasApp, findCanvasApp } from "./canvas-app-catalog.js";
import { canvasArtifactFilename, normalizeCanvasSlot, eventSlot, latestCanvasEventData, latestCanvasRev } from "./canvas-support.js";
import type { SessionStateStore } from "./session-store.js";
import { resolveEffectiveSpawnOwner, type SessionCatalog } from "./cms.js";
import { admissionToWait, PROVIDER_BUDGET_WAKE_PROMPT } from "./provider-budgets.js";
import { splitSystemContextBlock } from "./prompt-system-context.js";
import { buildCheckAgentsReport, CHECK_AGENTS_MEMO_EVENT, type CheckAgentsMemo } from "./check-agents-report.js";
// One predicate, every surface: the portal, the viewer spine and the control
// bridge all decide "is this principal an admin?" the same way.
import { evaluateRoleObservation } from "../api/src/session-authz.js";
import { parseAgentFqn } from "./agent-fqn.js";
import { decideSessionControl } from "./agent-manager-tools.js";
import type { StorageConfig } from "./storage-config.js";
import { SESSION_STATE_MISSING_PREFIX, sanitizePromptAttachmentRefs, IMAGE_ATTACHMENT_CONTENT_TYPES, ATTACHMENT_MAX_BYTES, ATTACHMENTS_MAX_TOTAL_BYTES, type AbortTurnResult, type PromptAttachmentRef, type ManagedSessionConfig, type SerializableSessionConfig, type TurnResult, type OrchestrationInput } from "./types.js";
import type { ArtifactStore } from "./session-store.js";
import type { AgentConfig } from "./agent-loader.js";
import { systemChildAgentUUID } from "./agent-loader.js";
import { PilotSwarmClient } from "./client.js";
import { PilotSwarmManagementClient, type SessionOrchestrationStats } from "./management-client.js";
import { replyInternalSessionMessage, sendInternalSessionMessage } from "./session-messages.js";
import { loadKnowledgeIndexFromFactStore } from "./knowledge-index.js";
import { mergePromptSections } from "./prompt-layering.js";
import { approvePermissionForSession } from "./permissions.js";
import { formatSessionOwnerLabel, getSessionOwnerKind, matchesSessionOwnerFilters } from "./session-owner-utils.js";
import { cmsRetryBestEffort, cmsRetryCritical } from "./cms-retry.js";
import {
    archiveName,
    artifactExists,
    assembleRegenClosure,
    buildMapReduceSeedPrompt,
    deterministicPackage,
    DISTILLER_SYSTEM_MESSAGE,
    distillInputName,
    distillOutputName,
    packageName,
    parseDistillerResponse,
    renderBootstrap,
    runRegenArchive,
    runRegenDistill,
} from "./regen-worker.js";
import { REGEN_DISTILLER_SERVICE_KIND } from "./distiller-tools.js";
import { computeCronAtNextFire, type CronAtSchedule } from "./cron-at.js";
import { SpanStatusCode, trace as otelTrace } from "@opentelemetry/api";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { attemptStoreRecovery, runTurnCommit, runTurnPreamble, type TurnLifecycleContext } from "./session-lifecycle.js";
import { supportsVersionedSnapshots, writeTurnSentinel } from "./snapshot-protocol.js";

const SYSTEM_AGENT_IDS = new Set(["pilotswarm", "sweeper", "resourcemgr", "facts-manager"]);

/** The trimmed agent definition both resolution paths hand to their callers. */
export interface ResolvedAgentDefinition {
    name: string;
    prompt: string;
    tools?: string[];
    initialPrompt?: string;
    initialRequiredTool?: string;
    title?: string;
    system?: boolean;
    id?: string;
    parent?: string;
    splash?: string;
    splashMobile?: string;
    namespace?: string;
    promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent";
    creatable?: boolean;
    /** Present when the definition came from an agent package. */
    packageId?: string;
    packageScope?: "shared" | "user";
}

/**
 * THE agent-name resolver: FQN parsing, fuzzy matching, package privacy, and
 * owner shadowing in one place.
 *
 * This used to exist twice — the resolveAgentConfig activity had the full
 * rule set while the control bridge's inline copy had none of it, so
 * `spawn_agent`/`create_agent_session` could bind another user's private
 * agent, could not address `__shared:<name>`, and ignored the caller's own
 * shadowing copy. A security rule with two implementations has one that is
 * wrong; this is now the only one.
 *
 * `getCallerOwnerKey` is awaited lazily — only when a user-scope package
 * agent is actually in play — and must resolve to the caller's owner key
 * (`provider\u0001subject`) or null. Fail closed: null means no private
 * agents match.
 */
export async function resolveAgentDefinitionForCaller(opts: {
    agentName: string;
    userAgents?: any[];
    systemAgents?: any[];
    getCallerOwnerKey: () => Promise<string | null>;
}): Promise<ResolvedAgentDefinition | null> {
    const agents: Array<any> = [
        ...(opts.userAgents ?? []).map(a => ({ ...a, system: false, creatable: true })),
        ...(opts.systemAgents ?? []).map(a => ({ ...a, creatable: false })),
    ];
    const normalize = (value?: string) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

    // Parse the reference. `a:b` has meant `namespace:agent` since long
    // before FQNs existed, so the parser reports that shape as AMBIGUOUS
    // and we keep the namespace reading first — an existing binding must
    // not change meaning because per-user namespaces shipped.
    const fqn = parseAgentFqn(opts.agentName);
    let lookupNamespace: string | undefined;
    let rawName = opts.agentName;
    /** `__shared:` explicitly asks past the caller's own copy. */
    let sharedOnly = false;
    if (fqn.kind === "shared") {
        rawName = fqn.name;
        sharedOnly = true;
    } else if (fqn.kind === "bare") {
        rawName = fqn.name;
    } else if (fqn.kind === "ambiguous" || fqn.kind === "owner") {
        rawName = fqn.name;
        lookupNamespace = fqn.namespaceRef ?? fqn.ownerRef;
    } else {
        // Invalid (reserved prefix, bad semver, malformed). Fall back to
        // the raw string so a legitimately odd agent name still resolves
        // the way it always did; a reserved name simply will not match.
        rawName = opts.agentName;
    }

    const lookup = normalize(rawName);
    // Also try without trailing "agent" suffix for fuzzy matching
    // (LLM often says "Sweeper agent" which normalizes to "sweeperagent", but id is "sweeper")
    const lookupBase = lookup.replace(/agent$/, "");

    let callerKeyResolved = false;
    let callerKey: string | null = null;
    const callerOwnerKeyOnce = async (): Promise<string | null> => {
        if (!callerKeyResolved) {
            callerKeyResolved = true;
            try {
                callerKey = await opts.getCallerOwnerKey();
            } catch {
                // Fail closed: an unresolvable caller gets no private agents.
                callerKey = null;
            }
        }
        return callerKey;
    };
    const ownerKeyOf = (owner?: { provider?: string; subject?: string } | null) =>
        owner?.provider && owner?.subject ? `${owner.provider}\u0001${owner.subject}` : null;
    const visibleToCaller = async (agent: any): Promise<boolean> => {
        const agentOwnerKey = ownerKeyOf(agent?.packageOwner);
        if (agent?.packageScope !== "user" || !agentOwnerKey) return true;
        const key = await callerOwnerKeyOnce();
        return key !== null && key === agentOwnerKey;
    };

    const candidatesFor = (a: any) => [a.name, a.id, a.title].map(normalize).filter(Boolean);
    const nameMatches = (a: any) => {
        const candidates = candidatesFor(a);
        return candidates.includes(lookup) || (lookupBase && candidates.includes(lookupBase));
    };

    let matches = agents.filter(a => {
        if (lookupNamespace && normalize(a.namespace) !== normalize(lookupNamespace)) return false;
        return nameMatches(a);
    });

    // An ambiguous `a:b` that matched nothing as `namespace:agent` gets its
    // second reading — `owner:package` — rather than just failing. Order,
    // not guesswork: the old meaning always wins when it resolves.
    if (matches.length === 0 && fqn.kind === "ambiguous") {
        matches = agents.filter(nameMatches);
    }

    if (sharedOnly) {
        // `__shared:x` means the deployment's copy, explicitly. This is the
        // one thing bare-name precedence otherwise takes away: without it,
        // a user with their own copy could never reach the shared one.
        matches = matches.filter(a => a.packageScope !== "user");
    } else {
        // SHADOWING, at the agent level: the caller's own copy comes first,
        // then everything public. Same rule the registry resolver applies,
        // so "run X" and "show me X" cannot disagree about which X.
        const key = matches.some(a => a.packageScope === "user") ? await callerOwnerKeyOnce() : null;
        matches = [
            ...matches.filter(a => a.packageScope === "user" && ownerKeyOf(a.packageOwner) === key && key !== null),
            ...matches.filter(a => !(a.packageScope === "user" && ownerKeyOf(a.packageOwner) === key && key !== null)),
        ];
    }

    let agent: any = undefined;
    for (const candidate of matches) {
        if (await visibleToCaller(candidate)) { agent = candidate; break; }
    }
    if (!agent) return null;
    return {
        name: agent.name,
        prompt: agent.prompt,
        tools: agent.tools ?? undefined,
        initialPrompt: agent.initialPrompt ?? undefined,
        initialRequiredTool: agent.initialRequiredTool ?? undefined,
        title: agent.title ?? undefined,
        system: agent.system ?? undefined,
        id: agent.id ?? undefined,
        parent: agent.parent ?? undefined,
        splash: agent.splash ?? undefined,
        splashMobile: agent.splashMobile ?? undefined,
        namespace: agent.namespace ?? undefined,
        promptLayerKind: agent.promptLayerKind ?? undefined,
        creatable: agent.creatable ?? !agent.system,
        packageId: agent.packageId ?? undefined,
        packageScope: agent.packageScope ?? undefined,
    };
}

// The canvas helpers (filenames, slot normalization, revision derivation)
// live in canvas-support.ts, shared with the app catalog. Re-exported so
// existing importers keep their path.
export { CANVAS_ARTIFACT_FILENAME, canvasArtifactFilename } from "./canvas-support.js";

const SESSION_RECOVERY_NOTICE =
    "[SYSTEM: The runtime recovered this session after the live Copilot session was lost on a worker. " +
    "Some very recent in-memory state may have been lost. Re-read the visible conversation and continue carefully from the latest durable state.]";
const LOSSY_SESSION_REPLAY_NOTICE =
    "[SYSTEM: The runtime is replaying this turn after a worker restart lost the live Copilot session state before it could be durably dehydrated. " +
    "Some recent in-memory work may be missing, and the previous turn may have partially executed. " +
    "Re-read the visible conversation and durable facts, avoid blindly repeating destructive actions, and if the correct next step is unclear, stop and ask the user how to proceed.]";
const CORRUPTED_TRANSCRIPT_REPLAY_NOTICE =
    "[SYSTEM: The runtime recreated this session after the live Copilot transcript became inconsistent. " +
    "Some recent in-memory work may be missing, and the previous turn may have partially executed. " +
    "Re-read the visible conversation and continue carefully from the latest durable state.]";
const REHYDRATED_SESSION_NOTICE =
    "[SYSTEM: This session was rehydrated on a different worker from its durable snapshot. " +
    "The conversation history is fully preserved. Continue seamlessly.]";

function normalizeJsonObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function buildContractJson(contract: unknown, parentSessionId: string, childSessionId: string): Record<string, unknown> | null {
    const normalized = normalizeJsonObject(contract);
    if (!normalized) return null;
    const current = {
        ...normalized,
        contractId: typeof normalized.contractId === "string" && normalized.contractId ? normalized.contractId : randomUUID(),
        parentSessionId,
        childSessionId,
    };
    return {
        current,
        revisions: [{
            revision: 1,
            updatedAt: new Date().toISOString(),
            updatedBySessionId: parentSessionId,
            reason: "spawn_agent contract",
            contract: current,
        }],
    };
}

function appendContractPatchJson(existing: Record<string, unknown> | null, patch: unknown, parentSessionId: string, childSessionId: string): Record<string, unknown> | null {
    const normalizedPatch = normalizeJsonObject(patch);
    if (!normalizedPatch) return null;
    const currentExisting = normalizeJsonObject(existing?.current) ?? {};
    const revisions = Array.isArray(existing?.revisions) ? [...existing.revisions] : [];
    const nextRevision = revisions.length + 1;
    const current = {
        ...currentExisting,
        ...normalizedPatch,
        contractId: typeof currentExisting.contractId === "string" && currentExisting.contractId ? currentExisting.contractId : randomUUID(),
        parentSessionId,
        childSessionId,
    };
    revisions.push({
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
        updatedBySessionId: parentSessionId,
        reason: "message_agent contract patch",
        contract: current,
    });
    return { current, revisions };
}

function collectReferenceValues(result: Record<string, unknown>, fields: string[], objectField: "key" | "path"): Set<string> {
    const values = new Set<string>();
    for (const field of fields) {
        const items = Array.isArray(result[field]) ? result[field] as unknown[] : [];
        for (const item of items) {
            if (typeof item === "string" && item.trim()) {
                values.add(item.trim());
            } else if (item && typeof item === "object") {
                const value = (item as Record<string, unknown>)[objectField];
                if (typeof value === "string" && value.trim()) values.add(value.trim());
            }
        }
    }
    return values;
}

/** @internal Exported for contract normalization tests. */
export function collectContractViolations(contractJson: Record<string, unknown> | null, result: Record<string, unknown> | null, missingResultCode?: string): Array<Record<string, unknown>> {
    const contract = normalizeJsonObject(contractJson?.current);
    if (!contract) return [];
    if (!result) {
        return missingResultCode ? [{ code: missingResultCode, message: "Contracted child closed without a structured result." }] : [];
    }

    const factKeys = collectReferenceValues(result, ["factsWritten", "factKeys", "facts", "evidenceFactKeys"], "key");
    const artifactPaths = collectReferenceValues(result, ["artifactsWritten", "artifactPaths", "artifacts", "artifactPointers"], "path");
    const genericFactOutputs = collectReferenceValues(result, ["outputs", "outputReferences"], "key");
    const genericArtifactOutputs = collectReferenceValues(result, ["outputs", "outputReferences"], "path");
    const violations: Array<Record<string, unknown>> = [];

    for (const expected of Array.isArray(contract.expectedFacts) ? contract.expectedFacts : []) {
        const key = (expected as any)?.key;
        if ((expected as any)?.required === false || typeof key !== "string") continue;
        if (!factKeys.has(key) && !genericFactOutputs.has(key) && !genericArtifactOutputs.has(key)) {
            violations.push({ code: "missing_fact_reference", message: `Required fact was not referenced in the result: ${key}`, expected });
        }
    }

    for (const expected of Array.isArray(contract.expectedArtifacts) ? contract.expectedArtifacts : []) {
        const path = (expected as any)?.path;
        if ((expected as any)?.required === false || typeof path !== "string") continue;
        if (!artifactPaths.has(path) && !genericArtifactOutputs.has(path) && !genericFactOutputs.has(path)) {
            violations.push({ code: "missing_artifact_reference", message: `Required artifact was not referenced in the result: ${path}`, expected });
        }
    }

    return violations;
}

function buildResultJson(resultInput: unknown, child: { sessionId: string; parentSessionId?: string }, contractJson: Record<string, unknown> | null, existingResultJson: Record<string, unknown> | null, fallbackVerdict: string, missingResultCode?: string): { resultJson: Record<string, unknown>; verdict: string; summary: string; violations: Array<Record<string, unknown>>; strictBlocked: boolean } {
    const normalized = normalizeJsonObject(resultInput);
    const completedAt = new Date().toISOString();
    const baseResult: Record<string, any> = normalized
        ? { ...normalized }
        : {
            verdict: fallbackVerdict,
            summary: fallbackVerdict === "cancelled" ? "Sub-agent was cancelled without a structured partial result." : "Sub-agent was closed without a structured result.",
        };
    const result: Record<string, any> = {
        ...baseResult,
        sessionId: child.sessionId,
        parentSessionId: child.parentSessionId,
        verdict: typeof baseResult.verdict === "string" ? baseResult.verdict : fallbackVerdict,
        summary: typeof baseResult.summary === "string" ? baseResult.summary : "Structured result recorded.",
        completedAt: typeof baseResult.completedAt === "string" ? baseResult.completedAt : completedAt,
    };
    const violations = collectContractViolations(contractJson, normalized ? result : null, normalized ? undefined : missingResultCode);
    if (violations.length > 0) {
        result.contractViolations = [...(Array.isArray(result.contractViolations) ? result.contractViolations : []), ...violations];
    }
    const contract = normalizeJsonObject(contractJson?.current);
    const strictBlocked = contract?.validationMode === "strict" && violations.length > 0;
    const existingRevisions = Array.isArray(existingResultJson?.revisions)
        ? existingResultJson.revisions
        : [];
    const nextRevision = existingRevisions.length + 1;
    return {
        resultJson: {
            current: result,
            revisions: [
                ...existingRevisions,
                { revision: nextRevision, submittedAt: completedAt, submittedBySessionId: child.parentSessionId, result },
            ],
        },
        verdict: String(result.verdict),
        summary: String(result.summary),
        violations,
        strictBlocked,
    };
}

function normalizePromptText(text?: string): string {
    return String(text || "").replace(/\r\n/g, "\n").trim();
}

function decorateRehydrationSystemPrompt(text?: string, workerNodeId?: string): string | undefined {
    if (!text || !workerNodeId) return text;

    const rehydrationPrefix = "The session was dehydrated and has been rehydrated on a new worker";
    if (!text.startsWith(`${rehydrationPrefix}.`)) return text;
    if (text.startsWith(`${rehydrationPrefix} (${workerNodeId}).`)) return text;

    return text.replace(
        `${rehydrationPrefix}.`,
        `${rehydrationPrefix} (${workerNodeId}).`,
    );
}

function isInternalSystemPrompt(text?: string): boolean {
    const normalized = normalizePromptText(text);
    if (!normalized) return false;

    return /^\[SYSTEM:/i.test(normalized)
        || /^\[CHILD_UPDATE\b/i.test(normalized)
        || /^\[SESSION_MESSAGE(?:_RESPONSE)?\b/i.test(normalized)
        || /^Sub-agent spawned successfully\./i.test(normalized)
        || /^Message sent to sub-agent /i.test(normalized)
        || /^No sub-agents have been spawned yet\./i.test(normalized)
        || /^Sub-agent status report \(/i.test(normalized)
        || /^Active sessions \(/i.test(normalized)
        || /^Sub-agents completed:/i.test(normalized)
        || /^Sub-agent .* has been (completed gracefully|cancelled|deleted)\./i.test(normalized)
        || /^Graceful (completion|cancellation|deletion) requested for sub-agent /i.test(normalized)
        || /^(spawn_agent|message_agent|check_agents|wait_for_agents|complete_agent|cancel_agent|delete_agent) failed/i.test(normalized);
}

function isLiveSessionLostErrorMessage(message?: string): boolean {
    const normalized = String(message || "");
    return /\bSession not found\b/i.test(normalized);
}

function isToolCallTranscriptCorruptionErrorMessage(message?: string): boolean {
    const normalized = String(message || "");
    return normalized.includes("assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'")
        || /Invalid value for 'content': expected a string, got null/i.test(normalized);
}

function isMissingSessionStateErrorMessage(message?: string): boolean {
    return String(message || "").includes(SESSION_STATE_MISSING_PREFIX);
}

function stripMissingSessionStatePrefix(message?: string): string {
    const normalized = String(message || "");
    const index = normalized.indexOf(SESSION_STATE_MISSING_PREFIX);
    if (index < 0) return normalized.trim();
    return normalized.slice(index + SESSION_STATE_MISSING_PREFIX.length).trim();
}

function isMissingDehydrateSnapshotErrorMessage(message?: string): boolean {
    return /Session state directory not ready during dehydrate/i.test(String(message || ""));
}

function buildUnrecoverableSessionLossMessage(sessionId: string, detail: string): string {
    return `${SESSION_STATE_MISSING_PREFIX} unrecoverable live Copilot session loss for ${sessionId}. ` +
        `The runtime attempted to resume or rehydrate the session, but recovery failed. ` +
        `Some very recent in-memory state may have been lost. ${detail}`;
}

function buildLossyReplayMessage(sessionId: string, detail: string): string {
    return `The runtime detected missing Copilot session state for ${sessionId} while resuming a later turn. ` +
        `It will recreate a fresh Copilot session and replay the pending turn from durable orchestration context. ` +
        `Some very recent work may be missing or partially executed. ${detail}`.trim();
}

function normalizeEventData(eventData?: Record<string, unknown>): Record<string, unknown> | null {
    return eventData && typeof eventData === "object" ? eventData : null;
}

function summarizeSdkSystemPromptEchoEvent(
    event: { eventType: string; data: unknown },
): { eventType: string; data: unknown } | null {
    if (event.eventType !== "system.message") return event;
    const data = normalizeEventData(event.data as Record<string, unknown> | undefined);
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content.startsWith("You are the GitHub Copilot CLI, a terminal assistant built by GitHub.")) {
        return event;
    }

    const normalized = normalizePromptText(content).replace(/\s+/g, " ");
    const maxSnippetLength = 120;
    const snippet = normalized.length > maxSnippetLength
        ? `${normalized.slice(0, maxSnippetLength).trimEnd()}...`
        : normalized;

    return {
        ...event,
        data: {
            ...(data ?? {}),
            content:
                `[SYSTEM: Copilot SDK rebuilt the full system prompt for model input. ` +
                `Full content omitted from CMS (${content.length} chars). ` +
                `Snippet: ${snippet}]`,
        },
    };
}

function activityTrace(activityCtx: any, label: string): (message: string) => void {
    return (message: string) => {
        activityCtx.traceInfo(`[${label}] ${message}`);
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? "");
}

async function recordLossyHandoffEvent(
    catalog: SessionCatalog | null | undefined,
    sessionId: string,
    workerNodeId: string | undefined,
    data: Record<string, unknown>,
    traceFailure: (message: string) => void,
): Promise<void> {
    if (!catalog) return;
    await catalog.recordEvents(sessionId, [{
        eventType: "session.lossy_handoff",
        data,
    }], workerNodeId).catch((error: unknown) => {
        traceFailure(`CMS lossy handoff event failed: ${errorMessage(error)}`);
    });
    await catalog.upsertSessionMetricSummary(sessionId, {
        lossyHandoffCountIncrement: 1,
    }).catch((error: unknown) => {
        traceFailure(`CMS lossy handoff summary update failed: ${errorMessage(error)}`);
    });
}

function finiteMetricNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function buildUsageSummaryUpsert(data: unknown): {
    tokensInputIncrement?: number;
    tokensOutputIncrement?: number;
    tokensCacheReadIncrement?: number;
    tokensCacheWriteIncrement?: number;
} | null {
    // Convention: tokensInputIncrement is the *inclusive* prompt-token count:
    // it INCLUDES tokensCacheReadIncrement AND tokensCacheWriteIncrement.
    // That is how the Copilot SDK reports usage for every vendor it fronts —
    // verified on 2026-08-27 across GPT, Claude, Grok and MAI: in every
    // recorded turn cache_read + cache_write <= input, and equal to it when
    // a turn wrote to the cache. computeCacheHitRatio() in cms.ts (cache_read
    // / input) and cms_provider_settle_turn (total = input + output, since
    // 0070) both rest on it. If a future provider ever reports input_tokens
    // EXCLUDING the cached prefix (Anthropic's raw API does), normalize here
    // BEFORE storing — do not invert the convention downstream.
    const usage = (data ?? {}) as Record<string, unknown>;
    const tokensInputIncrement = finiteMetricNumber(usage.inputTokens ?? usage.prompt_tokens);
    const tokensOutputIncrement = finiteMetricNumber(usage.outputTokens ?? usage.completion_tokens);
    const tokensCacheReadIncrement = finiteMetricNumber(usage.cacheReadTokens ?? usage.cached_prompt_tokens);
    const tokensCacheWriteIncrement = finiteMetricNumber(usage.cacheWriteTokens);

    if (
        tokensInputIncrement == null
        && tokensOutputIncrement == null
        && tokensCacheReadIncrement == null
        && tokensCacheWriteIncrement == null
    ) {
        return null;
    }

    return {
        ...(tokensInputIncrement != null ? { tokensInputIncrement } : {}),
        ...(tokensOutputIncrement != null ? { tokensOutputIncrement } : {}),
        ...(tokensCacheReadIncrement != null ? { tokensCacheReadIncrement } : {}),
        ...(tokensCacheWriteIncrement != null ? { tokensCacheWriteIncrement } : {}),
    };
}

function isFailureToolCompletion(data: unknown): boolean {
    const eventData = normalizeEventData(data as Record<string, unknown> | undefined);
    if (!eventData) return false;
    return eventData.resultType === "failure"
        || typeof eventData.error === "string"
        || typeof eventData.errorMessage === "string";
}

async function tryReadSnapshotSizeBytes(sessionStore: SessionStateStore | null | undefined, sessionId: string): Promise<number | undefined> {
    if (!sessionStore) return undefined;

    try {
        const store = sessionStore as any;
        if (typeof store.getSnapshotSizeBytes === "function") {
            const sizeBytes = finiteMetricNumber(await store.getSnapshotSizeBytes(sessionId));
            if (sizeBytes != null) return sizeBytes;
        }

        if (typeof store.metaPath === "function") {
            const metadataPath = store.metaPath(sessionId);
            if (metadataPath && fs.existsSync(metadataPath)) {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
                const sizeBytes = finiteMetricNumber(metadata?.sizeBytes);
                if (sizeBytes != null) return sizeBytes;
            }
        }
    } catch {}

    try {
        const store = sessionStore as any;
        if (typeof store.tarPath === "function") {
            const tarPath = store.tarPath(sessionId);
            if (tarPath && fs.existsSync(tarPath)) {
                const sizeBytes = finiteMetricNumber(fs.statSync(tarPath).size);
                if (sizeBytes != null) return sizeBytes;
            }
        }
    } catch {}

    return undefined;
}

// ─── SessionProxy ────────────────────────────────────────────────
// The orchestration's view of a specific ManagedSession.
// Each method maps 1:1 to an activity dispatched to the session's worker node.

import type { ContextTier, ReasoningEffort } from "./model-providers.js";

const DISTILLER_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DISTILLER_TIERS = new Set(["default", "long_context"]);

/** Operator-supplied effort, validated. Unknown values fall back to the model default. */
function normalizeDistillerEffort(value?: string): ReasoningEffort | undefined {
    return value && DISTILLER_EFFORTS.has(value) ? (value as ReasoningEffort) : undefined;
}

/** Operator-supplied context tier, validated the same way. */
function normalizeDistillerTier(value?: string): ContextTier | undefined {
    return value && DISTILLER_TIERS.has(value) ? (value as ContextTier) : undefined;
}

export function createSessionProxy(
    ctx: any,
    sessionId: string,
    affinityKey: string,
    config: SerializableSessionConfig,
) {
    return {
        runTurn(
            prompt: string,
            bootstrap?: boolean,
            turnIndex?: number,
            turnMeta?: { parentSessionId?: string; nestingLevel?: number; requiredTool?: string; cycleOrigin?: "cron" | "cron_at"; retryCount?: number; clientMessageIds?: string[]; sender?: unknown; snapshot?: { expectedVersion?: number; turnKey: string }; attachments?: Array<{ filename: string; contentType: string; sizeBytes: number }>; transcriptEpoch?: number; epochStart?: boolean; stashedPrompts?: string[] },
        ) {
            return ctx.scheduleActivityOnSession(
                // The epoch-start turn is a distinct activity name (runTurn2):
                // pre-1.0.67 workers don't register it, so a rolling deploy can
                // never hand the fresh-epoch create to a worker that would
                // silently resume the dead transcript instead.
                turnMeta?.epochStart ? "runTurn2" : "runTurn",
                {
                    sessionId,
                    prompt,
                    config,
                    ...(bootstrap ? { bootstrap: true } : {}),
                    ...(turnIndex != null ? { turnIndex } : {}),
                    ...(turnMeta?.parentSessionId ? { parentSessionId: turnMeta.parentSessionId } : {}),
                    ...(turnMeta?.nestingLevel != null ? { nestingLevel: turnMeta.nestingLevel } : {}),
                    ...(turnMeta?.requiredTool ? { requiredTool: turnMeta.requiredTool } : {}),
                    ...(turnMeta?.cycleOrigin ? { cycleOrigin: turnMeta.cycleOrigin } : {}),
                    ...(turnMeta?.retryCount != null ? { retryCount: turnMeta.retryCount } : {}),
                    ...(turnMeta?.clientMessageIds && turnMeta.clientMessageIds.length > 0
                        ? { clientMessageIds: turnMeta.clientMessageIds }
                        : {}),
                    // Security-model sender identity: forward it into the runTurn
                    // activity input so the worker records it on the user.message
                    // event (session-proxy reads input.sender below).
                    ...(turnMeta?.sender ? { sender: turnMeta.sender } : {}),
                    ...(turnMeta?.snapshot ? { snapshot: turnMeta.snapshot } : {}),
                    // Image attachment REFS only — the worker fetches bytes from
                    // the artifact store inside the activity (never on the wire).
                    ...(turnMeta?.attachments && turnMeta.attachments.length > 0
                        ? { attachments: turnMeta.attachments }
                        : {}),
                    ...(turnMeta?.transcriptEpoch ? { transcriptEpoch: turnMeta.transcriptEpoch } : {}),
                    ...(turnMeta?.epochStart ? { epochStart: true } : {}),
                    // Prompts the budget gate refused on earlier attempts. The
                    // orchestration sends them, the worker-side fold replays
                    // them — and this spread is the wire between the two. It
                    // was missing on first ship: both ends were built and the
                    // field died HERE, so the replay never executed and
                    // delivery was whatever the rebuilt history happened to
                    // make the model say. The same three-place wiring class
                    // as the regen-tool gap.
                    ...(turnMeta?.stashedPrompts && turnMeta.stashedPrompts.length > 0
                        ? { stashedPrompts: turnMeta.stashedPrompts }
                        : {}),
                },
                affinityKey,
            );
        },
        dehydrate(reason: string, eventData?: Record<string, unknown>) {
            return ctx.scheduleActivityOnSession(
                "dehydrateSession",
                {
                    sessionId,
                    reason,
                    ...(eventData && Object.keys(eventData).length > 0 ? { eventData } : {}),
                },
                affinityKey,
            );
        },
        hydrate() {
            return ctx.scheduleActivityOnSession(
                "hydrateSession",
                { sessionId },
                affinityKey,
            );
        },
        needsHydration() {
            return ctx.scheduleActivityOnSession(
                "needsHydrationSession",
                { sessionId },
                affinityKey,
            );
        },
        destroy() {
            return ctx.scheduleActivityOnSession(
                "destroySession",
                { sessionId },
                affinityKey,
            );
        },
        checkpoint() {
            return ctx.scheduleActivityOnSession(
                "checkpointSession",
                { sessionId },
                affinityKey,
            );
        },
        /**
         * Stop-turn fast-path interrupt: lands on the worker owning the warm
         * session and aborts the in-flight turn CONCURRENTLY with the still
         * running `runTurn` activity (requires stable workerNodeId + a free
         * worker slot; otherwise the dropped-future backstop still stops it).
         */
        abortTurn(reason: string, expectedTurnIndex?: number) {
            return ctx.scheduleActivityOnSession(
                "abortTurn",
                {
                    sessionId,
                    reason,
                    ...(expectedTurnIndex != null ? { expectedTurnIndex } : {}),
                },
                affinityKey,
            );
        },
    };
}

export function buildRunTurnConfig(
    inputConfig: SerializableSessionConfig,
    hostname: string,
    fallbackAgentIdentity?: string,
): SerializableSessionConfig {
    const runConfig: SerializableSessionConfig = {
        ...inputConfig,
        turnSystemPrompt: mergePromptSections([
            inputConfig.turnSystemPrompt,
            `Running on host "${hostname}".`,
        ]),
    };

    if (!runConfig.agentIdentity && fallbackAgentIdentity) {
        runConfig.agentIdentity = fallbackAgentIdentity;
    }

    return runConfig;
}

/**
 * Derive the app-assigned CRAWLER role from the bound agent definition.
 *
 * The crawler role is a property of the AGENT, not of a session: it is resolved
 * from the worker's static, loaded agent definitions every turn by matching the
 * session's resolved identity (agentIdentity / boundAgentName) against each
 * agent's CANONICAL identifier (id / name). Because the agent list is static
 * worker configuration, this is deterministic and replay-safe.
 *
 * Deriving it here (rather than trusting a persisted `isCrawler` / legacy
 * `isHarvester`) means the role can NEVER be inherited from a parent session or
 * smuggled in via a stale serialized config — a child only becomes a crawler if
 * its OWN bound agent declares `crawler: true` (or legacy `harvester: true`).
 * System agents (e.g. facts-manager) that should be crawler-capable get the
 * tools through the SessionManager gating, not here.
 *
 * SECURITY (P5 review BLOCKER#2): `title` is display metadata, NOT an
 * authorization key — matching on it would let a non-crawler whose title
 * normalizes to a crawler's identity receive the privileged crawl queue
 * (`facts_read_uncrawled` / `facts_set_crawled`, which read facts across ALL
 * scopes). We match only `id` / `name`, and we FAIL CLOSED on ambiguity: when
 * more than one loaded agent resolves to the same normalized identity, the
 * privileged role is granted only if EVERY one declares the crawler role.
 */
export function resolveCrawlerRole(
    identity: string | undefined,
    boundAgentName: string | undefined,
    userAgents?: Array<{ name?: string; id?: string; title?: string; crawler?: boolean; harvester?: boolean }>,
    systemAgents?: Array<{ name?: string; id?: string; title?: string; crawler?: boolean; harvester?: boolean }>,
): boolean {
    const norm = (v?: string) => (v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const target = norm(identity) || norm(boundAgentName);
    if (!target) return false;
    const agents = [...(userAgents ?? []), ...(systemAgents ?? [])];
    // Canonical identifiers ONLY — never `title`.
    const matches = agents.filter((a) => {
        const candidates = [a.id, a.name].map(norm).filter(Boolean);
        return candidates.includes(target);
    });
    if (matches.length === 0) return false;
    const hasCrawlerRole = (agent: { crawler?: boolean; harvester?: boolean }) => agent.crawler === true || agent.harvester === true;
    // Fail closed on a normalized-id/name collision: do not let an ambiguous
    // match between a crawler and a non-crawler escalate to the role.
    return matches.every(hasCrawlerRole);
}

/**
 * Sessions whose bound-agent restore has already been announced by THIS
 * worker process. The backfill re-fires every turn for a session whose
 * durable input lacks the binding (the input itself cannot be repaired), and
 * without this set each of those turns wrote another
 * `session.bound_agent_restored` event. Once per session per process is
 * enough for observability; a pod move costs at most one duplicate. Swept
 * wholesale at a bound so a long-lived worker cannot grow it forever.
 */
const boundAgentRestoreAnnounced = new Set<string>();
const BOUND_AGENT_RESTORE_ANNOUNCED_SWEEP_AT = 5_000;

/**
 * Backfill a session's bound agent from the CMS catalog row.
 *
 * WHY THIS EXISTS: a top-level session's creation config lives in an
 * IN-MEMORY map on the API server that created it (`client.ts`
 * `sessionConfigs`). The orchestration is started lazily by whichever server
 * process handles the FIRST MESSAGE — and with more than one portal replica
 * behind a load balancer, that is routinely a different process. The lookup
 * misses, and the orchestration input is started with an empty config: no
 * `boundAgentName`, no model, nothing. The model already self-heals from the
 * catalog row (catalog-authoritative adoption in runTurn) and so does
 * `agentIdentity` — but the PROMPT layer and per-agent MCP grants key off
 * `boundAgentName`, so an API-created agent session ran with its agent's
 * title and tools-ish surface but NONE of its instructions. Measured on a
 * live fleet 2026-08-31: every MCP-created agent session composed only the
 * base + app-default layers.
 *
 * The CMS row's `agentId` is written by createSessionForAgent at create time
 * and is authoritative, exactly like the model. Backfill from it, guarded:
 *
 *   - only when the input carried no boundAgentName (never override);
 *   - only when the id matches a loaded USER agent by canonical name/id —
 *     a system agent must never be backfilled into the app-agent layering,
 *     which would hand it the app default prompt it deliberately does not
 *     get (and service identities like regen-distiller are not user agents,
 *     so they fall out here too);
 *   - never when the input explicitly declared a non-app prompt layering.
 *
 * Exact-name result: the prompt lookup is keyed by the agent's exact name,
 * so the matched agent's own `name` is returned, not the raw row value.
 *
 * @internal exported for tests
 */
export function resolveBoundAgentBackfill(
    runConfig: SerializableSessionConfig,
    catalogAgentId: string | null | undefined,
    userAgents?: Array<{ name?: string; id?: string }>,
): string | undefined {
    if (runConfig.boundAgentName) return undefined;
    const kind = runConfig.promptLayering?.kind;
    if (kind && kind !== "app-agent") return undefined;
    const wanted = String(catalogAgentId ?? "").trim();
    if (!wanted) return undefined;
    const match = (userAgents ?? []).find((a) => a.name === wanted || a.id === wanted);
    return match?.name || undefined;
}

/** @deprecated Use `resolveCrawlerRole`; retained for compatibility. */
export const resolveHarvesterRole = resolveCrawlerRole;

/** @internal Child model options shared by inline and activity spawn paths. */
export function childModelCreationOptions(config: SerializableSessionConfig) {
    return {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        contextTier: config.contextTier,
        childContract: config.childContract,
    };
}

/** @internal Initial turn options shared by every named-agent creation path. */
export function initialAgentTurnOptions(initialRequiredTool?: string) {
    return {
        bootstrap: true as const,
        ...(initialRequiredTool ? { requiredTool: initialRequiredTool } : {}),
    };
}



// ─── SessionManagerProxy ─────────────────────────────────────────
// The orchestration's view of the SessionManager singleton.
// Operations that don't require session affinity.

export function createSessionManagerProxy(ctx: any) {
    return {
        listModels() {
            return ctx.scheduleActivity("listModels", {});
        },
        summarizeSession(sessionId: string) {
            return ctx.scheduleActivity("summarizeSession", { sessionId });
        },
        /** Spawn a child session via the PilotSwarmClient SDK. Returns the generated child session ID. */
        spawnChildSession(parentSessionId: string, config: any, task: string, nestingLevel?: number, isSystem?: boolean, title?: string, agentId?: string, splash?: string, titleIsExplicit?: boolean, initialRequiredTool?: string) {
            return ctx.scheduleActivity("spawnChildSession", {
                parentSessionId, config, task, nestingLevel, isSystem, title, agentId, splash, titleIsExplicit,
                ...(initialRequiredTool ? { initialRequiredTool } : {}),
            });
        },
    /**
     * Resolve a loaded agent config by name. Returns null if not found.
     *
     * `callerSessionId` comes from the orchestration INSTANCE, never from the
     * model: it is what lets the activity refuse to hand a private package's
     * agent to somebody else's session. Threading it here rather than through
     * the orchestration generator keeps the yield sequence byte-identical, so
     * this is not an orchestration version change.
     */
    resolveAgentConfig(agentName: string) {
        return ctx.scheduleActivity("resolveAgentConfig", { agentName, callerSessionId: ctx.instanceId });
    },
        /** Send a message to a session via the PilotSwarmClient SDK. */
        sendToSession(sessionId: string, message: string) {
            return ctx.scheduleActivity("sendToSession", { sessionId, message });
        },
        /** Send a raw command (JSON) directly to a session's event queue. */
        sendCommandToSession(sessionId: string, command: any) {
            return ctx.scheduleActivity("sendCommandToSession", { sessionId, command });
        },
        /** Get the status of a session via the PilotSwarmClient SDK. */
        getSessionStatus(sessionId: string) {
            return ctx.scheduleActivity("getSessionStatus", { sessionId });
        },
        /** Get orchestration runtime stats for a session. */
        getOrchestrationStats(sessionId: string) {
            return ctx.scheduleActivity("getOrchestrationStats", { sessionId });
        },
        /** List all sessions via the PilotSwarmClient SDK. */
        listSessions(filters?: { includeSystem?: boolean; ownerQuery?: string; ownerKind?: string }) {
            return ctx.scheduleActivity("listSessions", filters ?? {});
        },
        /** List direct child sessions of a session. */
        listChildSessions(parentSessionId: string) {
            return ctx.scheduleActivity("listChildSessions", { parentSessionId });
        },
        /** @deprecated Send a child_updates event to a parent orchestration. Use sendToSession instead. */
        notifyParent(parentOrchId: string, childOrchId: string, childSessionId: string, update: any) {
            return ctx.scheduleActivity("notifyParent", { parentOrchId, childOrchId, childSessionId, update });
        },
        /** Get all descendant session IDs of a session (children, grandchildren, etc.). */
        getDescendantSessionIds(sessionId: string) {
            return ctx.scheduleActivity("getDescendantSessionIds", { sessionId });
        },
        /** Cancel a session's orchestration (terminates immediately). */
        cancelSession(sessionId: string, reason?: string) {
            return ctx.scheduleActivity("cancelSession", { sessionId, reason });
        },
        /** Cancel a session's orchestration and delete it from CMS. */
        deleteSession(sessionId: string, reason?: string) {
            return ctx.scheduleActivity("deleteSession", { sessionId, reason });
        },
        /** Update a session's CMS state (e.g. "rejected" for policy violations). */
        updateCmsState(sessionId: string, state: string, lastError?: string | null, waitReason?: string | null) {
            const payload: { sessionId: string; state: string; lastError?: string | null; waitReason?: string | null } = {
                sessionId,
                state,
            };
            if (lastError !== undefined) payload.lastError = lastError;
            if (waitReason !== undefined) payload.waitReason = waitReason;
            return ctx.scheduleActivity("updateCmsState", payload);
        },
        /** Persist this session's model metadata in CMS. */
        updateSessionModel(sessionId: string, model: string, reasoningEffort?: string | null, contextTier?: string | null, source?: string | null) {
            return ctx.scheduleActivity("updateSessionModel", { sessionId, model, reasoningEffort, contextTier, source });
        },
        /** Get the worker's authoritative session policy + allowed agent names. */
        getWorkerSessionPolicy() {
            return ctx.scheduleActivity("getWorkerSessionPolicy", {});
        },
        /** Load curated skills and open asks from the knowledge pipeline. */
        loadKnowledgeIndex(cap?: number) {
            return ctx.scheduleActivity("loadKnowledgeIndex", { cap });
        },
        /** Record CMS lifecycle events from the orchestration (waits, spawns, cron, commands). */
        recordSessionEvent(sessionId: string, events: { eventType: string; data: unknown }[]) {
            return ctx.scheduleActivity("recordSessionEvent", { sessionId, events });
        },
        /** Compute the next wall-clock cron fire in an activity so tzdata-dependent results are recorded in history. */
        computeCronAtNextFire(schedule: CronAtSchedule, afterUtcMs: number, lastOccurrenceKey?: string) {
            return ctx.scheduleActivity("computeCronAtNextFire", { schedule, afterUtcMs, lastOccurrenceKey });
        },
        // ── Session regeneration (1.0.67) ──────────────────────
        /** ARCHIVE stage: transcript slice → attempt-scoped artifact. Idempotent per attempt. */
        runRegenArchive(sessionId: string, epoch: number, attemptId: string) {
            return ctx.scheduleActivity("runRegenArchive", { sessionId, epoch, attemptId });
        },
        /** DISTILL (deterministic): closure package in-activity → ResumePackage artifact + bootstrap. */
        runRegenDistill(sessionId: string, epoch: number, attemptId: string, opts?: { handoff?: string; instructions?: string; sessionModel?: string; distillerModel?: string; archiveArtifactId?: string }) {
            return ctx.scheduleActivity("runRegenDistill", { sessionId, epoch, attemptId, ...(opts ?? {}) });
        },
        /** Post-flip boundary: epoch_committed event + transcript_epoch + regen_count, one CMS transaction. */
        commitEpochBoundary(sessionId: string, commit: Record<string, unknown>) {
            return ctx.scheduleActivity("commitEpochBoundary", { sessionId, commit });
        },
        /** Proven rebirth: session.regenerated event + last_regen_stats. */
        recordRegenerated(sessionId: string, payload: Record<string, unknown>) {
            return ctx.scheduleActivity("recordRegenerated", { sessionId, payload });
        },
        // ── Service-session distiller (1.0.68) ─────────────────
        /** Spawn the regen-distiller service session under the tree root (idempotent per attempt). */
        runRegenSpawnDistiller(sessionId: string, epoch: number, attemptId: string, opts?: { archiveArtifactId?: string; archiveChunkIds?: string[]; handoff?: string; instructions?: string; distillerModel?: string; distillerReasoningEffort?: string; distillerContextTier?: string }) {
            return ctx.scheduleActivity("runRegenSpawnDistiller", { sessionId, epoch, attemptId, ...(opts ?? {}) });
        },
        /** Poll the distiller service session: running | completed (with response) | failed. */
        runRegenCheckDistiller(distillerSessionId: string) {
            return ctx.scheduleActivity("runRegenCheckDistiller", { distillerSessionId });
        },
        /** Parse/validate the distiller's final message into the package (+dumps); deterministic fallback on junk. */
        runRegenCollectDistiller(sessionId: string, epoch: number, attemptId: string, distillerSessionId: string, opts?: { archiveArtifactId?: string; archiveChunkIds?: string[]; handoff?: string; instructions?: string; distillerModel?: string; distillerReasoningEffort?: string; distillerContextTier?: string }) {
            return ctx.scheduleActivity("runRegenCollectDistiller", { sessionId, epoch, attemptId, distillerSessionId, ...(opts ?? {}) });
        },
        /** Best-effort cancel of a timed-out/failed distiller service session. */
        runRegenCancelDistiller(distillerSessionId: string) {
            return ctx.scheduleActivity("runRegenCancelDistiller", { distillerSessionId });
        },
    };
}

// ─── Activity Registration ───────────────────────────────────────
// Thin dispatchers — each is a one-liner that calls the corresponding
// SessionManager or ManagedSession method.

export function registerActivities(
    runtime: any,
    sessionManager: SessionManager,
    sessionStore: SessionStateStore | null,
    githubToken?: string,
    catalog?: SessionCatalog | null,
    provider?: any,
    storeUrl?: string,
    cmsSchema?: string,
    clientConfig?: {
        storageConfig?: StorageConfig;
        duroxideSchema?: string;
        factsSchema?: string;
        // Full facts/CMS target so activity-layer clients resolve the SAME store
        // as the worker (07 P3 — otherwise parent-triggered deleteSession /
        // cleanup / reads hit the wrong DB when facts live on HorizonDB).
        cmsFactsDatabaseUrl?: string;
        enhancedFactsDatabaseUrl?: string;
        factsProvider?: "pg" | "horizon";
        enhancedFactsSchema?: string;
        useManagedIdentity?: boolean;
        aadDbUser?: string;
    },
    /** Loaded system agents — used by resolveAgentConfig activity. */
    systemAgents?: AgentConfig[],
    /** Worker-level session policy — used by getWorkerSessionPolicy activity. */
    workerSessionPolicy?: import("./types.js").SessionPolicy | null,
    /** Names of loaded non-system agents — used by getWorkerSessionPolicy activity. */
    workerAllowedAgentNames?: string[],
    /** Loaded user-creatable agents — used by resolveAgentConfig activity. */
    userAgents?: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; namespace?: string; id?: string; title?: string; initialPrompt?: string; splash?: string; splashMobile?: string; parent?: string; crawler?: boolean; harvester?: boolean; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }>,
    /** Fact store instance for the loadKnowledgeIndex activity. */
    factStore?: import("./facts-store.js").FactStore | null,
    /** Worker node identifier — written on every CMS event for worker tracking. */
    workerNodeId?: string,
    /** Artifact store — resolves image attachment refs to bytes inside runTurn. */
    artifactStore?: ArtifactStore | null,
) {
    // Shared config for every activity-layer internal PilotSwarmClient /
    // PilotSwarmManagementClient. Carries the FULL facts/CMS target (07 P3) so
    // these clients resolve the SAME store as the worker — otherwise
    // parent-triggered deleteSession / cleanup / reads would hit the wrong DB
    // when facts live on an enhanced (HorizonDB) store.
    const internalClientConfig = () => ({
        store: storeUrl!,
        ...(clientConfig?.storageConfig != null && { storageConfig: clientConfig.storageConfig }),
        cmsSchema,
        ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
        ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        ...(clientConfig?.cmsFactsDatabaseUrl != null && { cmsFactsDatabaseUrl: clientConfig.cmsFactsDatabaseUrl }),
        ...(clientConfig?.enhancedFactsDatabaseUrl != null && { enhancedFactsDatabaseUrl: clientConfig.enhancedFactsDatabaseUrl }),
        ...(clientConfig?.factsProvider != null && { factsProvider: clientConfig.factsProvider }),
        ...(clientConfig?.enhancedFactsSchema != null && { enhancedFactsSchema: clientConfig.enhancedFactsSchema }),
        ...(clientConfig?.useManagedIdentity != null && { useManagedIdentity: clientConfig.useManagedIdentity }),
        ...(clientConfig?.aadDbUser != null && { aadDbUser: clientConfig.aadDbUser }),
    });

    // ── runTurn ──────────────────────────────────────────────
    const runTurnHandler = async (
        activityCtx: any,
        input: {
            sessionId: string;
            prompt: string;
            config: SerializableSessionConfig;
            bootstrap?: boolean;
            turnIndex?: number;
            parentSessionId?: string;
            nestingLevel?: number;
            requiredTool?: string;
            cycleOrigin?: "cron" | "cron_at";
            retryCount?: number;
            /** Session lifecycle protocol (orchestration 1.0.57+). Absent → legacy behavior. */
            snapshot?: { expectedVersion?: number; turnKey: string };
            /** Image attachment refs (1.0.65+) — bytes are fetched from the artifact store below. */
            attachments?: PromptAttachmentRef[];
            /** Session regeneration (1.0.67+): epoch this turn belongs to. Absent → 0. */
            transcriptEpoch?: number;
            /** First turn of a fresh epoch (runTurn2): conditional epoch init. */
            epochStart?: boolean;
        },
    ): Promise<TurnResult> => {
        // Attachment count is traced unconditionally: a 2026-07-21 incident
        // showed turns whose ActivityScheduled input carried refs executing
        // WITHOUT them (suspected work-item redelivery after eviction/lock
        // churn). This line makes the executed input's truth visible.
        activityCtx.traceInfo(`[runTurn] session=${input.sessionId} attachments=${Array.isArray(input.attachments) ? input.attachments.length : "absent"}`);

        const modelSummary = await sessionManager.getModelSummary(input.sessionId);
        const turnTelemetry = {
            tokensInput: 0,
            tokensOutput: 0,
            tokensCacheRead: 0,
            tokensCacheWrite: 0,
            toolCalls: 0,
            toolErrors: 0,
            toolNames: new Set<string>(),
            modelSummary,
            // The model that actually served this turn, observed from the SDK's
            // own events. `input.config.model` is only set when the session
            // pinned a model explicitly; a session running on the deployment
            // default leaves it undefined, which is why turn_completed used to
            // report model: null and the portal rendered "Mod: unknown".
            observedModel: null as string | null,
        };
        const turnStartedAt = new Date();
        const turnSpan = otelTrace.getTracer("pilotswarm-turns").startSpan("session.turn", {
            attributes: {
                "pilotswarm.session_id": input.sessionId,
                "pilotswarm.turn_index": input.turnIndex ?? 0,
                "pilotswarm.bootstrap": Boolean(input.bootstrap),
                "pilotswarm.retry_count": input.retryCount ?? 0,
                "pilotswarm.nesting_level": input.nestingLevel ?? 0,
                "pilotswarm.has_parent_session": Boolean(input.parentSessionId),
                ...(input.parentSessionId ? { "pilotswarm.parent_session_id": input.parentSessionId } : {}),
                ...(input.requiredTool ? { "pilotswarm.required_tool": input.requiredTool } : {}),
                ...(input.cycleOrigin ? { "pilotswarm.cycle_origin": input.cycleOrigin } : {}),
                ...(input.config.model ? { "pilotswarm.model": input.config.model } : {}),
                ...(input.config.reasoningEffort ? { "pilotswarm.reasoning_effort": input.config.reasoningEffort } : {}),
                ...(workerNodeId ? { "pilotswarm.worker_node_id": workerNodeId } : {}),
            },
        });

        const hostname = os.hostname();
        const MAX_SUB_AGENTS = 50;
        const MAX_NESTING_LEVEL = 2;
        let fallbackAgentIdentity: string | undefined;
        let catalogSessionRow: any = null;
        // Self-heal older persisted system sessions created before agentIdentity
        // was forwarded through worker bootstrap/orchestration input.
        if (catalog) {
            catalogSessionRow = await cmsRetryBestEffort(
                `runTurn.getSession authoritative-config session=${input.sessionId}`,
                () => catalog!.getSession(input.sessionId),
                (msg) => activityCtx.traceInfo(msg),
            );
            if (!input.config.agentIdentity) {
                fallbackAgentIdentity = catalogSessionRow?.agentId ?? undefined;
            }
        }

        const runConfig = buildRunTurnConfig(input.config, hostname, fallbackAgentIdentity);
        if (catalogSessionRow?.model) {
            const staleConfiguredModel = String(input.config.model || "").trim();
            if (staleConfiguredModel && staleConfiguredModel !== catalogSessionRow.model) {
                await cmsRetryBestEffort(
                    `runTurn.recordEvent model-mismatch session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.model_mismatch",
                        data: {
                            catalogModel: catalogSessionRow.model,
                            configuredModel: staleConfiguredModel,
                            action: "catalog_model_adopted",
                            message: "Runtime session config disagreed with the session catalog model; the catalog is authoritative and its exact model was adopted before provider admission.",
                        },
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
            runConfig.model = catalogSessionRow.model;
            runConfig.reasoningEffort = catalogSessionRow.reasoningEffort ?? undefined;
            runConfig.contextTier = catalogSessionRow.contextTier ?? undefined;
        }
        // Self-heal the bound agent the same way the model is self-healed
        // above: the catalog row is authoritative, the orchestration input is
        // not (see resolveBoundAgentBackfill for how API-created sessions
        // lose their entire creation config). Runs every turn, so existing
        // broken sessions heal on their next turn with no migration.
        const backfilledBoundAgent = resolveBoundAgentBackfill(
            runConfig, catalogSessionRow?.agentId, userAgents,
        );
        if (backfilledBoundAgent) {
            runConfig.boundAgentName = backfilledBoundAgent;
            if (!runConfig.promptLayering) runConfig.promptLayering = { kind: "app-agent" };
            activityCtx.traceInfo(`[runTurn] boundAgentName restored from catalog agentId=${backfilledBoundAgent} (orchestration input carried none)`);
            if (catalog && !boundAgentRestoreAnnounced.has(input.sessionId)) {
                if (boundAgentRestoreAnnounced.size >= BOUND_AGENT_RESTORE_ANNOUNCED_SWEEP_AT) boundAgentRestoreAnnounced.clear();
                boundAgentRestoreAnnounced.add(input.sessionId);
                await cmsRetryBestEffort(
                    `runTurn.recordEvent bound-agent-restored session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.bound_agent_restored",
                        data: {
                            agentId: backfilledBoundAgent,
                            message: "Orchestration input carried no boundAgentName; restored from the authoritative session catalog row. The creation config was lost at start (API-server in-memory config miss).",
                        },
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                ).catch(() => {});
            }
        }

        // Derive the app-assigned crawler role authoritatively from the bound
        // agent definition EVERY turn.
        // It is a property of the agent, resolved from static worker config, so
        // it survives hydration, is replay-safe, and can never be inherited from
        // a parent or trusted from a stale serialized config.
        runConfig.isCrawler = resolveCrawlerRole(
            runConfig.agentIdentity, runConfig.boundAgentName, userAgents, systemAgents,
        );
        runConfig.isHarvester = runConfig.isCrawler;
        const trace = activityTrace(activityCtx, "runTurn");

        const failForMissingState = async (message: string) => {
            if (catalog) {
                // Best-effort: this fires from already-failed code paths;
                // we don't want a CMS hiccup to escalate into a thrown activity.
                await cmsRetryBestEffort(
                    `runTurn.failForMissingState session=${input.sessionId}`,
                    () => catalog!.updateSession(input.sessionId, {
                        state: "failed",
                        lastError: message,
                    }),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
            return { type: "error", message } as TurnResult;
        };

        let inlineSdkClient: PilotSwarmClient | null = null;
        let inlineSdkClientPromise: Promise<PilotSwarmClient> | null = null;
        let cancelPoll: ReturnType<typeof setInterval> | null = null;
        let finalTurnResult: TurnResult | null = null;

        try {
            finalTurnResult = await sessionManager.withRunTurnLock(input.sessionId, "runTurn", async () => {
        // ── Session lifecycle protocol preamble (proposal §3.3) ─────────
        // Only active when the orchestration (1.0.57+) supplied snapshot
        // coordinates AND the store implements the versioned CAS contract.
        // Absent either, this activity behaves exactly as before.
        const lifecycle: TurnLifecycleContext | null =
            input.snapshot && sessionStore && supportsVersionedSnapshots(sessionStore)
                ? {
                    store: sessionStore,
                    sessionStateDir: sessionManager.getSessionStateDir(),
                    sessionId: input.sessionId,
                    // Store-wins: expectedVersion is non-load-bearing and 1.0.59
                    // stops sending it (dead for the reconcile — the worker
                    // ignores it for every control decision). Default to 0 for
                    // frozen versions that still supply it, and for the two
                    // observability-only reads (lossy flag, snapshot_store_empty).
                    expectedVersion: input.snapshot.expectedVersion ?? 0,
                    turnKey: input.snapshot.turnKey,
                    // Session regeneration: epoch scopes every store call to
                    // the current chain and gates local-dir trust. Absent on
                    // pre-1.0.67 inputs → 0 (legacy chain, today's behavior).
                    transcriptEpoch: input.transcriptEpoch ?? 0,
                    dropWarmSession: () => sessionManager.dropWarmSession(input.sessionId),
                    trace,
                }
                : null;
        let lifecycleBaseVersion = 0;
        let lifecycleRehydrated = false;
        let lifecyclePreambleFresh = false;
        // Protocol-native persistence stats: the legacy dehydrate/hydrate
        // activities no longer run, so the preamble/commit paths feed the
        // same CMS summary + events the Stats pane reads. Best-effort only.
        const recordLifecycleHydration = async (version: number) => {
            if (!catalog) return;
            await cmsRetryBestEffort(
                `runTurn.lifecycleHydrated session=${input.sessionId}`,
                async () => {
                    await catalog!.upsertSessionMetricSummary(input.sessionId, {
                        hydrationCountIncrement: 1,
                        lastHydratedAt: true,
                    });
                    await catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.hydrated",
                        data: { version, protocol: "lifecycle" },
                    }], workerNodeId);
                },
                (msg) => activityCtx.traceInfo(msg),
            );
        };
        if (lifecycle) {
            const pre = await runTurnPreamble(lifecycle);
            if (pre.kind === "already-committed") {
                activityCtx.traceInfo(
                    `[runTurn] session=${input.sessionId} already-committed recovery at v${pre.version}; ` +
                    `returning stored result without re-running the turn`,
                );
                await recordLifecycleHydration(pre.version);
                return { ...(pre.result as TurnResult), snapshotVersion: pre.version };
            }
            lifecycleBaseVersion = pre.baseVersion;
            lifecycleRehydrated = pre.kind === "hydrated";
            lifecyclePreambleFresh = pre.kind === "fresh";
            if (lifecycleRehydrated) {
                await recordLifecycleHydration(pre.baseVersion);
            }
            if (pre.kind === "hydrated" && pre.regressed && catalog) {
                // Store-wins anomaly: the store was BELOW this worker's marker
                // (backup restore / data loss). The store still won — we
                // hydrated it — but surface the regression. Best-effort (P7).
                const regressed = pre.regressed;
                await cmsRetryBestEffort(
                    `runTurn.recordEvent snapshot-regressed session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.snapshot_regressed",
                        data: {
                            markerVersion: regressed.markerVersion,
                            storeVersion: regressed.storeVersion,
                            hydratedVersion: pre.baseVersion,
                            message: "Snapshot store version was below the worker's local marker (restore from an older backup, or store data loss); store wins — hydrated the stored version.",
                        },
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
            if (pre.kind === "fresh" && pre.lossy && !input.epochStart && catalog) {
                await cmsRetryBestEffort(
                    `runTurn.recordEvent snapshot-store-empty session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.snapshot_store_empty",
                        data: {
                            expectedVersion: input.snapshot!.expectedVersion ?? 0,
                            message: "Snapshot store held no data for a session with committed turns; falling back to fresh-session recovery.",
                        },
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
        }

        // ── the provider budget gate ─────────────────────────────────
        //
        // Before anything expensive: before a Copilot session is created or
        // warmed, before a prompt is hydrated, and above all before the
        // model is called. A paused turn must cost nothing.
        //
        // It runs HERE, in the activity, rather than in the orchestration,
        // because activity bodies are not replay-frozen — the check itself
        // needs no orchestration version. What it returns is the ordinary
        // `wait` TurnResult, so the orchestration's existing machinery does
        // the rest: a durable timer, a waiting status, a wait_started event,
        // and a resume that re-enters this same gate.
        //
        // FAIL CLOSED. Provider identity is both authorization and billing;
        // a turn that cannot prove which credential it may use must not call
        // a model through a cached/default binding.
        // What the gate ADMITTED — the provider that pays, and the model
        // reference it was admitted under. Both are settled against later;
        // neither is re-derived, because the observed model name the SDK
        // reports back is a bare name ("gpt-5.4") and a limit scoped to one
        // model matches the qualified reference ("azure-prod:gpt-5.4"). A
        // per-model limit would never match its own turns.
        const admittedProvider = { name: null as string | null, modelRef: null as string | null };
        let admissionModel: string | null = null;
        if (runConfig.model) {
            await sessionManager.refreshModelProviders();
            try {
                admissionModel = sessionManager.normalizeModelRef(runConfig.model) ?? null;
            } catch {
                await sessionManager.refreshModelProviders();
                try {
                    admissionModel = sessionManager.normalizeModelRef(runConfig.model) ?? null;
                } catch (err: any) {
                    // The ref names a provider the runtime registry has never
                    // heard of — exactly what a deleted provider looks like.
                    // Throwing here dies BEFORE the admission gate, whose
                    // no_provider verdict owns this case (the honest wait,
                    // pause_state, the paused listing, wake on re-create).
                    // Hand the gate the raw reference and let it rule.
                    activityCtx.traceInfo(
                        `[runTurn] model ref did not resolve (${err?.message ?? err}); deferring to the admission gate`,
                    );
                    admissionModel = runConfig.model;
                }
            }
        }
        if (catalog?.providers) {
            try {
                const admission = await catalog.providers.checkTurn(input.sessionId, admissionModel);
                admittedProvider.name = admission.providerName;
                admittedProvider.modelRef = admission.modelQualified;
                if (!runConfig.model && admission.modelQualified) {
                    runConfig.model = admission.modelQualified;
                }
                if (!catalogSessionRow?.model && admission.modelQualified) {
                    catalogSessionRow = await cmsRetryCritical(
                        `runTurn.getSession stamped-model session=${input.sessionId}`,
                        () => catalog!.getSession(input.sessionId),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                    runConfig.model = catalogSessionRow?.model ?? admission.modelQualified;
                    runConfig.reasoningEffort = catalogSessionRow?.reasoningEffort ?? undefined;
                    runConfig.contextTier = catalogSessionRow?.contextTier ?? undefined;
                }
                (runConfig as ManagedSessionConfig).admittedModel = admission.modelQualified ?? undefined;
                const wait = admissionToWait(admission, input.sessionId, Date.now());
                if (wait) {
                    activityCtx.traceInfo(
                        `[runTurn] provider budget paused ${input.sessionId}: ${wait.reason}`,
                    );
                    await cmsRetryBestEffort(
                        `runTurn.recordEvent budget-paused session=${input.sessionId}`,
                        () => catalog!.recordEvents(input.sessionId, [{
                            eventType: "session.budget_paused",
                            data: {
                                kind: admission.pause?.kind ?? "limit",
                                provider: admission.pause?.provider ?? null,
                                resetsAtUtc: admission.pause?.resetsAtUtc ?? null,
                                content: wait.reason,
                            },
                        }], workerNodeId),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                    return wait as TurnResult;
                }
            } catch (err: any) {
                activityCtx.traceInfo(
                    `[runTurn] provider admission failed (fail-closed): ${err?.message ?? err}`,
                );
                return {
                    type: "error",
                    message: `Provider admission could not verify this turn: ${err?.message ?? err}`,
                } as TurnResult;
            }
        }

        const executeTurnBody = async (): Promise<TurnResult> => {
        let session: any = null;
        let effectivePrompt = input.prompt;
        // Prompts the budget gate refused on earlier attempts. Each was
        // durably recorded as a user.message WHEN IT WAS STASHED, so they are
        // folded into what the model sees but never re-recorded here — the
        // write below records input.prompt alone. When the only "new" prompt
        // is the internal wake nudge, the stash IS the message: the nudge
        // says "the user did not send a new message", which would be false
        // sitting under their words.
        {
            const stashed = Array.isArray((input as any).stashedPrompts)
                ? ((input as any).stashedPrompts as unknown[])
                    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
                : [];
            if (stashed.length > 0) {
                // A bootstrap turn carries no new user words by definition —
                // the wake nudge arrives as one, because its [SYSTEM:] body
                // is extracted into system context and the prompt substituted
                // with the internal continuation marker.
                const isWakeNudge = input.bootstrap === true
                    || input.prompt === PROVIDER_BUDGET_WAKE_PROMPT;
                effectivePrompt = isWakeNudge
                    ? stashed.join("\n\n")
                    : `${stashed.join("\n\n")}\n\n${input.prompt}`;
                activityCtx.traceInfo(
                    `[runTurn] replaying ${stashed.length} prompt(s) the budget gate had refused`);
            }
        }
        // Conditional epoch init (runTurn2): create a brand-new SDK session
        // ONLY when the epoch's chain is empty (preamble "fresh"). A committed
        // grounding turn recovers via already-committed above; a non-empty
        // chain resumes — an unconditional reset would erase a committed
        // grounding turn on activity retry.
        const epochCreate = input.epochStart === true && (!lifecycle || lifecyclePreambleFresh);
        try {
            session = await sessionManager.getOrCreate(input.sessionId, runConfig, {
                turnIndex: input.turnIndex,
                transcriptEpoch: input.transcriptEpoch ?? 0,
                ...(epochCreate ? { epochStart: true } : {}),
                trace,
                lockHeld: true,
            });
        } catch (err: any) {
            const message = err?.message || String(err);
            if (isMissingSessionStateErrorMessage(message) || isLiveSessionLostErrorMessage(message)) {
                const detail = isMissingSessionStateErrorMessage(message)
                    ? stripMissingSessionStatePrefix(message)
                    : message;

                // ── Lifecycle store recovery BEFORE lossy replay ─────────
                // The store may hold a perfect committed snapshot (e.g. the
                // SDK refused to resume from locally damaged files). Restore
                // it and retry — lossy replay (whose turn-0 reset DELETES
                // the store snapshot) is only reachable when the store is
                // empty, making that delete a no-op.
                if (lifecycle) {
                    try {
                        const recoveredVersion = await attemptStoreRecovery(lifecycle);
                        if (recoveredVersion != null) {
                            trace(
                                `session=${input.sessionId} restored committed snapshot v${recoveredVersion} ` +
                                `after getOrCreate failure (${detail.slice(0, 120)}); retrying resume`,
                            );
                            session = await sessionManager.getOrCreate(input.sessionId, runConfig, {
                                turnIndex: input.turnIndex,
                                trace,
                                lockHeld: true,
                            });
                            lifecycleBaseVersion = recoveredVersion;
                            lifecycleRehydrated = true;
                        }
                    } catch (storeRecoveryErr: any) {
                        trace(
                            `session=${input.sessionId} snapshot-store recovery failed: ` +
                            `${storeRecoveryErr?.message ?? storeRecoveryErr}; falling back to lossy replay`,
                        );
                        session = null;
                    }
                }
                if (session) {
                    // Recovered losslessly — skip the lossy replay machinery.
                } else {
                trace(
                    `session=${input.sessionId} missing resumable state before turn ${input.turnIndex ?? "unknown"}; ` +
                    "starting lossy fresh-session replay",
                );
                await recordLossyHandoffEvent(
                    catalog,
                    input.sessionId,
                    workerNodeId,
                    {
                        cause: "missing_resumable_state_before_run_turn",
                        message: buildLossyReplayMessage(input.sessionId, detail),
                        detail,
                        error: message,
                        recoveryMode: "fresh_session_replay",
                        nextStep: "replay_pending_turn_with_recreated_copilot_session",
                        ...(input.turnIndex != null ? { iteration: input.turnIndex } : {}),
                    },
                    (failureMessage) => activityCtx.traceInfo(`[runTurn] ${failureMessage}`),
                );
                if (catalog) {
                    await cmsRetryBestEffort(
                        `runTurn.recordEvent system.message-lossy-replay session=${input.sessionId}`,
                        () => catalog!.recordEvents(input.sessionId, [{
                            eventType: "system.message",
                            data: {
                                content:
                                    "The runtime is replaying this turn after a worker restart lost the live Copilot session state before durable dehydrate completed. " +
                                    "Some recent work may be missing or partially executed.",
                            },
                        }], workerNodeId),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                }
                try {
                    session = await sessionManager.getOrCreate(input.sessionId, runConfig, {
                        turnIndex: 0,
                        trace,
                        lockHeld: true,
                    });
                } catch (recoveryErr: any) {
                    const recoveryMessage = recoveryErr?.message || String(recoveryErr);
                    const fatalMessage = isMissingSessionStateErrorMessage(recoveryMessage)
                        ? buildUnrecoverableSessionLossMessage(
                            input.sessionId,
                            stripMissingSessionStatePrefix(recoveryMessage),
                        )
                        : buildUnrecoverableSessionLossMessage(input.sessionId, recoveryMessage);
                    trace(`session=${input.sessionId} lossy replay session recreation failed error=${fatalMessage}`);
                    return await failForMissingState(fatalMessage);
                }
                effectivePrompt = mergePromptSections([LOSSY_SESSION_REPLAY_NOTICE, input.prompt]) || input.prompt;
                }
            } else {
                throw err;
            }
        }

        // ── Lifecycle p3: sentinel marks the dir as mid-mutation from here
        // until the post-turn commit clears it. Written after getOrCreate so
        // the turn-0 reset path cannot wipe it, before any body mutation.
        if (lifecycle) {
            writeTurnSentinel(
                path.join(sessionManager.getSessionStateDir(), input.sessionId),
                input.snapshot!.turnKey,
            );
            if (lifecycleRehydrated) {
                effectivePrompt = mergePromptSections([REHYDRATED_SESSION_NOTICE, effectivePrompt]) || effectivePrompt;
            }
        }

        const getInlineClient = async () => {
            if (inlineSdkClient) return inlineSdkClient;
            if (inlineSdkClientPromise) return await inlineSdkClientPromise;
            if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");
            inlineSdkClientPromise = (async () => {
                const startedClient = new PilotSwarmClient(internalClientConfig());
                await startedClient.start();
                inlineSdkClient = startedClient;
                return startedClient;
            })();
            try {
                return await inlineSdkClientPromise;
            } finally {
                inlineSdkClientPromise = null;
            }
        };

        const isAutonomousSystemTurn = () => {
            if (!SYSTEM_AGENT_IDS.has(runConfig.agentIdentity || "")) return false;
            if (input.bootstrap === true) return true;
            return /^\s*\[SYSTEM:/i.test(String(input.prompt ?? ""));
        };

        const sanitizeAutonomousSystemSessionFilters = <T extends { include_system?: boolean; owner_query?: string; owner_kind?: string }>(args?: T): T | undefined => {
            if (!args || !isAutonomousSystemTurn()) return args;
            if (!args.owner_query && !args.owner_kind) return args;
            const sanitized = { ...args };
            delete sanitized.owner_query;
            delete sanitized.owner_kind;
            return sanitized;
        };

        const isReadOnlyTuner = () => runConfig.agentIdentity === "agent-tuner";

        // The one shared resolver — FQN parsing (`__shared:` works here too),
        // package privacy, and the caller's own-copy shadowing included. The
        // previous inline copy had none of that: it could hand another user's
        // private agent to this session and could not address the shared copy
        // of a shadowed name.
        const resolveAgentConfigInline = (agentName: string) =>
            resolveAgentDefinitionForCaller({
                agentName,
                userAgents,
                systemAgents,
                getCallerOwnerKey: async () => {
                    const owner = catalog
                        ? await resolveEffectiveSpawnOwner(
                            (id) => catalog!.getSession(id),
                            input.sessionId,
                        ).catch(() => null)
                        : null;
                    return owner?.provider && owner?.subject
                        ? `${owner.provider}\u0001${owner.subject}`
                        : null;
                },
            });

        const loadDirectChildSessions = async () => {
            const sdkClient = await getInlineClient();
            const sessions = await sdkClient.listSessions();
            const directChildren = sessions.filter(s => s.parentSessionId === input.sessionId);
            return await Promise.all(directChildren.map(async (child) => {
                const info = await sdkClient._getSessionInfo(child.sessionId);
                const outcome = catalog ? await catalog.getChildOutcome(child.sessionId).catch(() => null) : null;
                const outcomeResult = normalizeJsonObject(outcome?.resultJson?.current);
                const contractCurrent = normalizeJsonObject(outcome?.contractJson?.current);
                return {
                    orchId: `session-${child.sessionId}`,
                    sessionId: child.sessionId,
                    title: info.title ?? child.title,
                    status: info.status,
                    iterations: info.iterations ?? child.iterations ?? 0,
                    parentSessionId: child.parentSessionId,
                    isSystem: child.isSystem ?? info.isSystem ?? false,
                    agentId: child.agentId ?? info.agentId,
                    result: outcome?.summary ?? (typeof outcomeResult?.summary === "string" ? outcomeResult.summary : info.result),
                    contract: contractCurrent ?? undefined,
                    contractStatus: outcome?.contractJson ? "contracted" : undefined,
                    verdict: outcome?.verdict ?? undefined,
                    contractViolations: Array.isArray(outcomeResult?.contractViolations) ? outcomeResult.contractViolations : undefined,
                    error: info.error,
                };
            }));
        };

        const resolveManagedChild = async (agentId: string) => {
            const targetOrchId = agentId.startsWith("session-") ? agentId : `session-${agentId}`;
            const children = await loadDirectChildSessions();
            const child = children.find(entry => entry.orchId === targetOrchId);
            if (!child) {
                throw new Error(
                    `agent "${targetOrchId}" not found. Known agents: ${children.filter(entry => !entry.isSystem).map(entry => entry.orchId).join(", ") || "none"}`,
                );
            }
            if (child.isSystem) {
                throw new Error(`agent "${targetOrchId}" is a worker-managed system agent and is not a controllable spawned sub-agent`);
            }
            return child;
        };

        /**
         * Is the manager session's owner allowed to drive `targetSessionId`
         * as its user?
         *
         * Owner-or-admin, deliberately narrower than "can read". Visibility
         * includes sessions shared WITH you, and being allowed to watch a run
         * is not the same as being allowed to type into it. The decision uses
         * the same role predicate the portal and the viewer spine use, so a
         * demotion lands here too — it is never a name that grants.
         */
        const canDriveSession = async (
            targetSessionId: string,
            opts?: { refuseSystem?: boolean },
        ): Promise<{ ok: true } | { ok: false; reason: string }> => {
            if (!catalog) return { ok: false, reason: "no session catalog on this worker" };
            const target = await catalog.getSession(targetSessionId).catch(() => null);
            const me = await resolveEffectiveSpawnOwner(
                (id) => catalog!.getSession(id),
                input.sessionId,
            ).catch(() => null);

            let isAdmin = false;
            if (me?.provider && me?.subject && typeof (catalog as any).getUserRole === "function") {
                try {
                    const observation = await (catalog as any).getUserRole(me);
                    isAdmin = evaluateRoleObservation(observation, { principal: me }).isAdmin;
                } catch {
                    isAdmin = false;   // a read failure is not evidence of privilege
                }
            }

            // The rule itself lives in agent-manager-tools as a pure function
            // so it can be tested directly; this half is only the IO.
            return decideSessionControl({
                target: target as any,
                targetIdLabel: targetSessionId.slice(0, 8),
                caller: me,
                callerIsAdmin: isAdmin,
                refuseSystem: opts?.refuseSystem,
            });
        };

        // Same-turn draw serialization: parallel draw_canvas calls in one
        // assistant message would otherwise race the derive-write-record
        // section and mint duplicate revisions.
        async function latestCanvasDataRev(catalog: any, sessionId: string, slot = 1): Promise<number> {
    const rows = await catalog.getSessionEventsBefore(
        sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_data"],
    );
    let latest = 0;
    for (const row of rows || []) {
        if (eventSlot(row) !== slot) continue;
        const rev = Number((row as any)?.data?.dataRev);
        if (Number.isFinite(rev) && rev > latest && Number.isInteger(rev)) latest = rev;
    }
    return latest;
}

let canvasDrawChain: Promise<void> = Promise.resolve();
        // Per-slot tick throttle (the plane makes ticks cheap; a runaway
        // loop must not flood viewers). Execution-scoped, like the chain.
        // Keys are `${targetSessionId}:${slot}` — a child ticking its own
        // canvas and its parent's dashboard are separate budgets.
        const canvasTickClock = new Map<string, number>();
        const CANVAS_TICK_MIN_INTERVAL_MS = 100;
        /**
         * Cross-session canvas targeting: ANCESTORS ONLY. A sub-agent may
         * draw on its parent's (or grandparent's, or the root's) surface —
         * never a sibling's, a child's, or a stranger's. Worker-trusted,
         * the same stance as fromArtifact; the walk is the catalog's parent
         * chain, capped at the spawn-nesting depth.
         */
        const resolveCanvasTarget = async (requested?: unknown): Promise<{ target: string; crossSession: boolean } | { error: string }> => {
            const requestedId = String(requested ?? "").trim();
            if (!requestedId || requestedId === input.sessionId) {
                return { target: input.sessionId, crossSession: false };
            }
            let cursor: string | null = input.sessionId;
            for (let depth = 0; depth < 8 && cursor; depth++) {
                let row: any;
                try {
                    row = await catalog?.getSession?.(cursor);
                } catch (err: any) {
                    return { error: `could not verify the session lineage: ${err?.message || String(err)}` };
                }
                const parent: string | null = row?.parentSessionId ?? null;
                if (!parent) break;
                if (parent === requestedId) return { target: requestedId, crossSession: true };
                cursor = parent;
            }
            return { error: `session_id ${requestedId} is not an ancestor of this session — canvas tools may target only your parent chain (parent, grandparent, root)` };
        };

        const controlToolBridge = {
            /**
             * Send a message to a session AS ITS USER.
             *
             * The message lands in the target's chat as a user turn, which is
             * what makes the Agent Manager able to actually drive a
             * verification run rather than only watch one. Distinct from
             * `send_session_message`, which is an auditable cross-session
             * REQUEST envelope, and from `message_agent`, which only reaches
             * your own children.
             *
             * Gated on owner-or-admin (see canDriveSession) — typing into
             * someone else's session is a write, not a read.
             */
            messageAgentSession: async (args: { session_id: string; message: string }) => {
                try {
                    const targetId = String(args.session_id || "").trim();
                    const message = String(args.message ?? "");
                    if (!targetId) return "Error: session_id is required.";
                    if (!message.trim()) return "Error: message must not be empty.";

                    const verdict = await canDriveSession(targetId);
                    if (!verdict.ok) {
                        return `[SYSTEM: message_agent_session refused — ${verdict.reason}. Nothing was sent.]`;
                    }

                    const target = await catalog!.getSession(targetId).catch(() => null);
                    if (target && ["failed", "terminated"].includes(String(target.state))) {
                        return `[SYSTEM: message_agent_session failed — session ${targetId.slice(0, 8)} is ${target.state} and cannot accept messages.]`;
                    }

                    const sdkClient = await getInlineClient();
                    await (sdkClient as any)._getDuroxideClient().enqueueEvent(
                        `session-${targetId}`,
                        "messages",
                        JSON.stringify({ prompt: message }),
                    );
                    return `[SYSTEM: delivered to ${targetId} as a user message. `
                        + `It runs on its own schedule — read_session_info / read_agent_events to see what it did.]`;
                } catch (error: any) {
                    return `[SYSTEM: message_agent_session failed — ${error?.message || String(error)}]`;
                }
            },

            /**
             * complete / cancel / delete a session the caller is entitled to.
             *
             * The existing complete_agent / cancel_agent / delete_agent tools
             * resolve through `resolveManagedChild`, so they only ever reach
             * the caller's OWN children — a manager could create a top-level
             * test session and then had no way to clean it up. Same authority
             * rule as messaging (owner-or-admin), plus a hard refusal on
             * system sessions for every principal.
             *
             * The command shapes mirror the sub-agent tools exactly (`done`,
             * `cancel`, `delete`), so a session ends the same way regardless
             * of which surface asked.
             */
            manageAgentSession: async (args: { session_id: string; action: string; reason?: string }) => {
                try {
                    const targetId = String(args.session_id || "").trim();
                    const action = String(args.action || "").trim().toLowerCase();
                    if (!targetId) return "Error: session_id is required.";
                    if (!["complete", "cancel", "delete"].includes(action)) {
                        return `Error: action must be one of complete, cancel, delete (got "${action}").`;
                    }
                    if (targetId === input.sessionId) {
                        return `[SYSTEM: manage_agent_session refused — that is THIS session. Ending your own session from inside a turn is not supported; finish the turn instead.]`;
                    }

                    const verdict = await canDriveSession(targetId, { refuseSystem: true });
                    if (!verdict.ok) {
                        return `[SYSTEM: manage_agent_session refused — ${verdict.reason}. Nothing was changed.]`;
                    }

                    const target = await catalog!.getSession(targetId).catch(() => null);
                    const sdkClient = await getInlineClient();
                    const reason = args.reason ?? `${action} requested by agent-manager`;

                    if (action === "delete") {
                        // A terminal session has no live orchestration to ask,
                        // so the row is removed directly — mirroring
                        // deleteAgent rather than inventing a second rule.
                        if (target && ["completed", "failed", "cancelled", "terminated"].includes(String(target.state))) {
                            await sdkClient.deleteSession(targetId);
                            return `[SYSTEM: session ${targetId.slice(0, 8)} was already ${target.state} and has been deleted. Reason: ${reason}]`;
                        }
                        await sdkClient._getDuroxideClient().enqueueEvent(
                            `session-${targetId}`,
                            "messages",
                            JSON.stringify({ type: "cmd", cmd: "delete", id: `delete-mgr-${Date.now()}`, args: { reason } }),
                        );
                        return `[SYSTEM: graceful deletion requested for ${targetId}. It cancels its descendants first, then deletes itself. Poll read_session_info to confirm. Reason: ${reason}]`;
                    }

                    const cmd = action === "complete" ? "done" : "cancel";
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        `session-${targetId}`,
                        "messages",
                        JSON.stringify({ type: "cmd", cmd, id: `${cmd}-mgr-${Date.now()}`, args: { reason } }),
                    );
                    return `[SYSTEM: ${action} requested for ${targetId}. It settles on its own schedule — poll read_session_info to confirm. Reason: ${reason}]`;
                } catch (error: any) {
                    return `[SYSTEM: manage_agent_session failed — ${error?.message || String(error)}]`;
                }
            },

            /**
             * Create a TOP-LEVEL session — the Agent Manager's test loop (§7).
             *
             * `spawn_agent` can only ever produce a child, so a manager could
             * not verify a published agent the way a user actually runs it:
             * as a root session, with no parent transcript above it and no
             * sub-agent preamble injected into its system message. Those
             * differences are exactly what a verification run needs to be free
             * of, which is why this is a separate capability rather than a
             * flag on spawn.
             *
             * IDEMPOTENCY. This runs inline inside the `runTurn` activity, so
             * a turn that crashes after the create and is retried would
             * otherwise create a SECOND root session — and unlike a child, a
             * stray root is not reaped with its parent. The session id is
             * therefore derived deterministically from (manager session,
             * agent, key), and an existing live session with that id is
             * reused rather than duplicated. This is the same trick
             * spawnChildSession already uses for deterministic system
             * children.
             */
            createAgentSession: async (args: {
                agent_name: string;
                prompt?: string;
                title?: string;
                model?: string;
                reasoning_effort?: import("./model-providers.js").ReasoningEffort;
                test_of?: string;
                key?: string;
            }) => {
                try {
                    const agentName = String(args.agent_name || "").trim();
                    if (!agentName) return "Error: agent_name is required.";

                    const agentDef = await resolveAgentConfigInline(agentName);
                    if (!agentDef) {
                        return `[SYSTEM: create_agent_session failed — agent "${agentName}" not found. Use list_agent_packages / ps_list_agents to see what is installed.]`;
                    }
                    // A worker-managed system agent is not a thing a user can
                    // run either, so it is not a valid verification target.
                    if (agentDef.system && agentDef.creatable === false) {
                        return `[SYSTEM: create_agent_session failed — "${agentName}" is a worker-managed system agent and cannot be created as a top-level session.]`;
                    }
                    if (args.model && !args.model.includes(":")) {
                        return `[SYSTEM: create_agent_session failed — model "${args.model}" is not allowed. Call list_available_models and use an exact provider:model value.]`;
                    }

                    // Owned by the MANAGER SESSION'S OWNER, never by "whoever
                    // the model named" — the same rule the viewer spine uses.
                    // An admin's manager therefore creates test sessions owned
                    // by the admin, not silently owned by the package's owner.
                    const owner = catalog
                        ? await resolveEffectiveSpawnOwner(
                            (id) => catalog!.getSession(id),
                            input.sessionId,
                        ).catch(() => null)
                        : null;

                    const slug = `agent-session:${agentName}:${String(args.key || "default")}`;
                    const newSessionId = systemChildAgentUUID(input.sessionId, slug);

                    if (catalog) {
                        const existing = await catalog.getSession(newSessionId).catch(() => null);
                        if (existing && !["completed", "failed", "terminated"].includes(existing.state)) {
                            return `[SYSTEM: create_agent_session reused the existing live session ${newSessionId} for ${agentName} (key="${String(args.key || "default")}"). Pass a different key to create another.]`;
                        }
                    }

                    const sdkClient = await getInlineClient();
                    const normalizedModel = args.model
                        ? await sessionManager.normalizeModelRefForSession(
                            input.sessionId, args.model, { requireQualified: true },
                        )
                        : undefined;

                    // No parentSessionId and nestingLevel 0 — that IS what
                    // makes this a root. The sub-agent preamble that
                    // spawnAgent builds is deliberately NOT applied.
                    const created = await sdkClient.createSession({
                        sessionId: newSessionId,
                        nestingLevel: 0,
                        ...(normalizedModel ? { model: normalizedModel } : {}),
                        ...(args.reasoning_effort ? { reasoningEffort: args.reasoning_effort } : {}),
                        boundAgentName: agentDef.name,
                        promptLayering: { kind: "app-agent" as const },
                        ...(agentDef.tools ? { toolNames: agentDef.tools } : {}),
                        agentId: agentDef.id ?? agentName,
                        ...(owner ? { owner } : {}),
                    });

                    if (catalog) {
                        const meta: Record<string, any> = {
                            agentId: agentDef.id ?? agentName,
                            title: typeof args.title === "string" && args.title.trim()
                                ? args.title.trim()
                                : `${agentDef.title || agentName}: ${newSessionId.slice(0, 8)}`,
                        };
                        if (agentDef.splash) meta.splash = agentDef.splash;
                        if (agentDef.splashMobile) meta.splashMobile = agentDef.splashMobile;
                        // `testOf` is what lets the sweeper reap verification
                        // sessions instead of leaving them to accumulate as
                        // ordinary top-level rows in the user's list.
                        if (args.test_of) meta.metadata = { testOf: String(args.test_of) };
                        await cmsRetryBestEffort(
                            `createAgentSession.updateSession meta session=${newSessionId}`,
                            () => catalog!.updateSession(newSessionId, meta),
                            (msg) => activityCtx.traceInfo(msg),
                        );
                    }

                    const bootstrap = typeof args.prompt === "string" && args.prompt.trim()
                        ? args.prompt.trim()
                        : (agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`);
                    // Stamp who actually wrote this. It goes onto the queue as a
                    // user-role prompt, and an unstamped user-role message is
                    // rendered from the READER's perspective — so the new
                    // session's transcript opened with the agent's own
                    // instructions under "You:", which no person had typed.
                    // `kind: "agent"` when a manager supplied the opening line,
                    // `kind: "system"` when it is the agent definition's own.
                    const bootstrapFromManager = typeof args.prompt === "string" && args.prompt.trim().length > 0;
                    await created.send(bootstrap, {
                        ...initialAgentTurnOptions(agentDef.initialRequiredTool),
                        sender: bootstrapFromManager
                            ? { kind: "agent", sessionId: input.sessionId, display: `${runConfig.agentIdentity || "agent"} · opening message` }
                            : { kind: "system", display: `${agentName} kickoff` },
                    });

                    return `[SYSTEM: created top-level session ${newSessionId} running "${agentName}"`
                        + `${args.test_of ? ` (testOf: ${args.test_of})` : ""}. `
                        + `It is a ROOT session owned by this session's owner — it is not your child, so it will not report back to you. `
                        + `Watch it with read_session_info / read_agent_events on ${newSessionId}.]`;
                } catch (error: any) {
                    return `[SYSTEM: create_agent_session failed — ${error?.message || String(error)}]`;
                }
            },

            spawnAgent: async (args: {
                agent_name?: string;
                task?: string;
                model?: string;
                reasoning_effort?: import("./model-providers.js").ReasoningEffort;
                system_message?: string;
                tool_names?: string[];
                title?: string;
                contract?: Record<string, unknown>;
            }) => {
                try {
                    const childNestingLevel = (input.nestingLevel ?? 0) + 1;
                    if (childNestingLevel > MAX_NESTING_LEVEL) {
                        return `[SYSTEM: spawn_agent failed — you are already at nesting level ${input.nestingLevel ?? 0} (max ${MAX_NESTING_LEVEL}). ` +
                            `Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]`;
                    }

                    const existingChildren = (await loadDirectChildSessions()).filter(child => !child.isSystem);
                    const activeCount = existingChildren.filter(child => child.status === "running").length;
                    if (activeCount >= MAX_SUB_AGENTS) {
                        return `[SYSTEM: spawn_agent failed — you already have ${activeCount} running sub-agents (max ${MAX_SUB_AGENTS}). ` +
                            `Wait for some to complete before spawning more.]`;
                    }

                    let agentTask = args.task || "";
                    let agentSystemMessage = args.system_message;
                    let agentToolNames = args.tool_names;
                    let agentModel = args.model;
                    let agentReasoningEffort = args.reasoning_effort;
                    let agentIsSystem = false;
                    const explicitAgentTitle = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
                    let agentTitle: string | undefined = explicitAgentTitle;
                    let agentTitleIsExplicit = Boolean(explicitAgentTitle);
                    let agentId: string | undefined;
                    let agentSplash: string | undefined;
                    let agentSplashMobile: string | undefined;
                    let agentInitialRequiredTool: string | undefined;
                    let boundAgentName: string | undefined;
                    let promptLayeringKind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" | undefined;
                    let resolvedAgentName = args.agent_name;

                    const applyAgentDef = (agentDef: any, useDefinitionDefaults = false) => {
                        agentTask = useDefinitionDefaults
                            ? (agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`)
                            : (args.task || agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`);
                        agentSystemMessage = useDefinitionDefaults ? undefined : args.system_message;
                        agentToolNames = useDefinitionDefaults
                            ? (agentDef.tools ?? undefined)
                            : (args.tool_names ?? agentDef.tools ?? undefined);
                        agentIsSystem = agentDef.system ?? false;
                        if (!agentTitleIsExplicit) agentTitle = agentDef.title;
                        agentId = agentDef.id ?? resolvedAgentName;
                        agentSplash = agentDef.splash;
                        agentSplashMobile = agentDef.splashMobile;
                        agentInitialRequiredTool = agentDef.initialRequiredTool;
                        boundAgentName = agentDef.name;
                        promptLayeringKind = agentDef.promptLayerKind
                            ?? (agentDef.system
                                ? ((agentDef.namespace || "pilotswarm") === "pilotswarm"
                                    ? "pilotswarm-system-agent"
                                    : "app-system-agent")
                                : "app-agent");
                    };

                    if (resolvedAgentName) {
                        const agentDef = await resolveAgentConfigInline(resolvedAgentName);
                        if (!agentDef) {
                            return `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" not found. Use ps_list_agents to see available agents.]`;
                        }
                        if (agentDef.system && agentDef.creatable === false) {
                            return `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" is a worker-managed system agent and cannot be spawned from a session. ` +
                                `If it is missing, the workers likely need to be restarted.]`;
                        }
                        applyAgentDef(agentDef, resolvedAgentName !== args.agent_name);
                    }

                    // Spawned children inherit the parent lineage's EFFECTIVE
                    // owner instead of any system flag: the nearest owned
                    // ancestor's user, or — when the lineage is system (system
                    // sessions are ownerless by design) — the concrete SYSTEM
                    // user principal. Owning the child by the System user lets
                    // it resolve the admin-stored System GitHub Copilot key
                    // through the ordinary per-owner credential path while
                    // staying a normal, deletable, manageable session
                    // (deliberately NOT is_system — that flag blocks deletion
                    // and pins it into the system tree). Read via the
                    // authoritative CMS rows, not in-memory flags, so it
                    // survives worker restarts.
                    let inheritedOwner: import("./cms.js").UserPrincipal | null = null;
                    if (catalog) {
                        inheritedOwner = await resolveEffectiveSpawnOwner(
                            (id) => catalog!.getSession(id),
                            input.sessionId,
                        ).catch(() => null);
                    }

                    if (agentModel && !agentModel.includes(":")) {
                        return `[SYSTEM: spawn_agent failed — model "${agentModel}" is not allowed. ` +
                            `When overriding a sub-agent model, first call list_available_models and then use the exact provider:model value from that list. ` +
                            `If you are unsure, omit model so the sub-agent inherits your current model.]`;
                    }

                    // v1.0.49: same-name duplicate spawns are allowed. The
                    // global MAX_SUB_AGENTS cap and per-spawn nesting limit
                    // still apply. The parent is responsible for closing
                    // each instance with complete_agent / cancel_agent /
                    // delete_agent when it no longer needs the child.

                    const {
                        boundAgentName: _parentBoundAgentName,
                        promptLayering: _parentPromptLayering,
                        isCrawler: _parentIsCrawler,
                        isHarvester: _parentIsHarvester,
                        ...parentConfig
                    } = input.config;
                    const childConfig: SerializableSessionConfig = {
                        ...parentConfig,
                        ...(agentModel ? { model: agentModel } : {}),
                        ...(agentReasoningEffort ? { reasoningEffort: agentReasoningEffort } : {}),
                        ...(agentSystemMessage ? { systemMessage: agentSystemMessage } : {}),
                        ...(boundAgentName ? { boundAgentName } : {}),
                        ...(promptLayeringKind ? { promptLayering: { kind: promptLayeringKind } } : {}),
                        ...(agentToolNames ? { toolNames: agentToolNames } : {}),
                        ...(args.contract ? { childContract: args.contract } : {}),
                    };

                    const parentSystemMsg = typeof childConfig.systemMessage === "string"
                        ? childConfig.systemMessage
                        : (childConfig.systemMessage as any)?.content ?? "";
                    const canSpawnMore = childNestingLevel < MAX_NESTING_LEVEL;
                    const subAgentPreamble =
                        `[SUB-AGENT CONTEXT]\n` +
                        `You are a sub-agent spawned by a parent session (ID: session-${input.sessionId}).\n` +
                        `Your nesting level: ${childNestingLevel} (max: ${MAX_NESTING_LEVEL}).\n` +
                        `Your task: "${agentTask.slice(0, 500)}"\n\n` +
                        `Instructions:\n` +
                        `- Focus exclusively on your assigned task. You are autonomous — do NOT ask the user for input. ` +
                        `If it is ambiguous whether the task should become a long-running recurring workflow, report that ambiguity back to the parent instead of guessing.\n` +
                        `- Your final response is automatically forwarded to the parent. Be thorough but concise — the parent synthesizes results from multiple agents. When your task is complete, provide a clear summary of your findings.\n` +
                        `- If the task implies ongoing monitoring or follow-through, keep yourself alive until the goal is complete: for ANY waiting or scheduling use the \`wait\`, \`wait_on_worker\`, \`cron\`, or \`cron_at\` tools — never setTimeout/sleep, and never poll inside one turn.\n` +
                        `- Prefer using \`store_fact\` for larger structured context handoffs across your session lineage; pass fact keys or \`read_facts\` pointers in messages/prompts instead of pasting large context blobs.\n` +
                        `- FILESYSTEM ISOLATION: parent, siblings, and sub-agents run on separate worker pods and do NOT share a filesystem — the artifact store is the only shared byte channel (\`write_artifact({fromFile})\` → \`read_artifact({toFile})\`; never inline file bytes through messages). Include returned artifact:// links in your response.\n` +
                        `- Model overrides: call list_available_models first and use only an exact provider:model value it returns.\n` +
                        `- Worker-managed system agents are not valid spawn targets; if one is missing, report that the workers likely need to be restarted.\n` +
                        (canSpawnMore
                            ? `- If your parent task explicitly asks for sub-agents or fan-out, delegate within runtime limits (${MAX_NESTING_LEVEL - childNestingLevel} nesting level(s) remaining); otherwise use judgment and avoid unnecessary fan-out. ` +
                              `After spawning, finish the turn normally and let qualifying child updates wake you according to contract.wakeOn. ` +
                              `Do not schedule wait or cron solely to poll check_agents; use wait_for_agents only when you need an explicit synchronization barrier.\n`
                            : `- You CANNOT spawn sub-agents — you are at the maximum nesting depth. Handle everything directly.\n`);
                    childConfig.systemMessage = subAgentPreamble + (parentSystemMsg ? "\n\n" + parentSystemMsg : "");

                    const sdkClient = await getInlineClient();
                    const normalizedModel = childConfig.model
                        ? await sessionManager.normalizeModelRefForSession(
                            input.sessionId,
                            childConfig.model,
                            { requireQualified: Boolean(agentModel) },
                        )
                        : undefined;
                    if (normalizedModel) childConfig.model = normalizedModel;

                    const childSession = await sdkClient.createSession({
                        parentSessionId: input.sessionId,
                        nestingLevel: childNestingLevel,
                        ...childModelCreationOptions(childConfig),
                        systemMessage: childConfig.systemMessage,
                        boundAgentName: childConfig.boundAgentName,
                        promptLayering: childConfig.promptLayering,
                        toolNames: childConfig.toolNames,
                        waitThreshold: childConfig.waitThreshold,
                        agentId,
                        // Explicit owner takes the cms_set_session_owner path
                        // (lazily registering the user row); when null, the CMS
                        // falls back to copying the direct parent's owner row.
                        ...(inheritedOwner ? { owner: inheritedOwner } : {}),
                    });

                    if (catalog) {
                        const meta: Record<string, any> = {};
                        if (agentTitle) {
                            meta.title = (agentTitleIsExplicit || agentIsSystem)
                                ? agentTitle
                                : `${agentTitle}: ${childSession.sessionId.slice(0, 8)}`;
                        }
                        if (agentId) meta.agentId = agentId;
                        if (agentSplash) meta.splash = agentSplash;
                        if (agentSplashMobile) meta.splashMobile = agentSplashMobile;
                        if (Object.keys(meta).length > 0) {
                            // Best-effort: child has been created and is about to be
                            // sent its bootstrap. A failed meta update means the row
                            // is missing title/agentId/splash, not that the spawn
                            // failed. Don't escalate to a thrown spawn_agent.
                            const capturedMeta = meta;
                            await cmsRetryBestEffort(
                                `runTurn.spawn.updateSession meta session=${childSession.sessionId}`,
                                () => catalog!.updateSession(childSession.sessionId, capturedMeta),
                                (msg) => activityCtx.traceInfo(msg),
                            );
                        }

                        const contractJson = buildContractJson(args.contract, input.sessionId, childSession.sessionId);
                        if (contractJson) {
                            await cmsRetryCritical(
                                `runTurn.spawn.upsertChildOutcome contract child=${childSession.sessionId}`,
                                () => catalog!.upsertChildOutcome({
                                    childSessionId: childSession.sessionId,
                                    parentSessionId: input.sessionId,
                                    contractJson,
                                }),
                                (msg) => activityCtx.traceInfo(msg),
                            );
                        }
                    }

                    // Stamped: a spawned child's opening task is written by
                    // THIS agent, not by whoever later reads the child's
                    // transcript. Unstamped it renders as their own "You:".
                    await childSession.send(agentTask, {
                        ...initialAgentTurnOptions(agentInitialRequiredTool),
                        sender: { kind: "agent", sessionId: input.sessionId, display: `${runConfig.agentIdentity || "agent"} · task` },
                    });

                    if (catalog) {
                        await cmsRetryBestEffort(
                            `runTurn.spawn.recordEvent agent_spawned session=${input.sessionId}`,
                            () => catalog!.recordEvents(input.sessionId, [{
                                eventType: "session.agent_spawned",
                                data: { childSessionId: childSession.sessionId, agentId: agentId || undefined, task: agentTask.slice(0, 500) },
                            }], workerNodeId),
                            (msg) => activityCtx.traceInfo(msg),
                        );
                    }

                    const childOrchId = `session-${childSession.sessionId}`;
                    return `[SYSTEM: Sub-agent spawned successfully.\n` +
                        `  Agent ID: ${childOrchId}\n` +
                        `  ${resolvedAgentName ? `Agent: ${resolvedAgentName}\n  ` : ``}Task: "${agentTask.slice(0, 200)}"\n` +
                        `  The agent is now running autonomously. Continue your work in this SAME turn and keep following the user's remaining steps. ` +
                        `Do NOT stop just because the child started. If your plan says to pause, call wait or wait_for_agents explicitly. ` +
                        `You can also use check_agents to poll status, ` +
                        `or message_agent to send instructions.]`;
                } catch (err: any) {
                    return `[SYSTEM: spawn_agent failed: ${err?.message || String(err)}]`;
                }
            },
            setSessionModel: async (args: { model: string; reasoning_effort?: import("./model-providers.js").ReasoningEffort | null }) => {
                try {
                    const requestedModel = String(args.model || "").trim();
                    if (!requestedModel) return "[SYSTEM: set_session_model failed: model is required.]";
                    if (!storeUrl) return "[SYSTEM: set_session_model failed: no storeUrl is configured.]";
                    const resolved = await sessionManager.resolveModelSwitchConfigForSession(
                        input.sessionId,
                        requestedModel,
                        "reasoning_effort" in args ? args.reasoning_effort ?? null : undefined,
                    );

                    const sdkClient = new PilotSwarmClient(internalClientConfig());
                    try {
                        await sdkClient.start();
                        await (sdkClient as any).duroxideClient.enqueueEvent(
                            `session-${input.sessionId}`,
                            "messages",
                            JSON.stringify({
                                type: "cmd",
                                cmd: "set_model",
                                id: `set-model-tool-${randomUUID()}`,
                                args: {
                                    model: resolved.model,
                                    reasoningEffort: resolved.reasoningEffort,
                                    source: "tool",
                                },
                            }),
                        );
                    } finally {
                        await sdkClient.stop().catch(() => {});
                    }

                    const effortText = resolved.reasoningEffort ? `:${resolved.reasoningEffort}` : "";
                    return `[SYSTEM: Model switch accepted. Stop this turn now; the runtime will automatically continue on ${resolved.model}${effortText}.]`;
                } catch (err: any) {
                    return `[SYSTEM: set_session_model failed: ${err?.message || String(err)}]`;
                }
            },
            regenerateContext: async (args: { handoff?: string; instructions?: string }) => {
                try {
                    if (!storeUrl) return "[SYSTEM: regenerate_context failed: no storeUrl is configured.]";
                    const sdkClient = new PilotSwarmClient(internalClientConfig());
                    try {
                        await sdkClient.start();
                        await (sdkClient as any).duroxideClient.enqueueEvent(
                            `session-${input.sessionId}`,
                            "messages",
                            JSON.stringify({
                                type: "cmd",
                                cmd: "regenerate",
                                id: `regenerate-tool-${randomUUID()}`,
                                args: {
                                    ...(args.handoff ? { handoff: String(args.handoff).slice(0, 4_000) } : {}),
                                    ...(args.instructions ? { instructions: String(args.instructions).slice(0, 4_000) } : {}),
                                    source: "tool",
                                },
                                // Owner-gate evidence: the runTurn activity input's
                                // authoritative sender, stamped server-side — the
                                // cmd handler refuses non-owner turns on shared
                                // sessions. Never an LLM-supplied value.
                                ...((input as any).sender ? { sender: (input as any).sender } : {}),
                            }),
                        );
                    } finally {
                        await sdkClient.stop().catch(() => {});
                    }
                    return "[SYSTEM: Regeneration accepted. Finish this turn cleanly NOW — at the next boundary the runtime archives your transcript, distills a resume package, and rebuilds your context. Durable state (facts, artifacts, children, schedule) is untouched.]";
                } catch (err: any) {
                    return `[SYSTEM: regenerate_context failed: ${err?.message || String(err)}]`;
                }
            },
            regenerateAgent: async (args: { agent_id: string; handoff?: string; instructions?: string }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    const sdkClient = await getInlineClient();
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        child.orchId,
                        "messages",
                        JSON.stringify({
                            type: "cmd",
                            cmd: "regenerate",
                            id: `regenerate-parent-${randomUUID()}`,
                            args: {
                                ...(args.handoff ? { handoff: String(args.handoff).slice(0, 4_000) } : {}),
                                ...(args.instructions ? { instructions: String(args.instructions).slice(0, 4_000) } : {}),
                                source: "parent",
                            },
                            // Parent-of gate evidence: the child's handler accepts
                            // source "parent" only when this id equals its own
                            // carried parentSessionId.
                            requestedBy: input.sessionId,
                        }),
                    );
                    return `[SYSTEM: Regeneration requested for sub-agent ${child.orchId}. It applies at the child's next turn boundary; check_agents will reflect the rebirth. Continue your work in this SAME turn.]`;
                } catch (err: any) {
                    return `[SYSTEM: regenerate_agent failed: ${err?.message || String(err)}]`;
                }
            },
            messageAgent: async (args: { agent_id: string; message: string; contract_patch?: Record<string, unknown> }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    if (catalog && args.contract_patch) {
                        const existing = await catalog.getChildOutcome(child.sessionId);
                        const contractJson = appendContractPatchJson(existing?.contractJson ?? null, args.contract_patch, input.sessionId, child.sessionId);
                        if (contractJson) {
                            await cmsRetryCritical(
                                `runTurn.message.upsertChildOutcome contract child=${child.sessionId}`,
                                () => catalog!.upsertChildOutcome({
                                    childSessionId: child.sessionId,
                                    parentSessionId: input.sessionId,
                                    contractJson,
                                }),
                                (msg) => activityCtx.traceInfo(msg),
                            );
                        }
                    }
                    const sdkClient = await getInlineClient();
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        child.orchId,
                        "messages",
                        JSON.stringify({ prompt: args.message }),
                    );
                    return `[SYSTEM: Message sent to sub-agent ${child.orchId}: "${args.message.slice(0, 200)}". ` +
                        `Continue your work in this SAME turn. If you are waiting on the child, call wait_for_agents explicitly rather than stopping here.]`;
                } catch (err: any) {
                    return `[SYSTEM: message_agent failed: ${err?.message || String(err)}]`;
                }
            },
            checkAgents: async (args?: { full?: boolean }) => {
                // A DELTA report — see check-agents-report.ts for the why.
                // The memo of what this parent last saw is a CMS event, so it
                // survives a worker move and never touches orchestrator state.
                // Any failure to read it falls back to the full report.
                try {
                    const children = (await loadDirectChildSessions()).filter(child => !child.isSystem);
                    if (children.length === 0) {
                        return `[SYSTEM: No sub-agents have been spawned yet.]`;
                    }
                    let memo: CheckAgentsMemo | null = null;
                    if (!args?.full && catalog) {
                        try {
                            const recent = await catalog.getSessionEventsBefore(input.sessionId, Number.MAX_SAFE_INTEGER, 5, [CHECK_AGENTS_MEMO_EVENT]);
                            const latest = recent.reduce<any>((best, e) => (!best || e.seq > best.seq ? e : best), null);
                            memo = latest?.data && typeof latest.data === "object" ? latest.data as CheckAgentsMemo : null;
                        } catch {
                            memo = null;
                        }
                    }
                    const report = buildCheckAgentsReport(children, memo, { full: args?.full === true });
                    if (catalog) {
                        // Fire-and-forget: a lost memo only costs one extra full report next time.
                        void cmsRetryBestEffort(
                            `runTurn.checkAgents memo session=${input.sessionId}`,
                            () => catalog!.recordEvents(input.sessionId, [{
                                eventType: CHECK_AGENTS_MEMO_EVENT,
                                data: { at: new Date().toISOString(), perChild: report.perChild },
                            }]),
                            (msg) => activityCtx.traceInfo(msg),
                        ).catch(() => {});
                    }
                    return report.text;
                } catch (err: any) {
                    return `[SYSTEM: check_agents failed: ${err?.message || String(err)}]`;
                }
            },
            resolveWaitForAgents: async (agentIds?: string[]) => {
                const children = (await loadDirectChildSessions()).filter(child => !child.isSystem);
                if (agentIds && agentIds.length > 0) {
                    return await Promise.all(agentIds.map(async (agentId) => (await resolveManagedChild(agentId)).orchId));
                }
                const running = children.filter(child => child.status === "running").map(child => child.orchId);
                return running.length > 0 ? running : children.map(child => child.orchId);
            },
            listSessions: async (args?: { include_system?: boolean; owner_query?: string; owner_kind?: string; query?: string; session_id?: string; agent_id?: string; state?: string; parent_session_id?: string; group_id?: string; include_children?: boolean; updated_since?: string;  limit?: number }) => {
                try {
                    const sdkClient = await getInlineClient();
                    const effectiveArgs = sanitizeAutonomousSystemSessionFilters(args);
                    const limit = Math.max(1, Math.min(100, Number(effectiveArgs?.limit) || 50));
                    const query = String(effectiveArgs?.query || "").trim().toLowerCase();
                    const exactSessionId = String(effectiveArgs?.session_id || "").replace(/^session-/, "");
                    const agentId = String(effectiveArgs?.agent_id || "").trim();
                    const state = String(effectiveArgs?.state || "").trim().toLowerCase();
                    const parentSessionId = String(effectiveArgs?.parent_session_id || "").replace(/^session-/, "");
                    const groupFilterRaw = effectiveArgs?.group_id;
                    const groupFilter = typeof groupFilterRaw === "string" ? groupFilterRaw.trim() : undefined;
                    const includeChildren = effectiveArgs?.include_children === true;
                    const updatedSince = Date.parse(String(effectiveArgs?.updated_since || ""));
                    const sessions = (await sdkClient.listSessions()).filter((session: any) => matchesSessionOwnerFilters(session, {
                        includeSystem: effectiveArgs?.include_system === true,
                        ownerQuery: effectiveArgs?.owner_query,
                        ownerKind: effectiveArgs?.owner_kind,
                    })).filter((session: any) => {
                        if (!includeChildren && session.parentSessionId) return false;
                        if (exactSessionId && session.sessionId !== exactSessionId) return false;
                        if (agentId && session.agentId !== agentId) return false;
                        if (state && String(session.status || "").toLowerCase() !== state) return false;
                        if (parentSessionId && session.parentSessionId !== parentSessionId) return false;
                        if (groupFilter === "null" && session.viewerGroupId) return false;
                        if (groupFilter && groupFilter !== "null" && session.viewerGroupId !== groupFilter) return false;
                        if (Number.isFinite(updatedSince)) {
                            const updatedAt = Date.parse(session.updatedAt || session.lastActiveAt || session.createdAt || "");
                            if (!Number.isFinite(updatedAt) || updatedAt < updatedSince) return false;
                        }
                        if (query) {
                            const haystack = [
                                session.sessionId,
                                session.title,
                                session.agentId,
                                formatSessionOwnerLabel(session),
                            ].map((part) => String(part || "").toLowerCase()).join(" ");
                            if (!haystack.includes(query)) return false;
                        }
                        return true;
                    }).slice(0, limit);
                    if (sessions.length === 0) {
                        return "[SYSTEM: Active sessions (0). No sessions matched the requested filters.]";
                    }
                    const lines = sessions.map((s: any) =>
                        `  - ${s.sessionId}${s.sessionId === input.sessionId ? " (this session)" : ""}\n` +
                        `    Title: ${s.title ?? "(untitled)"}\n` +
                        `    Owner: ${formatSessionOwnerLabel(s)}\n` +
                        `    Agent: ${s.agentId ?? "generic"}\n` +
                        `    Group: ${s.viewerGroupId ?? "none"}\n` +
                        `    Status: ${s.status}, Iterations: ${s.iterations ?? 0}\n` +
                        `    Parent: ${s.parentSessionId ?? "none"}`
                    );
                    return `[SYSTEM: Active sessions (${sessions.length}):\n${lines.join("\n")}]`;
                } catch (err: any) {
                    return `[SYSTEM: list_sessions failed: ${err?.message || String(err)}]`;
                }
            },
            sendSessionMessage: async (args: { session_id: string; subject: string; body: string; reason?: string; expects_response?: boolean; expires_at?: string }) => {
                try {
                    if (isReadOnlyTuner()) return `[SYSTEM: send_session_message is disabled for read-only agent-tuner sessions.]`;
                    const targetSessionId = String(args.session_id || "").replace(/^session-/, "");
                    if (!targetSessionId) return `[SYSTEM: send_session_message failed: session_id is required.]`;
                    if (targetSessionId === input.sessionId) return `[SYSTEM: send_session_message failed: target session is this session.]`;
                    if (!args.subject?.trim() || !args.body?.trim()) return `[SYSTEM: send_session_message failed: subject and body are required.]`;
                    if (args.body.length > 8192) return `[SYSTEM: send_session_message failed: body exceeds 8 KB.]`;
                    if (!catalog) return `[SYSTEM: send_session_message failed: CMS catalog is unavailable.]`;
                    const sdkClient = await getInlineClient();
                    const allowedReasons = new Set(["help", "guidance", "fact-request", "status-request", "handoff"]);
                    const reason = allowedReasons.has(String(args.reason || "")) ? args.reason as any : undefined;
                    const { requestId } = await sendInternalSessionMessage({
                        catalog,
                        duroxideClient: sdkClient._getDuroxideClient(),
                    }, {
                        fromSessionId: input.sessionId,
                        toSessionId: targetSessionId,
                        subject: args.subject,
                        body: args.body,
                        reason,
                        expectsResponse: args.expects_response === true,
                        expiresAt: args.expires_at,
                    });
                    return `[SYSTEM: Cross-session message queued. Request ID: ${requestId}. Target: session-${targetSessionId}.]`;
                } catch (err: any) {
                    return `[SYSTEM: send_session_message failed: ${err?.message || String(err)}]`;
                }
            },
            replySessionMessage: async (args: { request_id: string; session_id: string; body: string; verdict?: string }) => {
                try {
                    if (isReadOnlyTuner()) return `[SYSTEM: reply_session_message is disabled for read-only agent-tuner sessions.]`;
                    const targetSessionId = String(args.session_id || "").replace(/^session-/, "");
                    if (!targetSessionId || !args.request_id || !args.body?.trim()) return `[SYSTEM: reply_session_message failed: request_id, session_id, and body are required.]`;
                    if (!catalog) return `[SYSTEM: reply_session_message failed: CMS catalog is unavailable.]`;
                    const sdkClient = await getInlineClient();
                    const allowedVerdicts = new Set(["answered", "declined", "blocked", "stale"]);
                    const verdict = allowedVerdicts.has(String(args.verdict || "")) ? args.verdict as any : "answered";
                    await replyInternalSessionMessage({
                        catalog,
                        duroxideClient: sdkClient._getDuroxideClient(),
                    }, {
                        requestId: args.request_id,
                        fromSessionId: input.sessionId,
                        toSessionId: targetSessionId,
                        verdict,
                        body: args.body,
                    });
                    return `[SYSTEM: Cross-session reply queued for request ${args.request_id}. Target: session-${targetSessionId}.]`;
                } catch (err: any) {
                    return `[SYSTEM: reply_session_message failed: ${err?.message || String(err)}]`;
                }
            },
            completeAgent: async (args: { agent_id: string; result?: Record<string, unknown> }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    let builtOutcome: ReturnType<typeof buildResultJson> | null = null;
                    if (catalog) {
                        const existing = await catalog.getChildOutcome(child.sessionId).catch(() => null);
                        const hasExistingResult = Boolean(normalizeJsonObject(existing?.resultJson?.current));
                        if (args.result || (existing?.contractJson && !hasExistingResult)) {
                            builtOutcome = buildResultJson(args.result, child, existing?.contractJson ?? null, existing?.resultJson ?? null, "success", "completed_without_result");
                        }
                        if (builtOutcome?.strictBlocked) {
                            return `[SYSTEM: complete_agent blocked by strict contract validation for ${child.orchId}: ${builtOutcome.violations.map(v => v.message || v.code).join("; ")}]`;
                        }
                    }
                    if (catalog && builtOutcome) {
                        await cmsRetryCritical(
                            `runTurn.complete.upsertChildOutcome result child=${child.sessionId}`,
                            () => catalog!.upsertChildOutcome({
                                childSessionId: child.sessionId,
                                parentSessionId: input.sessionId,
                                resultJson: builtOutcome!.resultJson,
                                verdict: builtOutcome!.verdict,
                                summary: builtOutcome!.summary,
                                completedAt: new Date(),
                            }),
                            (msg) => activityCtx.traceInfo(msg),
                        );
                    }
                    const sdkClient = await getInlineClient();
                    const cmdId = `done-inline-${Date.now()}`;
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        child.orchId,
                        "messages",
                        JSON.stringify({ type: "cmd", cmd: "done", id: cmdId, args: { reason: "Completed by parent" } }),
                    );
                    return `[SYSTEM: Graceful completion requested for sub-agent ${child.orchId}. ` +
                        `Use check_agents or wait_for_agents to observe final completion.]`;
                } catch (err: any) {
                    return `[SYSTEM: complete_agent failed: ${err?.message || String(err)}]`;
                }
            },
            cancelAgent: async (args: { agent_id: string; reason?: string; partial_result?: Record<string, unknown> }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    let builtOutcome: ReturnType<typeof buildResultJson> | null = null;
                    if (catalog) {
                        const existing = await catalog.getChildOutcome(child.sessionId).catch(() => null);
                        const hasExistingResult = Boolean(normalizeJsonObject(existing?.resultJson?.current));
                        if (args.partial_result || (existing?.contractJson && !hasExistingResult)) {
                            builtOutcome = buildResultJson(args.partial_result, child, existing?.contractJson ?? null, existing?.resultJson ?? null, "cancelled", "completed_without_result");
                        }
                    }
                    if (catalog && builtOutcome) {
                        await cmsRetryCritical(
                            `runTurn.cancel.upsertChildOutcome partial child=${child.sessionId}`,
                            () => catalog!.upsertChildOutcome({
                                childSessionId: child.sessionId,
                                parentSessionId: input.sessionId,
                                resultJson: builtOutcome!.resultJson,
                                verdict: builtOutcome!.verdict,
                                summary: builtOutcome!.summary,
                                completedAt: new Date(),
                            }),
                            (msg) => activityCtx.traceInfo(msg),
                        );
                    }
                    const sdkClient = await getInlineClient();
                    const cmdId = `cancel-inline-${Date.now()}`;
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        child.orchId,
                        "messages",
                        JSON.stringify({ type: "cmd", cmd: "cancel", id: cmdId, args: { reason: args.reason ?? "Cancelled by parent" } }),
                    );
                    return `[SYSTEM: Graceful cancellation requested for sub-agent ${child.orchId}. ` +
                        `Use check_agents or wait_for_agents to observe final termination.${args.reason ? ` Reason: ${args.reason}` : ""}]`;
                } catch (err: any) {
                    return `[SYSTEM: cancel_agent failed: ${err?.message || String(err)}]`;
                }
            },
            deleteAgent: async (args: { agent_id: string; reason?: string }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    const sdkClient = await getInlineClient();
                    if (child.status === "completed" || child.status === "failed" || child.status === "cancelled") {
                        await sdkClient.deleteSession(child.sessionId);
                        return `[SYSTEM: Sub-agent ${child.orchId} has been deleted.${args.reason ? ` Reason: ${args.reason}` : ""}]`;
                    }
                    const cmdId = `delete-inline-${Date.now()}`;
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        child.orchId,
                        "messages",
                        JSON.stringify({ type: "cmd", cmd: "delete", id: cmdId, args: { reason: args.reason ?? "Deleted by parent" } }),
                    );
                    return `[SYSTEM: Graceful deletion requested for sub-agent ${child.orchId}. ` +
                        `It will cancel its descendants first and then delete itself.${args.reason ? ` Reason: ${args.reason}` : ""}]`;
                } catch (err: any) {
                    return `[SYSTEM: delete_agent failed: ${err?.message || String(err)}]`;
                }
            },
            // ── Canvas (root sessions only) ─────────────────────────────
            //
            // Three layers of the root gate, because they fail differently:
            // the DECLARATION is filtered off child sessions in
            // session-manager (catalog row's parentSessionId); the bridge
            // methods are absent when THIS execution knows its parent
            // (input.parentSessionId — absent on frozen pre-1.0.32
            // orchestration versions, hence the third layer); and each method
            // re-checks the catalog row itself, which is the authority.
            //
            // ATOMICITY: drawCanvas persists the canvas_updated event HERE,
            // awaited, immediately after the byte write — derive, write, and
            // record happen inside one serialized section, so parallel tool
            // calls in one assistant message cannot mint duplicate revs.
            // session-proxy's generic onEvent persister treats
            // canvas_updated as already-persisted (see EPHEMERAL_TYPES); the
            // handler's opts.onEvent emit is the live-push half only.
            // Every session gets the canvas bridge — root, sub-agent, and
            // sub-sub-agent alike. Each draws its OWN canvases; there is no
            // cross-session canvas access here, so a child cannot touch its
            // parent's surface any more than a stranger's.
            ...({
                drawCanvas: async (args: { html?: string; fromArtifact?: { sessionId?: string; filename: string; expectedSha256?: string }; note?: string; responseContract?: Record<string, any>; slot?: number; name?: string; session_id?: string }) => {
                    if (!artifactStore) return { error: "this worker has no artifact store" };
                    if (!catalog) return { error: "canvas requires the CMS catalog" };
                    const slot = normalizeCanvasSlot(args.slot);
                    if (slot === null) return { error: "slot must be an integer 1-5" };
                    const rawName = args.name === undefined ? undefined : String(args.name).trim();
                    if (rawName !== undefined && rawName.length > 60) {
                        return { error: "name must be 60 characters or fewer" };
                    }
                    const resolved = await resolveCanvasTarget(args.session_id);
                    if ("error" in resolved) return { error: resolved.error };
                    const { target, crossSession } = resolved;
                    const run = canvasDrawChain.then(async () => {
                        // Source resolution. fromArtifact pulls bytes store-side —
                        // the same trust stance as read_artifact/write_artifact's
                        // cross-session paths (the artifact layer is worker-trusted);
                        // the model never carries the document.
                        let html: string;
                        let source: { kind: "artifact"; sessionId: string; filename: string; sha256: string } | undefined;
                        if (args.fromArtifact) {
                            const from = args.fromArtifact;
                            const sourceSessionId = String(from.sessionId || input.sessionId);
                            const filename = String(from.filename || "");
                            let text: string;
                            try {
                                text = await artifactStore.downloadArtifactText(sourceSessionId, filename);
                            } catch (err: any) {
                                return { error: `could not read artifact ${filename} from session ${sourceSessionId}: ${err?.message || String(err)}` };
                            }
                            const fetchedBytes = Buffer.byteLength(text, "utf8");
                            if (fetchedBytes > 900_000) {
                                return { error: `artifact ${filename} is ${fetchedBytes} bytes; the canvas cap is 900 KB` };
                            }
                            const sha256 = nodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
                            if (from.expectedSha256 && sha256 !== from.expectedSha256) {
                                return { error: `SHA_MISMATCH: artifact ${filename} hashes ${sha256}, expected ${from.expectedSha256}; nothing was drawn` };
                            }
                            if (!text.trim()) {
                                return { error: `artifact ${filename} is empty; to clear the canvas pass html: ""` };
                            }
                            html = text;
                            source = { kind: "artifact", sessionId: sourceSessionId, filename, sha256 };
                        } else {
                            html = String(args.html ?? "");
                        }
                        // Interface card: extract the embedded manifest, resolve the
                        // EFFECTIVE contract (explicit argument wins; else the
                        // manifest's, revalidated by the same normalizer; an invalid
                        // embedded contract with no explicit override fails the draw
                        // closed rather than arming nothing silently).
                        const extraction = html ? extractCanvasAppManifest(html) : { manifest: null };
                        let effectiveContract = args.responseContract;
                        let manifestWarning: string | undefined;
                        if (!effectiveContract && html) {
                            if (extraction.error && !args.fromArtifact) {
                                // Inline draw with a broken manifest attempt: tolerate —
                                // the author is iterating live and passed no contract —
                                // but SAY SO, or they first learn at reuse time when the
                                // fromArtifact draw fails closed.
                                manifestWarning = `CANVAS-APP-MANIFEST attempt is broken (${extraction.error}); drawn without it — fix the comment before saving this as an app.`;
                            } else if (extraction.error) {
                                return { error: `the artifact's CANVAS-APP-MANIFEST is broken: ${extraction.error}. Fix the stored app or pass an explicit responseContract.` };
                            }
                            if (extraction.manifest?.responseContract !== undefined) {
                                const normalized = normalizeCanvasResponseContract(extraction.manifest.responseContract);
                                if (normalized.error) {
                                    return { error: `the embedded CANVAS-APP-MANIFEST contract is invalid: ${normalized.error}. Fix the stored app or pass an explicit responseContract.` };
                                }
                                effectiveContract = normalized.contract;
                            }
                        }
                        const app = canvasAppCard(extraction.manifest);
                        const note = args.note ? String(args.note) : undefined;
                        // Atomic rev mint (multi-writer safe), AFTER every
                        // validation refusal above: the mint writes latest_rev
                        // into the 0045 cache, and a rev minted for a draw
                        // that then failed validation would unlock ticks on an
                        // empty slot (latestCanvasRev is table-first). The
                        // seed from the table/event read floors legacy
                        // sessions whose cache row never landed. Residual
                        // window: an upload/record failure AFTER the mint
                        // burns a phantom rev — infra-failure only, and the
                        // next successful draw overwrites it; read_canvas
                        // stays honest because it is log-first.
                        const seedRev = await latestCanvasRev(catalog, target, slot);
                        const rev = typeof (catalog as any).mintCanvasRev === "function"
                            ? await (catalog as any).mintCanvasRev(target, slot, seedRev)
                            : seedRev + 1;
                        await artifactStore.uploadArtifact(
                            target, canvasArtifactFilename(slot), html, "text/html",
                            // Pinned on EVERY draw, not just the first: uploads
                            // replace artifact metadata wholesale, so a pin set
                            // once at rev 1 was silently erased by rev 2.
                            { pinned: true } as any,
                        );
                        const sizeBytes = Buffer.byteLength(html, "utf8");
                        // Durable commit BEFORE returning: a rev is only ever
                        // advertised after both its bytes and its event exist.
                        // The response contract rides the event so every
                        // client learns it exactly where it learns the rev —
                        // live push and cold snapshot alike, no extra fetch.
                        await catalog.recordEvents(target, [{
                            eventType: "session.canvas_updated",
                            data: {
                                rev,
                                slot,
                                ...(rawName !== undefined ? { name: rawName } : {}),
                                sizeBytes,
                                ...(note ? { note } : {}),
                                ...(effectiveContract ? { responseContract: effectiveContract } : {}),
                                ...(source ? { source } : {}),
                                // Attribution: who actually drew this revision.
                                // Only present on cross-session draws, so the
                                // portal can badge "drawn by sub-agent X".
                                ...(crossSession ? { by: input.sessionId } : {}),
                            },
                        }], workerNodeId);
                        // The per-slot cache (migration 0045). Non-fatal on
                        // purpose: the event above is durable, and the next
                        // draw falls back to the event scan if this row is
                        // missing — failing the draw over a cache write would
                        // invert the dependency.
                        try {
                            await catalog.upsertSessionCanvas?.(target, slot, rawName ?? null, rev, sizeBytes);
                        } catch { /* self-heals on the next draw */ }
                        // The app's half of the KV write switch (Part D.3),
                        // cached so a KV write never re-reads the document.
                        // A document with no manifest clears it: the new page
                        // declares nothing, so collaborators cannot write. A
                        // failed cache write fails CLOSED: the previous app's
                        // `viewers` switch must not stay armed for a page that
                        // declared nothing, so clearing is retried and the
                        // result tells the agent when neither landed.
                        let kvManifestWarning: string | undefined;
                        try {
                            await (catalog as any).setCanvasKvManifest?.(target, slot, extraction.manifest?.kv ?? null);
                        } catch {
                            try {
                                await (catalog as any).setCanvasKvManifest?.(target, slot, null);
                            } catch {
                                kvManifestWarning = "the canvas KV manifest cache could not be written; collaborators may keep the previous app's write access until the next successful draw.";
                            }
                        }
                        if (kvManifestWarning) manifestWarning = manifestWarning ? `${manifestWarning} ${kvManifestWarning}` : kvManifestWarning;
                        // The data plane (migration 0047): doc pointer for
                        // live viewers + RESET of the data mirror — the new
                        // page starts from its own initial state, never the
                        // old page's stale ticks. Non-fatal: the plane is the
                        // acceleration path, the event above is the truth.
                        try {
                            if (await (catalog as any).canvasLiveAvailable?.()) {
                                const sha = createHash("sha256").update(html, "utf8").digest("hex");
                                await (catalog as any).upsertCanvasLiveDoc?.(target, slot, { rev, sha }, input.sessionId);
                            }
                        } catch { /* live viewers resync from events */ }
                        return {
                            rev,
                            slot,
                            ...(rawName !== undefined ? { name: rawName } : {}),
                            sizeBytes,
                            ...(source ? { source } : {}),
                            ...(app ? { app } : {}),
                            ...(effectiveContract ? { responseContract: effectiveContract } : {}),
                            ...(manifestWarning ? { manifestWarning } : {}),
                        };
                    }).catch((err: any) => ({ error: err?.message || String(err) }));
                    canvasDrawChain = run.then(() => undefined, () => undefined);
                    return run;
                },
                updateCanvas: async (args: { data?: Record<string, any>; patch?: Record<string, any>; note?: string; slot?: number; session_id?: string }) => {
                    if (!catalog) return { error: "canvas requires the CMS catalog" };
                    const slot = normalizeCanvasSlot(args.slot);
                    if (slot === null) return { error: "slot must be an integer 1-5" };
                    const resolved = await resolveCanvasTarget(args.session_id);
                    if ("error" in resolved) return { error: resolved.error };
                    const { target, crossSession } = resolved;
                    const isPatch = args.patch !== undefined;
                    const body = isPatch ? args.patch : args.data;
                    // Rate limit at the source: the plane makes ticks cheap
                    // enough that a runaway loop could flood viewers. Applies
                    // per (target, slot) within this execution.
                    const now = Date.now();
                    const tickKey = `${target}:${slot}`;
                    const lastTick = canvasTickClock.get(tickKey) || 0;
                    if (now - lastTick < CANVAS_TICK_MIN_INTERVAL_MS) {
                        return { error: `ticking slot ${slot} faster than ${CANVAS_TICK_MIN_INTERVAL_MS} ms apart — aggregate your changes into fewer, larger ticks` };
                    }
                    canvasTickClock.set(tickKey, now);
                    const run = canvasDrawChain.then(async () => {
                        if ((await latestCanvasRev(catalog, target, slot)) === 0) {
                            return { error: `no canvas has been drawn in slot ${slot} — draw_canvas first; ticks patch an existing page` };
                        }
                        const planeAvailable = await (catalog as any).canvasLiveAvailable?.().catch(() => false);
                        // The plane is where merges live. Without it (older
                        // deployment), a patch has no current state to merge
                        // against — refuse with the actionable alternative
                        // instead of guessing.
                        if (isPatch && !planeAvailable) {
                            return { error: "this deployment predates the canvas data plane — send data (the whole state) instead of patch" };
                        }
                        // Whole state after this write, whoever computes it:
                        // the plane merges patches server-side; a plain PUT is
                        // its own whole state.
                        let mergedPayload: Record<string, unknown> = (body ?? {}) as Record<string, unknown>;
                        let planeSeq: number | undefined;
                        if (planeAvailable) {
                            const live = await (catalog as any).upsertCanvasLiveTick(
                                target, slot,
                                isPatch ? { patch: body } : { data: body },
                                input.sessionId,
                                32_768,
                            );
                            if (live?.refused) {
                                return {
                                    error: `the merged canvas state would exceed 32768 bytes`
                                        + (live.currentSizeBytes != null ? ` (currently ${live.currentSizeBytes} bytes)` : "")
                                        + `. Aggregate the data, remove stale keys (patch with null deletes), or redraw if the shape truly grew.`,
                                };
                            }
                            mergedPayload = live.payload ?? mergedPayload;
                            planeSeq = live.seq;
                        }
                        const sizeBytes = Buffer.byteLength(JSON.stringify(mergedPayload), "utf8");
                        // Dual-write phase: the durable event carries the
                        // MERGED whole state so pre-plane readers (older
                        // portals, cold loads) stay complete. Flipping
                        // PILOTSWARM_CANVAS_DURABLE_TICKS=0 ends this — only
                        // after every reader in the environment prefers the
                        // plane, and the completion checkpoint ships with
                        // that flip.
                        let dataRev: number | undefined;
                        // The flag only silences durable ticks where the
                        // plane actually took the write. Plane absent =
                        // today's path stays, whatever the flag says —
                        // otherwise a PUT would be written NOWHERE and still
                        // report success.
                        if (!planeAvailable || process.env.PILOTSWARM_CANVAS_DURABLE_TICKS !== "0") {
                            dataRev = (await latestCanvasDataRev(catalog, target, slot)) + 1;
                            await catalog.recordEvents(target, [{
                                eventType: "session.canvas_data",
                                data: {
                                    dataRev,
                                    slot,
                                    sizeBytes,
                                    payload: mergedPayload,
                                    ...(isPatch ? { patched: true } : {}),
                                    ...(crossSession ? { by: input.sessionId } : {}),
                                    ...(args.note ? { note: String(args.note) } : {}),
                                },
                            }], workerNodeId);
                        }
                        return {
                            ...(dataRev !== undefined ? { dataRev } : {}),
                            ...(planeSeq !== undefined ? { seq: planeSeq } : {}),
                            slot,
                            sizeBytes,
                            mode: isPatch ? "patch" : "data",
                        };
                    }).catch((err: any) => ({ error: err?.message || String(err) }));
                    canvasDrawChain = run.then(() => undefined, () => undefined);
                    return run;
                },
                // Bring an ALREADY-DRAWN canvas to the user's screen without
                // redrawing it: no bytes, no new rev, nothing marked unseen.
                // The portal routes the event through the same flip guards a
                // draw uses (active session, freshness, per-slot opt-out).
                showCanvas: async (args: { slot?: number; session_id?: string }) => {
                    if (!catalog) return { error: "canvas requires the CMS catalog" };
                    const slot = normalizeCanvasSlot(args.slot);
                    if (slot === null) return { error: "slot must be an integer 1-5" };
                    const resolved = await resolveCanvasTarget(args.session_id);
                    if ("error" in resolved) return { error: resolved.error };
                    const { target, crossSession } = resolved;
                    const rev = await latestCanvasRev(catalog, target, slot);
                    if (rev === 0) {
                        return { error: `nothing has been drawn in slot ${slot} — draw_canvas first; show_canvas only presents an existing canvas` };
                    }
                    await catalog.recordEvents(target, [{
                        eventType: "session.canvas_presented",
                        data: { slot, rev, ...(crossSession ? { by: input.sessionId } : {}) },
                    }], workerNodeId);
                    return { presented: true, slot, rev };
                },
                // Door 3 of the canvas KV store: the agent. Same chokepoint
                // as the browser doors; the principal is the session itself.
                canvasKv: async (args: { op: "get" | "put" | "list" | "delete"; key?: string; value?: unknown; prefix?: string; limit?: number; after?: string; ifMatch?: number; slot?: number; session_id?: string }) => {
                    if (!catalog) return { error: "canvas KV requires the CMS catalog" };
                    if (typeof (catalog as any).canvasKvWrite !== "function") return { error: "this deployment's catalog predates the canvas KV store (migration 0064)" };
                    const slot = normalizeCanvasSlot(args.slot);
                    if (slot === null) return { error: "slot must be an integer 1-5" };
                    const resolved = await resolveCanvasTarget(args.session_id);
                    if ("error" in resolved) return { error: resolved.error };
                    const { target } = resolved;
                    const principal = { kind: "agent" as const, sessionId: input.sessionId };
                    const store = catalog as any;
                    try {
                        switch (args.op) {
                            case "get": {
                                if (!args.key) return { error: "key is required for get (use list with a prefix to browse)" };
                                const read = await readCanvasKv(store, target, slot, principal, { key: args.key });
                                return read.entries.length ? { found: true, ...read.entries[0] } : { found: false, key: args.key };
                            }
                            case "list": {
                                const read = await readCanvasKv(store, target, slot, principal, { prefix: args.prefix, limit: args.limit, after: args.after });
                                return { entries: read.entries, ...(read.nextAfter ? { nextAfter: read.nextAfter } : {}), policy: read.policy };
                            }
                            case "put":
                            case "delete": {
                                if (!args.key) return { error: "key is required" };
                                const op = args.op === "put"
                                    ? { op: "put" as const, key: args.key, value: args.value, ifMatch: args.ifMatch ?? null }
                                    : { op: "delete" as const, key: args.key, ifMatch: args.ifMatch ?? null };
                                const written = await writeCanvasKv(store, target, slot, principal, [op]);
                                const result = written.results[0];
                                return result.ok
                                    ? { ok: true, key: result.key, rev: result.rev }
                                    : { error: `${result.code}: ${result.error}`, key: result.key, ...(result.rev !== undefined ? { rev: result.rev } : {}) };
                            }
                            default:
                                return { error: `op must be get, put, list or delete (got ${String((args as any).op)})` };
                        }
                    } catch (err: any) {
                        return { error: err?.message || String(err) };
                    }
                },
                // The app catalog (interactive-canvas-apps Part F). Publish
                // copies the canvas bytes to a pinned `app-<name>.html`
                // artifact and writes ONE shared fact `apps/<name>` whose value
                // is the card — derived from the document's manifest, never
                // from the model's memory of it. Find is a ranked search over
                // that namespace (hybrid on an enhanced store, a plain listing
                // with a lexical filter on a base store).
                publishCanvasApp: async (args: { name?: string; description?: string; tags?: string[]; slot?: number; session_id?: string }) => {
                    const slot = normalizeCanvasSlot(args.slot);
                    if (slot === null) return { error: "slot must be an integer 1-5" };
                    const resolved = await resolveCanvasTarget(args.session_id);
                    if ("error" in resolved) return { error: resolved.error };
                    return publishCanvasApp(
                        { artifactStore, catalog, factStore, sessionId: input.sessionId, agentIdentity: runConfig.agentIdentity ?? null, workerNodeId },
                        { name: args.name, description: args.description, tags: args.tags, slot, target: resolved.target },
                    );
                },
                findCanvasApp: async (args: { query?: string; limit?: number }) => findCanvasApp({ factStore }, args),
                readCanvas: async (args: { offset?: number; maxBytes?: number; manifestOnly?: boolean; includeData?: boolean; slot?: number; session_id?: string }) => {
                    if (!artifactStore) return { error: "this worker has no artifact store" };
                    if (!catalog) return { error: "canvas requires the CMS catalog" };
                    const slot = normalizeCanvasSlot(args.slot);
                    if (slot === null) return { error: "slot must be an integer 1-5" };
                    const resolved = await resolveCanvasTarget(args.session_id);
                    if ("error" in resolved) return { error: resolved.error };
                    const { target } = resolved;
                    // "What is the page showing right now?" — the plane's
                    // last-value row, one PK read. Opt-in (the payload can be
                    // 32 KB of model context) and independent of paging.
                    const liveState = async () => {
                        if (!args.includeData) return {};
                        try {
                            if (!(await (catalog as any).canvasLiveAvailable?.())) return {};
                            const rows = await (catalog as any).getCanvasLive?.(target);
                            const hit = (rows || []).find((r: any) => Number(r.slot) === slot);
                            return hit ? { live: { seq: hit.seq, data: hit.payload, updatedBy: hit.updatedBy, updatedAt: hit.updatedAt } } : {};
                        } catch { return {}; }
                    };
                    try {
                        // Log FIRST: the event log is the single authority on
                        // whether a canvas exists. Orphan bytes from a crashed
                        // half-draw (or a user-uploaded canvas.html) read as
                        // "not drawn" — the documented conservative answer.
                        // Known window: a crash BETWEEN byte write and event
                        // write on a redraw serves rev-N metadata over rev-N+1
                        // bytes until the next successful draw. Self-healing;
                        // accepted.
                        if (args.manifestOnly) {
                            // The interface card without the bytes: embedded
                            // manifest summary from the stored document plus the
                            // ARMED contract from the latest draw event — the
                            // pair an inheriting agent needs to interpret
                            // canvas-action messages and author ticks.
                            const latest = await latestCanvasEventData(catalog, target, slot);
                            if (latest.rev === 0) return { exists: false };
                            const docText = await artifactStore.downloadArtifactText(target, canvasArtifactFilename(slot));
                            const extraction = extractCanvasAppManifest(docText);
                            const card = canvasAppCard(extraction.manifest);
                            // Events are writable via send_session_event with no
                            // validation — the armed contract re-passes the
                            // normalizer here so an injected megabyte "contract"
                            // cannot ride a cheap read into model context.
                            const armed = normalizeCanvasResponseContract(latest.responseContract);
                            return {
                                exists: true,
                                rev: latest.rev,
                                sizeBytes: Buffer.byteLength(docText, "utf8"),
                                ...(card ? { app: card } : {}),
                                ...(armed.contract ? { responseContract: armed.contract } : {}),
                                ...(extraction.error ? { manifestError: extraction.error } : {}),
                                ...(await liveState()),
                            };
                        }
                        const rev = await latestCanvasRev(catalog, target, slot);
                        if (rev === 0) return { exists: false };
                        const text = await artifactStore.downloadArtifactText(target, canvasArtifactFilename(slot));
                        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
                        const maxChars = Math.min(262_144, Math.max(1, Math.floor(Number(args.maxBytes) || 65_536)));
                        const content = text.slice(offset, offset + maxChars);
                        return {
                            exists: true,
                            rev,
                            sizeBytes: Buffer.byteLength(text, "utf8"),
                            // offset/paging are UTF-16 code units ("characters");
                            // sizeChars is the value offset reconciles against.
                            sizeChars: text.length,
                            offset,
                            content,
                            truncated: offset + content.length < text.length,
                            ...(await liveState()),
                        };
                    } catch (err: any) {
                        return { error: err?.message || String(err) };
                    }
                },
            }),
        } as const;

        // Cooperative cancellation: poll for lock steal
        let cancelled = false;
        cancelPoll = setInterval(() => {
            if (activityCtx.isCancelled()) {
                cancelled = true;
                session?.abort?.();
                if (cancelPoll) clearInterval(cancelPoll);
            }
        }, 2_000);

            // Build onEvent callback: write each non-ephemeral event to CMS as it fires.
            // We track every in-flight CMS recordEvents promise so we can flush them
            // before posting `session.turn_completed`. Without this barrier the
            // turn_completed insert can race ahead of the SDK's `assistant.message`
            // insert and CMS will assign the smaller `seq` to turn_completed,
            // breaking event-ordering invariants downstream (see cms-seq-nodemap).
            const pendingEventWrites: Promise<unknown>[] = [];
            const trackEventWrite = (promise: Promise<unknown> | undefined | null) => {
                if (!promise || typeof (promise as Promise<unknown>).then !== "function") return;
                pendingEventWrites.push((promise as Promise<unknown>).catch(() => {}));
            };
            const EPHEMERAL_TYPES = new Set([
                "assistant.message_delta",
                "assistant.streaming_delta",
                "assistant.reasoning_delta",
                // Tool-call argument streaming fragments — the same transient
                // per-token class as the other *_delta events. The assembled
                // call is persisted separately as tool.execution_start, so
                // recording these only bloats the CMS stream and floods the
                // client event buffer (starving the milestone-only sequence view).
                "assistant.tool_call_delta",
                "user.message", // Already recorded explicitly above — skip the SDK's duplicate
                // Persisted ATOMICALLY by the drawCanvas bridge method (derive
                // + write + record in one awaited, serialized section). The
                // handler's emit is the live-push half only; recording it here
                // too would double-insert every revision.
                "session.canvas_updated",
                // Same contract as canvas_updated: the showCanvas bridge
                // records it durably itself; the emit is live-push only.
                "session.canvas_presented",
                // Same contract for data ticks: the updateCanvas bridge method
                // records the event (payload inline) inside the serialized
                // section — the generic path must not double-insert it.
                "session.canvas_data",
            ]);
            const onEvent = catalog
                ? (event: { eventType: string; data: unknown }) => {
                    if (EPHEMERAL_TYPES.has(event.eventType)) return;
                    const persistedEvent = summarizeSdkSystemPromptEchoEvent(event);
                    if (!persistedEvent) return;
                    if (event.eventType === "session.wait_started") {
                        const data = (event.data ?? {}) as { reason?: string };
                        void cmsRetryBestEffort(
                            `runTurn.onEvent updateSession state=waiting session=${input.sessionId}`,
                            () => catalog.updateSession(input.sessionId, {
                                state: "waiting",
                                waitReason: data.reason ?? null,
                                lastActiveAt: new Date(),
                            }),
                            (msg) => activityCtx.traceInfo(msg),
                        );
                    } else if (event.eventType === "session.input_required_started") {
                        const data = (event.data ?? {}) as { question?: string };
                        void cmsRetryBestEffort(
                            `runTurn.onEvent updateSession state=input_required session=${input.sessionId}`,
                            () => catalog.updateSession(input.sessionId, {
                                state: "input_required",
                                waitReason: data.question ?? null,
                                lastActiveAt: new Date(),
                            }),
                            (msg) => activityCtx.traceInfo(msg),
                        );
                    }
                    if (event.eventType === "assistant.usage" || event.eventType === "assistant.turn_start") {
                        // Both carry the bound model; usage is emitted per API
                        // call, so the last one seen is the model that served
                        // the turn's final iteration.
                        const eventModel = (normalizeEventData(event.data as Record<string, unknown> | undefined) ?? {}).model;
                        if (typeof eventModel === "string" && eventModel) {
                            turnTelemetry.observedModel = eventModel;
                        }
                    }
                    if (event.eventType === "assistant.usage") {
                        const usageUpsert = buildUsageSummaryUpsert(event.data);
                        if (usageUpsert) {
                            turnTelemetry.tokensInput += usageUpsert.tokensInputIncrement ?? 0;
                            turnTelemetry.tokensOutput += usageUpsert.tokensOutputIncrement ?? 0;
                            turnTelemetry.tokensCacheRead += usageUpsert.tokensCacheReadIncrement ?? 0;
                            turnTelemetry.tokensCacheWrite += usageUpsert.tokensCacheWriteIncrement ?? 0;
                        }
                    } else if (event.eventType === "tool.execution_start") {
                        turnTelemetry.toolCalls += 1;
                        const eventData = normalizeEventData(event.data as Record<string, unknown> | undefined);
                        const toolName = typeof eventData?.toolName === "string"
                            ? eventData.toolName
                            : typeof eventData?.name === "string"
                                ? eventData.name
                                : undefined;
                        if (toolName) turnTelemetry.toolNames.add(toolName);
                    } else if (event.eventType === "tool.execution_complete" && isFailureToolCompletion(event.data)) {
                        turnTelemetry.toolErrors += 1;
                    }
                    // Best-effort with one transient retry. trackEventWrite tracks
                    // the wrapped promise so the post-turn barrier waits for the
                    // retry to settle before emitting turn_completed.
                    const writePromise = cmsRetryBestEffort(
                        `runTurn.onEvent recordEvent ${persistedEvent.eventType} session=${input.sessionId}`,
                        () => catalog.recordEvents(input.sessionId, [persistedEvent], workerNodeId),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                    trackEventWrite(writePromise);
                }
                : undefined;

            // Record the user prompt as a CMS event before running the turn.
            // Skip internal timer continuation prompts — they're system-generated, not user input.
            // Orchestration ≥1.0.71 appends the turn's system note to the
            // prompt as a trailing <system_context> block (it is sent to the
            // model that way). The transcript keeps its old shape: the note
            // is recorded from `turnSystemPrompt` as `system.message` below,
            // and `user.message` is persisted WITHOUT the block. ≤1.0.70
            // turns carry no flag and no block; the split is a no-op there.
            const promptForRecord = input.config?.systemContextInPrompt
                ? splitSystemContextBlock(input.prompt).prompt
                : input.prompt;
            const isTimerPrompt = /^The \d+ second wait is now complete\./i.test(promptForRecord);
            const isRetryAttempt = (input.retryCount ?? 0) > 0;
            if (catalog && input.config.turnSystemPrompt && !isRetryAttempt) {
                const persistedSystemPrompt = decorateRehydrationSystemPrompt(
                    input.config.turnSystemPrompt,
                    workerNodeId,
                );
                trackEventWrite(cmsRetryBestEffort(
                    `runTurn.recordEvent system-prompt session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "system.message",
                        data: { content: persistedSystemPrompt },
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                ));
            }
            if (catalog && !isTimerPrompt && !input.bootstrap && !isRetryAttempt && promptForRecord) {
                const promptEventType = isInternalSystemPrompt(promptForRecord) ? "system.message" : "user.message";
                // v1.0.47: when the orchestration tagged the turn with one or
                // more clientMessageIds (the UI-generated identities of the
                // contributing local outbox items), persist them on the
                // durable user.message event so the client can ack/cancel by
                // exact id rather than text match.
                const incomingClientMessageIds: string[] = Array.isArray((input as any).clientMessageIds)
                    ? ((input as any).clientMessageIds as unknown[]).filter((id) => typeof id === "string" && id) as string[]
                    : [];
                const eventData: Record<string, unknown> = { content: promptForRecord };
                if (incomingClientMessageIds.length > 0) {
                    eventData.clientMessageIds = incomingClientMessageIds;
                }
                // Security model: structured sender identity (server-stamped
                // at the API edge) rides the durable user.message event so
                // UIs can render attribution chips without parsing [FROM:]
                // markers out of the prompt text.
                if ((input as any).sender && typeof (input as any).sender === "object") {
                    eventData.sender = (input as any).sender;
                }
                // Image attachment refs ride the durable user.message event so
                // transcripts can render thumbnails; bytes stay in the store.
                const eventAttachments = sanitizePromptAttachmentRefs(input.attachments);
                if (eventAttachments.length > 0) {
                    eventData.attachments = eventAttachments;
                }
                const capturedPromptEventType = promptEventType;
                trackEventWrite(cmsRetryBestEffort(
                    `runTurn.recordEvent ${capturedPromptEventType} session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: capturedPromptEventType,
                        data: eventData,
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                ));
            }

            // Mark session as "running" in CMS before the turn, and publish the
            // in-flight turn index so stopSessionTurn() can address the
            // turn-scoped stop queue (stopTurn.<turnIndex>).
            if (catalog) {
                await cmsRetryBestEffort(
                    `runTurn.preTurn updateSession state=running session=${input.sessionId}`,
                    () => catalog!.updateSession(input.sessionId, {
                        state: "running",
                        lastActiveAt: new Date(),
                    }),
                    (msg) => activityCtx.traceInfo(msg),
                );
                await cmsRetryBestEffort(
                    `runTurn.preTurn setActiveTurnIndex session=${input.sessionId} turn=${input.turnIndex ?? 0}`,
                    () => catalog!.setActiveTurnIndex(input.sessionId, input.turnIndex ?? 0),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }

            activityCtx.traceInfo(`[runTurn] invoking ManagedSession.runTurn for ${input.sessionId}`);

            // Record turn_started CMS event
            if (catalog) {
                trackEventWrite(cmsRetryBestEffort(
                    `runTurn.recordEvent turn_started session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.turn_started",
                        data: { iteration: input.turnIndex ?? 0 },
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                ));
            }

            // ── Image attachments: resolve refs → blobs, vision-gated ────────
            // Bytes are fetched HERE (inside the activity) so the durable wire
            // carries only refs. Every drop is explicit: an omission note is
            // appended to the prompt and a runtime.attachment_dropped event is
            // recorded — the model is never sent a payload it cannot see, and
            // the operator is never silently ignored.
            const requestedAttachments = sanitizePromptAttachmentRefs(input.attachments);
            const turnAttachmentBlobs: Array<{ data: string; mimeType: string; displayName?: string }> = [];
            if (requestedAttachments.length > 0) {
                const droppedAttachments: Array<{ filename: string; contentType: string; reason: string }> = [];
                let visionInfo: Awaited<ReturnType<SessionManager["getModelVisionInfo"]>> | null = null;
                try {
                    // Consult the catalog on the session's OWN client — the
                    // same token the blobs will ride out on. Deployments that
                    // run sessions on per-user/system Copilot keys have no
                    // meaningful default token (it may be a seed sentinel).
                    visionInfo = await sessionManager.getModelVisionInfo(input.config.model, { sessionId: input.sessionId });
                } catch (err: any) {
                    activityCtx.traceInfo(`[runTurn] vision-capability lookup failed: ${err?.message ?? err}`);
                }
                if (!visionInfo?.vision) {
                    for (const ref of requestedAttachments) {
                        droppedAttachments.push({ filename: ref.filename, contentType: ref.contentType, reason: "no_vision_support" });
                    }
                } else {
                    const perImageCap = Math.min(ATTACHMENT_MAX_BYTES, visionInfo.maxImageBytes || Number.POSITIVE_INFINITY);
                    const maxImages = Math.min(requestedAttachments.length, visionInfo.maxImages || requestedAttachments.length);
                    let totalBytes = 0;
                    for (const ref of requestedAttachments) {
                        if (turnAttachmentBlobs.length >= maxImages) {
                            droppedAttachments.push({ filename: ref.filename, contentType: ref.contentType, reason: "too_many_images" });
                            continue;
                        }
                        const mediaTypeOk = IMAGE_ATTACHMENT_CONTENT_TYPES.has(ref.contentType)
                            && (!visionInfo.supportedMediaTypes || visionInfo.supportedMediaTypes.includes(ref.contentType));
                        if (!mediaTypeOk) {
                            droppedAttachments.push({ filename: ref.filename, contentType: ref.contentType, reason: "type_rejected" });
                            continue;
                        }
                        if (!artifactStore) {
                            droppedAttachments.push({ filename: ref.filename, contentType: ref.contentType, reason: "store_unavailable" });
                            continue;
                        }
                        try {
                            const download = await artifactStore.downloadArtifact(input.sessionId, ref.filename);
                            const body: Buffer = download.body;
                            if (body.length > perImageCap || totalBytes + body.length > ATTACHMENTS_MAX_TOTAL_BYTES) {
                                droppedAttachments.push({ filename: ref.filename, contentType: ref.contentType, reason: "size_exceeded" });
                                continue;
                            }
                            totalBytes += body.length;
                            turnAttachmentBlobs.push({
                                data: body.toString("base64"),
                                mimeType: download.contentType || ref.contentType,
                                displayName: ref.filename,
                            });
                        } catch (err: any) {
                            activityCtx.traceInfo(`[runTurn] attachment fetch failed for ${ref.filename}: ${err?.message ?? err}`);
                            droppedAttachments.push({ filename: ref.filename, contentType: ref.contentType, reason: "fetch_failed" });
                        }
                    }
                }
                if (droppedAttachments.length > 0) {
                    const modelLabel = visionInfo?.modelId || input.config.model || "current model";
                    const noteLines = droppedAttachments.map((d) => (d.reason === "no_vision_support"
                        ? `[image attachment '${d.filename}' omitted — model '${modelLabel}' does not support image input]`
                        : `[image attachment '${d.filename}' omitted — ${d.reason.replace(/_/g, " ")}]`));
                    effectivePrompt = `${effectivePrompt}\n\n${noteLines.join("\n")}`;
                    if (catalog) {
                        trackEventWrite(cmsRetryBestEffort(
                            `runTurn.recordEvent attachment_dropped session=${input.sessionId}`,
                            () => catalog!.recordEvents(input.sessionId, droppedAttachments.map((d) => ({
                                eventType: "runtime.attachment_dropped",
                                data: { ...d, modelId: visionInfo?.modelId ?? null },
                            })), workerNodeId),
                            (msg) => activityCtx.traceInfo(msg),
                        ));
                    }
                    activityCtx.traceInfo(
                        `[runTurn] dropped ${droppedAttachments.length}/${requestedAttachments.length} image attachment(s): `
                        + droppedAttachments.map((d) => `${d.filename}(${d.reason})`).join(", "),
                    );
                }
            }

            const runTurnWithPrompt = async (targetSession: any, prompt: string) => {
                return await targetSession.runTurn(prompt, {
                    onEvent,
                    modelSummary,
                    bootstrap: input.bootstrap,
                    requiredTool: input.requiredTool,
                    cycleOrigin: input.cycleOrigin,
                    turnIndex: input.turnIndex,
                    controlToolBridge,
                    ...(turnAttachmentBlobs.length > 0 ? { attachments: turnAttachmentBlobs } : {}),
                });
            };

            let result = await runTurnWithPrompt(session, effectivePrompt);

            if (result.type === "error" && isLiveSessionLostErrorMessage((result as any).message)) {
                activityCtx.traceInfo(
                    `[runTurn] live Copilot session lost for ${input.sessionId}; invalidating warm session and attempting recovery`,
                );

                await sessionManager.invalidateWarmSession(input.sessionId, { lockHeld: true }).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] warm-session invalidation failed (non-fatal): ${err?.message ?? err}`);
                });

                if (catalog) {
                    await cmsRetryBestEffort(
                        `runTurn.recordEvent system.message-recovery session=${input.sessionId}`,
                        () => catalog!.recordEvents(input.sessionId, [{
                            eventType: "system.message",
                            data: {
                                content:
                                    "The runtime recovered this session after the worker lost the live Copilot session. " +
                                    "Some very recent in-memory state may have been lost.",
                            },
                        }], workerNodeId),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                }

                try {
                    session = await sessionManager.getOrCreate(input.sessionId, runConfig, {
                        turnIndex: input.turnIndex,
                        trace,
                        lockHeld: true,
                    });
                } catch (err: any) {
                    const recoveryMessage = err?.message || String(err);
                    const fatalMessage = isMissingSessionStateErrorMessage(recoveryMessage)
                        ? buildUnrecoverableSessionLossMessage(
                            input.sessionId,
                            stripMissingSessionStatePrefix(recoveryMessage),
                        )
                        : buildUnrecoverableSessionLossMessage(input.sessionId, recoveryMessage);
                    activityCtx.traceInfo(`[runTurn] unrecoverable session loss for ${input.sessionId}: ${fatalMessage}`);
                    return await failForMissingState(fatalMessage);
                }

                const recoveredPrompt = mergePromptSections([SESSION_RECOVERY_NOTICE, input.prompt]) || input.prompt;
                result = await runTurnWithPrompt(session, recoveredPrompt);

                if (result.type === "error" && isLiveSessionLostErrorMessage((result as any).message)) {
                    const fatalMessage = buildUnrecoverableSessionLossMessage(input.sessionId, (result as any).message);
                    activityCtx.traceInfo(`[runTurn] recovery re-run still reported lost session for ${input.sessionId}: ${fatalMessage}`);
                    return await failForMissingState(fatalMessage);
                }
            }

            if (result.type === "error" && isToolCallTranscriptCorruptionErrorMessage((result as any).message)) {
                const transcriptError = (result as any).message;
                activityCtx.traceInfo(
                    `[runTurn] corrupted live Copilot transcript for ${input.sessionId}; resetting stored session state and attempting fresh-session replay`,
                );

                await sessionManager.resetSessionState(input.sessionId, { lockHeld: true }).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] stored-session reset failed (non-fatal): ${err?.message ?? err}`);
                });

                await recordLossyHandoffEvent(
                    catalog,
                    input.sessionId,
                    workerNodeId,
                    {
                        cause: "corrupted_tool_call_transcript_during_run_turn",
                        message:
                            "The runtime detected an inconsistent live Copilot transcript and recreated a fresh session to replay the pending turn.",
                        detail: transcriptError,
                        error: transcriptError,
                        recoveryMode: "fresh_session_replay",
                        nextStep: "replay_pending_turn_with_recreated_copilot_session",
                        ...(input.turnIndex != null ? { iteration: input.turnIndex } : {}),
                    },
                    (failureMessage) => activityCtx.traceInfo(`[runTurn] ${failureMessage}`),
                );

                if (catalog) {
                    await cmsRetryBestEffort(
                        `runTurn.recordEvent system.message-corrupted-transcript session=${input.sessionId}`,
                        () => catalog!.recordEvents(input.sessionId, [{
                            eventType: "system.message",
                            data: {
                                content:
                                    "The runtime recreated this session after the live Copilot transcript became inconsistent. " +
                                    "Some recent in-memory work may be missing or partially executed.",
                            },
                        }], workerNodeId),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                }

                try {
                    session = await sessionManager.getOrCreate(input.sessionId, runConfig, {
                        turnIndex: 0,
                        trace,
                        lockHeld: true,
                    });
                } catch (err: any) {
                    const recoveryMessage = err?.message || String(err);
                    const fatalMessage =
                        `Live Copilot transcript became inconsistent for ${input.sessionId}, and fresh-session recovery failed. ${recoveryMessage}`;
                    activityCtx.traceInfo(`[runTurn] unrecoverable corrupted transcript for ${input.sessionId}: ${fatalMessage}`);
                    return { type: "error", message: fatalMessage } as TurnResult;
                }

                const recoveredPrompt = mergePromptSections([CORRUPTED_TRANSCRIPT_REPLAY_NOTICE, input.prompt]) || input.prompt;
                result = await runTurnWithPrompt(session, recoveredPrompt);
            }

            if (
                input.parentSessionId
                && result.type === "completed"
                && typeof result.content === "string"
                && /^QUESTION FOR PARENT:/i.test(result.content.trim())
            ) {
                result = {
                    ...result,
                    type: "wait",
                    seconds: 60,
                    reason: "waiting for parent answer",
                    content: result.content.trim(),
                } as TurnResult;
            }
            activityCtx.traceInfo(`[runTurn] ManagedSession.runTurn completed for ${input.sessionId} type=${result.type}`);

            // Drain event writes before the atomic post-turn writeback records
            // session.turn_completed.
            //
            // Ordering matters here: every per-event CMS write fired by the
            // SDK's onEvent callback (assistant.message, tool calls, usage,
            // etc.) must land in `session_events` with a smaller `seq` than
            // `session.turn_completed`, otherwise downstream consumers that
            // walk events in seq order (e.g. cms-seq-nodemap) see the turn
            // close before its own assistant.message.
            //
            // `runTurn` resolves once the SDK has emitted its final events,
            // but the corresponding `recordEvents` calls were dispatched
            // fire-and-forget. We therefore:
            //   1. Sleep 100ms to let any straggler onEvent callbacks fire
            //      and enqueue their CMS write (quiesce window).
            //   2. Drain `pendingEventWrites` and await all of them with
            //      allSettled — failed writes were already logged inline,
            //      we only need the ordering guarantee.
            //   3. Await the turn_completed insert so subsequent activity
            //      logic and any immediate CMS readers see a consistent tail.
            //
            // The 100ms is a deliberate, bounded pause. If it ever needs to
            // grow, prefer a real "SDK turn fully flushed" signal over a
            // larger sleep.
            if (catalog) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                const pendingWritesAtBarrier = pendingEventWrites.splice(0);
                if (pendingWritesAtBarrier.length > 0) {
                    await Promise.allSettled(pendingWritesAtBarrier);
                }
            }

            if (cancelled) return { type: "cancelled" };

            // ── Activity-level writeback: sync turn result → CMS ──
            // This lets listSessions() read entirely from CMS without
            // hitting duroxide for every session's customStatus.
            if (catalog) {
                const statusMap: Record<string, string> = {
                    completed: "idle", // orchestration decides idle vs completed; default to idle
                    wait: "waiting",
                    cron: "running",
                    input_required: "input_required",
                    error: "error",
                    cancelled: "idle",
                    stopped: "idle",
                    spawn_agent: "running",
                    message_agent: "running",
                    check_agents: "running",
                    wait_for_agents: "waiting",
                    list_sessions: "running",
                    complete_agent: "running",
                    cancel_agent: "running",
                    delete_agent: "running",
                };
                const liveStatus = statusMap[result.type] ?? "idle";
                const updates: import("./cms.js").SessionRowUpdates = {
                    state: liveStatus,
                    lastActiveAt: new Date(),
                };
                if (result.type === "error") {
                    updates.lastError = (result as any).message ?? null;
                    updates.waitReason = null;
                } else if (result.type === "wait") {
                    updates.waitReason = (result as any).reason ?? null;
                    updates.lastError = null;
                } else if (result.type === "input_required") {
                    updates.waitReason = (result as any).question ?? null;
                    updates.lastError = null;
                } else {
                    updates.waitReason = null;
                    updates.lastError = null;
                }
                const turnEndedAt = new Date();
                await cmsRetryBestEffort(
                    `runTurn.postTurn completeTurnWriteback state=${updates.state} session=${input.sessionId}`,
                    () => catalog!.completeTurnWriteback({
                        sessionId: input.sessionId,
                        // The session's bound agent. This was hardcoded null,
                        // which left session_turn_metrics.agent_id empty on
                        // every row ever written: fleet rollups papered over it
                        // by COALESCE-ing back through `sessions`, the hourly
                        // bucket proc's p_agent_id filter silently matched
                        // nothing, and per-agent attribution in dashboards read
                        // "not reported". runConfig carries the resolved
                        // identity (including the catalog self-heal for older
                        // sessions created before agentIdentity existed).
                        agentId: runConfig.agentIdentity ?? fallbackAgentIdentity ?? null,
                        model: turnTelemetry.observedModel ?? input.config.model ?? null,
                        reasoningEffort: input.config.reasoningEffort ?? null,
                        turnIndex: input.turnIndex ?? 0,
                        startedAt: turnStartedAt,
                        endedAt: turnEndedAt,
                        durationMs: Math.max(0, turnEndedAt.getTime() - turnStartedAt.getTime()),
                        tokensInput: turnTelemetry.tokensInput,
                        tokensOutput: turnTelemetry.tokensOutput,
                        tokensCacheRead: turnTelemetry.tokensCacheRead,
                        tokensCacheWrite: turnTelemetry.tokensCacheWrite,
                        toolCalls: turnTelemetry.toolCalls,
                        toolErrors: turnTelemetry.toolErrors,
                        toolNames: Array.from(turnTelemetry.toolNames).sort(),
                        resultType: result.type,
                        errorMessage: result.type === "error" ? ((result as any).message ?? null) : null,
                        workerNodeId: workerNodeId ?? null,
                        state: updates.state ?? "idle",
                        lastActiveAt: (updates.lastActiveAt as Date | undefined) ?? turnEndedAt,
                        lastError: updates.lastError ?? null,
                        waitReason: updates.waitReason ?? null,
                        currentIteration: input.turnIndex ?? 0,
                    }),
                    (msg) => activityCtx.traceInfo(msg),
                );

                // ── settle the provider budget ───────────────────────
                //
                // Separate from the metrics writeback above on purpose: this
                // is the ACCOUNTING write, and it must be exactly once. Its
                // idempotence lives in the ledger's (session, turn) primary
                // key, so an activity retry that re-runs this whole block
                // charges nothing twice.
                //
                // It is settled against the provider ADMITTED at the top of
                // this turn, never re-resolved here: if a provider was
                // deleted while the model was working, the tokens were still
                // spent on the credential that was admitted, and that is what
                // the ledger should say.
                if (catalog?.providers) {
                    await cmsRetryBestEffort(
                        `runTurn.postTurn settleTurn session=${input.sessionId}`,
                        async () => {
                            const facts = await catalog!.providers!.sessionChargeFacts(input.sessionId);
                            await catalog!.providers!.settleTurn({
                                sessionId: input.sessionId,
                                turnIndex: input.turnIndex ?? 0,
                                providerName: admittedProvider.name,
                                modelQualified: admittedProvider.modelRef
                                    ?? runConfig.model ?? input.config.model ?? null,
                                ownerUserId: facts.ownerUserId,
                                chargeClass: admittedProvider.name
                                    ? (facts.isSystem ? "system" : "user")
                                    : "unattributed",
                                agentId: runConfig.agentIdentity ?? fallbackAgentIdentity ?? null,
                                tokensInput: turnTelemetry.tokensInput,
                                tokensOutput: turnTelemetry.tokensOutput,
                                tokensCacheRead: turnTelemetry.tokensCacheRead,
                                tokensCacheWrite: turnTelemetry.tokensCacheWrite,
                            });
                        },
                        (msg) => activityCtx.traceInfo(msg),
                    );
                }
            }

            return result;
            };

        const bodyResult = await executeTurnBody();

        // ── Session lifecycle protocol commit (proposal §3.2) ───────────
        // The turn and its snapshot durability are one activity completion:
        // no observable state exists where the turn "happened" but its
        // snapshot doesn't. Commit on every result the body produced —
        // matching today's semantics where the warm session keeps whatever
        // state the turn (even a cancelled/errored one) left behind. The
        // layout guard skips paths where no snapshottable session exists:
        // the SDK writes workspace.yaml on session create, so a dir without
        // it (fake test clients, failed creates — possibly containing only
        // our own sentinel) has nothing the store could meaningfully hold,
        // and committing it would fail the whole turn.
        const lifecycleSessionDir = lifecycle
            ? path.join(sessionManager.getSessionStateDir(), input.sessionId)
            : null;
        if (lifecycle && lifecycleSessionDir && fs.existsSync(path.join(lifecycleSessionDir, "workspace.yaml"))) {
            const committed = await runTurnCommit(lifecycle, lifecycleBaseVersion, bodyResult);
            if (!committed.published && catalog) {
                // Store-wins: the snapshot was NOT advanced — a user stop, or a
                // discarded/foreign turn superseded this one at the store. The
                // turn's result still returns; record the memory loss so it is
                // operator-visible (never a bare heartbeat). Best-effort (P7).
                const reason = committed.unpublishedReason ?? "superseded";
                await cmsRetryBestEffort(
                    `runTurn.recordEvent snapshot-unpublished session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.snapshot_unpublished",
                        data: {
                            reason,
                            // The accepted-loss contract must be diagnosable: this
                            // turn's model memory did NOT reach the store, and (for
                            // a supersede) here is what won the base — so operators
                            // can tell a foreign writer / restore race / discarded
                            // turn apart, not just "loss happened".
                            modelMemoryCommitted: false,
                            baseVersion: lifecycleBaseVersion,
                            turnKey: input.snapshot?.turnKey,
                            ...(input.turnIndex != null ? { turnIndex: input.turnIndex } : {}),
                            ...(committed.observedStoreVersion != null ? { observedStoreVersion: committed.observedStoreVersion } : {}),
                            ...(committed.observedStoreTurnKey ? { observedStoreTurnKey: committed.observedStoreTurnKey } : {}),
                            ...(bodyResult?.type ? { resultType: bodyResult.type } : {}),
                            message: reason === "stopped"
                                ? "User-stopped turn: snapshot not committed (intentional discard)."
                                : "Turn snapshot superseded: the store advanced off this turn's base before it committed; the next turn rehydrates the winner.",
                        },
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
            if (catalog && committed.sizeBytes != null) {
                await cmsRetryBestEffort(
                    `runTurn.commitSummary session=${input.sessionId}`,
                    () => catalog!.upsertSessionMetricSummary(input.sessionId, {
                        snapshotSizeBytes: committed.sizeBytes,
                        ...(committed.rawSizeBytes != null ? { rawSizeBytes: committed.rawSizeBytes } : {}),
                    }),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
            if (committed.alreadyCommitted && committed.storedResult !== undefined) {
                // A racing attempt of this same turn won the CAS. Its
                // snapshot was restored (restore-not-replay, §3.2 r1–r3) —
                // return ITS result so the recorded outcome matches the
                // durable lineage instead of this attempt's divergent body.
                activityCtx.traceInfo(
                    `[runTurn] session=${input.sessionId} racing attempt committed v${committed.version} first; ` +
                    `adopting its stored result`,
                );
                return { ...(committed.storedResult as TurnResult), snapshotVersion: committed.version };
            }
            return { ...bodyResult, snapshotVersion: committed.version };
        }
        return bodyResult;
            }, { trace });
            if (!finalTurnResult) {
                throw new Error("runTurn completed without a turn result");
            }
            return finalTurnResult;
        } catch (err: any) {
            if (isSessionLockAcquireTimeoutError(err)) {
                const message = err.message || String(err);
                activityCtx.traceInfo(`[runTurn] ${message}`);
                if (catalog) {
                    await cmsRetryBestEffort(
                        `runTurn.lockTimeout recordEvent session.error session=${input.sessionId}`,
                        () => catalog!.recordEvents(input.sessionId, [{
                            eventType: "session.error",
                            data: { message, errorType: "session_lock_timeout" },
                        }], workerNodeId),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                    await cmsRetryBestEffort(
                        `runTurn.lockTimeout updateSession state=error session=${input.sessionId}`,
                        () => catalog!.updateSession(input.sessionId, {
                            state: "error",
                            lastError: message,
                            waitReason: null,
                            lastActiveAt: new Date(),
                        }),
                        (msg) => activityCtx.traceInfo(msg),
                    );
                }
                finalTurnResult = { type: "error", message } as TurnResult;
                return finalTurnResult;
            }
            turnSpan.recordException(err);
            turnSpan.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
            throw err;
        } finally {
            if (turnTelemetry.modelSummary) {
                turnSpan.setAttribute("pilotswarm.model_summary", turnTelemetry.modelSummary);
            }
            turnSpan.setAttribute("pilotswarm.tokens_input", turnTelemetry.tokensInput);
            turnSpan.setAttribute("pilotswarm.tokens_output", turnTelemetry.tokensOutput);
            turnSpan.setAttribute("pilotswarm.tokens_cache_read", turnTelemetry.tokensCacheRead);
            turnSpan.setAttribute("pilotswarm.tokens_cache_write", turnTelemetry.tokensCacheWrite);
            turnSpan.setAttribute("pilotswarm.tool_calls", turnTelemetry.toolCalls);
            turnSpan.setAttribute("pilotswarm.tool_errors", turnTelemetry.toolErrors);
            if (turnTelemetry.toolNames.size > 0) {
                turnSpan.setAttribute("pilotswarm.tool_names", Array.from(turnTelemetry.toolNames).sort().join(","));
            }
            if (finalTurnResult) {
                turnSpan.setAttribute("pilotswarm.turn_result", finalTurnResult.type);
                if (finalTurnResult.type === "error") {
                    turnSpan.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: (finalTurnResult as any).message || "turn failed",
                    });
                }
            }
            turnSpan.end();
            if (cancelPoll) clearInterval(cancelPoll);
            const clientToStop: PilotSwarmClient | null = inlineSdkClient;
            if (clientToStop) {
                try { await (clientToStop as any).stop(); } catch {}
            }
        }
    };
    runtime.registerActivity("runTurn", runTurnHandler);
    // Session regeneration: the epoch-start turn dispatches under a NEW
    // activity name so pre-1.0.67 workers — which would silently resume the
    // dead transcript — structurally cannot receive it (deployment gate §4).
    runtime.registerActivity("runTurn2", runTurnHandler);

    // ── abortTurn ────────────────────────────────────────────
    // Stop-turn fast-path interrupt. Routed on the session affinity key so it
    // lands on the worker owning the warm ManagedSession and runs CONCURRENTLY
    // with the in-flight runTurn activity (stable workerNodeId + free slot).
    // Bypasses the per-session run-turn lock by design; only touches in-memory
    // state and returns its outcome — the orchestration owns CMS bookkeeping.
    runtime.registerActivity("abortTurn", async (
        activityCtx: any,
        input: { sessionId: string; reason?: string; expectedTurnIndex?: number },
    ): Promise<AbortTurnResult> => {
        const reason = input.reason || "Stopped by user";
        activityCtx.traceInfo(
            `[abortTurn] session=${input.sessionId} expectedTurn=${input.expectedTurnIndex ?? "any"}`,
        );
        const result = await sessionManager.abortWarmSessionTurn(input.sessionId, {
            reason,
            ...(input.expectedTurnIndex != null ? { expectedTurnIndex: input.expectedTurnIndex } : {}),
        });
        activityCtx.traceInfo(
            `[abortTurn] session=${input.sessionId} outcome=${result.outcome}${result.detail ? ` (${result.detail})` : ""}`,
        );
        return result;
    });

    // ── LEGACY LIFECYCLE ACTIVITIES (compat surface, not dead code) ──
    //
    // dehydrateSession / hydrateSession / needsHydrationSession /
    // checkpointSession are scheduled ONLY by frozen orchestration versions
    // (≤ 1.0.56: their processPrompt probes needsHydrationSession before
    // every turn, their wait policy dehydrates, their warm continue-as-new
    // checkpoints) and by 1.0.57's one-shot normalization of a legacy CAN
    // input (hydrateSession when input.needsHydration=true). The lifecycle
    // protocol itself never schedules any of them — hydrate/commit live
    // inside the runTurn activity (P5).
    //
    // Retirement condition: when the ≤1.0.56 handlers are dropped from
    // DURABLE_SESSION_ORCHESTRATION_REGISTRY, delete these registrations
    // (and the session-proxy methods that schedule them) in the same
    // change. Until then they must stay byte-compatible.

    // ── dehydrateSession ────────────────────────────────────
    runtime.registerActivity("dehydrateSession", async (
        activityCtx: any,
        input: { sessionId: string; reason?: string; eventData?: Record<string, unknown> },
    ): Promise<{ lossyHandoff?: Record<string, unknown> } | void> => {
        const reason = input.reason ?? "unknown";
        const eventData = normalizeEventData(input.eventData);
        const trace = activityTrace(activityCtx, "dehydrateSession");
        const dehydrationSpan = otelTrace.getTracer("pilotswarm-lifecycle").startSpan("session.dehydration", {
            attributes: {
                "pilotswarm.session_id": input.sessionId,
                "pilotswarm.dehydration_reason": reason,
                "pilotswarm.worker_node_id": workerNodeId,
            },
        });
        trace(`session=${input.sessionId} start reason=${reason}`);

        try {
            try {
                await sessionManager.dehydrate(input.sessionId, reason, { trace });
            } catch (err: any) {
                const message = err?.message || String(err);
                if (isMissingDehydrateSnapshotErrorMessage(message)) {
                    const sessionStoreAttemptCount = Number(err?.sessionStoreAttemptCount) || undefined;
                    const lossyHandoffData = {
                        ...(eventData ?? {}),
                        reason,
                        cause: "missing_local_session_state_during_dehydrate",
                        message:
                            `Worker lost local Copilot session state before dehydrate completed for ${input.sessionId}. ` +
                            "The next turn will recreate a fresh Copilot session and continue with possible data loss.",
                        detail:
                            "Local session files were unavailable during dehydrate, so the latest live Copilot state " +
                            "could not be durably archived.",
                        error: message,
                        recoveryMode: "fresh_session_replay",
                        nextStep: "recreate_copilot_session_on_next_turn",
                        ...(sessionStoreAttemptCount ? { sessionStoreAttemptCount } : {}),
                        ...(typeof err?.sessionStoreError === "string" ? { sessionStoreError: err.sessionStoreError } : {}),
                    };
                    trace(`session=${input.sessionId} lossy handoff reason=${reason} error=${message}`);
                    dehydrationSpan.setAttribute("pilotswarm.dehydration_result", "lossy_handoff");
                    dehydrationSpan.setAttribute("pilotswarm.lossy_handoff", true);
                    dehydrationSpan.setStatus({ code: SpanStatusCode.ERROR, message });
                    await recordLossyHandoffEvent(
                        catalog,
                        input.sessionId,
                        workerNodeId,
                        lossyHandoffData,
                        (failureMessage) => activityCtx.traceInfo(`[dehydrateSession] ${failureMessage}`),
                    );
                    return { lossyHandoff: lossyHandoffData };
                }
                trace(`session=${input.sessionId} failed reason=${reason} error=${message}`);
                dehydrationSpan.setAttribute("pilotswarm.dehydration_result", "error");
                dehydrationSpan.recordException(err);
                dehydrationSpan.setStatus({ code: SpanStatusCode.ERROR, message });
                if (catalog) {
                    const sessionStoreAttemptCount = Number(err?.sessionStoreAttemptCount) || undefined;
                    await catalog.recordEvents(input.sessionId, [{
                        eventType: "session.error",
                        data: {
                            ...(eventData ?? {}),
                            reason,
                            message,
                            ...(sessionStoreAttemptCount ? { sessionStoreAttemptCount } : {}),
                            ...(typeof err?.sessionStoreError === "string" ? { sessionStoreError: err.sessionStoreError } : {}),
                        },
                    }], workerNodeId).catch((catalogErr: any) => {
                        activityCtx.traceInfo(`[dehydrateSession] CMS failure event write failed: ${catalogErr}`);
                    });
                    await catalog.updateSession(input.sessionId, {
                        lastError: message,
                        lastActiveAt: new Date(),
                    }).catch((catalogErr: any) => {
                        activityCtx.traceInfo(`[dehydrateSession] CMS lastError update failed: ${catalogErr}`);
                    });
                }
                throw err;
            }

            trace(`session=${input.sessionId} complete reason=${reason}`);

            dehydrationSpan.setAttribute("pilotswarm.dehydration_result", "completed");
            if (catalog) {
                const snapshotSizeBytes = await tryReadSnapshotSizeBytes(sessionStore, input.sessionId);
                if (snapshotSizeBytes != null) {
                    dehydrationSpan.setAttribute("pilotswarm.snapshot_size_bytes", snapshotSizeBytes);
                }
                await catalog.upsertSessionMetricSummary(input.sessionId, {
                    ...(snapshotSizeBytes != null ? { snapshotSizeBytes } : {}),
                    dehydrationCountIncrement: 1,
                    lastDehydratedAt: true,
                }).catch((err: any) => {
                    activityCtx.traceInfo(`[dehydrateSession] CMS summary update failed: ${err}`);
                });
                await catalog.recordEvents(input.sessionId, [{
                    eventType: "session.dehydrated",
                    data: {
                        reason,
                        ...(eventData ?? {}),
                    },
                }], workerNodeId).catch((err: any) => {
                    activityCtx.traceInfo(`[dehydrateSession] CMS success event write failed: ${err}`);
                });
            }
        } finally {
            dehydrationSpan.end();
        }
    });

    runtime.registerActivity("needsHydrationSession", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<boolean> => {
        const trace = activityTrace(activityCtx, "needsHydrationSession");
        trace(`session=${input.sessionId} start`);
        try {
            const result = await sessionManager.needsHydration(input.sessionId, { trace });
            trace(`session=${input.sessionId} result=${result}`);
            return result;
        } catch (error: unknown) {
            trace(`session=${input.sessionId} failed error=${errorMessage(error)}`);
            throw error;
        }
    });

    // ── hydrateSession ──────────────────────────────────────
    runtime.registerActivity("hydrateSession", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<void> => {
        const trace = activityTrace(activityCtx, "hydrateSession");
        const hydrationSpan = otelTrace.getTracer("pilotswarm-lifecycle").startSpan("session.hydration", {
            attributes: {
                "pilotswarm.session_id": input.sessionId,
                "pilotswarm.worker_node_id": workerNodeId,
            },
        });
        trace(`session=${input.sessionId} start`);
        try {
            try {
                await sessionManager.hydrate(input.sessionId, { trace });
            } catch (error: unknown) {
                trace(`session=${input.sessionId} failed error=${errorMessage(error)}`);
                hydrationSpan.setAttribute("pilotswarm.hydration_result", "error");
                hydrationSpan.recordException(error as Error);
                hydrationSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
                throw error;
            }
            trace(`session=${input.sessionId} complete`);
            hydrationSpan.setAttribute("pilotswarm.hydration_result", "completed");
            if (catalog) {
                // Best-effort: metric summary and the session.hydrated event are
                // observability only. Never block hydrate on CMS hiccups.
                await cmsRetryBestEffort(
                    `hydrateSession.upsertSummary session=${input.sessionId}`,
                    () => catalog!.upsertSessionMetricSummary(input.sessionId, {
                        hydrationCountIncrement: 1,
                        lastHydratedAt: true,
                    }),
                    (msg) => activityCtx.traceInfo(msg),
                );
                await cmsRetryBestEffort(
                    `hydrateSession.recordEvents session=${input.sessionId}`,
                    () => catalog!.recordEvents(input.sessionId, [{
                        eventType: "session.hydrated",
                        data: {},
                    }], workerNodeId),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
        } finally {
            hydrationSpan.end();
        }
    });

    // ── destroySession ──────────────────────────────────────
    runtime.registerActivity("destroySession", async (
        _ctx: any,
        input: { sessionId: string },
    ): Promise<void> => {
        await sessionManager.destroySession(input.sessionId);
    });

    // ── checkpointSession ───────────────────────────────────
    runtime.registerActivity("checkpointSession", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<void> => {
        await sessionManager.checkpoint(input.sessionId);
        if (catalog) {
            const snapshotSizeBytes = await tryReadSnapshotSizeBytes(sessionStore, input.sessionId);
            // Best-effort: metric summary is observability only. The blob has
            // already been written by sessionManager.checkpoint above.
            await cmsRetryBestEffort(
                `checkpointSession.upsertSummary session=${input.sessionId}`,
                () => catalog!.upsertSessionMetricSummary(input.sessionId, {
                    ...(snapshotSizeBytes != null ? { snapshotSizeBytes } : {}),
                    lastCheckpointAt: true,
                }),
                (msg) => activityCtx.traceInfo(msg),
            );
        }
    });

    // ── listModels ──────────────────────────────────────────
    // Always register — the model registry is the authoritative source.
    // Falls back to SDK listModels if a GitHub token is available.
    runtime.registerActivity("listModels", async (
        activityCtx: any,
        _input: Record<string, unknown>,
    ): Promise<string> => {
        activityCtx.traceInfo("[listModels] fetching");
        if (githubToken) {
            const { CopilotClient } = await import("@github/copilot-sdk");
            const sdk = new CopilotClient({ gitHubToken: githubToken });
            try {
                await sdk.start();
                const models = await sdk.listModels();
                return JSON.stringify(models.map((m: any) => ({ id: m.id })));
            } finally {
                try { await sdk.stop(); } catch {}
            }
        }
        // No GitHub token — return empty (registry models are injected by the tool handler)
        return JSON.stringify([]);
    });

    // ── summarizeSession ────────────────────────────────────
    // Fetches recent conversation from CMS, asks a lightweight LLM
    // for a 3-5 word title, and writes it back to CMS.
    if (catalog) {
        runtime.registerActivity("summarizeSession", async (
            activityCtx: any,
            input: { sessionId: string },
        ): Promise<string> => {
            activityCtx.traceInfo(`[summarizeSession] session=${input.sessionId}`);

            // Never overwrite system session titles (e.g. "Sweeper Agent")
            const session = await catalog.getSession(input.sessionId);
            if (session?.isSystem) {
                activityCtx.traceInfo(`[summarizeSession] skipping system session`);
                return session.title || "";
            }
            if (session?.titleLocked) {
                activityCtx.traceInfo(`[summarizeSession] skipping locked title`);
                return session.title || "";
            }

            // Named agent sessions have a title prefix (e.g. "Alpha Agent: <shortId>").
            // Detect this so we can preserve the prefix after summarization.
            const agentTitlePrefix = session?.agentId && session?.title?.includes(": ")
                ? session.title.split(": ")[0]
                : null;

            const events = await catalog.getSessionEvents(input.sessionId, undefined, 50);
            if (!events || events.length === 0) return "";

            // Build a condensed conversation transcript
            const lines: string[] = [];
            const userMessages: string[] = [];
            const assistantMessages: string[] = [];
            for (const evt of events) {
                if (evt.eventType === "user.message") {
                    const content = (evt.data as any)?.content;
                    if (content) {
                        const trimmed = String(content).trim();
                        // Canvas actions are wire-format JSON, not prose —
                        // titling a session "canvas-action action send data"
                        // is how one leaked into a session list.
                        if (trimmed && !trimmed.startsWith("[canvas-action] ")) {
                            lines.push(`User: ${trimmed.slice(0, 200)}`);
                            userMessages.push(trimmed);
                        }
                    }
                } else if (evt.eventType === "assistant.message") {
                    const content = (evt.data as any)?.content;
                    if (content) {
                        const trimmed = String(content).trim();
                        if (trimmed) {
                            lines.push(`Assistant: ${trimmed.slice(0, 200)}`);
                            assistantMessages.push(trimmed);
                        }
                    }
                }
            }
            if (lines.length === 0) return "";

            const persistSummaryTitle = async (
                rawTitle: string,
                source: "llm" | "fallback",
            ): Promise<string> => {
                // Defensive cleanup: models occasionally wrap the title in
                // quotes or add trailing punctuation despite instructions.
                // Models sometimes emit HTML-escaped text when the material
                // they summarized was itself escaped, which persisted titles
                // like "PostgreSQL &amp; MySQL". Titles are rendered as plain
                // text everywhere, so decode before storing. (&amp; last, or
                // "&amp;lt;" would collapse to "<".)
                const cleaned = String(rawTitle || "")
                    .trim()
                    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
                    .replace(/[.。!?…\s]+$/g, "")
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&quot;/g, '"')
                    .replace(/&#0?39;|&apos;/g, "'")
                    .replace(/&nbsp;/g, " ")
                    .replace(/&amp;/g, "&")
                    .trim();
                const title = cleaned.slice(0, 60).trim();
                if (!title) return "";
                const finalTitle = agentTitlePrefix ? `${agentTitlePrefix}: ${title}` : title;
                if (finalTitle === session?.title) return "";
                await catalog.updateSession(input.sessionId, { title: finalTitle });
                activityCtx.traceInfo(`[summarizeSession] ${source} title="${finalTitle}"`);
                return title;
            };

            const buildFallbackSummaryTitle = (): string => {
                const sourceText = userMessages[0] || assistantMessages[0] || transcript;
                const cleanedWords = String(sourceText)
                    .replace(/\s+/g, " ")
                    .trim()
                    .split(" ")
                    .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
                    .filter(Boolean);
                if (cleanedWords.length === 0) return "Recent Conversation";
                const desiredWords = Math.min(5, Math.max(3, cleanedWords.length >= 3 ? 3 : cleanedWords.length));
                const summary = cleanedWords.slice(0, desiredWords).join(" ");
                return summary || "Recent Conversation";
            };

            const transcript = lines.join("\n");
            const summaryPrompt =
                "Write a short, specific title (4-8 words) for this session so it is easy to " +
                "recognize in a long session list. Capture WHAT the session is about — the task, " +
                "target system, repo, PR, workflow, or goal — never the latest status update, a " +
                "greeting, or repeated monitoring chatter. For a recurring/supervision loop, name " +
                "what it monitors or produces, not the current cycle's progress. Prefer concrete " +
                "nouns and identifiers from the conversation (repo names, PR/work-item numbers, " +
                "feature names). Ignore filler or nonsense fragments in the transcript. " +
                "Return ONLY the title: no quotes, no trailing punctuation, no preamble.\n\n" +
                transcript;

            // Use a one-shot CopilotSession to generate the title.
            // Prefer the default provider from the registry (works without GitHub token).
            const { CopilotClient: SdkClient } = await import("@github/copilot-sdk");
            const sdk = new SdkClient({ ...(githubToken ? { gitHubToken: githubToken } : {}) });
            try {
                await sdk.start();
                // Resolve the default model + provider from the registry
                const defaultProvider = sessionManager.resolveDefaultProvider();
                const sessionOpts: any = {
                    onPermissionRequest: approvePermissionForSession,
                };
                if (defaultProvider) {
                    sessionOpts.model = defaultProvider.modelName;
                    sessionOpts.provider = defaultProvider.sdkProvider;
                } else if (githubToken) {
                    sessionOpts.model = "gpt-4o-mini";
                } else {
                    activityCtx.traceInfo("[summarizeSession] no provider and no GitHub token — skipping");
                    await sdk.stop();
                    return "";
                }
                const tempSession = await sdk.createSession(sessionOpts);
                let title = "";
                await new Promise<void>((resolve, reject) => {
                    tempSession.on("assistant.message", (event: any) => {
                        title = (event.data?.content || "").trim();
                    });
                    tempSession.on("session.idle", () => resolve());
                    tempSession.on("session.error", (event: any) => reject(new Error(event.data?.message || "session error")));
                    tempSession.send({ prompt: summaryPrompt });
                });
                await sdk.stop();

                const savedTitle = await persistSummaryTitle(title, "llm");
                if (savedTitle) return savedTitle;

                const fallbackTitle = await persistSummaryTitle(buildFallbackSummaryTitle(), "fallback");
                return fallbackTitle;
            } catch (err: any) {
                activityCtx.traceInfo(`[summarizeSession] failed: ${err.message}`);
                try { await sdk.stop(); } catch {}
                return await persistSummaryTitle(buildFallbackSummaryTitle(), "fallback");
            }
        });
    }

    // ── resolveAgentConfig ────────────────────────────────────
    // Resolves a loaded agent definition by name. User-creatable agents return
    // creatable=true. Worker-managed system agents return creatable=false so
    // callers can surface a clear error instead of spawning them.
    //
    // Matching, package privacy, and owner shadowing all live in
    // resolveAgentDefinitionForCaller — shared with the control bridge so
    // spawn_agent/create_agent_session and this activity can never disagree
    // about which agent a name means.
    runtime.registerActivity("resolveAgentConfig", async (
        _activityCtx: any,
        input: { agentName: string; callerSessionId?: string },
    ): Promise<ResolvedAgentDefinition | null> => {
        return resolveAgentDefinitionForCaller({
            agentName: input.agentName,
            userAgents,
            systemAgents,
            // PACKAGE PRIVACY, enforced at RESOLUTION rather than at creation.
            //
            // Workers install every enabled package, including other users'
            // user-scope ones, so `userAgents` is a fleet-wide list with no
            // tenancy in it. The Web API filters package agents when a session
            // is created (`_authorizePackageAgentCreate`), but `spawn_agent`
            // reaches this activity directly and never passes through that
            // filter — so a name match alone would hand Alice's private agent,
            // prompt and all, to Bob's session.
            //
            // It has to be enforced HERE and not at spawn time: the return
            // value carries the agent's full prompt, and merely returning it
            // writes that prompt into the caller's orchestration history.
            //
            // Deployment-owned plugin agents carry no package owner and stay
            // public, exactly as before.
            getCallerOwnerKey: async () => {
                const row = input.callerSessionId
                    ? await catalog?.getSession(input.callerSessionId)
                    : null;
                const owner = row?.owner as any;
                return owner?.provider && owner?.subject
                    ? `${owner.provider}\u0001${owner.subject}`
                    : null;
            },
        });
    });

    // ── spawnChildSession ─────────────────────────────────────
    // Creates a child session via the PilotSwarmClient SDK.
    // System child agents with a stable agentId use a deterministic UUID.
    // Other child sessions use a random UUID.
    // Goes through the full SDK path: CMS registration + orchestration startup.
    runtime.registerActivity("spawnChildSession", async (
        activityCtx: any,
        input: { parentSessionId: string; config: SerializableSessionConfig; task: string; nestingLevel?: number; isSystem?: boolean; title?: string; agentId?: string; splash?: string; titleIsExplicit?: boolean; initialRequiredTool?: string },
    ): Promise<string> => {
        const startedAt = Date.now();
        const trace = (message: string) => {
            activityCtx.traceInfo(`[spawnChildSession] +${Date.now() - startedAt}ms ${message}`);
        };
        const isDeterministicSystemChild = Boolean(input.isSystem && input.agentId);
        const childSessionId = isDeterministicSystemChild
            ? systemChildAgentUUID(input.parentSessionId, input.agentId!)
            : crypto.randomUUID();
        trace(`child=${childSessionId} parent=${input.parentSessionId} nesting=${input.nestingLevel ?? 0} isSystem=${input.isSystem ?? false} agent=${input.agentId ?? "custom"}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            ...internalClientConfig(),
            traceWriter: (message: string) => trace(message),
        });
        try {
            const clientStartAt = Date.now();
            await sdkClient.start();
            trace(`sdkClient.start done (${Date.now() - clientStartAt}ms)`);

            if (isDeterministicSystemChild && catalog) {
                const existingCheckAt = Date.now();
                // Critical: missing this read causes a duplicate child spawn for
                // a deterministic system agent (same UUID, two creates).
                const existing = await cmsRetryCritical(
                    `spawnChildSession.getSession existing-check session=${childSessionId}`,
                    () => catalog!.getSession(childSessionId),
                    (msg) => activityCtx.traceInfo(msg),
                );
                trace(`catalog.getSession existing check done (${Date.now() - existingCheckAt}ms)`);
                if (existing && !["completed", "failed", "terminated"].includes(existing.state)) {
                    trace(`reusing existing live system child: ${childSessionId}`);
                    return childSessionId;
                }
            }

            // Mark as system session BEFORE createSession so OrchestrationInput gets isSystem=true
            if (input.isSystem) {
                sdkClient.systemSessions.add(childSessionId);
            }

            // Child sessions may inherit a parent model that was created with a
            // bare alias such as "gpt-4.1". Normalize it here, but do not
            // require that the stored value is already provider-qualified.
            const normalizedModel = sessionManager.normalizeModelRef(input.config.model);
            if (normalizedModel) {
                input.config.model = normalizedModel;
            }
            trace(`model normalization done (${input.config.model ?? "inherit"})`);

            // Inherit the lineage's EFFECTIVE owner so the spawned child
            // renders under the same owner-filtered tree the parent already
            // passes: the nearest owned ancestor's user, or the SYSTEM user
            // principal when the lineage is system (system sessions are
            // ownerless by design — mapping to the System user lets the child
            // resolve the admin-stored System GitHub Copilot key through the
            // ordinary per-owner path while staying a normal deletable
            // session). True system children (input.isSystem — the
            // worker-managed agents) stay unowned by design and keep their
            // is_system row flag.
            let inheritedOwner: any = null;
            if (!input.isSystem && catalog) {
                const ownerLookupAt = Date.now();
                inheritedOwner = await resolveEffectiveSpawnOwner(
                    // Critical: skipping this read leaves the child unowned,
                    // making it invisible under owner-filtered tree views.
                    (id) => cmsRetryCritical(
                        `spawnChildSession.getSession ancestor=${id}`,
                        () => catalog!.getSession(id),
                        (msg) => activityCtx.traceInfo(msg),
                    ),
                    input.parentSessionId,
                );
                trace(`owner inheritance lookup done (${Date.now() - ownerLookupAt}ms; ${inheritedOwner ? "found" : "none"})`);
            }

            // Create the child session via the SDK — handles CMS row + orchestration start
            const createSessionAt = Date.now();
            const session = await sdkClient.createSession({
                sessionId: childSessionId,
                parentSessionId: input.parentSessionId,
                nestingLevel: input.nestingLevel,
                ...childModelCreationOptions(input.config),
                systemMessage: input.config.systemMessage,
                boundAgentName: input.config.boundAgentName,
                promptLayering: input.config.promptLayering,
                toolNames: input.config.toolNames,
                waitThreshold: input.config.waitThreshold,
                agentId: input.agentId,
                ...(inheritedOwner ? { owner: inheritedOwner } : {}),
            });
            trace(`sdkClient.createSession done (${Date.now() - createSessionAt}ms)`);

            // One-time metadata write: isSystem, title, agentId, splash
            const meta: Record<string, any> = {};
            if (input.isSystem) meta.isSystem = true;
            // Named agents get a prefixed title: "Agent Title: <shortId>"
            // System agents keep their fixed title as-is.
            if (input.title && (input.titleIsExplicit || input.isSystem)) {
                meta.title = input.title;
            } else if (input.title) {
                meta.title = `${input.title}: ${childSessionId.slice(0, 8)}`;
            }
            if (input.agentId) meta.agentId = input.agentId;
            if (input.splash) meta.splash = input.splash;
            // Frozen orchestration versions don't thread splashMobile through
            // the spawn input, so resolve it from the loaded agent definition.
            if (input.agentId) {
                const normalizeId = (value?: string) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
                const lookup = normalizeId(input.agentId);
                const agentDef = [...(userAgents ?? []), ...(systemAgents ?? [])].find(
                    (a: any) => [a.id, a.name].map(normalizeId).filter(Boolean).includes(lookup),
                ) as any;
                if (agentDef?.splashMobile) meta.splashMobile = agentDef.splashMobile;
            }
            if (Object.keys(meta).length > 0 && catalog) {
                const metaAt = Date.now();
                // Critical: title/agentId/splash drive UI rendering of the
                // newly-spawned child. Idempotent — set-style update.
                await cmsRetryCritical(
                    `spawnChildSession.updateSession meta session=${childSessionId}`,
                    () => catalog!.updateSession(childSessionId, meta),
                    (msg) => activityCtx.traceInfo(msg),
                );
                trace(`catalog.updateSession meta done (${Date.now() - metaAt}ms)`);
            }

            // Fire the initial task prompt (non-blocking: just enqueues).
            // This prompt is orchestration-generated bootstrap state for the child
            // session, not an actual user-authored message inside that child chat.
            const sendAt = Date.now();
            await session.send(input.task, {
                ...initialAgentTurnOptions(input.initialRequiredTool),
                // The comment above says it: this is orchestration-generated
                // bootstrap state, not a user-authored message. Say so in the
                // record, or the child's transcript opens under "You:".
                sender: { kind: "agent", sessionId: input.parentSessionId, display: "parent agent · task" },
            });
            trace(`session.send bootstrap done (${Date.now() - sendAt}ms)`);

            trace(`session created and task sent: ${childSessionId}`);
            return childSessionId;
        } finally {
            const clientStopAt = Date.now();
            await sdkClient.stop();
            trace(`sdkClient.stop done (${Date.now() - clientStopAt}ms total=${Date.now() - startedAt}ms)`);
        }
    });

    // ── sendToSession ───────────────────────────────────────
    // Sends a message to any session's orchestration event queue directly.
    // Does NOT call session.send() (which tries to start/resume the orchestration).
    // Instead, enqueues directly to the existing orchestration's "messages" queue.
    runtime.registerActivity("sendToSession", async (
        activityCtx: any,
        input: { sessionId: string; message: string },
    ): Promise<void> => {
        activityCtx.traceInfo(`[sendToSession] session=${input.sessionId} msg="${input.message.slice(0, 60)}"`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            const info = await (sdkClient as any)._getSessionInfo(input.sessionId);
            if (info?.status === "failed") {
                throw new Error(
                    `Session ${input.sessionId.slice(0, 8)} is a failed terminal orchestration and cannot accept new messages.`,
                );
            }
            if (
                info?.status === "completed"
                && info?.parentSessionId
                && !info?.isSystem
                && !info?.cronActive
                && !info?.cronInterval
            ) {
                throw new Error(
                    `Session ${input.sessionId.slice(0, 8)} is a completed terminal orchestration and cannot accept new messages.`,
                );
            }
            // Enqueue directly to the orchestration's event queue
            const orchestrationId = `session-${input.sessionId}`;
            await (sdkClient as any).duroxideClient.enqueueEvent(
                orchestrationId,
                "messages",
                JSON.stringify({ prompt: input.message }),
            );
            activityCtx.traceInfo(`[sendToSession] enqueued to ${orchestrationId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── sendCommandToSession ────────────────────────────────
    // Sends a raw JSON command directly to a session's orchestration event queue.
    // Unlike sendToSession, this does NOT wrap the payload in { prompt: ... }.
    runtime.registerActivity("sendCommandToSession", async (
        activityCtx: any,
        input: { sessionId: string; command: any },
    ): Promise<void> => {
        activityCtx.traceInfo(`[sendCommandToSession] session=${input.sessionId} cmd=${input.command?.cmd}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            const orchestrationId = `session-${input.sessionId}`;
            await (sdkClient as any).duroxideClient.enqueueEvent(
                orchestrationId,
                "messages",
                JSON.stringify(input.command),
            );
            activityCtx.traceInfo(`[sendCommandToSession] enqueued to ${orchestrationId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── getSessionStatus ────────────────────────────────────
    // Gets the status of a session via the PilotSwarmClient SDK.
    runtime.registerActivity("getSessionStatus", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<string> => {
        activityCtx.traceInfo(`[getSessionStatus] session=${input.sessionId}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            const info = await sdkClient._getSessionInfo(input.sessionId);
            return JSON.stringify({
                sessionId: info.sessionId,
                status: info.status,
                title: info.title,
                iterations: info.iterations,
                result: info.result,
                error: info.error,
            });
        } finally {
            await sdkClient.stop();
        }
    });

    // ── getOrchestrationStats ───────────────────────────────
    // Gets duroxide orchestration runtime stats for a session.
    runtime.registerActivity("getOrchestrationStats", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<SessionOrchestrationStats | null> => {
        activityCtx.traceInfo(`[getOrchestrationStats] session=${input.sessionId}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmManagementClient");

        const managementClient = new PilotSwarmManagementClient(internalClientConfig());
        try {
            await managementClient.start();
            return await managementClient.getOrchestrationStats(input.sessionId);
        } finally {
            await managementClient.stop();
        }
    });

    // ── listSessions ────────────────────────────────────────
    // Lists all sessions via the PilotSwarmClient SDK.
    runtime.registerActivity("listSessions", async (
        activityCtx: any,
        input: { includeSystem?: boolean; ownerQuery?: string; ownerKind?: string },
    ): Promise<string> => {
        activityCtx.traceInfo(`[listSessions]`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            const sessions = (await sdkClient.listSessions()).filter((session) => matchesSessionOwnerFilters(session, input));
            return JSON.stringify(sessions.map(s => ({
                sessionId: s.sessionId,
                title: s.title,
                owner: s.owner ?? null,
                ownerKind: getSessionOwnerKind(s),
                status: s.status,
                iterations: s.iterations,
                parentSessionId: s.parentSessionId,
                error: s.error,
            })));
        } finally {
            await sdkClient.stop();
        }
    });

    // ── listChildSessions ───────────────────────────────────
    // Lists direct child sessions of a parent with merged live status.
    runtime.registerActivity("listChildSessions", async (
        activityCtx: any,
        input: { parentSessionId: string },
    ): Promise<string> => {
        activityCtx.traceInfo(`[listChildSessions] parent=${input.parentSessionId}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            const sessions = await sdkClient.listSessions();
            const directChildren = sessions.filter(s => s.parentSessionId === input.parentSessionId);
            const enriched = await Promise.all(directChildren.map(async (child) => {
                const info = await sdkClient._getSessionInfo(child.sessionId);
                const outcome = catalog ? await catalog.getChildOutcome(child.sessionId).catch(() => null) : null;
                const outcomeResult = normalizeJsonObject(outcome?.resultJson?.current);
                const contractCurrent = normalizeJsonObject(outcome?.contractJson?.current);
                return {
                    orchId: `session-${child.sessionId}`,
                    sessionId: child.sessionId,
                    title: info.title ?? child.title,
                    status: info.status,
                    iterations: info.iterations ?? child.iterations ?? 0,
                    parentSessionId: child.parentSessionId,
                    isSystem: child.isSystem ?? info.isSystem ?? false,
                    agentId: child.agentId ?? info.agentId,
                    result: outcome?.summary ?? (typeof outcomeResult?.summary === "string" ? outcomeResult.summary : info.result),
                    contract: contractCurrent ?? undefined,
                    contractStatus: outcome?.contractJson ? "contracted" : undefined,
                    verdict: outcome?.verdict ?? undefined,
                    contractViolations: Array.isArray(outcomeResult?.contractViolations) ? outcomeResult.contractViolations : undefined,
                    error: info.error,
                };
            }));
            return JSON.stringify(enriched);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── notifyParent ────────────────────────────────────────
    // Sends a child_updates event to the parent orchestration so it can
    // wake up from durable sleep and process the child's result.
    // Uses raw enqueueEvent because it targets the "child_updates" queue,
    // not the standard "messages" queue that session.send() uses.
    runtime.registerActivity("notifyParent", async (
        activityCtx: any,
        input: { parentOrchId: string; childOrchId: string; childSessionId: string; update: any },
    ): Promise<void> => {
        activityCtx.traceInfo(`[notifyParent] parent=${input.parentOrchId} child=${input.childOrchId} type=${input.update?.type}`);
        if (!provider) throw new Error("No provider available");
        const { Client } = (await import("node:module")).createRequire(import.meta.url)("duroxide");
        const client = new Client(provider);
        await client.enqueueEvent(
            input.parentOrchId,
            "child_updates",
            JSON.stringify({
                childOrchId: input.childOrchId,
                childSessionId: input.childSessionId,
                ...input.update,
            }),
        );
    });

    // ── getDescendantSessionIds ──────────────────────────────
    // Returns all descendant session IDs (children, grandchildren, etc.)
    // Used by cancel/delete to cascade to grandchildren.
    runtime.registerActivity("getDescendantSessionIds", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<string[]> => {
        activityCtx.traceInfo(`[getDescendantSessionIds] session=${input.sessionId}`);
        if (!catalog) return [];
        // Critical: delete cascade depends on this list. Skipping descendants
        // would orphan child sessions, so retry transient PG errors hard.
        const descendants = await cmsRetryCritical(
            `getDescendantSessionIds session=${input.sessionId}`,
            () => catalog!.getDescendantSessionIds(input.sessionId),
            (msg) => activityCtx.traceInfo(msg),
        );
        activityCtx.traceInfo(`[getDescendantSessionIds] found ${descendants.length} descendants`);
        return descendants;
    });

    // ── cancelSession ───────────────────────────────────────
    // Cancels a session's orchestration (terminates immediately).
    runtime.registerActivity("cancelSession", async (
        activityCtx: any,
        input: { sessionId: string; reason?: string },
    ): Promise<void> => {
        activityCtx.traceInfo(`[cancelSession] session=${input.sessionId} reason=${input.reason ?? "none"}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            const orchestrationId = `session-${input.sessionId}`;
            // Cancel the orchestration via duroxide
            await (sdkClient as any).duroxideClient.cancelInstance(
                orchestrationId,
                input.reason ?? "Cancelled by parent",
            );
            // Update CMS status. Critical — terminal state must land in CMS
            // for clients to see the session as cancelled. Retry transient PG
            // errors hard; non-transient errors propagate to the caller.
            if (catalog) {
                await cmsRetryCritical(
                    `cancelSession.updateSession session=${input.sessionId}`,
                    () => catalog!.updateSession(input.sessionId, {
                        state: "cancelled",
                        lastError: input.reason ? `Cancelled: ${input.reason}` : "Cancelled",
                        waitReason: null,
                    }),
                    (msg) => activityCtx.traceInfo(msg),
                );
            }
            activityCtx.traceInfo(`[cancelSession] cancelled ${orchestrationId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── deleteSession ───────────────────────────────────────
    // Cancels a session's orchestration AND removes it from CMS.
    runtime.registerActivity("deleteSession", async (
        activityCtx: any,
        input: { sessionId: string; reason?: string },
    ): Promise<void> => {
        activityCtx.traceInfo(`[deleteSession] session=${input.sessionId} reason=${input.reason ?? "none"}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            // This does both: CMS soft-delete + duroxide cancel
            await sdkClient.deleteSession(input.sessionId);
            activityCtx.traceInfo(`[deleteSession] deleted session-${input.sessionId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── updateCmsState ─────────────────────────────────────
    // Updates a session's state in CMS (e.g. "rejected" for policy violations).
    // Critical: this is how terminal state lands in CMS; failure here desyncs
    // CMS from the orchestration's view, so retry transient PG errors hard.
    if (catalog) {
        runtime.registerActivity("updateCmsState", async (
            activityCtx: any,
            input: { sessionId: string; state: string; lastError?: string | null; waitReason?: string | null },
        ): Promise<void> => {
            activityCtx.traceInfo(`[updateCmsState] session=${input.sessionId} state=${input.state}`);
            const updates: { state: string; lastError?: string | null; waitReason?: string | null } = {
                state: input.state,
            };
            if (Object.prototype.hasOwnProperty.call(input, "lastError")) updates.lastError = input.lastError ?? null;
            if (Object.prototype.hasOwnProperty.call(input, "waitReason")) updates.waitReason = input.waitReason ?? null;
            await cmsRetryCritical(
                `updateCmsState session=${input.sessionId} state=${input.state}`,
                () => catalog.updateSession(input.sessionId, { ...updates }),
                (msg) => activityCtx.traceInfo(msg),
            );
        });

        runtime.registerActivity("updateSessionModel", async (
            activityCtx: any,
            input: { sessionId: string; model: string; reasoningEffort?: string | null; contextTier?: string | null; source?: string | null },
        ): Promise<void> => {
            activityCtx.traceInfo(`[updateSessionModel] session=${input.sessionId} model=${input.model}`);
            await cmsRetryCritical(
                `updateSessionModel session=${input.sessionId}`,
                () => catalog.updateSession(input.sessionId, {
                    model: input.model,
                    reasoningEffort: input.reasoningEffort ?? null,
                    contextTier: input.contextTier ?? null,
                    modelResolutionSource: input.source ?? "model_switch",
                }),
                (msg) => activityCtx.traceInfo(msg),
            );
        });
    }

    // ── getWorkerSessionPolicy ──────────────────────────────
    // Returns the worker's session policy and allowed agent names.
    // This is the authoritative source — even if a rogue client omits policy
    // from the OrchestrationInput, the orchestration can fetch it from the worker.
    runtime.registerActivity("getWorkerSessionPolicy", async (
        _activityCtx: any,
        _input: {},
    ): Promise<{ policy: import("./types.js").SessionPolicy | null; allowedAgentNames: string[] }> => {
        return {
            policy: workerSessionPolicy ?? null,
            allowedAgentNames: workerAllowedAgentNames ?? [],
        };
    });

    // ── loadKnowledgeIndex ──────────────────────────────────
    // Reads curated skills and open asks from the facts table for
    // injection into agent context before each turn.
    if (factStore) {
        runtime.registerActivity("loadKnowledgeIndex", async (
            activityCtx: any,
            input: { cap?: number },
        ): Promise<{ skills: Array<{ key: string; name: string; description: string }>; asks: Array<{ key: string; summary: string }> }> => {
            activityCtx.traceInfo("[loadKnowledgeIndex] loading curated skills and open asks");
            const cap = input.cap ?? 50;
            const { skills, asks } = await loadKnowledgeIndexFromFactStore(factStore, cap);

            activityCtx.traceInfo(`[loadKnowledgeIndex] ${skills.length} skills, ${asks.length} asks`);
            return { skills, asks };
        });
    }

    // ── recordSessionEvent ──────────────────────────────────
    // Lightweight CMS event recording for orchestration-level lifecycle events
    // (waits, spawns, cron, commands) that don't happen inside an existing activity.
    // Best-effort: nothing in the orchestration reads these back; losing one
    // degrades UI completeness but does not affect orchestration correctness.
    runtime.registerActivity("recordSessionEvent", async (
        activityCtx: any,
        input: { sessionId: string; events: { eventType: string; data: unknown }[] },
    ): Promise<void> => {
        if (!catalog) return;
        const eventTypes = input.events.map((e) => e.eventType).join(",");
        await cmsRetryBestEffort(
            `recordSessionEvent session=${input.sessionId} events=${eventTypes}`,
            () => catalog!.recordEvents(input.sessionId, input.events, workerNodeId),
            (msg) => activityCtx.traceInfo(msg),
        );
    });

    // -- computeCronAtNextFire --------------------------------
    runtime.registerActivity("computeCronAtNextFire", async (
        activityCtx: any,
        input: { schedule: CronAtSchedule; afterUtcMs: number; lastOccurrenceKey?: string },
    ): Promise<ReturnType<typeof computeCronAtNextFire>> => {
        activityCtx.traceInfo(`[computeCronAtNextFire] tz=${input.schedule?.tz} after=${input.afterUtcMs}`);
        return computeCronAtNextFire(input.schedule, input.afterUtcMs, input.lastOccurrenceKey);
    });

    // ── Session regeneration activities (1.0.67) ──────────────
    const regenDeps = (activityCtx: any) => {
        if (!catalog) throw new Error("session regeneration requires the CMS catalog");
        return {
            catalog,
            artifactStore: artifactStore ?? null,
            resolveModelOptions: (ref?: string) => sessionManager.resolveModelSessionOptions(ref),
            fallbackDistillerModel: process.env.PILOTSWARM_DISTILLER_FALLBACK_MODEL || undefined,
            trace: (message: string) => activityCtx.traceInfo(`[regen] ${message}`),
        };
    };

    runtime.registerActivity("runRegenArchive", async (
        activityCtx: any,
        input: { sessionId: string; epoch: number; attemptId: string },
    ) => {
        activityCtx.traceInfo(`[runRegenArchive] session=${input.sessionId} epoch=${input.epoch} attempt=${input.attemptId}`);
        return runRegenArchive(regenDeps(activityCtx), input);
    });

    runtime.registerActivity("runRegenDistill", async (
        activityCtx: any,
        input: { sessionId: string; epoch: number; attemptId: string; handoff?: string; instructions?: string; sessionModel?: string; distillerModel?: string; archiveArtifactId?: string },
    ) => {
        activityCtx.traceInfo(`[runRegenDistill] session=${input.sessionId} epoch=${input.epoch} attempt=${input.attemptId}`);
        return runRegenDistill(regenDeps(activityCtx), input);
    });

    runtime.registerActivity("commitEpochBoundary", async (
        activityCtx: any,
        input: { sessionId: string; commit: Record<string, unknown> },
    ): Promise<number> => {
        if (!catalog) throw new Error("session regeneration requires the CMS catalog");
        activityCtx.traceInfo(`[commitEpochBoundary] session=${input.sessionId} toEpoch=${(input.commit as any)?.toEpoch}`);
        return catalog.recordEpochCommitted(input.sessionId, input.commit);
    });

    runtime.registerActivity("recordRegenerated", async (
        activityCtx: any,
        input: { sessionId: string; payload: Record<string, unknown> },
    ): Promise<number> => {
        if (!catalog) throw new Error("session regeneration requires the CMS catalog");
        activityCtx.traceInfo(`[recordRegenerated] session=${input.sessionId} epoch=${(input.payload as any)?.epoch}`);
        return catalog.recordRegenerated(input.sessionId, input.payload);
    });

    // ── Service-session distiller activities (1.0.68) ──────────
    // The distiller is a REAL session (service_kind="regen-distiller") under
    // the served tree's ROOT: lifecycle events, metrics, and normal sweeper
    // cleanup apply because nothing is special-cased. Its id is deterministic
    // per attempt so activity retries reuse the same session.

    const distillerSessionIdFor = (sessionId: string, epoch: number, attemptId: string): string => {
        const digest = createHash("sha1")
            .update(`ps-regen-distiller:${sessionId}:e${epoch}:${attemptId}`)
            .digest();
        const b = Buffer.from(digest.subarray(0, 16));
        b[6] = (b[6] & 0x0f) | 0x50; // UUIDv5 version bits
        b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
        const h = b.toString("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    };

    const enqueueDistillerCmd = async (distillerSessionId: string, cmd: "done" | "cancel", idPrefix: string) => {
        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            await (sdkClient as any).duroxideClient.enqueueEvent(
                `session-${distillerSessionId}`,
                "messages",
                JSON.stringify({ type: "cmd", cmd, id: `${idPrefix}-${randomUUID()}` }),
            );
        } finally {
            await sdkClient.stop().catch(() => {});
        }
    };

    runtime.registerActivity("runRegenSpawnDistiller", async (
        activityCtx: any,
        input: { sessionId: string; epoch: number; attemptId: string; archiveArtifactId?: string; archiveChunkIds?: string[]; handoff?: string; instructions?: string; distillerModel?: string; distillerReasoningEffort?: string; distillerContextTier?: string },
    ) => {
        if (!catalog) throw new Error("distiller spawn requires the CMS catalog");
        if (!artifactStore) throw new Error("distiller spawn requires an artifact store");
        if (!storeUrl) throw new Error("distiller spawn requires a storeUrl");
        // Deployment kill switch: force the deterministic package fleet-wide.
        // Read in the ACTIVITY (recorded in history) — never in the orchestration.
        if (process.env.PILOTSWARM_REGEN_DETERMINISTIC_ONLY === "1") {
            return { fallback: "deterministic-only" };
        }
        const deps = regenDeps(activityCtx);
        const distillerSessionId = distillerSessionIdFor(input.sessionId, input.epoch, input.attemptId);
        // Build the seed once — reused by the fresh spawn and by the re-seed
        // path below so a create-then-crash-before-send retry still delivers it.
        const buildSeed = async (): Promise<string> => {
            const closure = await assembleRegenClosure({ catalog, artifactStore: artifactStore! }, input.sessionId);
            const seed = buildMapReduceSeedPrompt({
                servedSessionId: input.sessionId,
                epoch: input.epoch,
                attemptId: input.attemptId,
                archiveArtifactId: input.archiveArtifactId || archiveName(input.epoch, input.attemptId),
                ...(input.archiveChunkIds?.length ? { archiveChunkIds: input.archiveChunkIds } : {}),
                closure,
                ...(input.handoff ? { handoff: input.handoff } : {}),
                ...(input.instructions ? { instructions: input.instructions } : {}),
            });
            // Dump the EXACT distiller input (§9 dumps) on the served session.
            await artifactStore!.uploadArtifact(
                input.sessionId, distillInputName(input.epoch, input.attemptId), Buffer.from(seed, "utf8"), "text/markdown",
            );
            return seed;
        };
        const existing = await catalog.getSession(distillerSessionId).catch(() => null);
        if (existing) {
            // Only reuse a row that is ACTUALLY our distiller for THIS session —
            // re-verify the service columns before trusting its output as this
            // regen's package. The id is per-attempt and unguessable, so a
            // mismatch is not a real attack, but defense-in-depth: never collect
            // a foreign/mislabelled session as the distiller (adversarial-review
            // finding). A mismatch throws → the pipeline falls back deterministically.
            if (existing.serviceKind !== REGEN_DISTILLER_SERVICE_KIND || existing.serviceOf !== input.sessionId) {
                throw new Error(
                    `distiller id collision: ${distillerSessionId} exists but is not this session's distiller `
                    + `(serviceKind=${existing.serviceKind ?? "null"}, serviceOf=${existing.serviceOf ?? "null"})`,
                );
            }
            // Re-seed if the seed never landed (activity retried after
            // createSession but before send): otherwise the distiller sits with
            // no orchestration/work and the regen burns the whole 5-min deadline
            // before falling back (adversarial-review finding). Idempotent —
            // _startTurn ensures the orchestration then enqueues the prompt.
            const seeded = (await catalog.getSessionEventsBefore(distillerSessionId, Number.MAX_SAFE_INTEGER, 1, ["user.message"]).catch(() => [])).length > 0;
            if (!seeded) {
                activityCtx.traceInfo(`[runRegenSpawnDistiller] ${distillerSessionId} exists but was never seeded — re-seeding`);
                const seed = await buildSeed();
                const reseedClient = new PilotSwarmClient(internalClientConfig());
                try {
                    await reseedClient.start();
                    await catalog.markSessionService(distillerSessionId, REGEN_DISTILLER_SERVICE_KIND, input.sessionId);
                    // Stamped like the normal seed path below: a distiller
                    // seed is machinery, and an unstamped user-role prompt is
                    // rendered as the reader's own words.
                    await (reseedClient as any)._startTurn(distillerSessionId, seed, {
                        bootstrap: true,
                        sender: { kind: "system", display: "regen distiller seed" },
                    });
                } finally {
                    await reseedClient.stop().catch(() => {});
                }
            } else {
                activityCtx.traceInfo(`[runRegenSpawnDistiller] reusing ${distillerSessionId} (attempt retry)`);
            }
            return { distillerSessionId, distillerModel: existing.model ?? "(existing)", reused: true };
        }
        // Model policy (§9): per-call override → CLUSTER DEFAULT → configured
        // fallback. The served session's model is deliberately not in the chain.
        const candidates: Array<string | undefined> = [input.distillerModel, undefined, deps.fallbackDistillerModel];
        let resolvedRef: string | undefined;
        let resolvedAny = false;
        for (const ref of candidates) {
            if (deps.resolveModelOptions(ref)) { resolvedRef = ref; resolvedAny = true; break; }
        }
        if (!resolvedAny) {
            activityCtx.traceInfo(`[runRegenSpawnDistiller] no distiller model resolvable — caller falls back deterministically`);
            return { fallback: "no-model" };
        }
        // Root ancestor: service sessions collect under the tree root so a
        // sub-agent's distiller is still visible at the top (§9.1).
        let rootId = input.sessionId;
        for (let hop = 0; hop < 16; hop++) {
            const row = await catalog.getSession(rootId).catch(() => null);
            if (!row?.parentSessionId) break;
            rootId = row.parentSessionId;
        }
        const seed = await buildSeed();
        const owner = await resolveEffectiveSpawnOwner((id) => catalog.getSession(id), rootId).catch(() => null);
        const sdkClient = new PilotSwarmClient(internalClientConfig());
        try {
            await sdkClient.start();
            const session = await sdkClient.createSession({
                sessionId: distillerSessionId,
                parentSessionId: rootId,
                nestingLevel: 1,
                agentId: REGEN_DISTILLER_SERVICE_KIND,
                ...(resolvedRef ? { model: resolvedRef } : {}),
                // Operator-chosen distiller knobs. The context tier is the one
                // that decides whether a large archive can be read in a single
                // pass or has to be sampled, so it is worth exposing.
                ...(normalizeDistillerEffort(input.distillerReasoningEffort)
                    ? { reasoningEffort: normalizeDistillerEffort(input.distillerReasoningEffort)! }
                    : {}),
                ...(normalizeDistillerTier(input.distillerContextTier)
                    ? { contextTier: normalizeDistillerTier(input.distillerContextTier)! }
                    : {}),
                systemMessage: DISTILLER_SYSTEM_MESSAGE,
                toolNames: ["read_transcript_page"],
                ...(owner ? { owner } : {}),
            });
            await catalog.markSessionService(distillerSessionId, REGEN_DISTILLER_SERVICE_KIND, input.sessionId);
            await cmsRetryBestEffort(
                `runRegenSpawnDistiller.updateSession meta session=${distillerSessionId}`,
                () => catalog.updateSession(distillerSessionId, {
                    title: `Regen Distiller — ${input.sessionId.slice(0, 8)} e${input.epoch}→e${input.epoch + 1}`,
                    agentId: REGEN_DISTILLER_SERVICE_KIND,
                }),
                (msg) => activityCtx.traceInfo(msg),
            );
            await session.send(seed, {
                bootstrap: true,
                sender: { kind: "system", display: "regen distiller seed" },
            });
        } finally {
            await sdkClient.stop().catch(() => {});
        }
        activityCtx.traceInfo(`[runRegenSpawnDistiller] spawned ${distillerSessionId} under root ${rootId} model=${resolvedRef ?? "(default)"}`);
        return { distillerSessionId, distillerModel: resolvedRef ?? "(default)" };
    });

    runtime.registerActivity("runRegenCheckDistiller", async (
        _activityCtx: any,
        input: { distillerSessionId: string },
    ) => {
        if (!catalog) throw new Error("distiller check requires the CMS catalog");
        const row = await catalog.getSession(input.distillerSessionId).catch(() => null);
        if (!row) return { status: "failed", reason: "missing" };
        const rows = await catalog.getSessionEventsBefore(
            input.distillerSessionId, Number.MAX_SAFE_INTEGER, 1, ["assistant.message"],
        );
        if (rows.length > 0) return { status: "completed" };
        if (row.state === "failed" || row.state === "cancelled" || row.state === "completed") {
            return { status: "failed", reason: row.state };
        }
        return { status: "running" };
    });

    runtime.registerActivity("runRegenCollectDistiller", async (
        activityCtx: any,
        input: { sessionId: string; epoch: number; attemptId: string; distillerSessionId: string; archiveArtifactId?: string; archiveChunkIds?: string[]; handoff?: string; instructions?: string; distillerModel?: string; distillerReasoningEffort?: string; distillerContextTier?: string },
    ) => {
        if (!catalog) throw new Error("distiller collect requires the CMS catalog");
        if (!artifactStore) throw new Error("distiller collect requires an artifact store");
        const { sessionId, epoch, attemptId, distillerSessionId } = input;
        const filename = packageName(epoch, attemptId);
        const bootstrapMeta = {
            epoch,
            ...(input.archiveArtifactId ? { archiveArtifactId: input.archiveArtifactId } : {}),
            packageArtifactId: filename,
        };
        // Attempt idempotency: a retry after the package landed re-renders from it.
        if (await artifactExists(artifactStore, sessionId, filename)) {
            const stored = await artifactStore.downloadArtifact(sessionId, filename);
            const pkg = parseDistillerResponse(stored.body.toString("utf8"));
            return {
                packageArtifactId: filename,
                bootstrap: renderBootstrap(pkg, bootstrapMeta),
                distillerModel: "(reused)",
                distillMode: "llm",
                packageBytes: stored.body.length,
            };
        }
        // Scan the last few assistant messages (newest first), not just the
        // latest: a distiller that emits the JSON and THEN narrates ("done!")
        // would otherwise be misread as junk (adversarial-review finding). The
        // latest message is still dumped as the raw output of record.
        const rows = await catalog.getSessionEventsBefore(
            distillerSessionId, Number.MAX_SAFE_INTEGER, 5, ["assistant.message"],
        );
        const candidates = rows
            .slice()
            .sort((a, b) => Number((b as any).seq) - Number((a as any).seq))
            .map((r) => String((r.data as any)?.content ?? ""))
            .filter((t) => t.trim());
        const responseText = candidates[0] ?? "";
        // Dump the RAW pre-parse output (§9 dumps) — junk that triggers the
        // fallback stays inspectable.
        await artifactStore.uploadArtifact(
            sessionId,
            distillOutputName(epoch, attemptId),
            Buffer.from(responseText, "utf8"),
            "text/plain",
        );
        let pkg;
        let distillMode = "llm";
        let modelLabel = input.distillerModel ?? "(default)";
        try {
            if (candidates.length === 0) throw new Error("distiller produced no response");
            // Take the newest message that parses as a valid ResumePackage.
            let parsed;
            for (const text of candidates) {
                try { parsed = parseDistillerResponse(text); break; } catch { /* try older */ }
            }
            if (!parsed) throw new Error("no assistant message parsed as a ResumePackage");
            pkg = parsed;
        } catch (err: any) {
            activityCtx.traceInfo(`[runRegenCollectDistiller] parse failed (${err?.message || err}) — deterministic fallback`);
            const closure = await assembleRegenClosure({ catalog, artifactStore }, sessionId);
            pkg = deterministicPackage(closure, { ...(input.instructions ? { instructions: input.instructions } : {}) });
            distillMode = "deterministic";
            modelLabel = `(fallback:${modelLabel}:invalid)`;
        }
        const body = Buffer.from(JSON.stringify(pkg, null, 2), "utf8");
        await artifactStore.uploadArtifact(sessionId, filename, body, "application/json");
        // The distiller delivered — complete it so the sweeper's normal
        // stale-terminal scan reclaims it. Best-effort: an already-terminal or
        // unreachable distiller must never fail the collect.
        try {
            await enqueueDistillerCmd(distillerSessionId, "done", "distiller-complete");
        } catch (err: any) {
            activityCtx.traceInfo(`[runRegenCollectDistiller] complete enqueue failed (${err?.message || err})`);
        }
        return {
            packageArtifactId: filename,
            bootstrap: renderBootstrap(pkg, bootstrapMeta),
            distillerModel: modelLabel,
            distillMode,
            packageBytes: body.length,
        };
    });

    runtime.registerActivity("runRegenCancelDistiller", async (
        activityCtx: any,
        input: { distillerSessionId: string },
    ) => {
        try {
            await enqueueDistillerCmd(input.distillerSessionId, "cancel", "distiller-cancel");
            return { ok: true };
        } catch (err: any) {
            activityCtx.traceInfo(`[runRegenCancelDistiller] cancel enqueue failed (${err?.message || err})`);
            return { ok: false };
        }
    });
}
