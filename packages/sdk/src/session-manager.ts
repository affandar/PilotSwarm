import { CopilotClient, type CopilotSession, type SectionOverride, type SystemMessageConfig, type Tool } from "@github/copilot-sdk";
import { ManagedSession } from "./managed-session.js";
import type { SessionStateStore } from "./session-store.js";
import { SESSION_STATE_MISSING_PREFIX, type AbortTurnResult, type ManagedSessionConfig, type SerializableSessionConfig } from "./types.js";
import type { ModelProviderRegistry } from "./model-providers.js";
import { applyReasoningEffortToProviderConfig } from "./model-providers.js";
import { createFactTools } from "./facts-tools.js";
import { createGraphTools } from "./graph-tools.js";
import { createInspectTools, NO_VIEWER, type InspectViewer } from "./inspect-tools.js";
import { pinToolsNeverDefer } from "./tool-pinning.js";
import type { SessionCatalog } from "./cms.js";
import { SYSTEM_USER_PRINCIPAL } from "./cms.js";
import { evaluateRoleObservation } from "../api/src/session-authz.js";

/**
 * How long a resolved inspect viewer may be reused before it is looked up
 * again. Bounds how long a privilege change takes to bite; short enough that
 * a demotion lands within a turn or two, long enough that a chatty diagnostic
 * turn does not re-query per tool call.
 */
const INSPECT_VIEWER_TTL_MS = 30_000;
import type { FactStore } from "./facts-store.js";
import { isEnhancedFactStore } from "./facts-store.js";
import type { GraphStore } from "./graph-store.js";
import { buildKnowledgePromptBlocks, loadKnowledgeIndexFromFactStore, buildEnhancedRetrievalPromptBlock, buildGraphReaderPromptBlock } from "./knowledge-index.js";
import { composeStructuredSystemMessage, extractPromptContent, mergePromptSections } from "./prompt-layering.js";
import { buildPromptLayersEventPayload, type PromptLayerDescriptor } from "./prompt-layers.js";
import { approvePermissionForSession } from "./permissions.js";
import { readSnapshotMarker, supportsVersionedSnapshots, writeSnapshotMarker } from "./snapshot-protocol.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const DEHYDRATE_STORE_MAX_RETRIES = 1;
const DEHYDRATE_STORE_RETRY_BASE_DELAY_MS = 0;
const SESSION_LOCK_BACKOFF_MS = [5_000, 10_000, 20_000] as const;
const SESSION_LOCK_MAX_WAIT_MS = 120_000;
export const SESSION_LOCK_ACQUIRE_TIMEOUT_CODE = "PILOTSWARM_SESSION_LOCK_ACQUIRE_TIMEOUT";

export class SessionLockAcquireTimeoutError extends Error {
    readonly code = SESSION_LOCK_ACQUIRE_TIMEOUT_CODE;
    readonly sessionId: string;
    readonly operation: string;
    readonly waitedMs: number;

    constructor(sessionId: string, operation: string, waitedMs: number) {
        super(`can't acquire session lock for session ${sessionId} while running ${operation} after ${waitedMs}ms`);
        this.name = "SessionLockAcquireTimeoutError";
        this.sessionId = sessionId;
        this.operation = operation;
        this.waitedMs = waitedMs;
    }
}

export function isSessionLockAcquireTimeoutError(error: unknown): error is SessionLockAcquireTimeoutError {
    return Boolean(error && typeof error === "object" && (error as any).code === SESSION_LOCK_ACQUIRE_TIMEOUT_CODE);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(String(error));
}

type SessionTraceWriter = (message: string) => void;

function emitSessionManagerTrace(
    sessionId: string,
    message: string,
    options?: { trace?: SessionTraceWriter; level?: "info" | "warn" },
): void {
    const line = `[SessionManager] session=${sessionId} orch=session-${sessionId} ${message}`;
    if (typeof options?.trace === "function") {
        options.trace(line);
        return;
    }
    if (options?.level === "warn") {
        console.warn(line);
        return;
    }
    console.info(line);
}

function isMissingDehydrateSnapshotError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /Session state directory not ready during dehydrate/i.test(message);
}

/**
 * One loadable copy of a named agent.
 *
 * Agent-package scope shadowing means one agent NAME can be served by several
 * enabled packages at once (a shared copy plus per-user copies). Each copy is
 * a distinct prompt/descriptor; which one a session gets is decided per
 * session owner (`pickAgentCopyForOwner`), the same "own copy shadows shared"
 * rule the registry resolver applies. Non-package (deployment plugin) agents
 * carry no package fields.
 */
export interface AgentCopyEntry {
    prompt: string;
    kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent";
    descriptor?: import("./prompt-layers.js").PromptLayerDescriptor;
    packageId?: string;
    packageScope?: "shared" | "user";
    packageOwner?: { provider: string; subject: string } | null;
}

/**
 * The lookup value for one agent name: a deterministic default copy
 * (deployment code beats shared package beats user package), plus every copy
 * when the name is served by more than one.
 */
export interface AgentPromptEntry extends AgentCopyEntry {
    copies?: AgentCopyEntry[];
}

/** Key under which a package copy's per-agent config (MCP) is registered. */
export function packageAgentKey(packageId: string, agentName: string): string {
    return `pkg\u0001${packageId}\u0001${agentName}`;
}

/** Owner key used to match a session owner against a package copy's owner. */
export function agentOwnerKey(owner?: { provider?: string | null; subject?: string | null } | null): string | null {
    return owner?.provider && owner?.subject ? `${owner.provider}\u0001${owner.subject}` : null;
}

/**
 * Which copy of an agent name does THIS session get?
 *
 * Runs per turn, so enabling/disabling a copy re-resolves exactly like a
 * republish does — live sessions follow the registry's current answer, they
 * are not pinned to a copy.
 *
 * FAIL CLOSED, matching resolveAgentDefinitionForCaller: a user-scope copy is
 * PRIVATE to its owner, and the worker holds every tenant's copies at once.
 * The order is (1) the session owner's OWN user copy, (2) the best copy that
 * is public by construction — a deployment agent or a shared package. A
 * user-scope copy owned by someone ELSE is NEVER served, even when it is the
 * only copy of the name left: returning it would leak that owner's prompt,
 * MCP grants, and tool handlers into this session (they all follow the copy
 * picked here). undefined means "no package overlay for this session" — the
 * same outcome as the agent having been deleted, which is correct.
 */
export function pickAgentCopyForOwner(
    entry: AgentPromptEntry | undefined,
    ownerKey: string | null,
): AgentCopyEntry | undefined {
    if (!entry) return undefined;
    const copies = entry.copies?.length ? entry.copies : [entry];
    if (ownerKey) {
        const own = copies.find(
            (copy) => copy.packageScope === "user" && agentOwnerKey(copy.packageOwner) === ownerKey,
        );
        if (own) return own;
    }
    // The best PUBLIC copy, BY RANK not insertion order: a deployment agent
    // (no packageScope) outranks a shared package, matching the worker's
    // _finalizeAgentPromptLookup default. copies[] preserves load order, so
    // picking by find() alone could hand back a shared package while a
    // deployment agent of the same name exists — the two would disagree about
    // which copy is the default. Never a foreign private copy, at any rank.
    return copies.find((copy) => copy.packageScope == null)
        ?? copies.find((copy) => copy.packageScope === "shared")
        ?? undefined;
}

/** Worker-level defaults — applied to every session. */
export interface WorkerDefaults {
    frameworkBasePrompt?: string;
    frameworkBaseToolNames?: string[];
    appDefaultPrompt?: string;
    appDefaultToolNames?: string[];
    /** Backward-compatible alias for older code paths/tests. */
    systemMessage?: string;
    /** Raw prompt lookup for named and system agents bound directly to sessions. */
    agentPromptLookup?: Record<string, AgentPromptEntry>;
    /** Descriptor for the PilotSwarm framework base layer (from system default.agent.md). */
    frameworkBaseDescriptor?: import("./prompt-layers.js").PromptLayerDescriptor;
    /** Descriptor for the app default layer (from app default.agent.md or inline config). */
    appDefaultDescriptor?: import("./prompt-layers.js").PromptLayerDescriptor;
    /** Skill directories to pass to the Copilot SDK. */
    skillDirectories?: string[];
    /** Custom agents to pass to the Copilot SDK. */
    customAgents?: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; skills?: string[]; mcpServers?: Record<string, any> }>;
    /**
     * Deployment MCP catalog (merged `.mcp.json` map). NOT applied to
     * sessions wholesale — a session receives exactly its bound agent's
     * resolved map from `agentMcpServers` (capability-profiles Phase 1).
     */
    mcpServers?: Record<string, any>;
    /** Resolved per-agent MCP server maps, keyed by bound agent name. */
    agentMcpServers?: Record<string, Record<string, any>>;
    /**
     * Resolved base MCP map applied to EVERY session: base (default) agent
     * opt-ins plus direct worker-config servers (legacy semantics).
     */
    baseMcpServers?: Record<string, any>;
    /**
     * @deprecated Use `modelProviders` instead. Kept for backwards compatibility.
     * Custom LLM provider config (BYOK). Passed to every session.
     */
    provider?: {
        type?: "openai" | "azure" | "anthropic";
        baseUrl: string;
        apiKey?: string;
        azure?: { apiVersion?: string };
    };
    /** Multi-provider model registry. Takes precedence over `provider`. */
    modelProviders?: ModelProviderRegistry;
    /** Wall-clock turn cap in ms. 0 = no cap; undefined = 20-minute default. */
    turnTimeoutMs?: number;
    /** Turn inactivity watchdog in ms. 0 = disabled; undefined = 5-minute default. */
    turnInactivityTimeoutMs?: number;
}

function buildEffectivePromptLayers(
    workerDefaults: WorkerDefaults,
    config: SerializableSessionConfig,
    sessionOwnerKey: string | null = null,
): PromptLayerDescriptor[] {
    const boundAgentName = config.boundAgentName;
    const layerKind = config.promptLayering?.kind ?? (boundAgentName ? "app-agent" : undefined);
    const isPilotSwarmSystemAgent = layerKind === "pilotswarm-system-agent";
    const layers: PromptLayerDescriptor[] = [];
    if (workerDefaults.frameworkBaseDescriptor) layers.push(workerDefaults.frameworkBaseDescriptor);
    if (!isPilotSwarmSystemAgent && workerDefaults.appDefaultDescriptor) layers.push(workerDefaults.appDefaultDescriptor);
    if (boundAgentName) {
        const copy = pickAgentCopyForOwner(workerDefaults.agentPromptLookup?.[boundAgentName], sessionOwnerKey);
        if (copy?.descriptor) layers.push(copy.descriptor);
    }
    return layers;
}

/**
 * SessionManager — singleton per worker node.
 * Owns session lifecycle, wraps CopilotClient.
 *
 * Three ways a session appears:
 *   1. Brand new → createSession
 *   2. Same node, still warm → getSession returns it
 *   3. Post-hydration → local files exist → resumeSession
 *
 * @internal
 */
/**
 * Capability declaration for a model the Copilot catalog does not know.
 *
 * Returns undefined when the catalog says nothing useful — an empty override
 * is worse than none, since it would assert "no vision, no reasoning" rather
 * than "unknown".
 *
 * @internal Exported for test/unit/byok-context-window.test.mjs only.
 */
