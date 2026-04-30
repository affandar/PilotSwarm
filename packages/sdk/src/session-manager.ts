import { CopilotClient, type CopilotSession, type SectionOverride, type SystemMessageConfig, type Tool } from "@github/copilot-sdk";
import { ManagedSession } from "./managed-session.js";
import type { SessionStateStore } from "./session-store.js";
import { SESSION_STATE_MISSING_PREFIX, type ManagedSessionConfig, type SerializableSessionConfig } from "./types.js";
import type { ModelProviderRegistry } from "./model-providers.js";
import { createFactTools } from "./facts-tools.js";
import { createInspectTools } from "./inspect-tools.js";
import type { SessionCatalogProvider } from "./cms.js";
import type { FactStore } from "./facts-store.js";
import { buildKnowledgePromptBlocks, loadKnowledgeIndexFromFactStore } from "./knowledge-index.js";
import { composeStructuredSystemMessage, extractPromptContent, mergePromptSections } from "./prompt-layering.js";
import { approvePermissionForSession } from "./permissions.js";
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

/** Worker-level defaults — applied to every session. */
export interface WorkerDefaults {
    frameworkBasePrompt?: string;
    frameworkBaseToolNames?: string[];
    appDefaultPrompt?: string;
    appDefaultToolNames?: string[];
    /** Backward-compatible alias for older code paths/tests. */
    systemMessage?: string;
    /** Raw prompt lookup for named and system agents bound directly to sessions. */
    agentPromptLookup?: Record<string, { prompt: string; kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }>;
    /** Skill directories to pass to the Copilot SDK. */
    skillDirectories?: string[];
    /** Custom agents to pass to the Copilot SDK. */
    customAgents?: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null }>;
    /** MCP server configs to pass to the Copilot SDK. */
    mcpServers?: Record<string, any>;
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
    /** Turn timeout in milliseconds. 0 or undefined = no timeout. */
    turnTimeoutMs?: number;
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
    private client: CopilotClient | null = null;
    private sessions = new Map<string, ManagedSession>();
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
    /** Shared CMS catalog used to build always-on inspect tools. */
    private sessionCatalog: SessionCatalogProvider | null = null;
    /** Duroxide client used by tuner-only inspect tools. */
    private _duroxideClient: any = null;
    /** Lineage lookup for ancestor/descendant facts access. */
    private _getLineageSessionIds: ((sessionId: string) => Promise<string[]>) | null = null;
    /** Per-session critical sections; protects the SDK session handle and local session.db. */
    private sessionLocks = new Map<string, Promise<void>>();

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

    /** Set the worker-level tool registry. Called by PilotSwarmWorker. */
    setToolRegistry(registry: Map<string, Tool<any>>): void {
        this.toolRegistry = registry;
    }

    /** Set the cluster facts store for always-on facts tools. */
    setFactStore(factStore: FactStore | null): void {
        this.factStore = factStore;
    }

    /** Set the CMS catalog for always-on inspect tools (e.g. read_agent_events). */
    setSessionCatalog(catalog: SessionCatalogProvider | null): void {
        this.sessionCatalog = catalog;
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
    private async ensureClient(): Promise<CopilotClient> {
        if (!this.client) {
            // Resolve githubToken: explicit > registry (github provider) > none.
            // The token is optional — BYOK providers work without it.
            let token = this.githubToken;
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
            this.client = new CopilotClient({
                ...(token ? { gitHubToken: token } : {}),
                logLevel: "error",
                // The Copilot CLI honors COPILOT_HOME (and only COPILOT_HOME) to decide
                // where to write per-session state. Passing `configDir` on SessionConfig
                // is inert for state placement (verified empirically against
                // @github/copilot 1.0.36). We export COPILOT_HOME here so the CLI's
                // ~/.copilot resolves to <sessionStateDir>/.., which keeps test isolation
                // honest and lets production deployments place session state on the
                // mounted emptyDir volume rather than the container's user home.
                env: {
                    ...process.env,
                    COPILOT_HOME: path.dirname(this.sessionStateDir),
                },
            });
        }
        return this.client;
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
            const client = await this.ensureClient();
            await client.deleteSession(sessionId);
        } catch {}

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
        return this._withSessionLock(sessionId, operation, fn, options);
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
        };
        this.sessionConfigs.set(sessionId, config);

        const client = await this.ensureClient();
        const sessionDir = path.join(this.sessionStateDir, sessionId);

        // Merge user tools with system tool definitions (wait, ask_user, sub-agent tools)
        // so the LLM sees them at session creation time.
        if (!this.factStore) {
            throw new Error(
                "PilotSwarm invariant violated: factStore must be initialized before creating sessions.",
            );
        }
        const userTools = config.tools ?? [];
        const systemTools = ManagedSession.systemToolDefs();
        // Tuner sessions are read-only by design — no spawn / message / cancel.
        const isTunerSession = effectiveSerializableConfig.agentIdentity === "agent-tuner";
        const subAgentTools = isTunerSession ? [] : ManagedSession.subAgentToolDefs();
        const factTools = createFactTools({
            factStore: this.factStore,
            getLineageSessionIds: this._getLineageSessionIds ?? undefined,
            agentIdentity: effectiveSerializableConfig.agentIdentity,
            recordEvent: this.sessionCatalog
                ? async (sid, eventType, data) => {
                    try {
                        await this.sessionCatalog!.recordEvents(sid, [{ eventType, data }]);
                    } catch {
                        // Best-effort — never fail a tool call on telemetry errors.
                    }
                }
                : undefined,
        });
        const inspectTools = this.sessionCatalog
            ? createInspectTools({
                catalog: this.sessionCatalog,
                agentIdentity: effectiveSerializableConfig.agentIdentity,
                duroxideClient: this._duroxideClient ?? undefined,
                factStore: this.factStore ?? undefined,
            })
            : [];
        const SYSTEM_TOOL_NAMES = new Set([
            ...systemTools, ...subAgentTools, ...factTools, ...inspectTools,
        ].map((t: any) => t.name));
        const persistentSessionTools = [
            ...userTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...factTools,
            ...inspectTools,
        ];
        const allTools = [
            ...persistentSessionTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...systemTools,
            ...subAgentTools,
            ...factTools,
            ...inspectTools,
        ];
        config.tools = persistentSessionTools;

        // Build system message: worker base + client override
        const systemMessage = this._buildSystemMessage(sessionId, config);

        // Resolve model: config.model may be qualified (provider:model) or bare.
        // The SDK needs the bare model name; the provider config is separate.
        // Fall back to registry default if no model specified.
        const registry = this.workerDefaults.modelProviders;
        const effectiveModel = this.normalizeModelRef(config.model) || "";
        const resolvedProviderConfig = this._resolveProviderConfig(effectiveModel);
        let sdkModelName = effectiveModel;
        if (registry && effectiveModel) {
            const desc = registry.getDescriptor(effectiveModel);
            if (desc) sdkModelName = desc.modelName;
        }

        const sessionConfig: any = {
            sessionId,
            tools: allTools,
            model: sdkModelName,
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
            // Pass loaded skills, agents, and MCP from worker defaults
            ...(this.workerDefaults.skillDirectories?.length && { skillDirectories: this.workerDefaults.skillDirectories }),
            ...(this.workerDefaults.customAgents?.length && { customAgents: this.workerDefaults.customAgents }),
            ...(this.workerDefaults.mcpServers && Object.keys(this.workerDefaults.mcpServers).length > 0 && { mcpServers: this.workerDefaults.mcpServers }),
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
        this.sessions.set(sessionId, managed);
        return managed;
    }

    /** Get a session by ID (null if not in memory on this node). */
    get(sessionId: string): ManagedSession | null {
        return this.sessions.get(sessionId) ?? null;
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
                            const client = await this.ensureClient();
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
        if (this.client) {
            await this.client.stop();
            this.client = null;
        }
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

        return {
            action: async (currentContent: string) => {
                const knowledgeIndex = await loadKnowledgeIndexFromFactStore(this.factStore!, 50);
                const { askBlock, skillBlock } = buildKnowledgePromptBlocks(knowledgeIndex);
                return mergePromptSections([currentContent, askBlock, skillBlock]) ?? currentContent;
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
        return composeStructuredSystemMessage({
            frameworkBase,
            appDefault: layerKind === "pilotswarm-system-agent"
                ? undefined
                : this.workerDefaults.appDefaultPrompt,
            additionalSections,
        });
    }
}
