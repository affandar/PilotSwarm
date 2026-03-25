import {
    RESPONSE_VERSION_KEY,
    COMMAND_VERSION_KEY,
    RESPONSE_LATEST_KEY,
    commandResponseKey,
} from "./types.js";
import {
    SESSION_STATE_MISSING_PREFIX,
} from "./types.js";
import type {
    TurnAction,
    TurnResult,
    OrchestrationInput,
    SubAgentEntry,
    SerializableSessionConfig,
    PilotSwarmSessionStatus,
    CommandMessage,
    CommandResponse,
    SessionResponsePayload,
    SessionCommandResponse,
    SessionStatusSignal,
} from "./types.js";
import { createSessionProxy, createSessionManagerProxy } from "./session-proxy.js";
import { planWaitHandling } from "./wait-affinity.js";

/**
 * Set custom status as a JSON blob of session state.
 * Clients read this via waitForStatusChange() or getStatus().
 * @internal
 */
function setStatus(ctx: any, status: PilotSwarmSessionStatus, extra?: Record<string, unknown>) {
    const signal: SessionStatusSignal = { status, ...(extra ?? {}) } as SessionStatusSignal;
    ctx.setCustomStatus(JSON.stringify(signal));
}

/**
 * Long-lived durable session orchestration.
 *
 * One orchestration per copilot session. Uses:
 *   - SessionProxy for session-scoped operations (runTurn, dehydrate, hydrate, destroy)
 *   - SessionManagerProxy for global operations (listModels)
 *   - A single FIFO event queue ("messages") for all client→orchestration communication
 *
 * Main loop:
 *   1. Dequeue message from "messages" queue
 *   2. session.hydrate() if needed
 *   3. session.runTurn(prompt) — returns TurnResult
 *   4. Handle result: completed → idle wait, wait → timer, input → wait for answer
 *
 * @internal
 */
export const CURRENT_ORCHESTRATION_VERSION = "1.0.24";

/**
 * Long-lived durable session orchestration.
 *
 * One orchestration per copilot session. Uses:
 *   - SessionProxy for session-scoped operations (runTurn, dehydrate, hydrate, destroy)
 *   - SessionManagerProxy for global operations (listModels)
 *   - A single FIFO event queue ("messages") for all client→orchestration communication
 *
 * Main loop:
 *   1. Dequeue message from "messages" queue
 *   2. session.hydrate() if needed
 *   3. session.runTurn(prompt) — returns TurnResult
 *   4. Handle result: completed → idle wait, wait → timer, input → wait for answer
 *
 * @internal
 */