export function buildByokModelCapabilities(
    descriptor: any,
    contextTier?: string,
): { supports?: Record<string, boolean>; limits?: Record<string, unknown> } | undefined {
    if (!descriptor) return undefined;

    const supports: Record<string, boolean> = {};
    if (Array.isArray(descriptor.supportedReasoningEfforts) && descriptor.supportedReasoningEfforts.length > 0) {
        supports.reasoningEffort = true;
    }
    if (descriptor.vision) supports.vision = true;

    const limits: Record<string, unknown> = {};
    const sizes = descriptor.contextWindowSizes;
    if (sizes && typeof sizes === "object") {
        // Prefer the session's tier, else the largest declared — the catalog
        // is stating what the model can do, not what this turn will use.
        const tierValue = contextTier ? sizes[contextTier] : undefined;
        const window = Number.isFinite(tierValue)
            ? Number(tierValue)
            : Math.max(...Object.values(sizes).map((v) => Number(v)).filter((v) => Number.isFinite(v)), 0);
        if (window > 0) {
            limits.max_context_window_tokens = window;
            // max_prompt_tokens is the one that actually does anything.
            // Measured against @github/copilot-sdk 1.0.9 with kimi-k3, three
            // arms, one message each, reading session.usage_info.tokenLimit:
            //   max_context_window_tokens alone -> 128000 (the runtime default)
            //   max_prompt_tokens alone         -> 1048576
            //   both                            -> 1048576
            // tokenLimit is what the child process divides by to decide when to
            // compact, so without this line the declaration changes nothing and
            // a 1M model still compacts at ~102K.
            limits.max_prompt_tokens = window;
        }
    }
    if (descriptor.vision && typeof descriptor.vision === "object") {
        const v: Record<string, unknown> = {};
        if (Number.isFinite(descriptor.vision.maxImages)) v.max_prompt_images = Number(descriptor.vision.maxImages);
        if (Number.isFinite(descriptor.vision.maxImageBytes)) v.max_prompt_image_size = Number(descriptor.vision.maxImageBytes);
        if (Array.isArray(descriptor.vision.supportedMediaTypes)) v.supported_media_types = descriptor.vision.supportedMediaTypes;
        if (Object.keys(v).length > 0) limits.vision = v;
    }

    // `limits` is the only part that does real work, so a supports-only block
    // is dropped entirely.
    //
    // Declaring supports.reasoningEffort does NOT make the runtime send
    // reasoning_effort for a BYOK provider — measured five ways, see the note
    // at the sessionConfig call site. So a block carrying only `supports`
    // buys nothing, while still overriding runtime state for every BYOK model
    // in every deployment that has no contextWindowSizes in its catalog.
    // Measured against waldemort's catalog: 8 of its 14 models declare
    // supportedReasoningEfforts and no contextWindowSizes, so without this
    // line they would each start receiving {supports:{reasoningEffort:true}}
    // for no gain. A model that really can see gets limits.vision, so vision
    // declarations still survive.
    if (Object.keys(limits).length === 0) return undefined;
    return {
        ...(Object.keys(supports).length > 0 ? { supports } : {}),
        limits,
    };
}

export class SessionManager {
    /**
     * Resolved inspect viewers, keyed by session id. Static so it is shared
     * across manager instances in a worker process.
     *
     * The TTL alone does NOT bound this map: it is only consulted on read, so
     * a session touched once and never again leaves its entry behind forever.
     * A long-lived worker sees an unbounded number of session ids, so entries
     * are swept on insert once the map crosses a threshold.
     */
    private static _inspectViewerCache = new Map<string, { at: number; viewer: InspectViewer }>();
    private static readonly INSPECT_VIEWER_CACHE_SWEEP_AT = 2_000;

    private clients = new Map<string, CopilotClient>();
    /**
     * Backward-compat accessor for the default-token CopilotClient.
     *
     * The internal multi-client pool is keyed by GitHub Copilot token (so
     * per-user keys can override `GITHUB_TOKEN` for a specific session).
     * Tests that predate the pool — and a couple of internal call sites
     * that assume a single shared client — still read or assign
     * `manager.client = fakeClient` to inject a stub. Honor that by
     * populating both the empty-key slot AND the worker-default token
     * slot so `ensureClient()` returns the fake whether or not the
     * default `GITHUB_TOKEN` was set on the constructor.
     */
    get client(): CopilotClient | undefined {
        return this.clients.get("") ?? this.clients.get(this.githubToken || "");
    }
    set client(value: CopilotClient | undefined) {
        if (value) {
            this.clients.set("", value);
            if (this.githubToken) this.clients.set(this.githubToken, value);
        } else {
            this.clients.delete("");
            if (this.githubToken) this.clients.delete(this.githubToken);
        }
    }
    private sessions = new Map<string, ManagedSession>();

    /** Live in-memory session count — worker-registry health reporting. */
    get activeSessionCount(): number {
        return this.sessions.size;
    }
    /**
     * Records which CopilotClient each warm session is bound to (keyed by
     * the GitHub Copilot token). When the resolved token for a session
     * changes (for example the owner edited their per-user key in the
     * Admin Console), the warm session is destroyed at the start of the
     * next `getOrCreate` call so the next resume binds to the right
     * client. Sessions never appear in this map until they are actually
     * created/resumed in `_getOrCreateUnlocked`.
     */
    private sessionClientKeys = new Map<string, string>();
    private sessionStore: SessionStateStore | null = null;
    /** In-memory configs with non-serializable fields (tools, hooks). */
    private sessionConfigs = new Map<string, ManagedSessionConfig>();
    /** Worker-level tool registry — shared reference from PilotSwarmWorker. */
    private toolRegistry = new Map<string, Tool<any>>();
    /** Per-package tool maps, so a session prefers ITS package's handler on a name collision. */
    private packageToolRegistry: Map<string, Map<string, Tool<any>>> | null = null;
    /** Names registered by deployment code — a package tool must never shadow these. */
    private staticToolNames: Set<string> | null = null;
    /** Worker-level defaults for building blocks. */
    private workerDefaults: WorkerDefaults;
    /** Base directory for local session state files. */
    private sessionStateDir: string;
    /** Shared facts store used to build always-on facts tools. */
    private factStore: FactStore | null = null;
    /** Optional, separately-injected graph store (07 D2). Present iff a
     * graphDatabaseUrl was configured; gates graph-tool registration. */
    private graphStore: GraphStore | null = null;
    /** Shared CMS catalog used to build always-on inspect tools. */
    private sessionCatalog: SessionCatalog | null = null;
    /** Duroxide client used by tuner-only inspect tools. */
    private _duroxideClient: any = null;
    /** Lineage lookup for ancestor/descendant facts access. */
    private _getLineageSessionIds: ((sessionId: string) => Promise<string[]>) | null = null;
    /** Per-session critical sections; protects the SDK session handle and local session.db. */
    private sessionLocks = new Map<string, Promise<void>>();
    /** Last local activity per session — feeds the autonomous eviction clock. */
    private sessionLastTouchedAt = new Map<string, number>();

    constructor(
        private githubToken?: string,
        sessionStore?: SessionStateStore | null,
        workerDefaults?: WorkerDefaults,
        sessionStateDir?: string,
    ) {
        this.sessionStore = sessionStore ?? null;
        this.workerDefaults = workerDefaults ?? {};
        this.sessionStateDir = sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
    }

    /**
     * Artifact store, assigned by the worker after construction.
     *
     * Set here rather than taken as a constructor argument because the worker
     * builds its store after the SessionManager, and the only consumer is the
     * write bundle's patch artifacts — which degrade to a clear refusal when
     * it is absent rather than failing a turn.
     */
    artifactStore: import("./session-store.js").ArtifactStore | null = null;

    /** Store full config (with tools/hooks) for a session. Called by PilotSwarmClient. */
    setConfig(sessionId: string, config: ManagedSessionConfig): void {
        this.sessionConfigs.set(sessionId, config);
    }

    /** Get a human-readable model summary for LLM tool consumption. */
    getModelSummary(): string | undefined {
        return this.workerDefaults.modelProviders?.getModelSummaryForLLM();
    }

    /**
     * Normalize a model reference against the configured registry.
     * Throws for unknown models. When `requireQualified` is true, the caller
     * must provide the exact `provider:model` string rather than a bare alias.
     */
    normalizeModelRef(model?: string, options?: { requireQualified?: boolean }): string | undefined {
        const registry = this.workerDefaults.modelProviders;
        if (!registry) return model;

        const ref = model || registry.defaultModel;
        if (!ref) {
            if (model) {
                throw new Error(
                    `Unknown model "${model}". Call list_available_models and choose an exact configured provider:model value.`,
                );
            }
            throw new Error(
                "No default model is configured. Set defaultModel in model_providers.json or specify an explicit provider:model when creating the session.",
            );
        }

        const normalized = registry.normalize(ref);
        if (!normalized) {
            throw new Error(
                `Unknown model "${ref}". Call list_available_models and choose an exact configured provider:model value.`,
            );
        }
        if (options?.requireQualified && ref !== normalized) {
            throw new Error(
                `Model "${ref}" is not allowed. Use the exact provider:model value returned by list_available_models, for example "${normalized}".`,
            );
        }
        return normalized;
    }

    resolveModelSwitchConfig(
        model: string,
        reasoningEffort?: import("./model-providers.js").ReasoningEffort | null,
    ): { model: string; reasoningEffort: import("./model-providers.js").ReasoningEffort | null } {
        const normalized = this.normalizeModelRef(model, { requireQualified: true });
        const registry = this.workerDefaults.modelProviders;
        const descriptor = registry?.getDescriptor(normalized);
        if (reasoningEffort) {
            const supported = descriptor?.supportedReasoningEfforts ?? [];
            if (!supported.includes(reasoningEffort)) {
                throw new Error(`Model ${normalized} does not support reasoning effort '${reasoningEffort}'`);
            }
            return { model: normalized!, reasoningEffort };
        }
        return {
            model: normalized!,
            reasoningEffort: descriptor?.defaultReasoningEffort ?? null,
        };
    }

    /**
     * Cached Copilot model catalogs for vision-capability lookups (5 min TTL),
     * keyed by client token key — capability entitlements are PER TOKEN
     * (per-user keys can differ from the deployment default), so one shared
     * cache would leak one identity's catalog onto another's sessions.
     */
    private modelCatalogCaches = new Map<string, { fetchedAt: number; models: Array<{ id: string; capabilities?: any }> }>();

    /**
     * Resolve whether a session's model can be shown images, plus the
     * provider's vision limits. `modelRef` is the session-config value
     * (qualified `provider:model`, bare, or undefined → worker default).
     *
     * When `opts.sessionId` is given, the catalog is consulted on the SAME
     * CopilotClient that serves that session's turns (per-user/system key
     * aware) — the only token whose entitlements matter, because it is the
     * one the image blobs ride out on. Without a sessionId (tests, generic
     * callers) the default-token client is used as before.
     *
     * `known: false` means the catalog had no entry (BYOK model, catalog
     * fetch failure, no usable client, …) — callers must treat that as "no
     * vision" and degrade gracefully rather than guessing.
     */
    async getModelVisionInfo(modelRef?: string, opts?: { sessionId?: string }): Promise<{
        modelId: string;
        known: boolean;
        vision: boolean;
        supportedMediaTypes?: string[];
        maxImages?: number;
        maxImageBytes?: number;
    }> {
        let sdkModelName = String(modelRef || "").trim();
        // Hoisted out of the try: the declared-capability check below needs it.
        let descriptor: ReturnType<NonNullable<typeof this.workerDefaults.modelProviders>["getDescriptor"]> | undefined;
        try {
            const normalized = this.normalizeModelRef(modelRef || undefined);
            descriptor = this.workerDefaults.modelProviders?.getDescriptor(normalized);
            if (descriptor?.modelName) sdkModelName = descriptor.modelName;
            else if (normalized) sdkModelName = normalized.includes(":") ? normalized.split(":").slice(1).join(":") : normalized;
        } catch {
            // Unknown ref — fall through with the raw name; the catalog lookup decides.
            if (sdkModelName.includes(":")) sdkModelName = sdkModelName.split(":").slice(1).join(":");
        }
        if (!sdkModelName) return { modelId: "", known: false, vision: false };

        // A DECLARED capability wins, and skips the catalog entirely.
        //
        // The catalog below is the Copilot model list. A BYOK model — Fireworks,
        // a local vLLM — is never in it, so the lookup returns no entry, this
        // function reports `vision: false`, and the attachment gate drops every
        // image before its bytes are fetched. No amount of catalog querying can
        // fix that; only the operator knows, and this is where they say so.
        //
        // Absent a declaration nothing changes: Copilot and Azure models keep
        // resolving from the catalog exactly as before, and an unknown model
        // still fails closed.
        if (descriptor?.vision) {
            const declared = descriptor.vision;
            return {
                modelId: sdkModelName,
                known: true,
                vision: true,
                ...(Array.isArray(declared.supportedMediaTypes) ? { supportedMediaTypes: declared.supportedMediaTypes } : {}),
                ...(Number.isFinite(declared.maxImages) ? { maxImages: Number(declared.maxImages) } : {}),
                ...(Number.isFinite(declared.maxImageBytes) ? { maxImageBytes: Number(declared.maxImageBytes) } : {}),
            };
        }

        // Consult the catalog on the client that will serve this session's
        // turns. Prefer the recorded binding; on a cold worker the gate runs
        // before getOrCreate records one, so fall through to the same
        // per-user/system key resolution getOrCreate itself performs. Only a
        // session with no per-user key lands on the worker-default client.
        let client: CopilotClient | undefined;
        let cacheKey = "";
        if (opts?.sessionId) {
            let key = this.sessionClientKeys.get(opts.sessionId);
            if (key == null) {
                try {
                    const normalizedRef = this.normalizeModelRef(modelRef || undefined);
                    key = (await this._resolveSessionGitHubToken(opts.sessionId, {} as ManagedSessionConfig, normalizedRef || "")) || "";
                } catch {
                    key = "";
                }
            }
            cacheKey = key;
            try {
                client = await this.ensureClient(key || undefined);
            } catch {
                client = undefined;
            }
        }
        if (!client) {
            client = this.client;
            cacheKey = "";
        }
        if (!client) return { modelId: sdkModelName, known: false, vision: false };

        const now = Date.now();
        let cache = this.modelCatalogCaches.get(cacheKey);
        if (!cache || now - cache.fetchedAt > 5 * 60 * 1000) {
            try {
                const models = await client.listModels();
                cache = { fetchedAt: now, models: models as any[] };
                this.modelCatalogCaches.set(cacheKey, cache);
            } catch {
                // Keep a stale cache if we have one; otherwise report unknown.
                if (!cache) return { modelId: sdkModelName, known: false, vision: false };
            }
        }
        const entry = cache.models.find((m) => m?.id === sdkModelName)
            ?? cache.models.find((m) => String(m?.id || "").toLowerCase() === sdkModelName.toLowerCase());
        if (!entry) return { modelId: sdkModelName, known: false, vision: false };
        const caps = (entry as any).capabilities;
        const visionLimits = caps?.limits?.vision;
        return {
            modelId: sdkModelName,
            known: true,
            vision: Boolean(caps?.supports?.vision),
            ...(Array.isArray(visionLimits?.supported_media_types) ? { supportedMediaTypes: visionLimits.supported_media_types } : {}),
            ...(Number.isFinite(visionLimits?.max_prompt_images) ? { maxImages: Number(visionLimits.max_prompt_images) } : {}),
            ...(Number.isFinite(visionLimits?.max_prompt_image_size) ? { maxImageBytes: Number(visionLimits.max_prompt_image_size) } : {}),
        };
    }

