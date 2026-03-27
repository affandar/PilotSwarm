import {
    RESPONSE_LATEST_KEY,
} from "./types.js";
import {
    DURABLE_SESSION_LATEST_VERSION,
    DURABLE_SESSION_ORCHESTRATION_NAME,
} from "./orchestration-registry.js";
import type {
    PilotSwarmClientOptions,
    ManagedSessionConfig,
    SerializableSessionConfig,
    PilotSwarmSessionStatus,
    PilotSwarmSessionInfo,
    OrchestrationInput,
    UserInputHandler,
    CommandMessage,
    CommandResponse,
    SessionResponsePayload,
} from "./types.js";
import type { SessionCatalogProvider, SessionEvent } from "./cms.js";
import { PgSessionCatalogProvider } from "./cms.js";
import type { FactStore } from "./facts-store.js";
import { createFactStoreForUrl } from "./facts-store.js";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Client } = require("duroxide");

const DEFAULT_DUROXIDE_SCHEMA = "duroxide";
const WAIT_POLL_SLICE_MS = 10_000;

function createAbortError(message: string, reason?: unknown): Error {
    if (reason instanceof Error) return reason;
    const error = new Error(typeof reason === "string" && reason ? reason : message);
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) {
        throw createAbortError(message, signal.reason);
    }
}

/**
 * PilotSwarmClient — pure client-side session handle.
 *
 * Talks to duroxide only through the Client API (startOrchestration,
 * enqueueEvent, waitForStatusChange, getStatus). Does NOT own
 * SessionManager, Runtime, or CopilotSession.
 *
 * Creates its own duroxide Client and CMS catalog from the store URL.
 * Completely independent of PilotSwarmWorker.
 */
export class PilotSwarmClient {
    private config: PilotSwarmClientOptions & { waitThreshold: number };
    private _catalog!: SessionCatalogProvider;
    private _factStore: FactStore | null = null;
    private duroxideClient: any = null;
    private sessionConfigs = new Map<string, ManagedSessionConfig>();
    /** parentSessionId for sub-agent sessions. */
    private parentSessionIds = new Map<string, string>();
    /** nestingLevel for sub-agent sessions. */
    private nestingLevels = new Map<string, number>();
    /** System session flag. */
    systemSessions = new Set<string>();
    private activeOrchestrations = new Map<string, string>();
    private lastSeenStatusVersion = new Map<string, number>();
    private lastSeenIteration = new Map<string, number>();
    private lastSeenResponseVersion = new Map<string, number>();
    private activeWaitControllers = new Set<AbortController>();
    private activeWaitPromises = new Set<Promise<unknown>>();
    private started = false;
    /** Tracks agentId bound to each session (for policy and title prefixing). */
    private sessionAgentIds = new Map<string, string>();
    /** Effective session policy (set via config from worker). */
    private get _sessionPolicy(): import("./types.js").SessionPolicy | null {
        return this.config.sessionPolicy ?? null;
    }
    /** Allowed agent names (set via config from worker). */
    private get _allowedAgentNames(): string[] {
        return this.config.allowedAgentNames ?? [];
    }