export function* durableSessionOrchestration_1_0_24(
    ctx: any,
    input: OrchestrationInput,
): Generator<any, string, any> {
    const rawTraceInfo = typeof ctx.traceInfo === "function" ? ctx.traceInfo.bind(ctx) : null;
    if (rawTraceInfo) {
        ctx.traceInfo = (message: string) => rawTraceInfo(`[v1.0.23] ${message}`);
    }
    const dehydrateThreshold = input.dehydrateThreshold ?? 30;
    const idleTimeout = input.idleTimeout ?? 30;
    const inputGracePeriod = input.inputGracePeriod ?? 30;
    const checkpointInterval = input.checkpointInterval ?? -1; // seconds, -1 = disabled
    const rehydrationMessage = input.rehydrationMessage;
    const blobEnabled = input.blobEnabled ?? false;
    let needsHydration = input.needsHydration ?? false;
    let affinityKey = input.affinityKey ?? input.sessionId;
    let preserveAffinityOnHydrate = input.preserveAffinityOnHydrate ?? false;
    let iteration = input.iteration ?? 0;
    let config = { ...input.config };
    let retryCount = input.retryCount ?? 0;
    let taskContext = input.taskContext;
    const baseSystemMessage = input.baseSystemMessage ?? config.systemMessage;
    const isSystem = input.isSystem ?? false;
    const MAX_RETRIES = 3;
    const MAX_SUB_AGENTS = 20;
    const MAX_NESTING_LEVEL = 2; // 0=root, 1=child, 2=grandchild — no deeper

    // ─── Sub-agent tracking ──────────────────────────────────
    let subAgents: SubAgentEntry[] = input.subAgents ? [...input.subAgents] : [];
    let pendingToolActions: TurnAction[] = input.pendingToolActions ? [...input.pendingToolActions] : [];
    let pendingMessage: any = input.pendingMessage;
    // parentSessionId: prefer new field, fall back to old parentOrchId for backward compat
    const parentSessionId = input.parentSessionId
        ?? (input.parentOrchId ? input.parentOrchId.replace(/^session-/, '') : undefined);
    const nestingLevel = input.nestingLevel ?? 0;

    // If we have a captured task context, inject it into the system message
    // so it survives LLM conversation truncation (BasicTruncator never drops system messages).
    if (taskContext) {
        const base = typeof baseSystemMessage === 'string'
            ? baseSystemMessage ?? ''
            : (baseSystemMessage as any)?.content ?? '';
        config.systemMessage = base + (base ? '\n\n' : '') +
            '[RECURRING TASK]\n' +
            'Original user request (always remember, even if conversation history is truncated):\n"' +
            taskContext + '"';
    }

    // ─── Title summarization timer ───────────────────────────
    // First summarize at iteration 0 + 60s, then every 300s.
    // We track the target timestamp (epoch ms) across continueAsNew.
    // 0 means "schedule on first turn completion".
    let nextSummarizeAt = input.nextSummarizeAt ?? 0;

    // ─── Create proxies ──────────────────────────────────────
    const manager = createSessionManagerProxy(ctx);
    let session = createSessionProxy(ctx, input.sessionId, affinityKey, config);

    function writeJsonValue(key: string, value: unknown): void {
        ctx.setValue(key, JSON.stringify(value));
    }

    function readCounter(key: string): number {
        const raw = ctx.getValue(key);
        if (raw == null) return 0;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function bumpCounter(key: string): number {
        const next = readCounter(key) + 1;
        ctx.setValue(key, String(next));
        return next;
    }

    let lastResponseVersion = readCounter(RESPONSE_VERSION_KEY);
    let lastCommandVersion = readCounter(COMMAND_VERSION_KEY);
    let lastCommandId: string | undefined;

    function publishStatus(status: PilotSwarmSessionStatus, extra: Record<string, unknown> = {}): void {
        const signal: Record<string, unknown> = {
            iteration,
            ...(lastResponseVersion > 0 ? { responseVersion: lastResponseVersion } : {}),
            ...(lastCommandVersion > 0 ? { commandVersion: lastCommandVersion } : {}),
            ...(lastCommandId ? { commandId: lastCommandId } : {}),
            ...extra,
        };
        setStatus(ctx, status, signal);
    }

    function* writeLatestResponse(
        payload: Omit<SessionResponsePayload, "schemaVersion" | "version" | "emittedAt">,
    ): Generator<any, SessionResponsePayload, any> {
        const version = bumpCounter(RESPONSE_VERSION_KEY);
        const emittedAt: number = yield ctx.utcNow();
        const responsePayload: SessionResponsePayload = {
            schemaVersion: 1,
            version,
            emittedAt,
            ...payload,
        };
        writeJsonValue(RESPONSE_LATEST_KEY, responsePayload);
        lastResponseVersion = version;
        return responsePayload;
    }

    function* writeCommandResponse(
        response: CommandResponse,
    ): Generator<any, SessionCommandResponse, any> {
        const version = bumpCounter(COMMAND_VERSION_KEY);
        const emittedAt: number = yield ctx.utcNow();
        const payload: SessionCommandResponse = {
            ...response,
            schemaVersion: 1,
            version,
            emittedAt,
        };
        writeJsonValue(commandResponseKey(response.id), payload);
        lastCommandVersion = version;
        lastCommandId = response.id;
        return payload;
    }

    // ─── Helper: wrap prompt with resume context after dehydration ──
    function wrapWithResumeContext(userPrompt: string, extra?: string): string {
        const base = rehydrationMessage ??
            `The session was dehydrated and has been rehydrated on a new worker. ` +
            `The LLM conversation history is preserved.`;
        const parts = [userPrompt, ``, `[SYSTEM: ${base}`];
        if (extra) parts.push(extra);
        parts.push(`]`);
        return parts.join('\n');
    }

    function mergePrompt(existingPrompt?: string, nextPrompt?: string): string | undefined {
        if (!existingPrompt) return nextPrompt;
        if (!nextPrompt) return existingPrompt;
        return `${existingPrompt}\n\n${nextPrompt}`;
    }

    // ─── Shared continueAsNew input builder ──────────────────
    function continueInput(overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
        return {
            sessionId: input.sessionId,
            config,
            iteration,
            affinityKey,
            preserveAffinityOnHydrate,
            needsHydration,
            blobEnabled,
            dehydrateThreshold,
            idleTimeout,
            inputGracePeriod,
            checkpointInterval,
            rehydrationMessage,
            nextSummarizeAt,
            taskContext,
            baseSystemMessage,
            ...(pendingPrompt ? { bootstrapPrompt } : {}),
            subAgents,
            ...(pendingToolActions.length > 0 ? { pendingToolActions } : {}),
            ...(pendingMessage !== undefined ? { pendingMessage } : {}),
            parentSessionId,
            nestingLevel,
            ...(isSystem ? { isSystem: true } : {}),
            retryCount: 0, // reset by default; overrides can set it
            ...overrides,
        };
    }

    function continueInputWithPrompt(nextPrompt?: string, overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
        const mergedPrompt = mergePrompt(pendingPrompt, nextPrompt);
        return continueInput({
            ...(mergedPrompt ? { prompt: mergedPrompt } : {}),
            ...overrides,
        });
    }

    function* queueFollowupAndMaybeContinue(nextPrompt: string): Generator<any, boolean, any> {
        pendingPrompt = mergePrompt(pendingPrompt, nextPrompt);
        if (pendingToolActions.length > 0) {
            return false;
        }
        yield versionedContinueAsNew(continueInputWithPrompt());
        return true;
    }

    /** Yield this to continueAsNew into the current (latest) orchestration version. */
    function versionedContinueAsNew(input: OrchestrationInput) {
        return ctx.continueAsNewVersioned(input, CURRENT_ORCHESTRATION_VERSION);
    }

    function parseChildUpdate(promptText?: string): { sessionId: string; updateType: string; content: string } | null {
        if (typeof promptText !== "string") return null;
        const match = promptText.match(/^\[CHILD_UPDATE from=(\S+) type=(\S+)/);
        if (!match) return null;
        return {
            sessionId: match[1],
            updateType: match[2].replace(/\]$/, ""),
            content: promptText.split("\n").slice(1).join("\n").trim(),
        };
    }

    function* applyChildUpdate(update: { sessionId: string; updateType: string; content: string }): Generator<any, void, any> {
        ctx.traceInfo(`[orch] child update from=${update.sessionId} type=${update.updateType}`);
        const agent = subAgents.find(a => a.sessionId === update.sessionId);
        if (!agent) return;

        if (update.content) {
            agent.result = update.content.slice(0, 2000);
        }

        if (update.updateType === "completed") {
            agent.status = "completed";
        }

        try {
            const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
            const parsed = JSON.parse(rawStatus);
            if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "idle") {
                agent.status = parsed.status === "failed" ? "failed" : "completed";
            }
            if (parsed.result && parsed.result !== "done") {
                agent.result = parsed.result.slice(0, 2000);
            }
        } catch {}
    }

    // ─── Helper: dehydrate and optionally release affinity ───
    function* dehydrateForNextTurn(reason: string, resetAffinity = true): Generator<any, void, any> {
        ctx.traceInfo(`[orch] dehydrating session (reason=${reason}, resetAffinity=${resetAffinity})`);
        yield session.dehydrate(reason);
        needsHydration = true;
        preserveAffinityOnHydrate = !resetAffinity;
        if (resetAffinity) {
            affinityKey = yield ctx.newGuid();
            session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
        }
    }

    // ─── Helper: checkpoint without releasing pin ────────────
    function* maybeCheckpoint(): Generator<any, void, any> {
        if (!blobEnabled || checkpointInterval < 0) return;
        try {
            ctx.traceInfo(`[orch] checkpoint (iteration=${iteration})`);
            yield session.checkpoint();
        } catch (err: any) {
            ctx.traceInfo(`[orch] checkpoint failed: ${err.message ?? err}`);
        }
    }

    // ─── Helper: summarize session title if due ──────────────
    const FIRST_SUMMARIZE_DELAY = 60_000;    // 1 minute
    const REPEAT_SUMMARIZE_DELAY = 300_000;  // 5 minutes
    function* maybeSummarize(): Generator<any, void, any> {
        // System sessions have fixed titles — never summarize
        if (isSystem) return;
        const now: number = yield ctx.utcNow();
        // Schedule first summarize 60s after session start
        if (nextSummarizeAt === 0) {
            nextSummarizeAt = now + FIRST_SUMMARIZE_DELAY;
            return;
        }
        if (now < nextSummarizeAt) return;
        // Time to summarize — fire and forget (best effort)
        try {
            ctx.traceInfo(`[orch] summarizing session title`);
            yield manager.summarizeSession(input.sessionId);
        } catch (err: any) {
            ctx.traceInfo(`[orch] summarize failed: ${err.message}`);
        }
        nextSummarizeAt = now + REPEAT_SUMMARIZE_DELAY;
    }

    // ─── Prompt carried from continueAsNew ───────────────────
    let pendingPrompt: string | undefined = input.prompt;
    let bootstrapPrompt = input.bootstrapPrompt ?? false;

    ctx.traceInfo(`[orch] start: iter=${iteration} pending=${pendingPrompt ? `"${pendingPrompt.slice(0, 40)}"` : 'NONE'} queued=${pendingToolActions.length} hydrate=${needsHydration} blob=${blobEnabled}`);

    // ─── Policy enforcement (orchestration-side) ─────────────
    // Only check on the very first start (iteration 0, no parentSessionId — top-level only).
    // Sub-agent spawns are internal and not subject to top-level policy.
    if (iteration === 0 && !parentSessionId && !isSystem) {
        // Fetch the WORKER's authoritative policy (not the client's — can't trust client input).
        const workerPolicy: { policy: any; allowedAgentNames: string[] } = yield manager.getWorkerSessionPolicy();
        const policy = workerPolicy.policy;
        if (policy && policy.creation?.mode === "allowlist") {
            const agentId = input.agentId;
            const allowedNames = workerPolicy.allowedAgentNames;
            if (!agentId && !policy.creation.allowGeneric) {
                ctx.traceInfo(`[orch] policy rejection: generic session not allowed`);
                publishStatus("failed", { policyRejected: true });
                yield manager.updateCmsState(input.sessionId, "rejected");
                return "[POLICY] Session rejected: generic sessions are not allowed by session creation policy.";
            }
            if (agentId && allowedNames.length > 0 && !allowedNames.includes(agentId)) {
                ctx.traceInfo(`[orch] policy rejection: agent "${agentId}" not in allowed list`);
                publishStatus("failed", { policyRejected: true });
                yield manager.updateCmsState(input.sessionId, "rejected");
                return `[POLICY] Session rejected: agent "${agentId}" is not in the allowed agent list.`;
            }
        }
    }

    // ─── Resolve agent config for top-level named-agent sessions ───
    // When a session is created via createSessionForAgent("investigator"),
    // the agent's tools/systemMessage from .agent.md need to be injected
    // into the session config. Sub-agents get this via spawn_agent resolution,
    // but top-level sessions need it here.
    if (iteration === 0 && !parentSessionId && input.agentId) {
        const agentDef: any = yield manager.resolveAgentConfig(input.agentId);
        if (agentDef) {
            const mergedToolNames = Array.from(new Set([
                ...(agentDef.tools ?? []),
                ...(config.toolNames ?? []),
            ]));
            if (mergedToolNames.length > 0) {
                config.toolNames = mergedToolNames;
                ctx.traceInfo(`[orch] merged top-level agent tools for ${input.agentId}: ${mergedToolNames.join(", ")}`);
            }
            // Rebuild session proxy with updated config (tools now included)
            session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
        }
    }

    // ─── Set agent identity for namespace access control ─────────
    // The agentId travels through the config so fact tool handlers can
    // enforce knowledge pipeline namespace restrictions.
    if (input.agentId) {
        config.agentIdentity = input.agentId;
    }

    // ─── MAIN LOOP ──────────────────────────────────────────
    while (true) {
        let result: TurnResult;
        let prompt = "";
        let promptIsBootstrap = false;
        let replayingQueuedAction = false;

        if (pendingToolActions.length > 0) {
            result = pendingToolActions.shift()!;
            replayingQueuedAction = true;
            ctx.traceInfo(`[orch] replaying queued action: ${result.type} remaining=${pendingToolActions.length}`);
        } else {
        // ① GET NEXT PROMPT
            if (pendingPrompt) {
                prompt = pendingPrompt;
                pendingPrompt = undefined;
                promptIsBootstrap = bootstrapPrompt;
                bootstrapPrompt = false;
            } else {
                publishStatus("idle");

                let gotPrompt = false;
                while (!gotPrompt) {
                    // All messages (from users and child agents) arrive on the "messages" queue.
                    // Child agents communicate via the SDK (sendToSession), which enqueues
                    // to the same "messages" queue as user prompts.
                    let msgData: any;
                    if (pendingMessage !== undefined) {
                        msgData = pendingMessage;
                        pendingMessage = undefined;
                    } else {
                        const msg: any = yield ctx.dequeueEvent("messages");
                        msgData = typeof msg === "string" ? JSON.parse(msg) : msg;
                    }

                    // ── Command dispatch ─────────────────────────
                    if (msgData.type === "cmd") {
                        const cmdMsg = msgData as CommandMessage;
                        ctx.traceInfo(`[orch-cmd] ${cmdMsg.cmd} id=${cmdMsg.id}`);

                        switch (cmdMsg.cmd) {
                            case "set_model": {
                                const newModel = String(cmdMsg.args?.model || "");
                                const oldModel = config.model || "(default)";
                                config = { ...config, model: newModel };
                                const resp: CommandResponse = {
                                    id: cmdMsg.id,
                                    cmd: cmdMsg.cmd,
                                    result: { ok: true, oldModel, newModel },
                                };
                                yield* writeCommandResponse(resp);
                                publishStatus("idle");
                                yield versionedContinueAsNew(continueInput());
                                return "";
                            }
                            case "list_models": {
                                publishStatus("idle", { cmdProcessing: cmdMsg.id });
                                let models: unknown;
                                try {
                                    const raw: any = yield manager.listModels();
                                    models = typeof raw === "string" ? JSON.parse(raw) : raw;
                                } catch (err: any) {
                                    const resp: CommandResponse = {
                                        id: cmdMsg.id,
                                        cmd: cmdMsg.cmd,
                                        error: err.message || String(err),
                                    };
                                    yield* writeCommandResponse(resp);
                                    publishStatus("idle");
                                    continue;
                                }
                                const resp: CommandResponse = {
                                    id: cmdMsg.id,
                                    cmd: cmdMsg.cmd,
                                    result: { models, currentModel: config.model },
                                };
                                yield* writeCommandResponse(resp);
                                publishStatus("idle");
                                continue;
                            }
                            case "get_info": {
                                const resp: CommandResponse = {
                                    id: cmdMsg.id,
                                    cmd: cmdMsg.cmd,
                                    result: {
                                        model: config.model || "(default)",
                                        iteration,
                                        sessionId: input.sessionId,
                                        affinityKey: affinityKey?.slice(0, 8),
                                        preserveAffinityOnHydrate,
                                        needsHydration,
                                        blobEnabled,
                                    },
                                };
                                yield* writeCommandResponse(resp);
                                publishStatus("idle");
                                continue;
                            }
                            case "done": {
                                ctx.traceInfo(`[orch] /done command received — completing session`);

                                // Cascade: complete all sub-agents whose orchestrations may still be alive.
                                // Include "running" AND "completed" — a child that sent CHILD_UPDATE
                                // may still have a live orchestration waiting in its idle loop.
                                const liveChildren = subAgents.filter(a => a.status === "running" || a.status === "completed");
                                if (liveChildren.length > 0) {
                                    ctx.traceInfo(`[orch] /done: completing ${liveChildren.length} sub-agent(s)`);
                                    for (const child of liveChildren) {
                                        try {
                                            const childCmdId = `done-cascade-${iteration}-${child.sessionId.slice(0, 8)}`;
                                            yield manager.sendCommandToSession(child.sessionId,
                                                { type: "cmd", cmd: "done", id: childCmdId, args: { reason: "Parent session completing" } });
                                            child.status = "completed";
                                            ctx.traceInfo(`[orch] /done: completed child ${child.sessionId}`);
                                        } catch (err: any) {
                                            ctx.traceInfo(`[orch] /done: failed to complete child ${child.sessionId}: ${err.message} (non-fatal)`);
                                        }
                                    }
                                }

                                // If this is a child orchestration, send final result to parent
                                if (parentSessionId) {
                                    try {
                                        const doneReason = String(cmdMsg.args?.reason || "Session completed by user");
                                        yield manager.sendToSession(parentSessionId,
                                            `[CHILD_UPDATE from=${input.sessionId} type=completed iter=${iteration}]\n${doneReason}`);
                                    } catch (err: any) {
                                        ctx.traceInfo(`[orch] sendToSession(parent) on /done failed: ${err.message} (non-fatal)`);
                                    }
                                }

                                // Destroy the in-memory session
                                try {
                                    yield session.destroy();
                                } catch {}

                                const resp: CommandResponse = {
                                    id: cmdMsg.id,
                                    cmd: cmdMsg.cmd,
                                    result: { ok: true, message: "Session completed" },
                                };
                                yield* writeCommandResponse(resp);
                                publishStatus("completed");
                                return "done";
                            }
                            default: {
                                const resp: CommandResponse = {
                                    id: cmdMsg.id,
                                    cmd: cmdMsg.cmd,
                                    error: `Unknown command: ${cmdMsg.cmd}`,
                                };
                                yield* writeCommandResponse(resp);
                                publishStatus("idle");
                                continue;
                            }
                        }
                    }

                    const childUpdate = parseChildUpdate(msgData.prompt);
                    if (childUpdate) {
                        yield* applyChildUpdate(childUpdate);
                        continue;
                    }

                    if (!msgData.prompt) {
                        ctx.traceInfo(`[orch] ignoring non-prompt message while idle: ${JSON.stringify(msgData).slice(0, 120)}`);
                        continue;
                    }

                    prompt = msgData.prompt;
                    promptIsBootstrap = Boolean(msgData.bootstrap);
                    gotPrompt = true;
                }
            }

            // Detect archived state even when dehydration happened outside the orchestration,
            // such as abrupt worker loss or direct worker-side shutdown dehydration.
            if (blobEnabled && !needsHydration) {
                try {
                    needsHydration = yield session.needsHydration();
                } catch (err: any) {
                    ctx.traceInfo(`[orch] needsHydration probe failed: ${err.message ?? err}`);
                }
            }

            // If the session needs hydration, the LLM lost in-memory context.
            // Wrap the user's prompt with resume instructions so the LLM picks up where it left off.
            if (needsHydration && blobEnabled && prompt) {
                prompt = wrapWithResumeContext(prompt);
            }

            ctx.traceInfo(`[turn ${iteration}] session=${input.sessionId} prompt="${prompt.slice(0, 80)}"`);

            // ② HYDRATE if session was dehydrated (with retry)
            if (needsHydration && blobEnabled) {
                let hydrateAttempts = 0;
                while (true) {
                    try {
                        if (!preserveAffinityOnHydrate) {
                            affinityKey = yield ctx.newGuid();
                        }
                        session = createSessionProxy(ctx, input.sessionId, affinityKey, config);
                        yield session.hydrate();
                        needsHydration = false;
                        preserveAffinityOnHydrate = false;
                        break;
                    } catch (hydrateErr: any) {
                        const hMsg = hydrateErr.message || String(hydrateErr);

                        // Blob was deleted (e.g. after a reset) — skip hydration, start fresh
                        if (hMsg.includes("blob does not exist") || hMsg.includes("BlobNotFound") || hMsg.includes("404")) {
                            ctx.traceInfo(`[orch] hydrate skipped — blob not found, starting fresh session`);
                            needsHydration = false;
                            preserveAffinityOnHydrate = false;
                            break;
                        }

                        hydrateAttempts++;
                        ctx.traceInfo(`[orch] hydrate FAILED (attempt ${hydrateAttempts}/${MAX_RETRIES}): ${hMsg}`);
                        if (hydrateAttempts >= MAX_RETRIES) {
                            publishStatus("error", {
                                error: `Hydrate failed after ${MAX_RETRIES} attempts: ${hMsg}`,
                                retriesExhausted: true,
                            });
                            // Can't proceed without hydration — wait for next user message to retry
                            break;
                        }
                        const hydrateDelay = 10 * Math.pow(2, hydrateAttempts - 1);
                        publishStatus("error", {
                            error: `Hydrate failed: ${hMsg} (retry ${hydrateAttempts}/${MAX_RETRIES} in ${hydrateDelay}s)`,
                        });
                        yield ctx.scheduleTimer(hydrateDelay * 1000);
                    }
                }
                if (needsHydration) continue; // hydrate exhausted retries — go back to dequeue
            }

            // ②½ LOAD KNOWLEDGE PIPELINE CONTEXT ────────────────
            // Inject curated skills and active asks before running the turn.
            // Skip for facts-manager to avoid circular context injection.
            if (config.agentIdentity !== "facts-manager") {
                try {
                    const knowledgeIndex: any = yield manager.loadKnowledgeIndex();
                    if (knowledgeIndex) {
                        // Inject active asks into the prompt
                        if (knowledgeIndex.asks?.length > 0) {
                            const askLines = knowledgeIndex.asks.map((a: any) => `- ${a.key}`).join("\n");
                            const askBlock = `[ACTIVE FACT REQUESTS]\n` +
                                `The Facts Manager is seeking corroboration on these topics.\n` +
                                `If any are relevant to your current task, read the full ask\n` +
                                `with read_facts and contribute intake evidence if you can.\n${askLines}\n\n` +
                                `[FACT NAMESPACE RULES]\n` +
                                `- You can WRITE to: intake/<topic>/<session-id> (shared observations)\n` +
                                `- You can READ from: skills/*, asks/* (curated knowledge, open requests)\n` +
                                `- You CANNOT write to skills/ or asks/ (Facts Manager only)\n` +
                                `- You CANNOT read from intake/ (Facts Manager only)\n\n`;
                            prompt = askBlock + prompt;
                        }
                        // Inject curated skills with full body — matches the
                        // presentation format of file-based SKILL.md skills.
                        if (knowledgeIndex.skills?.length > 0) {
                            const skillBlocks = knowledgeIndex.skills.map((s: any) => {
                                let block = `### ${s.name}\n${s.description}\n`;
                                if (s.prompt) block += `\n${s.prompt}\n`;
                                if (s.toolNames?.length) block += `\nTools: ${s.toolNames.join(", ")}\n`;
                                return block;
                            }).join("\n");
                            const skillBlock = `[CURATED SKILLS]\n` +
                                `The following shared skills have been curated from operational experience.\n` +
                                `Apply them when relevant to your current task.\n\n${skillBlocks}\n`;
                            prompt = skillBlock + prompt;
                        }
                    }
                } catch (knErr: any) {
                    ctx.traceInfo(`[orch] loadKnowledgeIndex failed (non-fatal): ${knErr.message || knErr}`);
                }
            }

            // ③ RUN TURN via SessionProxy (with retry on failure)
            publishStatus("running");
            let turnResult: any;
            try {
                turnResult = yield session.runTurn(prompt, promptIsBootstrap, iteration);
            } catch (err: any) {
                // Activity failed (e.g. Copilot timeout, network error).
                const errorMsg = err.message || String(err);
                const missingStateIndex = errorMsg.indexOf(SESSION_STATE_MISSING_PREFIX);
                if (missingStateIndex >= 0) {
                    const fatalError = errorMsg.slice(missingStateIndex + SESSION_STATE_MISSING_PREFIX.length).trim();
                    ctx.traceInfo(`[orch] fatal missing session state: ${fatalError}`);
                    publishStatus("failed", { error: fatalError, fatal: true });
                    yield manager.updateCmsState(input.sessionId, "failed", fatalError);
                    throw new Error(fatalError);
                }
                retryCount++;
                ctx.traceInfo(`[orch] runTurn FAILED (attempt ${retryCount}/${MAX_RETRIES}): ${errorMsg}`);

                if (retryCount >= MAX_RETRIES) {
                    // Exhausted retries — park in error state but don't crash.
                    // The orchestration stays alive and will retry on the next user message.
                    ctx.traceInfo(`[orch] max retries exhausted, waiting for user input`);
                    publishStatus("error", {
                        error: `Failed after ${MAX_RETRIES} attempts: ${errorMsg}`,
                        retriesExhausted: true,
                    });
                    // Reset retry count and wait for next user message
                    retryCount = 0;
                    continue;
                }

                publishStatus("error", {
                    error: `${errorMsg} (retry ${retryCount}/${MAX_RETRIES} in 15s)`,
                });

                // Exponential backoff: 15s, 30s, 60s
                const retryDelay = 15 * Math.pow(2, retryCount - 1);
                ctx.traceInfo(`[orch] retrying in ${retryDelay}s`);

                if (blobEnabled) {
                    yield* dehydrateForNextTurn("error");
                }

                yield ctx.scheduleTimer(retryDelay * 1000);
                yield versionedContinueAsNew(continueInput({
                    prompt,
                    retryCount,
                    needsHydration: blobEnabled ? true : needsHydration,
                }));
                return "";
            }
            // Successful activity — reset retry counter
            retryCount = 0;

            result = typeof turnResult === "string"
                ? JSON.parse(turnResult) : turnResult;
        }
        if (!replayingQueuedAction) {
            iteration++;

            // ── Summarize title if due ──────────────────────────
            yield* maybeSummarize();
        }

        if ("queuedActions" in result && Array.isArray(result.queuedActions) && result.queuedActions.length > 0) {
            pendingToolActions.push(...result.queuedActions);
            ctx.traceInfo(`[orch] queued ${result.queuedActions.length} extra action(s) from turn`);
        }

        // ④ HANDLE RESULT
        switch (result.type) {
            case "completed":
                ctx.traceInfo(`[response] ${result.content}`);
                yield* writeLatestResponse({
                    iteration,
                    type: "completed",
                    content: result.content,
                    model: (result as any).model,
                });

                // If this is a child orchestration, notify the parent about our completion
                // via the SDK — sends to the parent's "messages" queue like any other message.
                if (parentSessionId) {
                    try {
                        yield manager.sendToSession(parentSessionId,
                            `[CHILD_UPDATE from=${input.sessionId} type=completed iter=${iteration}]\n${result.content.slice(0, 2000)}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) failed: ${err.message} (non-fatal)`);
                    }

                    // System sub-agents (sweeper, resourcemgr) should keep running forever.
                    // Non-system sub-agents auto-terminate after completing their task.
                    if (input.isSystem) {
                        ctx.traceInfo(`[orch] system sub-agent completed turn, continuing loop`);
                        yield* maybeCheckpoint();
                        continue;
                    }

                    // Non-system sub-agents auto-terminate after completing their task and notifying
                    // the parent. Without this, they sit in the idle loop forever (idleTimeout=-1)
                    // and accumulate as zombie orchestrations.
                    ctx.traceInfo(`[orch] sub-agent completed task, auto-terminating`);
                    try {
                        yield session.destroy();
                    } catch {}
                    publishStatus("completed");
                    return "done";
                }

                if (!blobEnabled || idleTimeout < 0) {
                    // continueAsNew after each completed turn to reset history.
                    // Without this, the same execution accumulates unbounded
                    // history which breaks replay after a worker restart —
                    // duroxide can match the second yield session.runTurn()
                    // to the cached result of the first one.
                    yield* maybeCheckpoint();
                    yield versionedContinueAsNew(continueInput());
                    return "";
                }

                // Race: next message vs idle timeout
                {
                    publishStatus("idle");
                    yield* maybeCheckpoint();
                    const idleDeadline: number = (yield ctx.utcNow()) + idleTimeout * 1000;
                    while (true) {
                        const now: number = yield ctx.utcNow();
                        const remainingMs = Math.max(0, idleDeadline - now);
                        if (remainingMs === 0) break;

                        const nextMsg = ctx.dequeueEvent("messages");
                        const idleTimer = ctx.scheduleTimer(remainingMs);
                        const raceResult: any = yield ctx.race(nextMsg, idleTimer);

                        if (raceResult.index === 0) {
                            const raceMsg = typeof raceResult.value === "string"
                                ? JSON.parse(raceResult.value) : (raceResult.value ?? {});
                            const childUpdate = parseChildUpdate(raceMsg.prompt);
                            if (childUpdate) {
                                yield* applyChildUpdate(childUpdate);
                                continue;
                            }

                            ctx.traceInfo("[session] user responded within idle window");
                            pendingMessage = raceMsg;
                            yield versionedContinueAsNew(continueInput());
                            return "";
                        }

                        break;
                    }

                    // Idle timeout → dehydrate. Next message will need resume context.
                    ctx.traceInfo("[session] idle timeout, dehydrating");
                    yield* dehydrateForNextTurn("idle");
                    // Don't continueAsNew with a prompt — wait for the next user message,
                    // which will be wrapped with resume context because needsHydration=true.
                    yield versionedContinueAsNew(continueInput());
                    return "";
                }

            case "wait":
                // Capture original user prompt as task context for recurring tasks.
                // This ensures the LLM remembers its task even after conversation truncation.
                if (!taskContext) {
                    taskContext = prompt.slice(0, 2000);
                    const base = typeof baseSystemMessage === 'string'
                        ? baseSystemMessage ?? ''
                        : (baseSystemMessage as any)?.content ?? '';
                    config.systemMessage = base + (base ? '\n\n' : '') +
                        '[RECURRING TASK]\n' +
                        'Original user request (always remember, even if conversation history is truncated):\n"' +
                        taskContext + '"';
                }

                // If this is a child orchestration, notify the parent on every wait cycle
                // via the SDK — sends a message to the parent's "messages" queue.
                if (parentSessionId) {
                    try {
                        const notifyContent = result.content
                            ? result.content.slice(0, 2000)
                            : `[wait: ${result.reason} (${result.seconds}s)]`;
                        yield manager.sendToSession(parentSessionId,
                            `[CHILD_UPDATE from=${input.sessionId} type=wait iter=${iteration}]\n${notifyContent}`);
                    } catch (err: any) {
                        ctx.traceInfo(`[orch] sendToSession(parent) wait failed: ${err.message} (non-fatal)`);
                    }
                }

                ctx.traceInfo(`[orch] durable timer: ${result.seconds}s (${result.reason})`);

                {
                    const waitPlan = planWaitHandling({
                        blobEnabled,
                        seconds: result.seconds,
                        dehydrateThreshold,
                        preserveWorkerAffinity: result.preserveWorkerAffinity,
                    });
                    if (waitPlan.shouldDehydrate) {
                        yield* dehydrateForNextTurn("timer", waitPlan.resetAffinityOnDehydrate);
                    }

                    const waitStartedAt: number = yield ctx.utcNow();
                    if (result.content) {
                        yield* writeLatestResponse({
                            iteration,
                            type: "wait",
                            content: result.content,
                            waitReason: result.reason,
                            waitSeconds: result.seconds,
                            waitStartedAt,
                            model: (result as any).model,
                        });
                        ctx.traceInfo(`[orch] intermediate: ${result.content.slice(0, 80)}`);
                    }

                    publishStatus("waiting", {
                        waitSeconds: result.seconds,
                        waitReason: result.reason,
                        waitStartedAt,
                        preserveWorkerAffinity: waitPlan.preserveAffinityOnHydrate,
                    });

                    // Checkpoint before the blocking wait
                    if (!waitPlan.shouldDehydrate) yield* maybeCheckpoint();

                    const timerTask = ctx.scheduleTimer(result.seconds * 1000);
                    const interruptMsg = ctx.dequeueEvent("messages");
                    const timerRace: any = yield ctx.race(timerTask, interruptMsg);

                    if (timerRace.index === 1) {
                        const interruptData = typeof timerRace.value === "string"
                            ? JSON.parse(timerRace.value) : (timerRace.value ?? {});
                        const childUpdate = parseChildUpdate(interruptData.prompt);
                        if (childUpdate) {
                            yield* applyChildUpdate(childUpdate);
                            const interruptedAt: number = yield ctx.utcNow();
                            const elapsedSec = Math.round((interruptedAt - waitStartedAt) / 1000);
                            const remainingSec = Math.max(0, result.seconds - elapsedSec);
                            if (remainingSec === 0) {
                                const timerPrompt = `The ${result.seconds} second wait is now complete. Continue with your task.`;
                                yield versionedContinueAsNew(continueInputWithPrompt(
                                    timerPrompt,
                                    { needsHydration: waitPlan.shouldDehydrate ? true : needsHydration },
                                ));
                            } else {
                                yield versionedContinueAsNew(continueInputWithPrompt(
                                    `The wait was partially completed (${elapsedSec}s elapsed, ${remainingSec}s remain). Resume the wait for the remaining ${remainingSec} seconds.`,
                                    { needsHydration: waitPlan.shouldDehydrate ? true : needsHydration },
                                ));
                            }
                            return "";
                        }
                        ctx.traceInfo(`[session] wait interrupted: "${(interruptData.prompt || "").slice(0, 60)}"`);

                        // Calculate remaining time for resume context
                        const interruptedAt: number = yield ctx.utcNow();
                        const elapsedSec = Math.round((interruptedAt - waitStartedAt) / 1000);
                        const remainingSec = Math.max(0, result.seconds - elapsedSec);
                        const userPrompt = interruptData.prompt || "";

                        let finalPrompt: string;
                        if (waitPlan.shouldDehydrate && userPrompt) {
                            finalPrompt = wrapWithResumeContext(
                                userPrompt,
                                `Your timer was interrupted by a USER MESSAGE. ` +
                                `RESPONSE FORMAT: You MUST first output a text response addressing the user's message. ` +
                                `Then call wait(${remainingSec}) to resume your timer. ` +
                                `IMPORTANT: A turn that calls wait() without any preceding text output is WRONG. ` +
                                `The user is waiting to see your reply. Always write text first, then call wait. ` +
                                `Timer context: ${result.seconds}s timer (reason: "${result.reason}"), ` +
                                `${elapsedSec}s elapsed, ${remainingSec}s remain.`,
                            );
                        } else if (userPrompt) {
                            // Not dehydrated but still interrupted — give timing context
                            finalPrompt = `${userPrompt}\n\n` +
                                `[SYSTEM: IMPORTANT — The above is a USER MESSAGE that interrupted your ${result.seconds}s timer (reason: "${result.reason}"). ` +
                                `RESPONSE FORMAT: You MUST first output a text response addressing the user's message. ` +
                                `Then call wait(${remainingSec}) to resume your timer. ` +
                                `A turn that calls wait() without any preceding text output is WRONG. ` +
                                `The user is waiting to see your reply. Always write text first, then call wait. ` +
                                `${elapsedSec}s elapsed, ${remainingSec}s remain.]`;
                        } else {
                            finalPrompt = userPrompt;
                        }

                        yield versionedContinueAsNew(continueInputWithPrompt(
                            finalPrompt,
                            { needsHydration: waitPlan.shouldDehydrate ? true : needsHydration },
                        ));
                        return "";
                    }

                    const timerPrompt = `The ${result.seconds} second wait is now complete. Continue with your task.`;
                    yield versionedContinueAsNew(continueInputWithPrompt(
                        timerPrompt,
                        { needsHydration: waitPlan.shouldDehydrate ? true : needsHydration },
                    ));
                    return "";
                }

            case "input_required":
                ctx.traceInfo(`[orch] waiting for user input: ${result.question}`);
                yield* writeLatestResponse({
                    iteration,
                    type: "input_required",
                    question: result.question,
                    choices: result.choices,
                    allowFreeform: result.allowFreeform,
                    model: (result as any).model,
                });

                if (!blobEnabled || inputGracePeriod < 0) {
                    publishStatus("input_required");
                    yield* maybeCheckpoint();
                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    yield versionedContinueAsNew(continueInputWithPrompt(
                        `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                        { needsHydration: false },
                    ));
                    return "";
                }

                if (inputGracePeriod === 0) {
                    publishStatus("input_required");
                    yield* dehydrateForNextTurn("input_required");
                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    yield versionedContinueAsNew(continueInputWithPrompt(
                        `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                    ));
                    return "";
                }

                // Race: user answer vs grace period
                {
                    publishStatus("input_required");
                    const answerEvt = ctx.dequeueEvent("messages");
                    const graceTimer = ctx.scheduleTimer(inputGracePeriod * 1000);
                    const raceResult: any = yield ctx.race(answerEvt, graceTimer);

                    if (raceResult.index === 0) {
                        const answerData = typeof raceResult.value === "string"
                            ? JSON.parse(raceResult.value) : (raceResult.value ?? {});
                        yield versionedContinueAsNew(continueInputWithPrompt(
                            `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                            { needsHydration: false },
                        ));
                        return "";
                    }

                    yield* dehydrateForNextTurn("input_required");
                    const answerMsg: any = yield ctx.dequeueEvent("messages");
                    const answerData = typeof answerMsg === "string"
                        ? JSON.parse(answerMsg) : answerMsg;
                    yield versionedContinueAsNew(continueInputWithPrompt(
                        `The user was asked: "${result.question}"\nThe user responded: "${answerData.answer}"`,
                    ));
                    return "";
                }

            case "cancelled":
                ctx.traceInfo("[session] turn cancelled");
                continue;

            // ─── Sub-Agent Result Handlers ───────────────────

            case "spawn_agent": {
                // Enforce nesting depth limit
                const childNestingLevel = nestingLevel + 1;
                if (childNestingLevel > MAX_NESTING_LEVEL) {
                    ctx.traceInfo(`[orch] spawn_agent denied: nesting level ${nestingLevel} is at max (${MAX_NESTING_LEVEL})`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: spawn_agent failed — you are already at nesting level ${nestingLevel} (max ${MAX_NESTING_LEVEL}). ` +
                        `Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]`,
                    )) return "";
                    continue;
                }

                // Enforce max sub-agents
                const activeCount = subAgents.filter(a => a.status === "running").length;
                if (activeCount >= MAX_SUB_AGENTS) {
                    ctx.traceInfo(`[orch] spawn_agent denied: ${activeCount}/${MAX_SUB_AGENTS} agents running`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: spawn_agent failed — you already have ${activeCount} running sub-agents (max ${MAX_SUB_AGENTS}). ` +
                        `Wait for some to complete before spawning more.]`,
                    )) return "";
                    continue;
                }

                // ─── Resolve agent config if agent_name is provided ───
                let agentTask = result.task;
                let agentSystemMessage = result.systemMessage;
                let agentToolNames = result.toolNames;
                let agentModel = result.model;
                let agentIsSystem = false;
                let agentTitle: string | undefined;
                let agentId: string | undefined;
                let agentSplash: string | undefined;
                let boundAgentName: string | undefined;
                let promptLayeringKind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" | undefined;
                let resolvedAgentName = result.agentName;

                const applyAgentDef = (agentDef: any, useDefinitionDefaults = false) => {
                    agentTask = useDefinitionDefaults
                        ? (agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`)
                        : (result.task || agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`);
                    agentSystemMessage = useDefinitionDefaults ? undefined : result.systemMessage;
                    agentToolNames = useDefinitionDefaults
                        ? (agentDef.tools ?? undefined)
                        : (result.toolNames ?? agentDef.tools ?? undefined);
                    agentIsSystem = agentDef.system ?? false;
                    agentTitle = agentDef.title;
                    agentId = agentDef.id ?? resolvedAgentName;
                    agentSplash = agentDef.splash;
                    boundAgentName = agentDef.name;
                    promptLayeringKind = agentDef.promptLayerKind
                        ?? (agentDef.system
                            ? ((agentDef.namespace || "pilotswarm") === "pilotswarm"
                                ? "pilotswarm-system-agent"
                                : "app-system-agent")
                            : "app-agent");
                };

                if (!resolvedAgentName && input.isSystem && agentTask) {
                    const compactTask = agentTask.trim();
                    const titleMatch = agentTask.match(/You are the \*{0,2}([^*\n]+?Agent)\*{0,2}/i);
                    const inferredLookup = (
                        compactTask && compactTask.length <= 80 && !compactTask.includes("\n")
                            ? compactTask
                            : titleMatch?.[1]?.trim()
                    );
                    if (inferredLookup) {
                        const inferredDef = yield manager.resolveAgentConfig(inferredLookup);
                        if (inferredDef?.system && inferredDef?.parent) {
                            resolvedAgentName = inferredDef.id ?? inferredDef.name;
                            ctx.traceInfo(`[orch] normalized custom system spawn to named agent: ${resolvedAgentName} (from "${inferredLookup}")`);
                            applyAgentDef(inferredDef, true);
                        }
                    }
                }

                if (resolvedAgentName) {
                    ctx.traceInfo(`[orch] resolving agent config for: ${resolvedAgentName}`);
                    const agentDef = yield manager.resolveAgentConfig(resolvedAgentName);
                    if (!agentDef) {
                        if (yield* queueFollowupAndMaybeContinue(
                            `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" not found. Use list_agents to see available agents.]`,
                        )) return "";
                        continue;
                    }
                    applyAgentDef(agentDef, resolvedAgentName !== result.agentName);
                }

                if (agentModel && !agentModel.includes(":")) {
                    ctx.traceInfo(`[orch] spawn_agent denied: unqualified model override "${agentModel}"`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: spawn_agent failed — model "${agentModel}" is not allowed. ` +
                        `When overriding a sub-agent model, first call list_available_models and then use the exact provider:model value from that list. ` +
                        `If you are unsure, omit model so the sub-agent inherits your current model.]`,
                    )) return "";
                    continue;
                }

                // If the parent is a system session, propagate isSystem to children
                if (input.isSystem) {
                    agentIsSystem = true;
                }

                // Auto-detect title for custom spawns by system sessions:
                // If the LLM didn't use agent_name, try to extract a reasonable title
                // from the task or system_message rather than showing "System Agent".
                if (!agentTitle && agentIsSystem) {
                    const text = agentTask || "";
                    // Look for "You are the **XYZ Agent**" or "You are the XYZ Agent" patterns
                    const titleMatch = text.match(/You are the \*{0,2}([^*\n]+?)\*{0,2}\s*[—–-]/i)
                        || text.match(/You are the \*{0,2}([^*\n]+?Agent)\*{0,2}/i);
                    if (titleMatch) {
                        agentTitle = titleMatch[1].trim();
                    }
                }

                ctx.traceInfo(`[orch] spawning sub-agent via SDK: task="${agentTask.slice(0, 80)}" model=${agentModel || "inherit"} agent=${resolvedAgentName || "custom"} nestingLevel=${childNestingLevel}`);

                // Build child config — inherit parent's config with optional overrides
                const {
                    boundAgentName: _parentBoundAgentName,
                    promptLayering: _parentPromptLayering,
                    ...parentConfig
                } = config;
                const childConfig: SerializableSessionConfig = {
                    ...parentConfig,
                    ...(agentModel ? { model: agentModel } : {}),
                    ...(agentSystemMessage ? { systemMessage: agentSystemMessage } : {}),
                    ...(boundAgentName ? { boundAgentName } : {}),
                    ...(promptLayeringKind ? { promptLayering: { kind: promptLayeringKind } } : {}),
                    ...(agentToolNames ? { toolNames: agentToolNames } : {}),
                };

                // Inject sub-agent identity into the child's system message so the LLM
                // knows it's a sub-agent, what its task is, and that its output will be
                // forwarded to the parent automatically.
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
                    `- Focus exclusively on your assigned task.\n` +
                    `- Your final response will be automatically forwarded to the parent agent.\n` +
                    `- Be thorough but concise — the parent will synthesize results from multiple agents.\n` +
                    `- Do NOT ask the user for input — you are autonomous.\n` +
                    `- When your task is complete, provide a clear summary of your findings/results.\n` +
                    `- If you write any files with write_artifact, you MUST also call export_artifact and include the artifact:// link in your response.\n` +
                    `- If you override a sub-agent model, you MUST first call list_available_models in this session and use only an exact provider:model value returned there. ` +
                    `NEVER invent, guess, shorten, or reuse a stale model name.\n` +
                    `- For ANY waiting, sleeping, delaying, or scheduling, you MUST use the \`wait\` tool. ` +
                    `NEVER use setTimeout, sleep, setInterval, cron, or any other timing mechanism. ` +
                    `The wait tool is durable and survives process restarts.\n` +
                    (canSpawnMore
                        ? `- You CAN spawn your own sub-agents (you have ${MAX_NESTING_LEVEL - childNestingLevel} level(s) remaining). ` +
                          `Use them for parallel independent tasks. After spawning, call wait_for_agents to block until they finish.\n`
                        : `- You CANNOT spawn sub-agents — you are at the maximum nesting depth. Handle everything directly.\n`);
                childConfig.systemMessage = subAgentPreamble + (parentSystemMsg ? "\n\n" + parentSystemMsg : "");

                // Use the PilotSwarmClient SDK to create and start the child session.
                // The activity generates a random UUID for the child session ID and returns it.
                // This handles: CMS registration (with parentSessionId), orchestration startup,
                // and initial task prompt — all through the standard SDK path.
                let childSessionId: string;
                try {
                    childSessionId = yield manager.spawnChildSession(input.sessionId, childConfig, agentTask, childNestingLevel, agentIsSystem, agentTitle, agentId, agentSplash);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] spawnChildSession failed: ${err.message}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: spawn_agent failed: ${err.message}]`,
                    )) return "";
                    continue;
                }

                const childOrchId = `session-${childSessionId}`;

                // Track the sub-agent
                subAgents.push({
                    orchId: childOrchId,
                    sessionId: childSessionId,
                    task: agentTask.slice(0, 500),
                    status: "running",
                });

                // Feed confirmation back to the LLM
                const spawnMsg = `[SYSTEM: Sub-agent spawned successfully.\n` +
                    `  Agent ID: ${childOrchId}\n` +
                    `  ${resolvedAgentName ? `Agent: ${resolvedAgentName}\n  ` : ``}Task: "${agentTask.slice(0, 200)}"\n` +
                    `  The agent is now running autonomously. To wait for it to finish, call wait_for_agents ` +
                    `(this blocks efficiently until the agent completes). You can also use check_agents to poll status, ` +
                    `or message_agent to send instructions.]`;

                if (yield* queueFollowupAndMaybeContinue(spawnMsg)) return "";
                continue;
            }

            case "message_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] message_agent: unknown agent ${targetOrchId}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: message_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`,
                    )) return "";
                    continue;
                }

                ctx.traceInfo(`[orch] message_agent via SDK: ${agentEntry.sessionId} msg="${result.message.slice(0, 60)}"`);

                try {
                    yield manager.sendToSession(agentEntry.sessionId, result.message);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] message_agent failed: ${err.message}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: message_agent failed: ${err.message}]`,
                    )) return "";
                    continue;
                }

                if (yield* queueFollowupAndMaybeContinue(
                    `[SYSTEM: Message sent to sub-agent ${targetOrchId}: "${result.message.slice(0, 200)}"]`,
                )) return "";
                continue;
            }

            case "check_agents": {
                ctx.traceInfo(`[orch] check_agents: ${subAgents.length} agents tracked`);

                if (subAgents.length === 0) {
                    if (yield* queueFollowupAndMaybeContinue(`[SYSTEM: No sub-agents have been spawned yet.]`)) return "";
                    continue;
                }

                // Get fresh status for each agent via the SDK
                const statusLines: string[] = [];
                for (const agent of subAgents) {
                    try {
                        const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
                        const parsed = JSON.parse(rawStatus);

                        // Update local tracking
                        // Sub-agents go "idle" when their turn completes
                        if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "idle") {
                            agent.status = parsed.status === "failed" ? "failed" : "completed";
                            if (parsed.result) agent.result = parsed.result.slice(0, 1000);
                        }

                        statusLines.push(
                            `  - Agent ${agent.orchId}\n` +
                            `    Task: "${agent.task.slice(0, 120)}"\n` +
                            `    Status: ${parsed.status}\n` +
                            `    Iterations: ${parsed.iterations ?? 0}\n` +
                            `    Output: ${parsed.result ?? "(no output yet)"}`
                        );
                    } catch (err: any) {
                        statusLines.push(
                            `  - Agent ${agent.orchId}\n` +
                            `    Task: "${agent.task.slice(0, 120)}"\n` +
                            `    Status: unknown (error: ${err.message})`
                        );
                    }
                }

                if (yield* queueFollowupAndMaybeContinue(
                    `[SYSTEM: Sub-agent status report (${subAgents.length} agents):\n${statusLines.join("\n")}]`,
                )) return "";
                continue;
            }

            case "list_sessions": {
                ctx.traceInfo(`[orch] list_sessions`);

                const rawSessions: string = yield manager.listSessions();
                const sessions = JSON.parse(rawSessions);

                const lines: string[] = sessions.map((s: any) =>
                    `  - ${s.sessionId}${s.sessionId === input.sessionId ? " (this session)" : ""}\n` +
                    `    Title: ${s.title ?? "(untitled)"}\n` +
                    `    Status: ${s.status}, Iterations: ${s.iterations ?? 0}\n` +
                    `    Parent: ${s.parentSessionId ?? "none"}`
                );

                if (yield* queueFollowupAndMaybeContinue(
                    `[SYSTEM: Active sessions (${sessions.length}):\n${lines.join("\n")}]`,
                )) return "";
                continue;
            }

            case "wait_for_agents": {
                let targetIds = result.agentIds;

                // If empty, wait for all running agents
                if (!targetIds || targetIds.length === 0) {
                    targetIds = subAgents.filter(a => a.status === "running").map(a => a.orchId);
                }

                if (targetIds.length === 0) {
                    ctx.traceInfo(`[orch] wait_for_agents: no running agents to wait for`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: No running sub-agents to wait for. All agents have already completed.]`,
                    )) return "";
                    continue;
                }

                ctx.traceInfo(`[orch] wait_for_agents: waiting for ${targetIds.length} agents`);
                publishStatus("running");

                // Event-driven wait: children send updates to the parent's "messages"
                // queue via sendToSession. We race messages vs a fallback poll timer.
                // Child updates arrive as "[CHILD_UPDATE from=... type=...]" messages.
                const POLL_INTERVAL_MS = 30_000; // 30s fallback poll (event-driven, so rarely needed)
                const MAX_WAIT_ITERATIONS = 360;
                for (let waitIter = 0; waitIter < MAX_WAIT_ITERATIONS; waitIter++) {
                    // Check if all targets are done (from local tracking)
                    const stillRunning = targetIds.filter(id => {
                        const agent = subAgents.find(a => a.orchId === id);
                        return agent && agent.status === "running";
                    });
                    if (stillRunning.length === 0) break;

                    // Race: message (child update or user) vs fallback poll timer
                    const msg = ctx.dequeueEvent("messages");
                    const pollTimer = ctx.scheduleTimer(POLL_INTERVAL_MS);
                    const waitRace: any = yield ctx.race(msg, pollTimer);

                    if (waitRace.index === 0) {
                        // Message arrived — could be a child update or a user message
                        const msgData = typeof waitRace.value === "string"
                            ? JSON.parse(waitRace.value) : (waitRace.value ?? {});

                        // Check if it's a child update (sent by sendToSession from child orch)
                        const childUpdateMatch = typeof msgData.prompt === "string"
                            && msgData.prompt.match(/^\[CHILD_UPDATE from=(\S+) type=(\S+)/);

                        if (childUpdateMatch) {
                            const childSessionId = childUpdateMatch[1];
                            const updateType = childUpdateMatch[2].replace(/\]$/, "");
                            const content = msgData.prompt.split("\n").slice(1).join("\n").trim();
                            ctx.traceInfo(`[orch] wait_for_agents: child update from=${childSessionId} type=${updateType}`);

                            const agent = subAgents.find(a => a.sessionId === childSessionId);
                            if (agent) {
                                if (content) agent.result = content.slice(0, 2000);
                                // Check via SDK if done (the update type alone isn't authoritative
                                // since "completed" means turn completed, not necessarily finished)
                                try {
                                    const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
                                    const parsed = JSON.parse(rawStatus);
                                    // Sub-agents go "idle" when their turn completes (they have no user to wait for)
                                    if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "idle") {
                                        agent.status = parsed.status === "failed" ? "failed" : "completed";
                                        if (parsed.result) agent.result = parsed.result.slice(0, 2000);
                                    }
                                } catch {}
                            }
                            continue;
                        }

                        // Not a child update — it's a user message interrupting the wait
                        if (msgData.prompt) {
                            ctx.traceInfo(`[orch] wait_for_agents interrupted by user: "${msgData.prompt.slice(0, 60)}"`);
                            yield versionedContinueAsNew(continueInputWithPrompt(msgData.prompt));
                            return "";
                        }
                    } else {
                        // Timer fired — fallback poll via SDK for any agents we missed
                        ctx.traceInfo(`[orch] wait_for_agents: fallback poll, checking ${stillRunning.length} agents`);
                        for (const targetId of stillRunning) {
                            const agent = subAgents.find(a => a.orchId === targetId);
                            if (!agent || agent.status !== "running") continue;
                            try {
                                const rawStatus: string = yield manager.getSessionStatus(agent.sessionId);
                                const parsed = JSON.parse(rawStatus);
                                // Sub-agents go "idle" when their turn completes
                                if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "idle") {
                                    agent.status = parsed.status === "failed" ? "failed" : "completed";
                                    if (parsed.result) agent.result = parsed.result.slice(0, 2000);
                                }
                            } catch {}
                        }
                    }
                }

                // Build results summary
                const resultLines: string[] = [];
                for (const targetId of targetIds) {
                    const agent = subAgents.find(a => a.orchId === targetId);
                    if (!agent) continue;
                    resultLines.push(
                        `  - Agent ${agent.orchId}\n` +
                        `    Task: "${agent.task.slice(0, 120)}"\n` +
                        `    Status: ${agent.status}\n` +
                        `    Result: ${agent.result ?? "(no result)"}`
                    );
                }

                if (yield* queueFollowupAndMaybeContinue(
                    `[SYSTEM: Sub-agents completed:\n${resultLines.join("\n")}]`,
                )) return "";
                continue;
            }

            case "complete_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] complete_agent: unknown agent ${targetOrchId}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: complete_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`,
                    )) return "";
                    continue;
                }

                ctx.traceInfo(`[orch] complete_agent: sending /done to ${agentEntry.sessionId}`);

                try {
                    // Send a /done command to the child's orchestration
                    const cmdId = `done-${iteration}`;
                    yield manager.sendCommandToSession(agentEntry.sessionId,
                        { type: "cmd", cmd: "done", id: cmdId, args: { reason: "Completed by parent" } });
                    agentEntry.status = "completed";
                } catch (err: any) {
                    ctx.traceInfo(`[orch] complete_agent failed: ${err.message}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: complete_agent failed: ${err.message}]`,
                    )) return "";
                    continue;
                }

                if (yield* queueFollowupAndMaybeContinue(
                    `[SYSTEM: Sub-agent ${targetOrchId} has been completed gracefully.]`,
                )) return "";
                continue;
            }

            case "cancel_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] cancel_agent: unknown agent ${targetOrchId}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: cancel_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`,
                    )) return "";
                    continue;
                }

                const cancelReason = result.reason ?? "Cancelled by parent";
                ctx.traceInfo(`[orch] cancel_agent: cancelling ${agentEntry.sessionId} reason="${cancelReason}"`);

                try {
                    // Cascade: cancel all descendants of the target agent first
                    const descendants: string[] = yield manager.getDescendantSessionIds(agentEntry.sessionId);
                    if (descendants.length > 0) {
                        ctx.traceInfo(`[orch] cancel_agent: cascading cancel to ${descendants.length} descendant(s)`);
                        for (const descId of descendants) {
                            try {
                                yield manager.cancelSession(descId, `Ancestor ${agentEntry.sessionId} cancelled: ${cancelReason}`);
                            } catch (err: any) {
                                ctx.traceInfo(`[orch] cancel_agent: failed to cancel descendant ${descId}: ${err.message} (non-fatal)`);
                            }
                        }
                    }
                    yield manager.cancelSession(agentEntry.sessionId, cancelReason);
                    agentEntry.status = "cancelled";
                } catch (err: any) {
                    ctx.traceInfo(`[orch] cancel_agent failed: ${err.message}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: cancel_agent failed: ${err.message}]`,
                    )) return "";
                    continue;
                }

                if (yield* queueFollowupAndMaybeContinue(
                    `[SYSTEM: Sub-agent ${targetOrchId} has been cancelled.${result.reason ? ` Reason: ${result.reason}` : ""}]`,
                )) return "";
                continue;
            }

            case "delete_agent": {
                const targetOrchId = result.agentId;
                const agentEntry = subAgents.find(a => a.orchId === targetOrchId);

                if (!agentEntry) {
                    ctx.traceInfo(`[orch] delete_agent: unknown agent ${targetOrchId}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: delete_agent failed — agent "${targetOrchId}" not found. ` +
                        `Known agents: ${subAgents.map(a => a.orchId).join(", ") || "none"}]`,
                    )) return "";
                    continue;
                }

                const deleteReason = result.reason ?? "Deleted by parent";
                ctx.traceInfo(`[orch] delete_agent: deleting ${agentEntry.sessionId} reason="${deleteReason}"`);

                try {
                    // Cascade: delete all descendants of the target agent first
                    const descendants: string[] = yield manager.getDescendantSessionIds(agentEntry.sessionId);
                    if (descendants.length > 0) {
                        ctx.traceInfo(`[orch] delete_agent: cascading delete to ${descendants.length} descendant(s)`);
                        for (const descId of descendants) {
                            try {
                                yield manager.deleteSession(descId, `Ancestor ${agentEntry.sessionId} deleted: ${deleteReason}`);
                            } catch (err: any) {
                                ctx.traceInfo(`[orch] delete_agent: failed to delete descendant ${descId}: ${err.message} (non-fatal)`);
                            }
                        }
                    }
                    yield manager.deleteSession(agentEntry.sessionId, deleteReason);
                    // Remove from subAgents tracking entirely
                    subAgents = subAgents.filter(a => a.orchId !== targetOrchId);
                } catch (err: any) {
                    ctx.traceInfo(`[orch] delete_agent failed: ${err.message}`);
                    if (yield* queueFollowupAndMaybeContinue(
                        `[SYSTEM: delete_agent failed: ${err.message}]`,
                    )) return "";
                    continue;
                }

                if (yield* queueFollowupAndMaybeContinue(
                    `[SYSTEM: Sub-agent ${targetOrchId} has been deleted.${result.reason ? ` Reason: ${result.reason}` : ""}]`,
                )) return "";
                continue;
            }

            case "error": {
                const missingStateIndex = result.message.indexOf(SESSION_STATE_MISSING_PREFIX);
                if (missingStateIndex >= 0) {
                    const fatalError = result.message.slice(missingStateIndex + SESSION_STATE_MISSING_PREFIX.length).trim();
                    ctx.traceInfo(`[orch] fatal missing session state: ${fatalError}`);
                    publishStatus("failed", { error: fatalError, fatal: true });
                    yield manager.updateCmsState(input.sessionId, "failed", fatalError);
                    throw new Error(fatalError);
                }

                // Treat like an activity failure — retry with backoff.
                retryCount++;
                ctx.traceInfo(`[orch] turn returned error (attempt ${retryCount}/${MAX_RETRIES}): ${result.message}`);

                if (retryCount >= MAX_RETRIES) {
                    ctx.traceInfo(`[orch] max retries exhausted for turn error, waiting for user input`);
                    publishStatus("error", {
                        error: `Failed after ${MAX_RETRIES} attempts: ${result.message}`,
                        retriesExhausted: true,
                    });
                    retryCount = 0;
                    continue;
                }

                publishStatus("error", {
                    error: `${result.message} (retry ${retryCount}/${MAX_RETRIES})`,
                });

                const errorRetryDelay = 15 * Math.pow(2, retryCount - 1);
                ctx.traceInfo(`[orch] retrying in ${errorRetryDelay}s after turn error`);

                if (blobEnabled) {
                    yield* dehydrateForNextTurn("error");
                }

                yield ctx.scheduleTimer(errorRetryDelay * 1000);
                yield versionedContinueAsNew(continueInput({
                    prompt,
                    retryCount,
                    needsHydration: blobEnabled ? true : needsHydration,
                }));
                return "";
            }
        }
    }
}
