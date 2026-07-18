import { CopilotClient, type CopilotSession, type SectionOverride, type SystemMessageConfig, type Tool } from "@github/copilot-sdk";
import { ManagedSession } from "./managed-session.js";
import type { SessionStateStore } from "./session-store.js";
import { SESSION_STATE_MISSING_PREFIX, type AbortTurnResult, type ManagedSessionConfig, type SerializableSessionConfig } from "./types.js";
import type { ModelProviderRegistry } from "./model-providers.js";
import { createFactTools } from "./facts-tools.js";
import { createGraphTools } from "./graph-tools.js";
import { createInspectTools } from "./inspect-tools.js";
import type { SessionCatalog } from "./cms.js";
import { SYSTEM_USER_PRINCIPAL } from "./cms.js";
import type { FactStore } from "./facts-store.js";
import { isEnhancedFactStore } from "./facts-store.js";
import type { GraphStore } from "./graph-store.js";
import { buildKnowledgePromptBlocks, loadKnowledgeIndexFromFactStore, buildEnhancedRetrievalPromptBlock, buildGraphReaderPromptBlock } from "./knowledge-index.js";
import { composeStructuredSystemMessage, extractPromptContent, mergePromptSections } from "./prompt-layering.js";
import { loadSkillsSync } from "./skills.js";
import { buildPromptLayersEventPayload, type PromptLayerDescriptor } from "./prompt-layers.js";
import { approvePermissionForSession } from "./permissions.js";
import { fingerprintCapabilityOverride, composeToolFilters } from "./capability-override.js";
import { PROTOCOL_FLOOR_TOOLS } from "./capability-catalog.js";
import { readSnapshotMarker, supportsVersionedSnapshots } from "./snapshot-protocol.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
// System-agent identities exempt from tier-based default-off exclusion: they
// receive whatever their profile/identity grants (mirrors session-proxy.ts).
const SYSTEM_AGENT_IDS = new Set(["pilotswarm", "sweeper", "resourcemgr", "facts-manager", "agent-tuner"]);
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

/** Worker-level defaults — applied to every session. */
export interface WorkerDefaults {
    frameworkBasePrompt?: string;
    frameworkBaseToolNames?: string[];
    appDefaultPrompt?: string;
    appDefaultToolNames?: string[];
    /** Backward-compatible alias for older code paths/tests. */
    systemMessage?: string;
    /** Raw prompt lookup for named and system agents bound directly to sessions. */
    agentPromptLookup?: Record<string, { prompt: string; kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent"; descriptor?: import("./prompt-layers.js").PromptLayerDescriptor }>;
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
     * Per-agent skill restriction, keyed by bound agent name: the skill
     * names to DISABLE for that agent's sessions (complemented against the
     * boot-time deployment skill catalog from `allowedSkills`).
     */
    agentDisabledSkills?: Record<string, string[]>;
    /**
     * Per-agent allowedSkills as declared, keyed by bound agent name. Used
     * at assembly to RE-complement against the live skill directories (the
     * CLI re-scans them per session create, so skills added after worker
     * boot must still be denied for restricted agents).
     */
    agentAllowedSkills?: Record<string, string[]>;
    /**
     * Per-agent tool policy, keyed by bound agent name. `deny` merges into
     * the session's excludedTools (which always win); `allow` switches the
     * session to allow-list mode via availableTools.
     */
    agentToolPolicy?: Record<string, { allow?: string[]; deny?: string[] }>;
    /**
     * Tool-group membership (group → member tool names) for expanding
     * group entries in session capability overrides.
     */
    toolGroupMembers?: Record<string, string[]>;
    /**
     * Skill name → tools that skill requires (from its tools.json). When a
     * skill is effectively enabled for a session, its required tools are
     * force-available and non-removable (a skill cannot run without them).
     */
    skillRequiredTools?: Record<string, string[]>;
    /**
     * Tool GROUP → capability tier. Groups at an "extended"/"system" tier are
     * DEFAULT-OFF: their tools are physically dropped from a session's tool
     * array unless the session opts in (via the tree override) or the bound
     * agent grants them — so their definitions never load (context savings).
     */
    toolGroupTiers?: Record<string, string>;
    /**
     * Skill name → capability tier. "extended"/"system" skills are DEFAULT-OFF
     * (added to disabledSkills unless opted in). System sessions are exempt.
     */
    skillTiers?: Record<string, string>;
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
    /** Wall-clock turn cap in ms. 0 = no cap; undefined = 10-minute default. */
    turnTimeoutMs?: number;
    /** Turn inactivity watchdog in ms. 0 = disabled; undefined = 5-minute default. */
    turnInactivityTimeoutMs?: number;
}