    constructor(options: PilotSwarmClientOptions) {
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
        };
    }

    // ─── Session Management ──────────────────────────────────

    async createSession(config?: ManagedSessionConfig & {
        sessionId?: string;
        onUserInputRequest?: UserInputHandler;
        /** Names of tools registered on the worker via worker.registerTools(). */
        toolNames?: string[];
        /** If this session is a sub-agent, the parent session ID. */
        parentSessionId?: string;
        /** Nesting level for sub-agent depth tracking. */
        nestingLevel?: number;
        /** Agent ID to bind this session to (for policy validation and title prefixing). */
        agentId?: string;
    }): Promise<PilotSwarmSession> {
        // ── Policy enforcement (client-side) ─────────────────
        const policy = this._sessionPolicy;
        const isSubAgent = !!config?.parentSessionId;

        // The "default" agent is a prompt overlay, not a session-level agent.
        // Reject it unconditionally regardless of policy mode.
        const agentId = config?.agentId;
        if (agentId === "default" && !isSubAgent) {
            throw new Error(
                'Session creation rejected: "default" is a prompt overlay, not a selectable agent.',
            );
        }

        if (policy && policy.creation?.mode === "allowlist" && !isSubAgent) {
            if (!agentId && !policy.creation.allowGeneric) {
                throw new Error(
                    "Session creation policy violation: generic sessions are not allowed. " +
                    "Use createSessionForAgent() to specify an agent.",
                );
            }
            if (agentId && !this._allowedAgentNames.includes(agentId)) {
                throw new Error(
                    `Session creation policy violation: agent "${agentId}" is not in the allowed agent list.`,
                );
            }
        }

        const sessionId = config?.sessionId ?? crypto.randomUUID();
        if (config) {
            const fullConfig: ManagedSessionConfig = {
                model: config.model,
                systemMessage: config.systemMessage,
                boundAgentName: config.boundAgentName,
                promptLayering: config.promptLayering,
                tools: config.tools,
                workingDirectory: config.workingDirectory,
                hooks: config.hooks,
                waitThreshold: config.waitThreshold ?? this.config.waitThreshold,
                toolNames: config.toolNames,
            };
            this.sessionConfigs.set(sessionId, fullConfig);
        }

        // CMS: write session record (state=pending, no orchestration yet)
        await this._catalog.createSession(sessionId, {
            model: config?.model,
            parentSessionId: config?.parentSessionId,
        });

        // Track parentSessionId for sub-agent orchestration input
        if (config?.parentSessionId) {
            this.parentSessionIds.set(sessionId, config.parentSessionId);
        }
        // Track nestingLevel for sub-agent depth enforcement
        if (config?.nestingLevel != null) {
            this.nestingLevels.set(sessionId, config.nestingLevel);
        }
        // Track agentId for orchestration input
        if (config?.agentId) {
            this.sessionAgentIds.set(sessionId, config.agentId);
        }

        return new PilotSwarmSession(sessionId, this, config?.onUserInputRequest);
    }

    /**
     * Create a session bound to a named agent.
     *
     * Validates that the agent exists in the loaded (non-system) agent list.
     * Sets the agentId on the session and applies a prefixed title:
     * `"Agent Title: <shortId>"`.
     *
     * @throws If the agent is not found, is a system agent, or policy rejects it.
     */
    async createSessionForAgent(agentName: string, opts?: {
        model?: string;
        onUserInputRequest?: UserInputHandler;
        toolNames?: string[];
        title?: string;
        splash?: string;
        initialPrompt?: string;
    }): Promise<PilotSwarmSession> {
        // Validate the agent exists and is non-system
        const allowed = this._allowedAgentNames;
        if (!allowed.includes(agentName)) {
            throw new Error(
                `Cannot create session for agent "${agentName}": not found in loaded agents or is a system agent.`,
            );
        }

        const session = await this.createSession({
            model: opts?.model,
            toolNames: opts?.toolNames,
            onUserInputRequest: opts?.onUserInputRequest,
            agentId: agentName,
            boundAgentName: agentName,
            promptLayering: { kind: "app-agent" },
        });

        // Set agent metadata in CMS (agentId + prefixed title)
        const shortId = session.sessionId.slice(0, 8);
        const agentTitle = opts?.title || (agentName.charAt(0).toUpperCase() + agentName.slice(1));
        await this._catalog.updateSession(session.sessionId, {
            agentId: agentName,
            title: `${agentTitle}: ${shortId}`,
            ...(opts?.splash ? { splash: opts.splash } : {}),
        });

        if (opts?.initialPrompt) {
            await session.send(opts.initialPrompt, { bootstrap: true });
        }

        return session;
    }

    /**
     * Create a system session (e.g. Sweeper Agent).
     *
     * System sessions are protected from deletion and appear with distinct
     * styling in the TUI. They use the same orchestration as regular sessions.
     * Idempotent: if a system session already exists, it is resumed.
     */
    async createSystemSession(config: {
        model?: string;
        systemMessage?: string;
        toolNames?: string[];
        title?: string;
        onUserInputRequest?: UserInputHandler;
    }): Promise<PilotSwarmSession> {
        // Check if a system session already exists — resume it
        const existingSessions = await this._catalog.listSessions();
        const existing = existingSessions.find(s => s.isSystem);
        if (existing) {
            this.systemSessions.add(existing.sessionId);
            return this.resumeSession(existing.sessionId, {
                model: config.model,
                systemMessage: config.systemMessage,
                toolNames: config.toolNames,
                onUserInputRequest: config.onUserInputRequest,
            });
        }

        const sessionId = crypto.randomUUID();
        this.systemSessions.add(sessionId);
        const fullConfig: ManagedSessionConfig = {
            model: config.model,
            systemMessage: config.systemMessage,
            toolNames: config.toolNames,
        };
        this.sessionConfigs.set(sessionId, fullConfig);

        // CMS: create with is_system = true
        await this._catalog.createSession(sessionId, {
            model: config.model,
            isSystem: true,
        });

        // Set a fixed title immediately
        if (config.title) {
            await this._catalog.updateSession(sessionId, { title: config.title });
        }

        return new PilotSwarmSession(sessionId, this, config.onUserInputRequest);
    }

    async resumeSession(sessionId: string, config?: ManagedSessionConfig & {
        onUserInputRequest?: UserInputHandler;
    }): Promise<PilotSwarmSession> {
        if (config) {
            this.sessionConfigs.set(sessionId, config);
        }
        // Mark orchestration as active so _ensureOrchestrationAndSend skips creation.
        // The orchestration should already be running for resumed sessions.
        const orchestrationId = `session-${sessionId}`;
        this.activeOrchestrations.set(sessionId, orchestrationId);

        // Sync tracking state from the live orchestration so the client
        // doesn't mistake pre-existing KV data (from prior turns) as new.
        // Without this, sendAndWait returns stale responses after worker restarts.
        try {
            const orchStatus = await this.duroxideClient!.getStatus(orchestrationId);
            if (orchStatus.customStatusVersion) {
                this.lastSeenStatusVersion.set(orchestrationId, orchStatus.customStatusVersion);
            }
            if (orchStatus.customStatus) {
                const cs = typeof orchStatus.customStatus === "string"
                    ? JSON.parse(orchStatus.customStatus) : orchStatus.customStatus;
                if (cs.iteration != null) {
                    this.lastSeenIteration.set(orchestrationId, cs.iteration);
                }
                if (cs.responseVersion != null) {
                    this.lastSeenResponseVersion.set(orchestrationId, cs.responseVersion);
                }
            }
        } catch {
            // Best-effort — if getStatus fails, we'll still work (may see a stale response on first poll)
        }

        return new PilotSwarmSession(sessionId, this, config?.onUserInputRequest);
    }

    async listSessions(): Promise<PilotSwarmSessionInfo[]> {
        const rows = await this._catalog.listSessions();
        return rows.map(row => ({
            sessionId: row.sessionId,
            status: (row.state as PilotSwarmSessionStatus) ?? "pending",
            title: row.title ?? undefined,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            iterations: row.currentIteration,
            error: row.lastError ?? undefined,
            parentSessionId: row.parentSessionId ?? undefined,
            isSystem: row.isSystem || undefined,
            agentId: row.agentId ?? undefined,
            splash: row.splash ?? undefined,
        }));
    }

    async deleteSession(sessionId: string): Promise<void> {
        // Guard: refuse to delete system sessions (CMS will also throw)
        const session = await this._catalog.getSession(sessionId);
        if (session?.isSystem) {
            throw new Error("Cannot delete system session");
        }

        this.sessionConfigs.delete(sessionId);
        this.parentSessionIds.delete(sessionId);
        this.nestingLevels.delete(sessionId);

        // CMS: soft-delete (source of truth)
        await this._catalog.softDeleteSession(sessionId);

        if (this._factStore) {
            try {
                await this._factStore.deleteSessionFactsForSession(sessionId);
            } catch (err) {
                console.error(`[PilotSwarmClient] session fact cleanup failed for ${sessionId}:`, err);
            }
        }

        // Duroxide: cancel orchestration (best effort)
        const orchestrationId = `session-${sessionId}`;
        if (this.duroxideClient) {
            try {
                await this.duroxideClient.cancelInstance(orchestrationId, "Session deleted");
            } catch {}
        }
        this.activeOrchestrations.delete(sessionId);
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async start(): Promise<void> {
        if (this.started) return;
        const store = this.config.store;
        const _trace = this.config.traceWriter ?? (() => {});
        const startedAt = Date.now();
        const trace = (message: string) => _trace(`[+${Date.now() - startedAt}ms] ${message}`);

        // Create duroxide client
        let provider: any;
        if (store === "sqlite::memory:") provider = SqliteProvider.inMemory();
        else if (store.startsWith("sqlite://")) provider = SqliteProvider.open(store);
        else if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            trace("[client] connectWithSchema start...");
            provider = await PostgresProvider.connectWithSchema(store, this.config.duroxideSchema ?? DEFAULT_DUROXIDE_SCHEMA);
            trace("[client] connectWithSchema done");
        } else {
            throw new Error(`Unsupported store URL: ${store}`);
        }
        this.duroxideClient = new Client(provider);

        // Create CMS catalog
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            trace("[client] CMS create start...");
            this._catalog = await PgSessionCatalogProvider.create(store, this.config.cmsSchema);
            trace("[client] CMS initialize start...");
            await this._catalog.initialize();
            trace("[client] CMS initialize done");
        }

        trace("[client] facts create start...");
        this._factStore = await createFactStoreForUrl(store, this.config.factsSchema);
        trace("[client] facts initialize start...");
        await this._factStore.initialize();
        trace("[client] facts initialize done");

        this.started = true;
        trace("[client] start complete");
    }

    async stop(): Promise<void> {
        for (const controller of [...this.activeWaitControllers]) {
            controller.abort(createAbortError("PilotSwarmClient stopped"));
        }
        await Promise.allSettled([...this.activeWaitPromises]);

        if (this._factStore) {
            try { await this._factStore.close(); } catch {}
            this._factStore = null;
        }
        if (this._catalog) {
            try { await this._catalog.close(); } catch {}
        }
        this.duroxideClient = null;
        this.started = false;
    }

    // ─── Internal ────────────────────────────────────────────

    private get _blobEnabled(): boolean {
        return this.config.blobEnabled ?? false;
    }

    /** @internal — ensure orchestration exists, update CMS, enqueue prompt. */
    private async _ensureOrchestrationAndSend(sessionId: string, prompt: string, opts?: { bootstrap?: boolean }): Promise<string> {
        if (!this.duroxideClient) throw new Error("Not started.");
        const _trace = this.config.traceWriter ?? (() => {});
        const startedAt = Date.now();
        const trace = (message: string) => _trace(`[+${Date.now() - startedAt}ms] ${message}`);

        const orchestrationId = `session-${sessionId}`;
        const fullConfig = this.sessionConfigs.get(sessionId);

        // Build toolNames: merge explicit toolNames with names extracted from Tool objects.
        const explicitNames: string[] = fullConfig?.toolNames ?? [];
        const objectNames: string[] = (fullConfig?.tools ?? [])
            .map((t: any) => typeof t === "string" ? t : t.name)
            .filter((n: string) => n && n !== "wait" && n !== "ask_user");
        const allNames = [...new Set([...explicitNames, ...objectNames])];

        const serializableConfig: SerializableSessionConfig = {
            model: fullConfig?.model,
            systemMessage: fullConfig?.systemMessage,
            workingDirectory: fullConfig?.workingDirectory,
            waitThreshold: fullConfig?.waitThreshold ?? this.config.waitThreshold,
            boundAgentName: fullConfig?.boundAgentName,
            promptLayering: fullConfig?.promptLayering,
            toolNames: allNames.length ? allNames : undefined,
        };

        trace(`[client] ensureOrchestrationAndSend start session=${sessionId} active=${this.activeOrchestrations.has(sessionId)}`);

        if (!this.activeOrchestrations.has(sessionId)) {
            const parentSessionId = this.parentSessionIds.get(sessionId);
            const nestingLevel = this.nestingLevels.get(sessionId);
            const input: OrchestrationInput = {
                sessionId,
                config: serializableConfig,
                iteration: 0,
                blobEnabled: this._blobEnabled,
                dehydrateThreshold: this.config.dehydrateThreshold ?? 30,
                idleTimeout: parentSessionId ? -1 : (this.config.dehydrateOnIdle ?? 30),
                inputGracePeriod: parentSessionId ? -1 : (this.config.dehydrateOnInputRequired ?? 30),
                checkpointInterval: this.config.checkpointInterval ?? -1,
                rehydrationMessage: this.config.rehydrationMessage,
                ...(parentSessionId ? { parentSessionId } : {}),
                ...(nestingLevel != null ? { nestingLevel } : {}),
                ...(this.systemSessions.has(sessionId) ? { isSystem: true } : {}),
                ...(this.sessionAgentIds.has(sessionId) ? { agentId: this.sessionAgentIds.get(sessionId) } : {}),
                ...(this._sessionPolicy ? { sessionPolicy: this._sessionPolicy } : {}),
                ...(this._allowedAgentNames.length > 0 ? { allowedAgentNames: this._allowedAgentNames } : {}),
            };
            const startAt = Date.now();
            await this.duroxideClient.startOrchestrationVersioned(
                orchestrationId,
                DURABLE_SESSION_ORCHESTRATION_NAME,
                input,
                DURABLE_SESSION_LATEST_VERSION,
            );
            this.activeOrchestrations.set(sessionId, orchestrationId);
            trace(`[client] startOrchestrationVersioned done (${Date.now() - startAt}ms)`);
        }

        // CMS: update state + orchestration ID
        const updateAt = Date.now();
        await this._catalog.updateSession(sessionId, {
            orchestrationId,
            state: "running",
            lastActiveAt: new Date(),
        });
        trace(`[client] updateSession running done (${Date.now() - updateAt}ms)`);

        const enqueueAt = Date.now();
        await this.duroxideClient.enqueueEvent(
            orchestrationId,
            "messages",
            JSON.stringify({ prompt, ...(opts?.bootstrap ? { bootstrap: true } : {}) }),
        );
        trace(`[client] enqueueEvent done (${Date.now() - enqueueAt}ms bootstrap=${opts?.bootstrap === true})`);
        trace("[client] ensureOrchestrationAndSend complete");

        return orchestrationId;
    }

    /** @internal */
    async _startAndWait(
        sessionId: string,
        prompt: string,
        onUserInput: UserInputHandler | undefined,
        timeout?: number,
        onIntermediateContent?: (content: string) => void,
        opts?: { bootstrap?: boolean; signal?: AbortSignal },
    ): Promise<string | undefined> {
        const orchestrationId = await this._ensureOrchestrationAndSend(sessionId, prompt, opts);

        return this._waitForTurnResult(
            orchestrationId,
            sessionId,
            onUserInput,
            timeout ?? 300_000,
            onIntermediateContent,
            opts?.signal,
        );
    }

    /** @internal */
    async _startTurn(sessionId: string, prompt: string, opts?: { bootstrap?: boolean }): Promise<string> {
        return this._ensureOrchestrationAndSend(sessionId, prompt, opts);
    }

    /** @internal */
    _getDuroxideClient() {
        return this.duroxideClient;
    }

    /** @internal */
    _getCatalog(): SessionCatalogProvider {
        return this._catalog;
    }

    /** @internal — exposed for PilotSwarmSession.wait() */
    async _waitForTurnResult_external(
        orchestrationId: string,
        sessionId: string,
        onUserInput: UserInputHandler | undefined,
        timeout: number,
        signal?: AbortSignal,
    ): Promise<string | undefined> {
        return this._waitForTurnResult(orchestrationId, sessionId, onUserInput, timeout, undefined, signal);
    }

    private _createWaitSignal(externalSignal?: AbortSignal): {
        controller: AbortController;
        signal: AbortSignal;
        cleanup: () => void;
    } {
        const controller = new AbortController();
        this.activeWaitControllers.add(controller);

        const onAbort = () => {
            controller.abort(createAbortError("PilotSwarmClient wait aborted", externalSignal?.reason));
        };

        if (externalSignal) {
            if (externalSignal.aborted) {
                onAbort();
            } else {
                externalSignal.addEventListener("abort", onAbort, { once: true });
            }
        }

        return {
            controller,
            signal: controller.signal,
            cleanup: () => {
                if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
                this.activeWaitControllers.delete(controller);
            },
        };
    }

    /** @internal */
    private async _getLatestResponse(orchestrationId: string): Promise<SessionResponsePayload | null> {
        if (!this.duroxideClient) return null;
        try {
            const raw = await this.duroxideClient.getValue(orchestrationId, RESPONSE_LATEST_KEY);
            if (!raw) return null;
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            return parsed ?? null;
        } catch {
            return null;
        }
    }

    /** @internal */
    async _getSessionInfo(sessionId: string): Promise<PilotSwarmSessionInfo> {
        const cmsRow = await this._catalog.getSession(sessionId);

        // Merge with live customStatus for real-time fields
        const orchestrationId = `session-${sessionId}`;
        let customStatus: any = {};
        let orchStatus: any = {};

        if (this.duroxideClient) {
            try {
                orchStatus = await this.duroxideClient.getStatus(orchestrationId);
                if (orchStatus.customStatus) {
                    try {
                        customStatus = typeof orchStatus.customStatus === "string"
                            ? JSON.parse(orchStatus.customStatus) : orchStatus.customStatus;
                    } catch {}
                }
            } catch {}
        }

        const latestResponse = customStatus?.responseVersion
            ? await this._getLatestResponse(orchestrationId)
            : null;

        let status: PilotSwarmSessionStatus = customStatus.status
            ?? (cmsRow?.state as PilotSwarmSessionStatus)
            ?? "pending";
        if (orchStatus.status === "Completed") status = "completed";
        if (orchStatus.status === "Failed") status = "failed";

        return {
            sessionId,
            status,
            model: cmsRow?.model ?? undefined,
            title: cmsRow?.title ?? undefined,
            agentId: cmsRow?.agentId ?? undefined,
            createdAt: cmsRow?.createdAt ?? new Date(),
            updatedAt: cmsRow?.updatedAt ?? new Date(),
            iterations: customStatus.iteration ?? cmsRow?.currentIteration ?? 0,
            pendingQuestion: customStatus.pendingQuestion
                ? { question: customStatus.pendingQuestion, choices: customStatus.choices, allowFreeform: customStatus.allowFreeform }
                : latestResponse?.type === "input_required" && latestResponse.question
                    ? {
                        question: latestResponse.question,
                        choices: latestResponse.choices,
                        allowFreeform: latestResponse.allowFreeform,
                    }
                : undefined,
            waitingUntil: customStatus.waitSeconds
                ? new Date(Date.now() + customStatus.waitSeconds * 1000)
                : undefined,
            waitReason: customStatus.waitReason,
            cronActive: customStatus.cronActive === true,
            cronInterval: typeof customStatus.cronInterval === "number" ? customStatus.cronInterval : undefined,
            cronReason: typeof customStatus.cronReason === "string" ? customStatus.cronReason : undefined,
            contextUsage: customStatus?.contextUsage && typeof customStatus.contextUsage === "object"
                ? customStatus.contextUsage
                : undefined,
            result: customStatus.turnResult?.type === "completed"
                ? customStatus.turnResult.content
                : latestResponse?.type === "completed"
                    ? latestResponse.content
                : (orchStatus.status === "Completed" ? orchStatus.output : undefined),
            error: orchStatus.status === "Failed" ? orchStatus.error : (cmsRow?.lastError ?? undefined),
        };
    }

    /** @internal */
    private async _waitForTurnResult(
        orchestrationId: string,
        sessionId: string,
        onUserInput: UserInputHandler | undefined,
        timeout: number,
        onIntermediateContent?: (content: string) => void,
        externalSignal?: AbortSignal,
    ): Promise<string | undefined> {
        const { signal, cleanup } = this._createWaitSignal(externalSignal);
        const getDuroxideClient = () => {
            const client = this.duroxideClient;
            if (!client) {
                throwIfAborted(signal, `PilotSwarmClient stopped while waiting for response (${orchestrationId})`);
                throw new Error(`PilotSwarmClient stopped while waiting for response (${orchestrationId})`);
            }
            return client;
        };
        const waitPromise = (async () => {
            const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
            let lastSeenVersion = this.lastSeenStatusVersion.get(orchestrationId) ?? 0;
            let lastSeenIteration = this.lastSeenIteration.get(orchestrationId) ?? -1;
            let lastSeenResponseVersion = this.lastSeenResponseVersion.get(orchestrationId) ?? 0;

            while (Date.now() < deadline) {
                throwIfAborted(signal, `PilotSwarmClient wait aborted (${orchestrationId})`);
                const remaining = deadline === Infinity
                    ? WAIT_POLL_SLICE_MS
                    : Math.min(deadline - Date.now(), WAIT_POLL_SLICE_MS);
                if (remaining <= 0) break;

                let statusResult: any;
                try {
                    statusResult = await getDuroxideClient().waitForStatusChange(
                        orchestrationId, lastSeenVersion, 1_000, remaining,
                    );
                } catch {
                    throwIfAborted(signal, `PilotSwarmClient wait aborted (${orchestrationId})`);
                    await new Promise(r => setTimeout(r, 1_000));
                    throwIfAborted(signal, `PilotSwarmClient wait aborted (${orchestrationId})`);
                    const orchStatus = await getDuroxideClient().getStatus(orchestrationId);
                    if (orchStatus.status === "Failed") throw new Error(orchStatus.error ?? "Orchestration failed");
                    if (orchStatus.status === "Completed") return orchStatus.output;
                    const currentVersion = orchStatus.customStatusVersion || 0;
                    if (currentVersion < lastSeenVersion) {
                        lastSeenVersion = 0;
                        lastSeenIteration = -1;
                    }
                    continue;
                }

                throwIfAborted(signal, `PilotSwarmClient wait aborted (${orchestrationId})`);

                if (statusResult.customStatusVersion > lastSeenVersion) {
                    lastSeenVersion = statusResult.customStatusVersion;
                } else if (statusResult.customStatusVersion < lastSeenVersion) {
                    lastSeenVersion = statusResult.customStatusVersion;
                    lastSeenIteration = -1;
                }

                let customStatus: any = null;
                if (statusResult.customStatus) {
                    try {
                        customStatus = typeof statusResult.customStatus === "string"
                            ? JSON.parse(statusResult.customStatus) : statusResult.customStatus;
                    } catch {}
                }

                if (customStatus) {
                    if (customStatus.intermediateContent && onIntermediateContent) {
                        onIntermediateContent(customStatus.intermediateContent);
                    }

                    if (customStatus.turnResult && customStatus.iteration > lastSeenIteration) {
                        lastSeenIteration = customStatus.iteration;
                        const result = customStatus.turnResult;

                        if (result.type === "completed") {
                            if (customStatus.status === "idle") {
                                if (onIntermediateContent) onIntermediateContent(result.content);
                                this.lastSeenStatusVersion.set(orchestrationId, lastSeenVersion);
                                this.lastSeenIteration.set(orchestrationId, lastSeenIteration);
                                return result.content;
                            }
                            if (onIntermediateContent) onIntermediateContent(result.content);
                        }

                        if (result.type === "input_required" && onUserInput) {
                            const response = await onUserInput(
                                {
                                    question: result.question,
                                    choices: result.choices,
                                    allowFreeform: result.allowFreeform,
                                },
                                { sessionId },
                            );
                            throwIfAborted(signal, `PilotSwarmClient wait aborted (${orchestrationId})`);
                            await getDuroxideClient().enqueueEvent(
                                orchestrationId,
                                "messages",
                                JSON.stringify(response),
                            );
                            continue;
                        }
                    }

                    if (customStatus.responseVersion && customStatus.responseVersion > lastSeenResponseVersion) {
                        const response = await this._getLatestResponse(orchestrationId);
                        lastSeenResponseVersion = Math.max(
                            lastSeenResponseVersion,
                            response?.version ?? customStatus.responseVersion,
                        );

                        if (response?.type === "completed" && response.content) {
                            if (customStatus.status === "idle" || customStatus.status === "completed") {
                                if (onIntermediateContent) onIntermediateContent(response.content);
                                this.lastSeenStatusVersion.set(orchestrationId, lastSeenVersion);
                                this.lastSeenIteration.set(orchestrationId, lastSeenIteration);
                                this.lastSeenResponseVersion.set(orchestrationId, lastSeenResponseVersion);
                                return response.content;
                            }
                            if (onIntermediateContent) onIntermediateContent(response.content);
                        }

                        if (response?.type === "wait" && response.content && onIntermediateContent) {
                            onIntermediateContent(response.content);
                        }

                        if (response?.type === "input_required" && response.question && onUserInput) {
                            const responseInput = await onUserInput(
                                {
                                    question: response.question,
                                    choices: response.choices,
                                    allowFreeform: response.allowFreeform,
                                },
                                { sessionId },
                            );
                            throwIfAborted(signal, `PilotSwarmClient wait aborted (${orchestrationId})`);
                            await getDuroxideClient().enqueueEvent(
                                orchestrationId,
                                "messages",
                                JSON.stringify(responseInput),
                            );
                            continue;
                        }
                    }
                }

                const orchStatus = await getDuroxideClient().getStatus(orchestrationId);
                if (orchStatus.status === "Failed") throw new Error(orchStatus.error ?? "Orchestration failed");
                if (orchStatus.status === "Completed") return orchStatus.output;
            }

            throwIfAborted(signal, `PilotSwarmClient wait aborted (${orchestrationId})`);
            this.lastSeenResponseVersion.set(orchestrationId, lastSeenResponseVersion);
            throw new Error(`Timeout waiting for response (${timeout}ms)`);
        })();

        this.activeWaitPromises.add(waitPromise);
        try {
            return await waitPromise;
        } finally {
            this.activeWaitPromises.delete(waitPromise);
            cleanup();
        }
    }
}