    /**
     * Set the worker-level tool registry. Called by PilotSwarmWorker.
     *
     * `opts.byPackage` carries each agent package's own tool map so a session
     * bound to a package copy resolves colliding tool names to ITS copy's
     * handler. `opts.staticNames` marks deployment-registered tools, which win
     * every collision (a package must not shadow deployment code).
     */
    setToolRegistry(
        registry: Map<string, Tool<any>>,
        opts?: { byPackage?: Map<string, Map<string, Tool<any>>>; staticNames?: Set<string> },
    ): void {
        this.toolRegistry = registry;
        this.packageToolRegistry = opts?.byPackage ?? null;
        this.staticToolNames = opts?.staticNames ?? null;
    }

    /** Set the cluster facts store for always-on facts tools. */
    setFactStore(factStore: FactStore | null): void {
        this.factStore = factStore;
    }

    /** Set the optional graph store (07 D2). `null`/absent ⇒ no graph tools. */
    setGraphStore(graphStore: GraphStore | null): void {
        this.graphStore = graphStore;
    }

    /** Set the CMS catalog for always-on inspect tools (e.g. read_agent_events). */
    setSessionCatalog(catalog: SessionCatalog | null): void {
        this.sessionCatalog = catalog;
    }

    /**
     * Hot-swap the model-provider registry after a config-file change on
     * disk (ConfigMap update). Applies to all subsequent model resolution;
     * live warm sessions keep their bound client until their next
     * getOrCreate re-resolves.
     */
    setModelProviders(registry: import("./model-providers.js").ModelProviderRegistry | null): void {
        this.workerDefaults.modelProviders = registry ?? undefined;
    }

    /** Set the duroxide client for tuner-only inspect tools. */
    setDuroxideClient(client: any): void {
        this._duroxideClient = client;
    }

    /** Set the lineage lookup for ancestor/descendant facts access. */
    setLineageSessionLookup(fn: ((sessionId: string) => Promise<string[]>) | null): void {
        this._getLineageSessionIds = fn;
    }

    /** @deprecated Use setLineageSessionLookup. */
    setDescendantSessionLookup(fn: ((sessionId: string) => Promise<string[]>) | null): void {
        this.setLineageSessionLookup(fn);
    }

    /**
     * Resolve the default model's SDK provider config.
     * Used by activities (e.g. summarizeSession) that need a lightweight LLM
     * without requiring a GitHub token.
     */
    resolveDefaultProvider(): { modelName: string; sdkProvider: any } | undefined {
        const registry = this.workerDefaults.modelProviders;
        if (!registry?.defaultModel) return undefined;
        const resolved = registry.resolve(registry.defaultModel);
        if (!resolved?.sdkProvider) return undefined;
        return { modelName: resolved.modelName, sdkProvider: resolved.sdkProvider };
    }

    /**
     * Resolve an arbitrary model ref (or the deployment default) to ephemeral
     * SDK session options. Null when the ref doesn't resolve — the regen
     * distiller walks its fallback chain on that (a dead session model must
     * not block the regeneration that exists to escape it).
     */
    resolveModelSessionOptions(ref?: string): { model?: string; provider?: unknown; gitHubToken?: string } | null {
        const registry = this.workerDefaults.modelProviders;
        if (!registry) {
            return this.githubToken ? { gitHubToken: this.githubToken } : null;
        }
        const target = ref ?? registry.defaultModel;
        if (!target) return this.githubToken ? { gitHubToken: this.githubToken } : null;
        try {
            const resolved = registry.resolve(target);
            if (!resolved) return null;
            if (resolved.sdkProvider) return { model: resolved.modelName, provider: resolved.sdkProvider };
            if (resolved.githubToken) return { model: resolved.modelName, gitHubToken: resolved.githubToken };
            return null;
        } catch {
            return null;
        }
    }

    /** Ensure the CopilotClient is started. */
    private async ensureClient(tokenOverride?: string): Promise<CopilotClient> {
        // Resolve the effective token: explicit override > worker default >
        // first registry github provider's resolved token. The override is
        // how per-user GitHub Copilot keys (cms.users.github_copilot_key)
        // get plumbed through to a dedicated CopilotClient.
        let token = tokenOverride;
        if (!token) token = this.githubToken;
        if (!token && this.workerDefaults.modelProviders) {
            for (const p of this.workerDefaults.modelProviders.allProviders) {
                if (p.type === "github" && p.models.length > 0) {
                    const firstModel = typeof p.models[0] === "string" ? p.models[0] : p.models[0].name;
                    const resolved = this.workerDefaults.modelProviders.resolve(`${p.id}:${firstModel}`);
                    token = resolved?.githubToken;
                    break;
                }
            }
        }

        const clientKey = token || "";
        const existing = this.clients.get(clientKey);
        if (existing) return existing;

        const created = new CopilotClient({
            ...(token ? { gitHubToken: token } : {}),
            logLevel: "error",
            // The Copilot CLI honors COPILOT_HOME (and only COPILOT_HOME) to decide
            // where to write per-session state. Passing `configDir` on SessionConfig
            // is inert for state placement (verified empirically against
            // @github/copilot 1.0.36). We export COPILOT_HOME here so the CLI's
            // ~/.copilot resolves to <sessionStateDir>/.., which keeps test isolation
            // honest and lets production deployments place session state on the
            // mounted emptyDir volume rather than the container's user home.
            //
            // All per-token CopilotClients share the same COPILOT_HOME; this is
            // safe because each session id is owned by a single client at any
            // moment (sessionClientKeys maps session_id -> token), and the
            // SessionManager destroys the warm handle on a token-change before
            // the new client touches the same session id.
            env: {
                ...process.env,
                COPILOT_HOME: path.dirname(this.sessionStateDir),
            },
        });
        this.clients.set(clientKey, created);
        return created;
    }