// Live skill-name scan for allowedSkills re-complementing at assembly.
// TTL-cached: assembly happens per session create/rebind, and a 30s window
// is far fresher than the CLI's own view while avoiding fs storms.
let _skillNamesCache: { names: string[]; at: number; key: string } | null = null;
function currentSkillNames(skillDirs: string[]): string[] {
    const key = skillDirs.join("|");
    const now = Date.now();
    if (_skillNamesCache && _skillNamesCache.key === key && now - _skillNamesCache.at < 30_000) {
        return _skillNamesCache.names;
    }
    const names = new Set<string>();
    for (const dir of skillDirs) {
        try {
            for (const skill of loadSkillsSync(dir)) names.add(skill.name);
        } catch { /* unreadable dir — the boot-time complement still applies */ }
    }
    _skillNamesCache = { names: [...names], at: now, key };
    return _skillNamesCache.names;
}

function buildEffectivePromptLayers(workerDefaults: WorkerDefaults, config: SerializableSessionConfig): PromptLayerDescriptor[] {
    const boundAgentName = config.boundAgentName;
    const layerKind = config.promptLayering?.kind ?? (boundAgentName ? "app-agent" : undefined);
    const isPilotSwarmSystemAgent = layerKind === "pilotswarm-system-agent";
    const layers: PromptLayerDescriptor[] = [];
    if (workerDefaults.frameworkBaseDescriptor) layers.push(workerDefaults.frameworkBaseDescriptor);
    if (!isPilotSwarmSystemAgent && workerDefaults.appDefaultDescriptor) layers.push(workerDefaults.appDefaultDescriptor);
    if (boundAgentName) {
        const agentDescriptor = workerDefaults.agentPromptLookup?.[boundAgentName]?.descriptor;
        if (agentDescriptor) layers.push(agentDescriptor);
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
export class SessionManager {
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

    /** Set the worker-level tool registry. Called by PilotSwarmWorker. */
    setToolRegistry(registry: Map<string, Tool<any>>): void {
        this.toolRegistry = registry;
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
        options?: { turnIndex?: number; trace?: SessionTraceWriter; lockHeld?: boolean },
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
        options?: { turnIndex?: number; trace?: SessionTraceWriter; lockHeld?: boolean },
    ): Promise<ManagedSession> {
        this.sessionLastTouchedAt.set(sessionId, Date.now());
        const turnIndex = options?.turnIndex;
        const trace = options?.trace;
        const inheritedToolNames = Array.from(new Set([
            ...(this.workerDefaults.frameworkBaseToolNames ?? []),
            ...(this.workerDefaults.appDefaultToolNames ?? []),
            ...(serializableConfig.toolNames ?? []),
        ]));
        const effectiveSerializableConfig: SerializableSessionConfig = inheritedToolNames.length > 0
            ? { ...serializableConfig, toolNames: inheritedToolNames }
            : serializableConfig;
        // Resolve tools: merge per-session (setConfig) + registry (toolNames)
        const storedConfig = this.sessionConfigs.get(sessionId);
        const resolvedTools = this._resolveTools(storedConfig, effectiveSerializableConfig);

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
        const resolvedProviderConfig = this._resolveProviderConfig(effectiveModel);
        let sdkModelName = effectiveModel;
        let modelDescriptor: import("./model-providers.js").ModelDescriptor | undefined;
        if (registry && effectiveModel) {
            const desc = registry.getDescriptor(effectiveModel);
            if (desc) {
                sdkModelName = desc.modelName;
                modelDescriptor = desc;
            }
        }

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
        const isTunerSession = effectiveSerializableConfig.agentIdentity === "agent-tuner";
        const mutatingSystemToolNames = new Set(["update_session_summary", "send_session_message", "reply_session_message"]);
        const userTools = config.tools ?? [];
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
            })
            : [];
        const SYSTEM_TOOL_NAMES = new Set([
            ...systemTools, ...subAgentTools, ...factTools, ...inspectTools, ...graphTools,
        ].map((t: any) => t.name));
        let persistentSessionTools = [
            ...userTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...factTools,
            ...inspectTools,
            ...graphTools,
        ];
        let allTools = [
            ...persistentSessionTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...systemTools,
            ...subAgentTools,
            ...factTools,
            ...inspectTools,
            ...graphTools,
        ];
        config.tools = persistentSessionTools;

        // Build system message: worker base + client override
        const systemMessage = this._buildSystemMessage(sessionId, config);

        // Per-agent MCP (capability-profiles Phase 1): a session gets the
        // base map (base-agent opt-ins + direct worker-config servers) plus
        // its bound agent's resolved server map — resolved worker-side at the
        // same chokepoint as the agent prompt. The deployment catalog is
        // never applied wholesale.
        // Capability-profile key: the bound agent, or — for FREEFORM
        // sub-agents spawned without an agent — the profile agent inherited
        // from the parent, so a restricted agent cannot mint an unrestricted
        // child by omitting agent_name. Applied uniformly across all three
        // axes (MCP, skills, tools) so a freeform child is consistent.
        const profileAgentName = effectiveSerializableConfig.boundAgentName
            ?? effectiveSerializableConfig.capabilityProfileAgent;
        const boundAgentMcpServers = profileAgentName
            ? this.workerDefaults.agentMcpServers?.[profileAgentName]
            : undefined;
        const effectiveMcpServers = {
            ...(this.workerDefaults.baseMcpServers ?? {}),
            ...(boundAgentMcpServers ?? {}),
        };

        // Per-agent skill/tool restrictions (capability-profiles Phase 2),
        // resolved worker-side from the bound agent's allowedSkills /
        // toolPolicy frontmatter. Deny composes ON TOP of the built-in floor
        // (the excluded native "task" tool, identity gates): excludedTools
        // always win in the CLI, so a policy can narrow but never widen.
        // Allow-list mode implicitly retains report_cycle — the turn-cycling
        // tool sessions cannot function without.
        const boundAgentName = profileAgentName;
        const agentDisabledSkills = boundAgentName
            ? this.workerDefaults.agentDisabledSkills?.[boundAgentName]
            : undefined;
        const agentToolPolicy = boundAgentName
            ? this.workerDefaults.agentToolPolicy?.[boundAgentName]
            : undefined;

        // Session-TREE capability override (capability-profiles Phase 3):
        // stored once on the tree root's row and applied by every tree
        // member on top of its own agent profile. FAIL CLOSED on a read
        // error — running a turn on the unrestricted agent profile would
        // silently re-enable everything a user disabled; a thrown error
        // fails the turn retryably instead (review addendum 3).
        let treeOverride: import("./capability-override.js").SessionCapabilityOverride | null = null;
        if (this.sessionCatalog) {
            try {
                treeOverride = await this.sessionCatalog.getCapabilityOverride(sessionId);
            } catch (error: unknown) {
                throw new Error(
                    `Capability override read failed for ${sessionId}: ${normalizeError(error).message} ` +
                    `(failing closed; the turn will retry)`,
                );
            }
        }
        const capabilityFingerprint = fingerprintCapabilityOverride(treeOverride);

        // MCP axis: enable pulls catalog servers in; disable removes; the
        // agent profile is the baseline and disable wins.
        if (treeOverride?.mcpServers) {
            for (const name of treeOverride.mcpServers.enable ?? []) {
                const server = this.workerDefaults.mcpServers?.[name];
                if (server) effectiveMcpServers[name] = server;
            }
            for (const name of treeOverride.mcpServers.disable ?? []) {
                delete effectiveMcpServers[name];
            }
        }

        // Skills axis: final disabled = (agent-disabled ∪ override-disable)
        // − (override-enable − override-disable). For restricted agents the
        // complement is recomputed against the LIVE skill directories, not
        // just the worker's boot snapshot — the CLI re-scans the dirs at
        // session create, so an out-of-snapshot skill must still be denied.
        const agentAllowedSkills = boundAgentName
            ? this.workerDefaults.agentAllowedSkills?.[boundAgentName]
            : undefined;
        const disabledSkillSet = new Set(agentDisabledSkills ?? []);
        if (agentAllowedSkills !== undefined && this.workerDefaults.skillDirectories?.length) {
            for (const name of currentSkillNames(this.workerDefaults.skillDirectories)) {
                if (!agentAllowedSkills.includes(name)) disabledSkillSet.add(name);
            }
        }
        if (treeOverride?.skills) {
            const skillDisable = new Set(treeOverride.skills.disable ?? []);
            for (const name of treeOverride.skills.enable ?? []) {
                if (!skillDisable.has(name)) disabledSkillSet.delete(name);
            }
            for (const name of skillDisable) disabledSkillSet.add(name);
        }

        // Tier-based DEFAULT-OFF (context reduction). Extended/system-tier
        // capabilities are withheld unless the session opts in or the bound
        // agent grants them; system SESSIONS are exempt (they get what their
        // profile/identity grants). Opt-in signals per axis are the tree
        // override's enable lists and the agent's own profile.
        const DEFAULT_OFF = new Set(["extended", "system"]);
        const isSystemSession = SYSTEM_AGENT_IDS.has(effectiveSerializableConfig.agentIdentity || "");
        const groupMembers = this.workerDefaults.toolGroupMembers ?? {};

        // Skills axis: extended/system skills are off unless opted in (override
        // enable) or the agent explicitly allows them via allowedSkills.
        const skillTiers = this.workerDefaults.skillTiers ?? {};
        const skillOptIn = new Set<string>([
            ...(treeOverride?.skills?.enable ?? []),
            ...(agentAllowedSkills ?? []),
        ]);
        if (!isSystemSession) {
            for (const [skillName, tier] of Object.entries(skillTiers)) {
                if (DEFAULT_OFF.has(tier) && !skillOptIn.has(skillName)) disabledSkillSet.add(skillName);
            }
        }

        const finalDisabledSkills = [...disabledSkillSet];

        // A skill cannot run without its declared tools, so any skill that is
        // effectively ENABLED for this session force-protects its required
        // tools — they become non-removable, exactly like the protocol floor.
        const skillRequiredTools = this.workerDefaults.skillRequiredTools ?? {};
        const activeSkillTools: string[] = [];
        for (const [skillName, tools] of Object.entries(skillRequiredTools)) {
            if (!disabledSkillSet.has(skillName)) activeSkillTools.push(...tools);
        }

        // Tools axis: default-off tools (extended/system group tiers) that the
        // session did not opt into are physically dropped from the tool array
        // below, so their definitions never load. Opt-in = the tree override's
        // tool/group enables, the agent's additive tools / allow-list, or an
        // active skill that requires the tool.
        const toolGroupTiers = this.workerDefaults.toolGroupTiers ?? {};
        const toolOptIn = new Set<string>([
            ...(agentToolPolicy?.allow ?? []),
            // The bound agent's additive `tools:` are merged into config.toolNames
            // by the orchestration — an explicit grant, so never default-dropped.
            ...(Array.isArray(config.toolNames) ? config.toolNames : []),
            ...activeSkillTools,
        ]);
        // Expand the override's tool enables (group names → members).
        for (const entry of treeOverride?.tools?.enable ?? []) {
            if (groupMembers[entry]) for (const m of groupMembers[entry]) toolOptIn.add(m);
            else toolOptIn.add(entry);
        }
        const defaultOffToolDrop = new Set<string>();
        if (!isSystemSession) {
            for (const [group, tier] of Object.entries(toolGroupTiers)) {
                if (!DEFAULT_OFF.has(tier)) continue;
                for (const member of groupMembers[group] ?? []) {
                    if (!toolOptIn.has(member)) defaultOffToolDrop.add(member);
                }
            }
        }
        // Physically remove default-off tools from the session's tool arrays so
        // their definitions never reach the model (the actual context savings).
        // Base floor is never dropped.
        if (defaultOffToolDrop.size > 0) {
            for (const floor of PROTOCOL_FLOOR_TOOLS) defaultOffToolDrop.delete(floor);
            const keep = (t: any) => !defaultOffToolDrop.has(t.name);
            persistentSessionTools = persistentSessionTools.filter(keep);
            allTools = allTools.filter(keep);
            config.tools = persistentSessionTools;
        }

        // Tools axis: group entries expand to members (individual entries
        // override their group; disable wins), the protocol floor AND active
        // skills' required tools are enforced in both directions, and
        // allow-mode retains granted MCP servers. Pure logic lives in
        // composeToolFilters (unit-tested).
        const { excludedTools: sessionExcludedTools, availableTools: sessionAvailableTools } = composeToolFilters({
            agentPolicy: agentToolPolicy,
            override: treeOverride?.tools,
            groupMembers: this.workerDefaults.toolGroupMembers ?? {},
            protocolFloor: [...PROTOCOL_FLOOR_TOOLS, ...activeSkillTools],
            hasMcpServers: Object.keys(effectiveMcpServers).length > 0,
        });

        const sessionConfig: any = {
            sessionId,
            tools: allTools,
            model: sdkModelName,
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
            // Excluded tools: the Copilot SDK's built-in "task" tool is the
            // permanent floor — PilotSwarm provides its own durable sub-agent
            // mechanism via spawn_agent / check_agents, and the native "task"
            // tool would bypass the durable orchestration layer. The bound
            // agent's toolPolicy.deny composes on top; excludedTools always
            // win over availableTools in the CLI.
            excludedTools: sessionExcludedTools,
            ...(sessionAvailableTools ? { availableTools: sessionAvailableTools } : {}),
            ...(finalDisabledSkills.length ? { disabledSkills: finalDisabledSkills } : {}),
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
            } else if (existing.requiresModelRebind(config)) {
                console.warn(
                    `[SessionManager] model config changed for ${sessionId}; ` +
                    `disconnecting warm Copilot session so it can resume with the new model config.`,
                );
                await existing.destroy();
                this.sessions.delete(sessionId);
            } else if (existing.appliedCapabilityFingerprint !== capabilityFingerprint) {
                // MCP servers and skills are fixed at session build, so a
                // changed tree override requires a rebind — same cost as a
                // model switch (capability-profiles Phase 4).
                console.warn(
                    `[SessionManager] capability override changed for ${sessionId}; ` +
                    `disconnecting warm Copilot session so it can rebind with the new capability set.`,
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
                storedExists = await this.sessionStore.exists(sessionId);
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
        } else if (turnIndex != null && turnIndex > 0) {
            if (fs.existsSync(sessionDir)) {
                emitSessionManagerTrace(sessionId, "turn>0 resuming from local session directory", { trace });
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else if (this.sessionStore && storedExists) {
                emitSessionManagerTrace(sessionId, "turn>0 hydrating from session store before resume", { trace });
                try {
                    await this.sessionStore.hydrate(sessionId);
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
        managed.appliedCapabilityFingerprint = capabilityFingerprint;
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
                            // Transient dehydration-retry session: leave the
                            // capability fingerprint empty — a later
                            // getOrCreate under a non-empty override sees a
                            // mismatch and rebinds, which is the safe side.
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
     */
    private _resolveTools(
        storedConfig: ManagedSessionConfig | undefined,
        serializableConfig: SerializableSessionConfig,
    ): Tool<any>[] {
        const registryTools: Tool<any>[] = [];
        if (serializableConfig.toolNames?.length) {
            for (const name of serializableConfig.toolNames) {
                const tool = this.toolRegistry.get(name);
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
                const activeAgentPrompt = latest.boundAgentName
                    ? this.workerDefaults.agentPromptLookup?.[latest.boundAgentName]?.prompt
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

    private _buildSystemMessage(
        sessionId: string,
        config: SerializableSessionConfig,
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
        const layerManifest = buildEffectivePromptLayers(this.workerDefaults, config);

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