/**
 * PilotSwarmSession — session handle.
 * Mirrors CopilotSession API, routes through duroxide orchestration.
 *
 * Event delivery:
 *   on(eventType, handler) — polls CMS session_events table for new events.
 *   on(handler)            — catch-all, receives every event type.
 *   Returns unsubscribe function. Polling starts on first subscription.
 */
export type SessionEventHandler = (event: SessionEvent) => void;

export class PilotSwarmSession {
    readonly sessionId: string;
    private client: PilotSwarmClient;
    private onUserInput?: UserInputHandler;
    lastOrchestrationId?: string;

    // Event subscription state
    private handlers = new Map<string | null, Set<SessionEventHandler>>();
    private lastSeenSeq = 0;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private polling = false;
    private static POLL_INTERVAL = 500; // ms

    /** @internal */
    constructor(sessionId: string, client: PilotSwarmClient, onUserInput?: UserInputHandler) {
        this.sessionId = sessionId;
        this.client = client;
        this.onUserInput = onUserInput;
    }

    async sendAndWait(
        prompt: string,
        timeout?: number,
        onIntermediateContent?: (content: string) => void,
        opts?: { signal?: AbortSignal },
    ): Promise<string | undefined> {
        return this.client._startAndWait(
            this.sessionId,
            prompt,
            this.onUserInput,
            timeout,
            onIntermediateContent,
            opts,
        );
    }