    /**
     * Return the GitHub Copilot token that should back the CopilotClient
     * used to resume/create the given session id. Resolution order:
     *
     *   1. Per-user override on the session's owner row in CMS
     *      (`users.github_copilot_key`). Only applied when the session's
     *      effective model resolves to a `type=github` provider — for
     *      BYOK Anthropic/OpenAI sessions the SDK never reads the token
     *      so there is no point spinning up a per-user CLI process.
     *   2. Worker-default resolution (constructor token > registry).
     *
     * Returns `undefined` to mean "use the worker default", which is the
     * shape `ensureClient` already understands.
     */
    private async _resolveSessionGitHubToken(
        sessionId: string,
        config: ManagedSessionConfig,
        effectiveModel: string,
        preloadedRow?: any,
    ): Promise<string | undefined> {
        if (!this.sessionCatalog) return undefined;

        const registry = this.workerDefaults.modelProviders;
        if (!registry || !effectiveModel) return undefined;
        const resolved = registry.resolve(effectiveModel);
        if (!resolved || resolved.type !== "github") return undefined;

        let row: any = preloadedRow ?? null;
        if (!row) {
            try {
                row = await this.sessionCatalog.getSession(sessionId);
            } catch {
                return undefined;
            }
        }
        // Ownerless system sessions act as the first-class SYSTEM user for
        // credential purposes: an admin-stored System key (Admin Console →
        // "Store as System key") resolves through the same per-user path.
        const owner = row?.owner;
        const principal = owner?.provider && owner?.subject
            ? {
                provider: owner.provider,
                subject: owner.subject,
                email: owner.email ?? null,
                displayName: owner.displayName ?? null,
            }
            : (row?.isSystem ? SYSTEM_USER_PRINCIPAL : null);
        if (!principal) return undefined;

        try {
            const userKey = await this.sessionCatalog.getUserGitHubCopilotKey(principal);
            return userKey ?? undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Pick the CopilotClient that was used to create/resume the given
     * session. Used by destroy / reset paths that operate on a known
     * session id outside the main getOrCreate flow.
     */
    private async _ensureClientForSession(sessionId: string): Promise<CopilotClient> {
        const cachedKey = this.sessionClientKeys.get(sessionId);
        if (cachedKey != null) {
            const cached = this.clients.get(cachedKey);
            if (cached) return cached;
            return this.ensureClient(cachedKey || undefined);
        }
        return this.ensureClient();
    }

    private _missingSessionStateError(sessionId: string, turnIndex: number, detail?: string): Error {
        const suffix = detail ? ` ${detail}` : "";
        return new Error(
            `${SESSION_STATE_MISSING_PREFIX} turn ${turnIndex} expected resumable Copilot session state for ${sessionId}, ` +
            `but none was found in memory, on disk, or in the session store.${suffix}`,
        );
    }

    private async _resetSessionState(sessionId: string): Promise<void> {
        const existing = this.sessions.get(sessionId);
        if (existing) {
            try {
                await existing.destroy();
            } catch {}
            this.sessions.delete(sessionId);
        }

        try {
            const client = await this._ensureClientForSession(sessionId);
            await client.deleteSession(sessionId);
        } catch {}

        // After we drop the session state we no longer remember which
        // CopilotClient (= which token) it was bound to; the next
        // getOrCreate will re-resolve.
        this.sessionClientKeys.delete(sessionId);

        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        if (this.sessionStore) {
            try {
                await this.sessionStore.delete(sessionId);
            } catch {}
        }
    }

    /**
     * Epoch-start reset (session regeneration): discard the warm handle, the
     * SDK's registration of the id, and the local dir — and clear ONLY the
     * current epoch's (empty or partial) store chain. Prior epochs' snapshots
     * and the legacy chain are never touched; they are the archive/rollback
     * record.
     */
    private async _resetSessionStateForEpoch(sessionId: string, epoch: number): Promise<void> {
        const existing = this.sessions.get(sessionId);
        if (existing) {
            try {
                await existing.destroy();
            } catch {}
            this.sessions.delete(sessionId);
        }

        try {
            const client = await this._ensureClientForSession(sessionId);
            await client.deleteSession(sessionId);
        } catch {}

        this.sessionClientKeys.delete(sessionId);

        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        if (this.sessionStore && epoch > 0) {
            try {
                await this.sessionStore.delete(sessionId, epoch);
            } catch {}
        }
    }

    private async _withSessionLock<T>(
        sessionId: string,
        operation: string,
        fn: () => Promise<T>,
        options?: { trace?: SessionTraceWriter },
    ): Promise<T> {
        const startedAt = Date.now();
        let backoffIndex = 0;
        let loggedFirstBackoff = false;

        while (true) {
            const currentLock = this.sessionLocks.get(sessionId);
            if (!currentLock) {
                let release!: () => void;
                const lock = new Promise<void>((resolve) => { release = resolve; });
                this.sessionLocks.set(sessionId, lock);
                try {
                    return await fn();
                } finally {
                    if (this.sessionLocks.get(sessionId) === lock) {
                        this.sessionLocks.delete(sessionId);
                    }
                    release();
                }
            }

            const waitedMs = Date.now() - startedAt;
            const remainingMs = SESSION_LOCK_MAX_WAIT_MS - waitedMs;
            if (remainingMs <= 0) {
                throw new SessionLockAcquireTimeoutError(sessionId, operation, SESSION_LOCK_MAX_WAIT_MS);
            }

            const configuredDelayMs = SESSION_LOCK_BACKOFF_MS[Math.min(backoffIndex, SESSION_LOCK_BACKOFF_MS.length - 1)];
            const delayMs = Math.min(configuredDelayMs, remainingMs);
            if (!loggedFirstBackoff) {
                loggedFirstBackoff = true;
                const message = `session lock busy for ${sessionId} during ${operation}; backing off for ${delayMs / 1000}s before retrying`;
                if (options?.trace) {
                    emitSessionManagerTrace(sessionId, message, { trace: options.trace, level: "warn" });
                }
                console.error(`[SessionManager] ${message}`);
            } else if (options?.trace) {
                emitSessionManagerTrace(
                    sessionId,
                    `session lock still busy during ${operation}; backing off for ${delayMs / 1000}s before retrying`,
                    { trace: options.trace },
                );
            }

            await Promise.race([
                currentLock.catch(() => undefined),
                sleep(delayMs),
            ]);
            backoffIndex += 1;
        }
    }

    async withRunTurnLock<T>(
        sessionId: string,
        operation: string,
        fn: () => Promise<T>,
        options?: { trace?: SessionTraceWriter },
    ): Promise<T> {
        this.sessionLastTouchedAt.set(sessionId, Date.now());
        try {
            return await this._withSessionLock(sessionId, operation, fn, options);
        } finally {
            this.sessionLastTouchedAt.set(sessionId, Date.now());
        }
    }

    /**
     * Autonomous eviction sweep (lifecycle protocol §3.4): local session
     * state is a cache. A session idle past `evictAfterMs` is reclaimed
     * without telling anyone — sessions with a committed snapshot marker
     * are simply destroyed + deleted (the store already holds their state;
     * the next runTurn self-validates and hydrates); unmarked (legacy)
     * sessions are dehydrated the old way so their only copy is preserved.
     * Returns the number of sessions reclaimed.
     */
    async sweepIdleSessions(evictAfterMs: number): Promise<number> {
        if (!(evictAfterMs > 0)) return 0;
        const now = Date.now();
        // Only sessions THIS manager has actually served since boot are
        // eviction candidates. Stranger dirs on disk (leftovers from a
        // previous container life, or another embedded worker sharing the
        // sessionStateDir) must never be pushed to the store — a stale dir
        // dehydrated over a newer snapshot silently rolls the session back.
        const candidates = new Set<string>([
            ...this.sessions.keys(),
            ...this.sessionLastTouchedAt.keys(),
        ]);

        let reclaimed = 0;
        for (const sessionId of candidates) {
            if (this.sessionLocks.has(sessionId)) continue; // busy — never race a turn
            const sessionDir = path.join(this.sessionStateDir, sessionId);
            const lastTouched = this.sessionLastTouchedAt.get(sessionId);
            if (lastTouched == null || now - lastTouched < evictAfterMs) continue;

            try {
                await this._withSessionLock(sessionId, "eviction", async () => {
                    // Re-check under the lock — a turn may have landed.
                    const touched = this.sessionLastTouchedAt.get(sessionId);
                    if (touched != null && Date.now() - touched < evictAfterMs) return;
                    const dirExists = fs.existsSync(sessionDir);
                    const committedMarker = dirExists ? readSnapshotMarker(sessionDir) : null;
                    const existing = this.sessions.get(sessionId);
                    if (existing) {
                        try { await existing.destroy(); } catch {}
                        this.sessions.delete(sessionId);
                    }
                    if (!dirExists) {
                        this.sessionLastTouchedAt.delete(sessionId);
                        reclaimed++;
                        return;
                    }
                    if (committedMarker) {
                        // Committed snapshot in the store — pure local delete.
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                        emitSessionManagerTrace(sessionId, `evicted (committed at v${committedMarker.version}); local cache reclaimed`);
                    } else if (this.sessionStore) {
                        // Unmarked dir. If the store already holds a VERSIONED
                        // chain for this session, the local files are a stale
                        // cache at best — reclaim without writing (a legacy
                        // dehydrate would destroy the CAS metadata and could
                        // roll the session back).
                        const versioned = supportsVersionedSnapshots(this.sessionStore)
                            ? await this.sessionStore.probeSnapshot(sessionId).catch(() => null)
                            : null;
                        if (versioned?.exists && !versioned.legacy) {
                            fs.rmSync(sessionDir, { recursive: true, force: true });
                            emitSessionManagerTrace(sessionId, `evicted (store versioned at v${versioned.version}); stale unmarked cache reclaimed`);
                        } else {
                            // Legacy session: its local files may be the only copy.
                            await this._dehydrateUnlocked(sessionId, "eviction");
                            emitSessionManagerTrace(sessionId, "evicted via legacy dehydrate (no committed marker)");
                        }
                    } else {
                        return; // no store — leave local state alone
                    }
                    this.sessionLastTouchedAt.delete(sessionId);
                    this.sessionClientKeys.delete(sessionId);
                    reclaimed++;
                });
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[SessionManager] eviction sweep skipped ${sessionId}: ${message}`);
            }
        }

        // Reap crash-orphaned hydrate temp roots (finally blocks don't run
        // on SIGKILL). They are dot-prefixed and never legitimate sessions.
        try {
            for (const entry of fs.readdirSync(this.sessionStateDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || !entry.name.startsWith(".ps-hydrate-")) continue;
                const orphan = path.join(this.sessionStateDir, entry.name);
                try {
                    if (now - fs.statSync(orphan).mtimeMs > 3_600_000) {
                        fs.rmSync(orphan, { recursive: true, force: true });
                    }
                } catch {}
            }
        } catch {}
        return reclaimed;
    }

    /**
     * Stop-turn interrupt primitive: abort the warm session's in-flight turn.
     *
     * LOCK-BYPASSING BY DESIGN — never take _withSessionLock here. runTurn
     * holds the session lock for the entire turn, so a lock-taking stop would
     * run only after the turn ended (defeating mid-flight stop). This method
     * only reads the warm map and touches ManagedSession in-memory state; the
     * runTurn activity remains the single writer of turn results.
     *
     * Sequence: set the stop marker (so the unwind classifies as "stopped"),
     * send the SDK abort, wait bounded time for the turn to unwind, and if the
     * SDK never fires session.idle escalate with forceSettleTurn() + warm
     * session invalidation (stop-turn plan, edge E3).
     */
    async abortWarmSessionTurn(
        sessionId: string,
        opts: { reason: string; expectedTurnIndex?: number; unwindGraceMs?: number },
    ): Promise<AbortTurnResult> {
        const managed = this.sessions.get(sessionId);
        if (!managed) {
            return { outcome: "no_active_turn", detail: "no warm session on this worker" };
        }
        const active = managed.getActiveTurn();
        if (!active) {
            return { outcome: "no_active_turn", detail: "warm session has no turn in flight" };
        }
        if (
            opts.expectedTurnIndex != null
            && active.turnIndex >= 0
            && active.turnIndex !== opts.expectedTurnIndex
        ) {
            return {
                outcome: "no_active_turn",
                turnIndex: active.turnIndex,
                detail: `active turn ${active.turnIndex} does not match expected ${opts.expectedTurnIndex}`,
            };
        }

        // Marker first, then abort — the unwind classification can never miss it.
        managed.requestStop(opts.reason);
        try {
            managed.abort();
        } catch (err: any) {
            // Abort RPC failure is non-fatal: the force-settle escalation below
            // still unwinds the turn.
            void err;
        }

        const graceMs = opts.unwindGraceMs ?? 8_000;
        const deadline = Date.now() + graceMs;
        while (managed.getActiveTurn() && Date.now() < deadline) {
            await sleep(200);
        }
        if (!managed.getActiveTurn()) {
            return { outcome: "stopped", turnIndex: active.turnIndex };
        }

        // Escalation: the SDK never fired session.idle. Settle the turn promise
        // ourselves, then drop the warm session so the next turn recreates it.
        // invalidateWarmSession takes the session lock, so fire-and-forget: the
        // lock serializes it behind the (now settling) turn's unwind.
        managed.forceSettleTurn(opts.reason);
        const settleDeadline = Date.now() + 2_000;
        while (managed.getActiveTurn() && Date.now() < settleDeadline) {
            await sleep(100);
        }
        void this.invalidateWarmSession(sessionId).catch(() => {});
        return { outcome: "stop_forced", turnIndex: active.turnIndex };
    }

    /**
     * Get existing session or create/resume one.
     * Merges: worker defaults → serializable config (from client) → in-memory config (tools/hooks).
     */
    async getOrCreate(
        sessionId: string,
        serializableConfig: SerializableSessionConfig,
        options?: { turnIndex?: number; trace?: SessionTraceWriter; lockHeld?: boolean; transcriptEpoch?: number; epochStart?: boolean },
    ): Promise<ManagedSession> {
        if (!options?.lockHeld) {
            return this._withSessionLock(
                sessionId,
                "getOrCreate",
                () => this._getOrCreateUnlocked(sessionId, serializableConfig, options),
                { trace: options?.trace },
            );
        }
        return this._getOrCreateUnlocked(sessionId, serializableConfig, options);
    }

    private async _getOrCreateUnlocked(
        sessionId: string,
        serializableConfig: SerializableSessionConfig,
        options?: { turnIndex?: number; trace?: SessionTraceWriter; lockHeld?: boolean; transcriptEpoch?: number; epochStart?: boolean },
    ): Promise<ManagedSession> {
        this.sessionLastTouchedAt.set(sessionId, Date.now());
        const turnIndex = options?.turnIndex;
        const trace = options?.trace;
        const transcriptEpoch = options?.transcriptEpoch ?? 0;
        const epochStart = options?.epochStart === true;
        const inheritedToolNames = Array.from(new Set([
            ...(this.workerDefaults.frameworkBaseToolNames ?? []),
            ...(this.workerDefaults.appDefaultToolNames ?? []),
            ...(serializableConfig.toolNames ?? []),
        ]));
        const effectiveSerializableConfig: SerializableSessionConfig = inheritedToolNames.length > 0
            ? { ...serializableConfig, toolNames: inheritedToolNames }
            : serializableConfig;
        // Which copy of the bound agent does this session get? Owner-aware:
        // the session owner's own user-scope package copy shadows the shared
        // one, the same rule the registry resolver applies at create time.
        // Resolved once here; prompt, descriptor, MCP, and tool-handler picks
        // below all follow the same copy so a session can never mix copies.
        const boundAgentEntry = effectiveSerializableConfig.boundAgentName
            ? this.workerDefaults.agentPromptLookup?.[effectiveSerializableConfig.boundAgentName]
            : undefined;
        // A PACKAGE agent (as opposed to a deployment/inline agent) carries a
        // packageId on its entry or on any of its copies. This is load-bearing
        // for MCP resolution: a package agent must never fall back to the
        // bare-name MCP key, which another copy of a shadowed name also wrote.
        const sessionOwnerKey = effectiveSerializableConfig.boundAgentName
            ? await this._sessionAgentOwnerKey(sessionId)
            : null;
        const boundAgentCopy = pickAgentCopyForOwner(boundAgentEntry, sessionOwnerKey);
        // Resolve tools: merge per-session (setConfig) + registry (toolNames)
        const storedConfig = this.sessionConfigs.get(sessionId);
        const resolvedTools = this._resolveTools(storedConfig, effectiveSerializableConfig, boundAgentCopy?.packageId);

        const config: ManagedSessionConfig = {
            ...storedConfig,
            ...effectiveSerializableConfig,
            tools: resolvedTools.length > 0 ? resolvedTools : undefined,
            hooks: storedConfig?.hooks,
            turnTimeoutMs: this.workerDefaults.turnTimeoutMs,
            turnInactivityTimeoutMs: this.workerDefaults.turnInactivityTimeoutMs,
        };
        this.sessionConfigs.set(sessionId, config);

        // ── Catalog model is the source of truth ─────────────────────────
        // The CMS session row's `model` is what the user selected and what
        // every surface displays. If the runtime config disagrees (a create
        // path that dropped the field, a stale snapshot from an older
        // deploy, a CMS-only model edit), complain LOUDLY and adopt the
        // catalog model — a session must never silently run something other
        // than what the catalog says. Adopting before the warm-session check
        // below means requiresModelRebind() also recreates a warm CLI
        // session that was frozen on the wrong model.
        let catalogRow: any = null;
        if (this.sessionCatalog) {
            try {
                catalogRow = await this.sessionCatalog.getSession(sessionId);
            } catch { /* row not readable — fall through to configured model */ }
            const catalogModel = String(catalogRow?.model || "").trim();
            const configuredModel = String(config.model || "").trim();
            if (catalogModel && catalogModel !== configuredModel) {
                emitSessionManagerTrace(
                    sessionId,
                    `model mismatch: catalog=${catalogModel} configured=${configuredModel || "(default)"}; catalog wins`,
                    { trace },
                );
                config.model = catalogModel;
                this.sessionConfigs.set(sessionId, config);
                try {
                    await this.sessionCatalog.recordEvents(sessionId, [{
                        eventType: "session.model_mismatch",
                        data: {
                            catalogModel,
                            configuredModel: configuredModel || null,
                            action: "catalog_model_adopted",
                            message: "Runtime session config disagreed with the session catalog model; the catalog is authoritative and its model was adopted for this turn.",
                        },
                    }]);
                } catch { /* observability only — never fails the create */ }
            }
        }

        // Resolve model up-front so we can pick the right CopilotClient
        // (per-user GitHub Copilot token) before any session create/resume.
        const registry = this.workerDefaults.modelProviders;
        const effectiveModel = this.normalizeModelRef(config.model) || "";
        const resolvedProvider = registry?.resolve(effectiveModel);
        const baseProviderConfig = this._resolveProviderConfig(effectiveModel);
        const sdkModelName = effectiveModel && registry?.getDescriptor(effectiveModel)?.modelName
            ? registry.getDescriptor(effectiveModel)!.modelName
            : effectiveModel;
        const modelDescriptor = registry && effectiveModel
            ? registry.getDescriptor(effectiveModel)
            : undefined;

        // `config.reasoningEffort` is passed to the SDK on its own below, and
        // for provider `type: github` that is what works. For a provider
        // declared `type: openai-proxy` the `@github/copilot` child process
        // drops it before the HTTP request is built, so it rides in the
        // provider baseUrl as a path prefix and the proxy at that baseUrl
        // strips it back off. Every other provider type is untouched, and a
        // session with no effort set is untouched.
        //
        // It used to ride in the model NAME. @github/copilot 1.0.79 parses
        // `model:key=value` as its own model-options syntax and rejects
        // unknown keys, so every such turn failed with
        // "Unknown model option key: effort". See
        // applyReasoningEffortToProviderConfig for the measurements.
        const resolvedProviderConfig = baseProviderConfig.provider
            ? {
                ...baseProviderConfig,
                provider: applyReasoningEffortToProviderConfig(
                    baseProviderConfig.provider,
                    modelDescriptor,
                    config.reasoningEffort,
                ),
            }
            : baseProviderConfig;

        // Context-window tier: only models whose catalog entry declares
        // supportedContextTiers get the field at all. An explicit valid tier
        // wins; otherwise fall back to the catalog default ("default" — the
        // smaller window — per registry normalization). A stale/invalid tier
        // on a tier-less model is dropped rather than forwarded.
        const supportedTiers = modelDescriptor?.supportedContextTiers ?? [];
        config.contextTier = supportedTiers.length > 0
            ? (config.contextTier && supportedTiers.includes(config.contextTier)
                ? config.contextTier
                : (modelDescriptor?.defaultContextTier ?? "default"))
            : undefined;

        // Built from the deployment's own catalog — the only place that knows
        // anything about a BYOK model. Deliberately AFTER the tier resolution
        // above: the declared window must match the tier this session actually
        // runs at, and before normalization config.contextTier can still be
        // unset or stale. See the modelCapabilities note at the config object.
        const byokModelCapabilities = buildByokModelCapabilities(modelDescriptor, config.contextTier);

        // Resolve the per-user GitHub Copilot token only when a catalog
        // is wired in. Skipping the await on the no-catalog path matters
        // for the SessionManager unit tests that exercise lock ordering
        // by counting microtasks before the first `resumeSession()` call.
        const userGithubToken = this.sessionCatalog
            ? await this._resolveSessionGitHubToken(sessionId, config, effectiveModel, catalogRow)
            : undefined;
        if (resolvedProvider?.type === "github" && !userGithubToken && !this.githubToken && !resolvedProvider.githubToken) {
            throw Object.assign(
                new Error(
                    "GitHub Copilot key missing or invalid. Set GITHUB_TOKEN on the worker, set your per-user GitHub Copilot key in Admin, or (for system sessions) have an admin store a System key in the Admin Console before using GitHub Copilot models.",
                ),
                { code: "GHCP_KEY_MISSING", status: 400 },
            );
        }
        const desiredClientKey = userGithubToken || "";
        const previousClientKey = this.sessionClientKeys.get(sessionId);
        if (previousClientKey !== undefined && previousClientKey !== desiredClientKey) {
            // Owner changed their per-user GitHub Copilot key (or it was
            // cleared) since we last warmed this session. Tear down the
            // warm handle so the resume path below binds to the right
            // CopilotClient. The session state on disk is reusable — we
            // only drop the in-memory CopilotSession.
            const existingWarm = this.sessions.get(sessionId);
            if (existingWarm) {
                emitSessionManagerTrace(
                    sessionId,
                    `github copilot token changed; recycling warm session onto new client`,
                    { trace },
                );
                try { await existingWarm.destroy(); } catch {}
                this.sessions.delete(sessionId);
            }
        }
        const client = await this.ensureClient(userGithubToken);
        this.sessionClientKeys.set(sessionId, desiredClientKey);
        const sessionDir = path.join(this.sessionStateDir, sessionId);

        // Merge user tools with system tool definitions (wait, ask_user, sub-agent tools)
        // so the LLM sees them at session creation time.
        if (!this.factStore) {
            throw new Error(
                "PilotSwarm invariant violated: factStore must be initialized before creating sessions.",
            );
        }
        // Tuner sessions are read-only by design — no spawn / message / cancel.
        // The old read-only tuner had its mutating tools stripped here. The
        // Agent Manager that replaces it is deliberately NOT read-only — its
        // whole purpose is to change agents — so the strip applies only to the
        // legacy id, and dies with it.
        const isTunerSession = effectiveSerializableConfig.agentIdentity === "agent-tuner";
        const mutatingSystemToolNames = new Set(["send_session_message", "reply_session_message", "draw_canvas", "show_canvas",
    "update_canvas"]);
        const userTools = config.tools ?? [];
        // Canvas tools are ROOT-only, and THIS is the declaration half of that
        // gate: sessionConfig.tools below is the sole chokepoint where
        // declarations reach the CLI (registerTools only refreshes the
        // handler map), and it has no notion of parentage — the catalog row
        // fetched above does. A child that saw the declaration while its
        // per-turn handler set excluded the tool would have its call silently
        // dropped by the CLI (no handler, no response, turn hangs), which is
        // strictly worse than an error. Fail open on an unreadable row: the
        // per-turn handler still refuses with a clear message.
        // Canvas tools are declared for EVERY session now — sub-agents draw
        // their own canvases (slots 1-5), independent of the parent's.
        const systemTools = ManagedSession.systemToolDefs()
            .filter((tool: any) => !isTunerSession || !mutatingSystemToolNames.has(tool.name));
        const readOnlyTunerSubAgentToolNames = new Set(["check_agents", "list_sessions"]);
        const subAgentTools = ManagedSession.subAgentToolDefs()
            .filter((tool: any) => !isTunerSession || readOnlyTunerSubAgentToolNames.has(tool.name));
        const factTools = createFactTools({
            factStore: this.factStore,
            getLineageSessionIds: this._getLineageSessionIds ?? undefined,
            agentIdentity: effectiveSerializableConfig.agentIdentity,
            isCrawler: effectiveSerializableConfig.isCrawler === true || effectiveSerializableConfig.isHarvester === true,
            // Enhanced tools light up only when the store is an EnhancedFactStore.
            // Pass it when EITHER capability is present: search powers
            // facts_search / facts_similar / search_skills; embedder powers the
            // facts-manager-only `manage_embedder` control tool. The tools
            // themselves gate on the specific capability they need.
            enhancedFactStore: isEnhancedFactStore(this.factStore)
                && (this.factStore.capabilities.search || this.factStore.capabilities.embedder)
                ? this.factStore
                : undefined,
            recordEvent: this.sessionCatalog
                ? async (sid, eventType, data) => {
                    try {
                        await this.sessionCatalog!.recordEvents(sid, [{ eventType, data }]);
                    } catch {
                        // Best-effort — never fail a tool call on telemetry errors.
                    }
                }
                : undefined,
            onSharedIntakeFactStored: this.sessionCatalog && this._duroxideClient
                ? async ({ key, sourceSessionId, agentId }) => {
                    try {
                        const sessions = await this.sessionCatalog!.listSessions();
                        const factsManager = sessions.find((session) => session.agentId === "facts-manager" && session.state !== "failed" && session.state !== "cancelled");
                        if (!factsManager) return;
                        const payload = {
                            type: "facts.intake_written",
                            key,
                            sourceSessionId,
                            agentId,
                            createdAt: new Date().toISOString(),
                        };
                        await this._duroxideClient.enqueueEvent(
                            `session-${factsManager.sessionId}`,
                            "messages",
                            JSON.stringify({ prompt: `[FACTS_INTAKE ${JSON.stringify(payload)}]` }),
                        );
                    } catch {
                        // Best-effort wake-up; the 6h maintenance pass is the fallback.
                    }
                }
                : undefined,
            }).filter((tool: any) => !isTunerSession || tool.name === "read_facts" || tool.name === "facts_search" || tool.name === "facts_similar" || tool.name === "search_skills");
        // Graph tools (07 P4) — registered ONLY when a graph store is configured.
        // Reader tools AND graph write/delete go to every session (so any agent
        // can incorporate into the SHARED graph) EXCEPT the read-only agent-tuner;
        // the crawl queue stays app-crawler-role + facts-manager only; graph_stats
        // to facts-manager + agent-tuner. Tuner never gets a mutating tool.
        const graphTools = this.graphStore
            ? createGraphTools({
                graphStore: this.graphStore,
                factStore: this.factStore,
                agentIdentity: effectiveSerializableConfig.agentIdentity,
                isCrawler: effectiveSerializableConfig.isCrawler === true || effectiveSerializableConfig.isHarvester === true,
                agentId: effectiveSerializableConfig.agentIdentity,
                // Graph reads use the SAME lineage visibility as read_facts. The
                // tuner branch inside createGraphTools forces unrestricted; for
                // everyone else this resolves their granted lineage sessions.
                resolveAccess: this._getLineageSessionIds
                    ? async (sessionId: string | undefined) => {
                        if (!sessionId) return { readerSessionId: null, grantedSessionIds: [] };
                        const raw = await this._getLineageSessionIds!(sessionId);
                        const granted = [...new Set((raw || []).filter((sid) => Boolean(sid) && sid !== sessionId))];
                        return { readerSessionId: sessionId, grantedSessionIds: granted };
                    }
                    : undefined,
                recordEvent: this.sessionCatalog
                    ? async (sid, eventType, data) => {
                        try {
                            await this.sessionCatalog!.recordEvents(sid, [{ eventType, data }]);
                        } catch {
                            // Best-effort telemetry.
                        }
                    }
                    : undefined,
            })
            : [];
        const inspectTools = this.sessionCatalog
            ? createInspectTools({
                catalog: this.sessionCatalog,
                agentIdentity: effectiveSerializableConfig.agentIdentity,
                duroxideClient: this._duroxideClient ?? undefined,
                factStore: this.factStore ?? undefined,
                // The viewer spine. Inspect tools act as this session's OWNER,
                // never as "whatever the model asked for" — resolved per
                // invocation so a role change lands on the next turn instead
                // of outliving the session. See createInspectTools' docstring.
                resolveViewer: () => this._resolveInspectViewer(sessionId),
                // The write bundle attaches patch artifacts to THIS session,
                // so a human reviews the proposed change where the
                // conversation that produced it already is.
                artifactStore: this.artifactStore ?? null,
                sessionId,
            })
            : [];
        // Service sessions (tree-scoped machinery, e.g. the regen distiller)
        // declare ONLY their user tools (the transcript pager): no system,
        // sub-agent, fact, inspect, or graph tools. Mirrors the per-turn gate
        // in managed-session.ts runTurn — hard exclusion beats instructions.
        const isServiceSession = effectiveSerializableConfig.agentIdentity === "regen-distiller";
        const unlessService = <T,>(tools: T[]): T[] => (isServiceSession ? [] : tools);
        const SYSTEM_TOOL_NAMES = new Set([
            ...systemTools, ...subAgentTools, ...factTools, ...inspectTools, ...graphTools,
        ].map((t: any) => t.name));
        const persistentSessionTools = [
            ...userTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...unlessService(factTools),
            ...unlessService(inspectTools),
            ...unlessService(graphTools),
        ];
        const allTools = [
            ...persistentSessionTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...unlessService(systemTools),
            ...unlessService(subAgentTools),
            ...unlessService(factTools),
            ...unlessService(inspectTools),
            ...unlessService(graphTools),
        ];
        config.tools = persistentSessionTools;

        // Build system message: worker base + client override
        const systemMessage = this._buildSystemMessage(sessionId, config, sessionOwnerKey);

        // Per-agent MCP (capability-profiles Phase 1): a session gets the
        // base map (base-agent opt-ins + direct worker-config servers) plus
        // its bound agent's resolved server map — resolved worker-side at the
        // same chokepoint as the agent prompt. The deployment catalog is
        // never applied wholesale.
        //
        // Read the MCP map of the copy THIS session actually resolved to.
        // The worker registers a package agent's MCP under a package-qualified
        // key only, and reserves the bare name for deployment/inline agents —
        // so the resolved copy's own packageId is the discriminator:
        //   • package copy resolved  → its qualified key (never the bare name,
        //     which another copy of a shadowed name could have written);
        //   • deployment/inline copy → the bare name (its own MCP);
        //   • no copy resolved (a foreign-private-only name) → no grants.
        // Keying off `boundAgentCopy.packageId` rather than "is any copy a
        // package" is load-bearing: when a deployment agent and a package
        // share a name and this session resolved the DEPLOYMENT copy, it must
        // still get the deployment agent's bare-key MCP, not an empty
        // qualified lookup.
        const boundAgentMcpServers = !effectiveSerializableConfig.boundAgentName || !boundAgentCopy
            ? undefined
            : boundAgentCopy.packageId
                ? this.workerDefaults.agentMcpServers?.[packageAgentKey(boundAgentCopy.packageId, effectiveSerializableConfig.boundAgentName)]
                : this.workerDefaults.agentMcpServers?.[effectiveSerializableConfig.boundAgentName];
        const effectiveMcpServers = {
            ...(this.workerDefaults.baseMcpServers ?? {}),
            ...(boundAgentMcpServers ?? {}),
        };

        const sessionConfig: any = {
            sessionId,
            // Sole chokepoint where tool DECLARATIONS reach the CLI (create and
            // resume share this object; ManagedSession.registerTools only
            // refreshes the client-side handler map). Pinned so tool search
            // cannot defer PilotSwarm tools out of the prompt — see
            // tool-pinning.ts for the why and the phase-2 opt-out path.
            tools: pinToolsNeverDefer(allTools),
            model: sdkModelName,
            // Tell the runtime what a BYOK model can do.
            //
            // A model outside the Copilot catalog has no capabilities, so the
            // runtime falls back to defaults — including a 128000 token limit
            // that makes a 1M-window model compact roughly 8x too early.
            // Declaring limits.max_prompt_tokens here fixes that; the reported
            // tokenLimit becomes the real window. Measured, see
            // buildByokModelCapabilities.
            //
            // It does NOT fix reasoning effort. Declaring
            // supports.reasoningEffort = true still does not put
            // `reasoning_effort` on the outgoing request for a BYOK provider —
            // verified on the multi-provider `providers`/`models` surface, with
            // enableConfigDiscovery on, and via the runtime's own
            // `model:defaultReasoningEffort=high` option. That is why
            // applyReasoningEffortToProviderConfig still exists.
            //
            // Only for non-github providers: Copilot models have real catalog
            // data and must not be overridden by our guesses.
            ...(resolvedProviderConfig.provider && byokModelCapabilities
                ? { modelCapabilities: byokModelCapabilities }
                : {}),
            ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
            ...(config.contextTier ? { contextTier: config.contextTier } : {}),
            systemMessage: systemMessage
                ? (typeof systemMessage === "string" ? { content: systemMessage } : systemMessage)
                : undefined,
            // configDir is intentionally omitted: the Copilot CLI does not honor it for
            // state placement (verified against @github/copilot 1.0.36). State location is
            // controlled exclusively via COPILOT_HOME, set on the spawned CLI in ensureClient().
            workingDirectory: config.workingDirectory,
            hooks: config.hooks,
            onPermissionRequest: (config as any).onPermissionRequest ?? approvePermissionForSession,
            infiniteSessions: { enabled: true },
            // Enable token-level streaming so the catch-all event handler in
            // ManagedSession sees `assistant.message_delta` /
            // `assistant.streaming_delta` arrivals and can emit a coarse
            // `assistant.streaming_progress` heartbeat for the activity pane.
            // The deltas themselves stay ephemeral (see EPHEMERAL_TYPES in
            // session-proxy.ts) so they never reach CMS.
            streaming: true,
            // Suppress sub-agent streaming events — we never want the parent
            // session's event log polluted with grandchild deltas.
            includeSubAgentStreamingEvents: false,
            // Exclude the Copilot SDK's built-in "task" tool — PilotSwarm provides
            // its own durable sub-agent mechanism via spawn_agent / check_agents.
            // The native "task" tool spawns in-process sub-agents that bypass the
            // durable orchestration layer, causing the LLM to use the wrong mechanism.
            excludedTools: ["task"],
            // Custom LLM provider — resolve from registry or legacy single provider
            ...resolvedProviderConfig,
            // Pass loaded skills and agents from worker defaults; MCP servers
            // are the bound agent's own resolved map (see above).
            ...(this.workerDefaults.skillDirectories?.length && { skillDirectories: this.workerDefaults.skillDirectories }),
            ...(this.workerDefaults.customAgents?.length && { customAgents: this.workerDefaults.customAgents }),
            ...(Object.keys(effectiveMcpServers).length > 0 && { mcpServers: effectiveMcpServers }),
        };

        let copilotSession: CopilotSession;

        // 1. Check if already in memory (warm) — update config in case
        //    tools were registered after the session was first created.
        const existing = this.sessions.get(sessionId);
        if (existing) {
            if (turnIndex === 0) {
                console.warn(
                    `[SessionManager] stale in-memory Copilot session found for turn 0 (${sessionId}); ` +
                    `discarding it and creating a fresh session.`,
                );
                await this._resetSessionState(sessionId);
            } else if (epochStart) {
                console.warn(
                    `[SessionManager] epoch-start for ${sessionId} (epoch ${transcriptEpoch}); ` +
                    `discarding the warm Copilot session of the previous epoch.`,
                );
                await existing.destroy();
                this.sessions.delete(sessionId);
            } else if (existing.requiresModelRebind(config)) {
                console.warn(
                    `[SessionManager] model config changed for ${sessionId}; ` +
                    `disconnecting warm Copilot session so it can resume with the new model config.`,
                );
                await existing.destroy();
                this.sessions.delete(sessionId);
            } else {
                existing.updateConfig(config);
                return existing;
            }
        }

        const localExists = fs.existsSync(sessionDir);
        let storedExists = false;
        if (this.sessionStore) {
            try {
                storedExists = await this.sessionStore.exists(sessionId, transcriptEpoch || undefined);
            } catch (error: unknown) {
                emitSessionManagerTrace(
                    sessionId,
                    `session-store exists probe failed turnIndex=${turnIndex ?? "unknown"} error=${normalizeError(error).message}`,
                    { trace, level: "warn" },
                );
                storedExists = false;
            }
        }
        emitSessionManagerTrace(
            sessionId,
            `resume probe turnIndex=${turnIndex ?? "unknown"} localExists=${localExists} storedExists=${storedExists} inMemory=${this.sessions.has(sessionId)}`,
            { trace },
        );

        if (turnIndex === 0) {
            if (localExists || storedExists) {
                console.warn(
                    `[SessionManager] stale persisted Copilot session found for turn 0 (${sessionId}); ` +
                    `discarding it and creating a fresh session.`,
                );
                await this._resetSessionState(sessionId);
            }

            copilotSession = await client.createSession(sessionConfig);
        } else if (epochStart) {
            // Session regeneration: first turn of a fresh epoch whose chain is
            // empty (the caller verified via the lifecycle preamble). Epoch-
            // aware reset — the previous epochs' snapshots are NEVER touched;
            // only the local dir and the SDK's own registration go.
            emitSessionManagerTrace(
                sessionId,
                `epoch-start create epoch=${transcriptEpoch}: discarding local dir, creating fresh SDK session`,
                { trace },
            );
            await this._resetSessionStateForEpoch(sessionId, transcriptEpoch);
            copilotSession = await client.createSession(sessionConfig);
            // Birth marker: the preamble's epoch invariant refuses to trust a
            // markerless dir under epoch >= 1, so stamp the incarnation the
            // moment it exists (version 0 = no commit yet).
            if (transcriptEpoch > 0) {
                try {
                    writeSnapshotMarker(sessionDir, { version: 0, epoch: transcriptEpoch });
                } catch { /* marker is rewritten on first commit */ }
            }
        } else if (turnIndex != null && turnIndex > 0) {
            if (fs.existsSync(sessionDir)) {
                emitSessionManagerTrace(sessionId, "turn>0 resuming from local session directory", { trace });
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else if (this.sessionStore && storedExists) {
                emitSessionManagerTrace(sessionId, "turn>0 hydrating from session store before resume", { trace });
                try {
                    await this.sessionStore.hydrate(sessionId, transcriptEpoch || undefined);
                } catch (error: unknown) {
                    emitSessionManagerTrace(
                        sessionId,
                        `turn>0 hydrate before resume failed error=${normalizeError(error).message}`,
                        { trace, level: "warn" },
                    );
                    throw error;
                }
                if (!fs.existsSync(sessionDir)) {
                    emitSessionManagerTrace(
                        sessionId,
                        "turn>0 hydrate reported success but no local session directory was restored",
                        { trace, level: "warn" },
                    );
                    throw this._missingSessionStateError(sessionId, turnIndex, " Hydration completed but no local session directory was restored.");
                }
                emitSessionManagerTrace(sessionId, "turn>0 hydrate restored local session directory; resuming session", { trace });
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else {
                emitSessionManagerTrace(
                    sessionId,
                    `turn>0 missing resumable state localExists=${localExists} storedExists=${storedExists}`,
                    { trace, level: "warn" },
                );
                throw this._missingSessionStateError(sessionId, turnIndex);
            }
        } else {
            // Backward-compatible permissive path for older orchestration versions.
            if (fs.existsSync(sessionDir)) {
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else if (this.sessionStore) {
                try {
                    await this.sessionStore.hydrate(sessionId);
                    if (fs.existsSync(sessionDir)) {
                        copilotSession = await client.resumeSession(sessionId, sessionConfig);
                    } else {
                        copilotSession = await client.createSession(sessionConfig);
                    }
                } catch {
                    copilotSession = await client.createSession(sessionConfig);
                }
            } else {
                copilotSession = await client.createSession(sessionConfig);
            }
        }

        const managed = new ManagedSession(sessionId, copilotSession, config);
        this.sessions.set(sessionId, managed);
        const promptLayers = buildEffectivePromptLayers(this.workerDefaults, config);
        if (promptLayers.length > 0 && this.sessionCatalog) {
            void this.sessionCatalog.recordEvents(sessionId, [{
                eventType: "session.prompt_layers",
                data: buildPromptLayersEventPayload(promptLayers),
            }]).catch(() => {});
        }
        return managed;
    }

    /** Get a session by ID (null if not in memory on this node). */
    get(sessionId: string): ManagedSession | null {
        return this.sessions.get(sessionId) ?? null;
    }

    /** Root directory holding per-session state dirs. */
    getSessionStateDir(): string {
        return this.sessionStateDir;
    }

    /**
     * Destroy the in-memory ManagedSession only — disk state untouched.
     * Used by the lifecycle preamble before overwriting local files with a
     * hydrated snapshot (a warm session bound to the old files must not
     * survive the swap). Caller holds the per-session run-turn lock.
     */
    async dropWarmSession(sessionId: string): Promise<void> {
        const existing = this.sessions.get(sessionId);
        if (!existing) return;
        try { await existing.destroy(); } catch {}
        this.sessions.delete(sessionId);
    }

    /**
     * Dehydrate a session: snapshot to the session store, release in-memory state.
     *
     * Order of operations matters here. The Copilot SDK's `disconnect()` is
     * documented to preserve the on-disk session directory intact (verified
     * empirically against @github/copilot 1.0.36). We:
     *   1. Take a pre-destroy checkpoint of the live directory as a safety net.
     *   2. Disconnect the in-memory session, retrying with `resumeSession` if
     *      the connection was already torn down (e.g. CLI process died).
     *   3. Persist the post-disconnect snapshot to the session store. This
     *      is a single-shot attempt because the SDK does not asynchronously
     *      flush after disconnect: the files either exist or they don't.
     *   4. If the post-disconnect snapshot is missing (which would indicate
     *      a future SDK regression), fall back to the pre-destroy checkpoint.
     */
    async dehydrate(sessionId: string, reason: string, options?: { trace?: SessionTraceWriter; lockHeld?: boolean }): Promise<void> {
        if (!options?.lockHeld) {
            return this._withSessionLock(
                sessionId,
                "dehydrate",
                () => this._dehydrateUnlocked(sessionId, reason, options),
                { trace: options?.trace },
            );
        }
        return this._dehydrateUnlocked(sessionId, reason, options);
    }

    private async _dehydrateUnlocked(sessionId: string, reason: string, options?: { trace?: SessionTraceWriter }): Promise<void> {
        const DESTROY_MAX_RETRIES = 3;
        const trace = options?.trace;
        let lastDestroyError: Error | undefined;
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        let checkpointPrepared = false;
        // Captured before destroy so we can tell whether a pre-destroy safety
        // checkpoint exists. Absence of local files is not benign by itself:
        // this dehydrate may have landed on a different worker after a prior
        // live turn, so the activity layer must treat missing state as lossy.
        const sessionDirExistedPreDestroy = fs.existsSync(sessionDir);

        emitSessionManagerTrace(sessionId, `dehydrate start reason=${reason}`, { trace });

        if (this.sessionStore && sessionDirExistedPreDestroy) {
            try {
                emitSessionManagerTrace(sessionId, "pre-dehydrate checkpoint start", { trace });
                await this.sessionStore.checkpoint(sessionId);
                checkpointPrepared = true;
                emitSessionManagerTrace(sessionId, "pre-dehydrate checkpoint complete", { trace });
            } catch (err: any) {
                const checkpointError = normalizeError(err);
                emitSessionManagerTrace(
                    sessionId,
                    `pre-dehydrate checkpoint failed error=${checkpointError.message}`,
                    { trace, level: "warn" },
                );
                console.warn(
                    `[SessionManager] pre-dehydrate checkpoint failed for ${sessionId}: ${checkpointError.message}`,
                );
            }
        }

        // Phase 1: Destroy the in-memory session (with retries)
        for (let attempt = 1; attempt <= DESTROY_MAX_RETRIES; attempt++) {
            const session = this.sessions.get(sessionId);
            if (!session) break; // No in-memory session — nothing to destroy

            try {
                emitSessionManagerTrace(sessionId, `destroy attempt ${attempt}/${DESTROY_MAX_RETRIES}`, { trace });
                await session.destroy();
                this.sessions.delete(sessionId);
                emitSessionManagerTrace(sessionId, `destroy complete on attempt ${attempt}/${DESTROY_MAX_RETRIES}`, { trace });
                break; // Success
            } catch (err: any) {
                lastDestroyError = normalizeError(err);
                this.sessions.delete(sessionId); // Remove broken session from map
                emitSessionManagerTrace(
                    sessionId,
                    `destroy failed on attempt ${attempt}/${DESTROY_MAX_RETRIES} error=${lastDestroyError.message}`,
                    { trace, level: "warn" },
                );

                if (attempt < DESTROY_MAX_RETRIES) {
                    // Re-create the session from local files so we can try destroy again.
                    if (fs.existsSync(sessionDir)) {
                        try {
                            const client = await this._ensureClientForSession(sessionId);
                            const config = this.sessionConfigs.get(sessionId) ?? {};
                            const copilotSession = await client.resumeSession(sessionId, {
                                tools: [...ManagedSession.systemToolDefs(), ...ManagedSession.subAgentToolDefs()],
                                onPermissionRequest: approvePermissionForSession,
                            });
                            const managed = new ManagedSession(sessionId, copilotSession, config);
                            this.sessions.set(sessionId, managed);
                            // Brief pause before retry
                            await sleep(500 * attempt);
                        } catch {
                            // Can't resume — session files may be corrupt. Fall through.
                            break;
                        }
                    } else {
                        break; // No local files — can't retry
                    }
                }
            }
        }

        // Phase 2: Persist to the session store (always attempt, even if destroy failed)
        if (this.sessionStore) {
            let lastStoreError: Error | undefined;
            let sessionStoreAttemptCount = 0;

            for (let attempt = 1; attempt <= DEHYDRATE_STORE_MAX_RETRIES; attempt++) {
                sessionStoreAttemptCount = attempt;
                try {
                    emitSessionManagerTrace(
                        sessionId,
                        `session-store dehydrate attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES} reason=${reason}`,
                        { trace },
                    );
                    await this.sessionStore.dehydrate(sessionId, { reason });
                    lastStoreError = undefined;
                    emitSessionManagerTrace(
                        sessionId,
                        `session-store dehydrate complete on attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES}`,
                        { trace },
                    );
                    break;
                } catch (storeErr: any) {
                    lastStoreError = normalizeError(storeErr);
                    emitSessionManagerTrace(
                        sessionId,
                        `session-store dehydrate failed on attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES} error=${lastStoreError.message}`,
                        { trace, level: "warn" },
                    );
                    if (attempt < DEHYDRATE_STORE_MAX_RETRIES) {
                        console.warn(
                            `[SessionManager] session-store dehydrate failed for ${sessionId} ` +
                            `(attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES}): ${lastStoreError.message}`,
                        );
                        await sleep(DEHYDRATE_STORE_RETRY_BASE_DELAY_MS * attempt);
                    }
                }
            }

            if (lastStoreError) {
                if (!lastDestroyError && checkpointPrepared && isMissingDehydrateSnapshotError(lastStoreError)) {
                    emitSessionManagerTrace(
                        sessionId,
                        "session-store dehydrate falling back to pre-destroy checkpoint after snapshot-missing error",
                        { trace, level: "warn" },
                    );
                    console.warn(
                        `[SessionManager] session-store dehydrate snapshot missing after destroy for ${sessionId}; ` +
                        `using the pre-destroy checkpoint as the durable fallback.`,
                    );
                    try {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    } catch {}
                } else {
                    const message = lastDestroyError
                        ? `Session ${sessionId} is not dehydratable (reason=${reason}): ` +
                            `destroy failed (${lastDestroyError.message}), ` +
                            `session-store persistence failed after ${sessionStoreAttemptCount} attempts (${lastStoreError.message}). ` +
                            `Session state may be lost on worker recycle.`
                        : `Session-store persistence failed after ${sessionStoreAttemptCount} attempts ` +
                            `during dehydrate for ${sessionId} (reason=${reason}): ${lastStoreError.message}`;
                    const error = new Error(message);
                    (error as any).sessionStoreAttemptCount = sessionStoreAttemptCount;
                    (error as any).sessionStoreError = lastStoreError.message;
                    (error as any).dehydrateReason = reason;
                    (error as any).sessionId = sessionId;
                    throw error;
                }
            }
        }

        if (lastDestroyError) {
            emitSessionManagerTrace(
                sessionId,
                `destroy exhausted retries but session-store persistence succeeded error=${lastDestroyError.message}`,
                { trace, level: "warn" },
            );
            console.warn(
                `[SessionManager] destroy() failed for ${sessionId} after ${DESTROY_MAX_RETRIES} attempts ` +
                `(${lastDestroyError.message}), but session-store persistence succeeded. Session state is preserved.`
            );
        } else {
            emitSessionManagerTrace(sessionId, `dehydrate complete reason=${reason}`, { trace });
        }
    }

    /**
     * Hydrate session state from the configured session store to local disk.
     * The next getOrCreate() will detect local files and resume.
     */
    async hydrate(sessionId: string, options?: { trace?: SessionTraceWriter; lockHeld?: boolean }): Promise<void> {
        if (!options?.lockHeld) {
            return this._withSessionLock(
                sessionId,
                "hydrate",
                () => this._hydrateUnlocked(sessionId, options),
                { trace: options?.trace },
            );
        }
        return this._hydrateUnlocked(sessionId, options);
    }

    private async _hydrateUnlocked(sessionId: string, options?: { trace?: SessionTraceWriter }): Promise<void> {
        const trace = options?.trace;
        if (this.sessionStore) {
            emitSessionManagerTrace(sessionId, "hydrate start via session store", { trace });
            try {
                await this.sessionStore.hydrate(sessionId);
                emitSessionManagerTrace(sessionId, "hydrate complete via session store", { trace });
            } catch (error: unknown) {
                emitSessionManagerTrace(
                    sessionId,
                    `hydrate failed error=${normalizeError(error).message}`,
                    { trace, level: "warn" },
                );
                throw error;
            }
        }
    }

    /**
     * Return true when the next turn must hydrate state from the session store.
     * This supports abrupt worker loss and direct worker-side dehydration.
     */
    async needsHydration(sessionId: string, options?: { trace?: SessionTraceWriter }): Promise<boolean> {
        const trace = options?.trace;
        if (!this.sessionStore) {
            emitSessionManagerTrace(sessionId, "needsHydration=false session store disabled", { trace });
            return false;
        }
        if (this.sessions.has(sessionId)) {
            emitSessionManagerTrace(sessionId, "needsHydration=false session is still warm in memory", { trace });
            return false;
        }

        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (fs.existsSync(sessionDir)) {
            emitSessionManagerTrace(sessionId, "needsHydration=false local session directory already exists", { trace });
            return false;
        }

        try {
            const storedExists = await this.sessionStore.exists(sessionId);
            emitSessionManagerTrace(sessionId, `needsHydration result=${storedExists}`, { trace });
            return storedExists;
        } catch (error: unknown) {
            emitSessionManagerTrace(
                sessionId,
                `needsHydration probe failed error=${normalizeError(error).message}`,
                { trace, level: "warn" },
            );
            return false;
        }
    }

    /**
     * Destroy a session and remove from tracking.
     */
    async destroySession(sessionId: string, options?: { lockHeld?: boolean }): Promise<void> {
        if (!options?.lockHeld) {
            return this._withSessionLock(sessionId, "destroySession", () => this.destroySession(sessionId, { lockHeld: true }));
        }
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Drop the warm in-memory session handle without deleting any persisted
     * local/session-store state. Used when the underlying Copilot session
     * becomes invalid and we want the next getOrCreate() to resume/hydrate it.
     */
    async invalidateWarmSession(sessionId: string, options?: { lockHeld?: boolean }): Promise<void> {
        if (!options?.lockHeld) {
            return this._withSessionLock(sessionId, "invalidateWarmSession", () => this.invalidateWarmSession(sessionId, { lockHeld: true }));
        }
        const session = this.sessions.get(sessionId);
        if (!session) return;
        try {
            await session.destroy();
        } catch {}
        this.sessions.delete(sessionId);
    }

    /**
     * Fully reset a session's live and persisted Copilot state.
     * Used when the stored transcript/session state becomes unusable and the
     * runtime must recreate a fresh Copilot session for lossy replay.
     */
    async resetSessionState(sessionId: string, options?: { lockHeld?: boolean }): Promise<void> {
        if (!options?.lockHeld) {
            return this._withSessionLock(sessionId, "resetSessionState", () => this._resetSessionState(sessionId));
        }
        await this._resetSessionState(sessionId);
    }

    /**
     * Checkpoint session state without destroying the session or
     * releasing affinity. Used for crash resilience — session stays warm.
     */
    async checkpoint(sessionId: string, options?: { lockHeld?: boolean }): Promise<void> {
        if (!options?.lockHeld) {
            return this._withSessionLock(sessionId, "checkpoint", () => this.checkpoint(sessionId, { lockHeld: true }));
        }
        if (this.sessionStore) {
            await this.sessionStore.checkpoint(sessionId);
        }
    }

    /** List all in-memory session IDs on this node. */
    activeSessionIds(): string[] {
        return [...this.sessions.keys()];
    }

    /** Shutdown: destroy all sessions, stop CopilotClient. */
    async shutdown(): Promise<void> {
        for (const [_, session] of this.sessions) {
            try { await session.destroy(); } catch {}
        }
        this.sessions.clear();
        this.sessionClientKeys.clear();
        for (const [, client] of this.clients) {
            try { await client.stop(); } catch {}
        }
        this.clients.clear();
    }

    /**
     * Resolve tools from per-session config + worker-level registry.
     * Per-session tools take precedence over registry tools with the same name.
     *
     * `preferredPackageId` is the package copy this session's bound agent
     * resolved to. On a tool-name collision between two enabled packages
     * (scope shadowing publishes the same tool name twice), the session gets
     * ITS copy's handler instead of whichever package loaded last. Deployment
     * (static) tools still win every collision.
     */
    private _resolveTools(
        storedConfig: ManagedSessionConfig | undefined,
        serializableConfig: SerializableSessionConfig,
        preferredPackageId?: string | null,
    ): Tool<any>[] {
        const registryTools: Tool<any>[] = [];
        const packageTools = preferredPackageId
            ? this.packageToolRegistry?.get(preferredPackageId)
            : undefined;
        if (serializableConfig.toolNames?.length) {
            for (const name of serializableConfig.toolNames) {
                const tool = (this.staticToolNames?.has(name) ? this.toolRegistry.get(name) : undefined)
                    ?? packageTools?.get(name)
                    ?? this.toolRegistry.get(name);
                if (tool) registryTools.push(tool);
            }
        }

        const combined = [
            ...(storedConfig?.tools ?? []),
            ...registryTools,
        ];

        // Deduplicate by name — per-session tools take precedence
        const seen = new Set<string>();
        const deduped: Tool<any>[] = [];
        for (const tool of combined) {
            const name = (tool as any).name;
            if (!seen.has(name)) {
                seen.add(name);
                deduped.push(tool);
            }
        }
        return deduped;
    }

    /**
     * Resolve the provider config for a given model.
     * Prefers ModelProviderRegistry, falls back to legacy single provider.
     */
    private _resolveProviderConfig(model?: string): Record<string, any> {
        // 1. Try the multi-provider registry
        const registry = this.workerDefaults.modelProviders;
        if (registry) {
            const resolved = registry.resolve(model);
            if (resolved) {
                if (resolved.type === "github") {
                    // GitHub provider — no SDK provider needed, uses gitHubToken on the client
                    return {};
                }
                if (resolved.sdkProvider) {
                    return { provider: resolved.sdkProvider };
                }
            }
        }

        // 2. Fall back to legacy single provider
        const p = this.workerDefaults.provider;
        if (!p) return {};

        // For Azure, dynamically construct deployment URL
        if (p.type === "azure" && model && !p.baseUrl.includes("/deployments/")) {
            return {
                provider: {
                    ...p,
                    baseUrl: `${p.baseUrl.replace(/\/+$/, "")}/deployments/${model}`,
                },
            };
        }
        return { provider: p };
    }

    /**
     * Build the final system message from:
     * 1. embedded PilotSwarm framework base
     * 2. app-level default instructions
     * 3. bound agent prompt (for named/system sessions)
     * 4. caller/runtime context
     */
    private _buildKnowledgeToolInstructionsSection(agentIdentity?: string): SectionOverride | undefined {
        if (!this.factStore || agentIdentity === "facts-manager") return undefined;

        // Capability-aware knowledge block (enhancedfactstore 07 §1.5/§1.6). Three
        // independent axes drive the content: enhanced-search facts, whether an
        // embedder is available (semantic), and graph presence. The base path is
        // byte-for-byte today's block.
        const enhancedSearch = isEnhancedFactStore(this.factStore) && this.factStore.capabilities.search;
        const hasEmbedder = isEnhancedFactStore(this.factStore) && this.factStore.capabilities.embedder === true;
        const hasGraph = !!this.graphStore;

        return {
            action: async (currentContent: string) => {
                if (enhancedSearch) {
                    // Enhanced: DROP the capped-50 skills push — the agent pulls
                    // ranked skills via search_skills every turn, so skip the
                    // skills read entirely (includeSkills:false). Open asks still
                    // surface on their small push path, but without the namespace
                    // rules (the enhanced block owns them, avoiding duplication).
                    // The semantic wording is gated on an actual embedder: with
                    // search-only/lexical-degrade, the block must not promise
                    // semantic recall.
                    const knowledgeIndex = await loadKnowledgeIndexFromFactStore(this.factStore!, 50, { includeSkills: false });
                    const { askBlock } = buildKnowledgePromptBlocks(knowledgeIndex, { includeNamespaceRules: false });
                    const enhancedBlock = buildEnhancedRetrievalPromptBlock({ semantic: hasEmbedder });
                    const graphBlock = hasGraph ? buildGraphReaderPromptBlock({ semanticSeed: hasEmbedder }) : undefined;
                    return mergePromptSections([currentContent, askBlock, enhancedBlock, graphBlock]) ?? currentContent;
                }
                // Base store: today's block unchanged (skills + asks push). When a
                // graph is configured on a base-facts deployment, add the graph
                // read block too (no semantic-seed sentence).
                const knowledgeIndex = await loadKnowledgeIndexFromFactStore(this.factStore!, 50);
                const { askBlock, skillBlock } = buildKnowledgePromptBlocks(knowledgeIndex);
                const graphBlock = hasGraph ? buildGraphReaderPromptBlock({ semanticSeed: false }) : undefined;
                return mergePromptSections([currentContent, askBlock, skillBlock, graphBlock]) ?? currentContent;
            },
        };
    }

    private _buildLastInstructionsSection(
        sessionId: string,
        initialConfig: SerializableSessionConfig,
    ): SectionOverride {
        return {
            action: async (currentContent: string) => {
                const latest = this.sessionConfigs.get(sessionId) ?? initialConfig;
                const runtimeContext = extractPromptContent(latest.systemMessage);
                // Owner-aware copy pick, re-resolved here because this action
                // runs per compose: with scope shadowing one agent name can be
                // served by several packages, and this session must get the
                // copy its OWNER resolves to — not whichever loaded last.
                const activeAgentPrompt = latest.boundAgentName
                    ? pickAgentCopyForOwner(
                        this.workerDefaults.agentPromptLookup?.[latest.boundAgentName],
                        await this._sessionAgentOwnerKey(sessionId),
                    )?.prompt
                    : undefined;
                const overlay = mergePromptSections([
                    activeAgentPrompt,
                    runtimeContext,
                    latest.turnSystemPrompt,
                ]);
                return mergePromptSections([currentContent, overlay]) ?? currentContent;
            },
        };
    }

    /**
     * The session owner's identity key for agent-copy shadowing, or null when
     * the session is ownerless/system or the owner is unreadable (fail-safe:
     * no key means no user-scope copy applies, never the wrong one).
     * Rides the inspect-viewer TTL cache — one CMS read per session per TTL.
     */
    private async _sessionAgentOwnerKey(sessionId: string): Promise<string | null> {
        try {
            const viewer = await this._resolveInspectViewer(sessionId);
            if (!viewer?.provider || !viewer?.subject || viewer.isSystemPrincipal) return null;
            return agentOwnerKey({ provider: viewer.provider, subject: viewer.subject });
        } catch {
            return null;
        }
    }

    /**
     * Who the inspect tools act as, for one session.
     *
     * Cached for INSPECT_VIEWER_TTL_MS, not for the session's life: a
     * privilege value must be able to go stale DOWNWARD promptly. Captured at
     * creation, it would let a demoted admin keep fleet-wide reach for as long
     * as they kept a session open; on a short TTL the worst case is bounded by
     * the TTL. The bound is the point, so it is a named constant, not a magic
     * number buried in a call.
     *
     * ADMIN COMES FROM THE USERS TABLE, not from a token. A worker holds an
     * owner and never sees a request — cron firings, sub-agent turns, crash
     * recovery and replay all run turns with no HTTP request behind them at
     * all — so the portal records the role it authenticated with
     * (`cms_set_user_role`, migration 0042) and the worker reads that
     * observation here.
     *
     * Two ways it fails closed, both deliberate:
     *   - No recorded role (never signed in, unknown principal, read failure)
     *     is plain user, never admin.
     *   - A role older than ROLE_MAX_AGE_MS is discarded. An observation that
     *     nothing has re-confirmed in half a day is not evidence of current
     *     privilege.
     */
    private async _resolveInspectViewer(sessionId: string): Promise<InspectViewer> {
        const cached = SessionManager._inspectViewerCache.get(sessionId);
        if (cached && Date.now() - cached.at < INSPECT_VIEWER_TTL_MS) return cached.viewer;

        let viewer: InspectViewer = NO_VIEWER;
        try {
            const row = await this.sessionCatalog?.getSession(sessionId);
            const owner = row?.owner;
            if (owner?.provider && owner?.subject) {
                const isSystemPrincipal = owner.provider === SYSTEM_USER_PRINCIPAL.provider
                    && owner.subject === SYSTEM_USER_PRINCIPAL.subject;
                viewer = {
                    provider: owner.provider,
                    subject: owner.subject,
                    // The System principal already reaches everything through
                    // isSystemPrincipal; asking the users table about it would
                    // only add a query whose answer changes nothing.
                    isAdmin: isSystemPrincipal ? false : await this._resolveOwnerIsAdmin(owner),
                    isSystemPrincipal,
                };
            } else if (row?.isSystem) {
                // Ownerless platform sessions act as the System principal, the
                // same way they already do for credential resolution.
                viewer = { provider: "system", subject: "system", isAdmin: false, isSystemPrincipal: true };
            }
        } catch {
            // Fail closed: NO_VIEWER reads nothing.
            viewer = NO_VIEWER;
        }
        SessionManager._cacheInspectViewer(sessionId, viewer);
        return viewer;
    }

    /**
     * Store a resolved viewer, sweeping expired entries first when the map has
     * grown past the sweep threshold. Expiry is by the same TTL the read path
     * enforces, so a swept entry could never have been served anyway.
     */
    private static _cacheInspectViewer(sessionId: string, viewer: InspectViewer): void {
        const now = Date.now();
        if (SessionManager._inspectViewerCache.size >= SessionManager.INSPECT_VIEWER_CACHE_SWEEP_AT) {
            for (const [id, entry] of SessionManager._inspectViewerCache) {
                if (now - entry.at >= INSPECT_VIEWER_TTL_MS) SessionManager._inspectViewerCache.delete(id);
            }
            // Everything was live (a genuinely huge concurrent working set).
            // Drop it all rather than grow without bound; the cost is one
            // re-resolution per session, never a wrong answer.
            if (SessionManager._inspectViewerCache.size >= SessionManager.INSPECT_VIEWER_CACHE_SWEEP_AT) {
                SessionManager._inspectViewerCache.clear();
            }
        }
        SessionManager._inspectViewerCache.set(sessionId, { at: now, viewer });
    }

    /**
     * Is this owner currently an administrator, per the last role the portal
     * observed for them?
     *
     * The decision itself lives in `evaluateRoleObservation` next to the other
     * shared authz predicates — the same reason `evaluateSessionAccess` moved
     * there in phase A. A security rule with two implementations has one that
     * is wrong.
     */
    private async _resolveOwnerIsAdmin(owner: { provider: string; subject: string }): Promise<boolean> {
        if (typeof this.sessionCatalog?.getUserRole !== "function") return false;
        try {
            const observation = await this.sessionCatalog.getUserRole(owner);
            return evaluateRoleObservation(observation, { principal: owner }).isAdmin;
        } catch {
            // A read failure is not evidence of privilege.
            return false;
        }
    }

    private _buildSystemMessage(
        sessionId: string,
        config: SerializableSessionConfig,
        sessionOwnerKey: string | null = null,
    ): SystemMessageConfig | undefined {
        const frameworkBase = this.workerDefaults.frameworkBasePrompt ?? this.workerDefaults.systemMessage;
        const boundAgentName = config.boundAgentName;
        const layerKind = config.promptLayering?.kind ?? (boundAgentName ? "app-agent" : undefined);
        const knowledgeToolInstructions = this._buildKnowledgeToolInstructionsSection(config.agentIdentity);
        const lastInstructions = this._buildLastInstructionsSection(sessionId, config);
        const additionalSections = knowledgeToolInstructions
            ? { tool_instructions: knowledgeToolInstructions, last_instructions: lastInstructions }
            : { last_instructions: lastInstructions };

        const isPilotSwarmSystemAgent = layerKind === "pilotswarm-system-agent";
        const layerManifest = buildEffectivePromptLayers(this.workerDefaults, config, sessionOwnerKey);

        return composeStructuredSystemMessage({
            frameworkBase,
            appDefault: isPilotSwarmSystemAgent
                ? undefined
                : this.workerDefaults.appDefaultPrompt,
            additionalSections,
            layerManifest: layerManifest.length > 0 ? layerManifest : undefined,
        });
    }
}
