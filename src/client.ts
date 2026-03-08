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
} from "./types.js";
import type { SessionCatalogProvider, SessionEvent } from "./cms.js";
import { PgSessionCatalogProvider } from "./cms.js";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Client } = require("duroxide");

const ORCHESTRATION_NAME = "durable-session-v2";
const ORCHESTRATION_VERSION = "1.0.6";
const DEFAULT_DUROXIDE_SCHEMA = "duroxide";

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
    private started = false;

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
    }): Promise<PilotSwarmSession> {
        const sessionId = config?.sessionId ?? crypto.randomUUID();
        if (config) {
            const fullConfig: ManagedSessionConfig = {
                model: config.model,
                systemMessage: config.systemMessage,
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

        return new PilotSwarmSession(sessionId, this, config?.onUserInputRequest);
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
        this.activeOrchestrations.set(sessionId, `session-${sessionId}`);
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

        // Create duroxide client
        let provider: any;
        if (store === "sqlite::memory:") provider = SqliteProvider.inMemory();
        else if (store.startsWith("sqlite://")) provider = SqliteProvider.open(store);
        else if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            provider = await PostgresProvider.connectWithSchema(store, this.config.duroxideSchema ?? DEFAULT_DUROXIDE_SCHEMA);
        } else {
            throw new Error(`Unsupported store URL: ${store}`);
        }
        this.duroxideClient = new Client(provider);

        // Create CMS catalog
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            this._catalog = await PgSessionCatalogProvider.create(store, this.config.cmsSchema);
            await this._catalog.initialize();
        }

        this.started = true;
    }

    async stop(): Promise<void> {
        this.duroxideClient = null;
        this.started = false;
    }

    // ─── Internal ────────────────────────────────────────────

    private get _blobEnabled(): boolean {
        return this.config.blobEnabled ?? false;
    }

    /** @internal — ensure orchestration exists, update CMS, enqueue prompt. */
    private async _ensureOrchestrationAndSend(sessionId: string, prompt: string): Promise<string> {
        if (!this.duroxideClient) throw new Error("Not started.");

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
            toolNames: allNames.length ? allNames : undefined,
        };

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
            };
            await this.duroxideClient.startOrchestrationVersioned(
                orchestrationId,
                ORCHESTRATION_NAME,
                input,
                ORCHESTRATION_VERSION,
            );
            this.activeOrchestrations.set(sessionId, orchestrationId);
        }

        // CMS: update state + orchestration ID
        await this._catalog.updateSession(sessionId, {
            orchestrationId,
            state: "running",
            lastActiveAt: new Date(),
        });

        await this.duroxideClient.enqueueEvent(
            orchestrationId,
            "messages",
            JSON.stringify({ prompt }),
        );

        return orchestrationId;
    }

    /** @internal */
    async _startAndWait(
        sessionId: string,
        prompt: string,
        onUserInput: UserInputHandler | undefined,
        timeout?: number,
        onIntermediateContent?: (content: string) => void,
    ): Promise<string | undefined> {
        const orchestrationId = await this._ensureOrchestrationAndSend(sessionId, prompt);

        return this._waitForTurnResult(
            orchestrationId,
            sessionId,
            onUserInput,
            timeout ?? 300_000,
            onIntermediateContent,
        );
    }

    /** @internal */
    async _startTurn(sessionId: string, prompt: string): Promise<string> {
        return this._ensureOrchestrationAndSend(sessionId, prompt);
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
    ): Promise<string | undefined> {
        return this._waitForTurnResult(orchestrationId, sessionId, onUserInput, timeout);
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
            createdAt: cmsRow?.createdAt ?? new Date(),
            updatedAt: cmsRow?.updatedAt ?? new Date(),
            iterations: customStatus.iteration ?? cmsRow?.currentIteration ?? 0,
            pendingQuestion: customStatus.pendingQuestion
                ? { question: customStatus.pendingQuestion, choices: customStatus.choices, allowFreeform: customStatus.allowFreeform }
                : undefined,
            waitingUntil: customStatus.waitSeconds
                ? new Date(Date.now() + customStatus.waitSeconds * 1000)
                : undefined,
            waitReason: customStatus.waitReason,
            result: orchStatus.status === "Completed"
                ? orchStatus.output
                : (customStatus.turnResult?.type === "completed" ? customStatus.turnResult.content : undefined),
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
    ): Promise<string | undefined> {
        const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
        let lastSeenVersion = this.lastSeenStatusVersion.get(orchestrationId) ?? 0;
        let lastSeenIteration = this.lastSeenIteration.get(orchestrationId) ?? -1;

        while (Date.now() < deadline) {
            const remaining = deadline === Infinity ? 30_000 : Math.min(deadline - Date.now(), 30_000);
            if (remaining <= 0) break;

            let statusResult: any;
            try {
                statusResult = await this.duroxideClient.waitForStatusChange(
                    orchestrationId, lastSeenVersion, 200, remaining,
                );
            } catch {
                await new Promise(r => setTimeout(r, 200));
                const orchStatus = await this.duroxideClient.getStatus(orchestrationId);
                if (orchStatus.status === "Failed") throw new Error(orchStatus.error ?? "Orchestration failed");
                if (orchStatus.status === "Completed") return orchStatus.output;
                const currentVersion = orchStatus.customStatusVersion || 0;
                if (currentVersion < lastSeenVersion) {
                    lastSeenVersion = 0;
                    lastSeenIteration = -1;
                }
                continue;
            }

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
                        } else {
                            if (onIntermediateContent) onIntermediateContent(result.content);
                        }
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
                        await this.duroxideClient.enqueueEvent(
                            orchestrationId,
                            "messages",
                            JSON.stringify(response),
                        );
                        continue;
                    }
                }
            }

            const orchStatus = await this.duroxideClient.getStatus(orchestrationId);
            if (orchStatus.status === "Failed") throw new Error(orchStatus.error ?? "Orchestration failed");
            if (orchStatus.status === "Completed") return orchStatus.output;
        }

        throw new Error(`Timeout waiting for response (${timeout}ms)`);
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
    ): Promise<string | undefined> {
        return this.client._startAndWait(
            this.sessionId,
            prompt,
            this.onUserInput,
            timeout,
            onIntermediateContent,
        );
    }

    async send(prompt: string): Promise<void> {
        this.lastOrchestrationId = await this.client._startTurn(this.sessionId, prompt);
    }

    async wait(timeout?: number): Promise<string | undefined> {
        if (!this.lastOrchestrationId) throw new Error("No pending turn. Call send() first.");
        return this.client._waitForTurnResult_external(
            this.lastOrchestrationId,
            this.sessionId,
            this.onUserInput,
            timeout ?? 300_000,
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