    async send(prompt: string, opts?: { bootstrap?: boolean }): Promise<void> {
        this.lastOrchestrationId = await this.client._startTurn(this.sessionId, prompt, opts);
    }

    async wait(timeout?: number, opts?: { signal?: AbortSignal }): Promise<string | undefined> {
        if (!this.lastOrchestrationId) throw new Error("No pending turn. Call send() first.");
        return this.client._waitForTurnResult_external(
            this.lastOrchestrationId,
            this.sessionId,
            this.onUserInput,
            timeout ?? 300_000,
            opts?.signal,
        );
    }

    /**
     * Subscribe to session events.
     *
     * Overloads:
     *   on(eventType, handler) — typed subscription (e.g. "assistant.message")
     *   on(handler)            — catch-all subscription
     *
     * Returns an unsubscribe function. Polling starts automatically.
     */
    on(eventType: string, handler: SessionEventHandler): () => void;
    on(handler: SessionEventHandler): () => void;
    on(eventTypeOrHandler: string | SessionEventHandler, handler?: SessionEventHandler): () => void {
        let key: string | null;
        let fn: SessionEventHandler;

        if (typeof eventTypeOrHandler === "function") {
            key = null;
            fn = eventTypeOrHandler;
        } else {
            key = eventTypeOrHandler;
            fn = handler!;
        }

        if (!this.handlers.has(key)) {
            this.handlers.set(key, new Set());
        }
        this.handlers.get(key)!.add(fn);

        // Start polling if not already running
        this._startPolling();

        return () => {
            const set = this.handlers.get(key);
            if (set) {
                set.delete(fn);
                if (set.size === 0) this.handlers.delete(key);
            }
            // Stop polling if no handlers left
            if (this.handlers.size === 0) {
                this._stopPolling();
            }
        };
    }

    async sendEvent(eventName: string, data: unknown): Promise<void> {
        const duroxideClient = this.client._getDuroxideClient();
        const orchestrationId = this.lastOrchestrationId ?? `session-${this.sessionId}`;
        if (duroxideClient) {
            await duroxideClient.enqueueEvent(
                orchestrationId,
                "messages",
                JSON.stringify(data),
            );
        }
    }

    async abort(): Promise<void> {
        const duroxideClient = this.client._getDuroxideClient();
        const orchestrationId = this.lastOrchestrationId ?? `session-${this.sessionId}`;
        if (duroxideClient) {
            await duroxideClient.cancelInstance(orchestrationId, "User abort");
        }
    }

    async destroy(): Promise<void> {
        this._stopPolling();
        await this.client.deleteSession(this.sessionId);
    }

    /** Get all persisted events for this session from CMS. */
        async getMessages(limit?: number): Promise<SessionEvent[]> {
        const catalog = this.client._getCatalog();
            return catalog.getSessionEvents(this.sessionId, undefined, limit);
    }

    async getInfo(): Promise<PilotSwarmSessionInfo> {
        return this.client._getSessionInfo(this.sessionId);
    }

    // ─── Private: event polling ──────────────────────────────

    private _startPolling(): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => this._poll(), PilotSwarmSession.POLL_INTERVAL);
        // Fire immediately too
        this._poll();
    }

    private _stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private async _poll(): Promise<void> {
        if (this.polling) return; // prevent overlapping polls
        this.polling = true;
        try {
            const catalog = this.client._getCatalog();
            const events = await catalog.getSessionEvents(
                this.sessionId,
                this.lastSeenSeq,
                200,
            );
            for (const event of events) {
                this.lastSeenSeq = event.seq;
                this._dispatch(event);
            }
        } catch {
            // Swallow — will retry on next poll
        } finally {
            this.polling = false;
        }
    }

    private _dispatch(event: SessionEvent): void {
        // Typed handlers
        const typed = this.handlers.get(event.eventType);
        if (typed) {
            for (const fn of typed) fn(event);
        }
        // Catch-all handlers
        const catchAll = this.handlers.get(null);
        if (catchAll) {
            for (const fn of catchAll) fn(event);
        }
    }
}   
