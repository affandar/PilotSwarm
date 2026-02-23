import type {
    DurableCopilotClientOptions,
    ManagedSessionConfig,
    SerializableSessionConfig,
    DurableSessionStatus,
    DurableSessionInfo,
    OrchestrationInput,
    UserInputHandler,
    CommandMessage,
    CommandResponse,
} from "./types.js";
import type { SessionCatalogProvider } from "./cms.js";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Client } = require("duroxide");

const ORCHESTRATION_NAME = "durable-session-v2";

/**
 * DurableCopilotClient (v2) — pure client-side session handle.
 *
 * Talks to duroxide only through the Client API (startOrchestration,
 * enqueueEvent, waitForStatusChange, getStatus). Does NOT own
 * SessionManager, Runtime, or CopilotSession.
 *
 * For single-process usage, pass the worker's `provider` so both share
 * the same database connection (required for sqlite::memory:).
 */
export class DurableCopilotClient {
    private config: DurableCopilotClientOptions & { waitThreshold: number };
    private _provider: any;
    private _catalog: SessionCatalogProvider;
    private duroxideClient: any = null;
    private sessionConfigs = new Map<string, ManagedSessionConfig>();
    private activeOrchestrations = new Map<string, string>();
    private lastSeenStatusVersion = new Map<string, number>();
    private lastSeenIteration = new Map<string, number>();
    private started = false;

    constructor(options: DurableCopilotClientOptions) {
        if (!options.catalog) throw new Error("SessionCatalogProvider is required. Pass catalog option.");
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
        };
        this._provider = options.provider ?? null;
        this._catalog = options.catalog;
    }

    // ─── Session Management ──────────────────────────────────

    async createSession(config?: ManagedSessionConfig & {
        sessionId?: string;
        onUserInputRequest?: UserInputHandler;
    }): Promise<DurableSession> {
        const sessionId = config?.sessionId ?? crypto.randomUUID();
        if (config) {
            const fullConfig: ManagedSessionConfig = {
                model: config.model,
                systemMessage: config.systemMessage,
                tools: config.tools,
                workingDirectory: config.workingDirectory,
                hooks: config.hooks,
                waitThreshold: config.waitThreshold ?? this.config.waitThreshold,
            };
            this.sessionConfigs.set(sessionId, fullConfig);
        }

        // CMS: write session record (state=pending, no orchestration yet)
        await this._catalog.createSession(sessionId, { model: config?.model });

        return new DurableSession(sessionId, this, config?.onUserInputRequest);
    }

    async resumeSession(sessionId: string, config?: ManagedSessionConfig & {
        onUserInputRequest?: UserInputHandler;
    }): Promise<DurableSession> {
        if (config) {
            this.sessionConfigs.set(sessionId, config);
        }
        return new DurableSession(sessionId, this, config?.onUserInputRequest);
    }

    async listSessions(): Promise<DurableSessionInfo[]> {
        const rows = await this._catalog.listSessions();
        return rows.map(row => ({
            sessionId: row.sessionId,
            status: (row.state as DurableSessionStatus) ?? "pending",
            title: row.title ?? undefined,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            iterations: row.currentIteration,
            error: row.lastError ?? undefined,
        }));
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.sessionConfigs.delete(sessionId);

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
        if (!this._provider) {
            this._provider = await this._createProvider();
        }
        this.duroxideClient = new Client(this._provider);
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
        const serializableConfig: SerializableSessionConfig = {
            model: fullConfig?.model,
            systemMessage: fullConfig?.systemMessage,
            workingDirectory: fullConfig?.workingDirectory,
            waitThreshold: fullConfig?.waitThreshold ?? this.config.waitThreshold,
        };

        if (!this.activeOrchestrations.has(sessionId)) {
            const input: OrchestrationInput = {
                sessionId,
                config: serializableConfig,
                iteration: 0,
                blobEnabled: this._blobEnabled,
                dehydrateThreshold: this.config.dehydrateThreshold ?? 30,
                idleTimeout: this.config.dehydrateOnIdle ?? 30,
                inputGracePeriod: this.config.dehydrateOnInputRequired ?? 30,
            };
            await this.duroxideClient.startOrchestration(
                orchestrationId,
                ORCHESTRATION_NAME,
                input,
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

    /** @internal — exposed for DurableSession.wait() */
    async _waitForTurnResult_external(
        orchestrationId: string,
        sessionId: string,
        onUserInput: UserInputHandler | undefined,
        timeout: number,
    ): Promise<string | undefined> {
        return this._waitForTurnResult(orchestrationId, sessionId, onUserInput, timeout);
    }

    /** @internal */
    async _getSessionInfo(sessionId: string): Promise<DurableSessionInfo> {
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

        let status: DurableSessionStatus = customStatus.status
            ?? (cmsRow?.state as DurableSessionStatus)
            ?? "pending";
        if (orchStatus.status === "Completed") status = "completed";
        if (orchStatus.status === "Failed") status = "failed";

        return {
            sessionId,
            status,
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
            result: orchStatus.status === "Completed" ? orchStatus.output : undefined,
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

    private async _createProvider(): Promise<any> {
        const store = this.config.store;
        if (store === "sqlite::memory:") return SqliteProvider.inMemory();
        if (store.startsWith("sqlite://")) return SqliteProvider.open(store);
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            return PostgresProvider.connect(store);
        }
        throw new Error(`Unsupported store URL: ${store}`);
    }
}

/**
 * DurableSession (v2) — session handle.
 * Mirrors CopilotSession API, routes through duroxide orchestration.
 */
export class DurableSession {
    readonly sessionId: string;
    private client: DurableCopilotClient;
    private onUserInput?: UserInputHandler;
    lastOrchestrationId?: string;

    /** @internal */
    constructor(sessionId: string, client: DurableCopilotClient, onUserInput?: UserInputHandler) {
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
        // v2 orchestrations are long-lived — use status polling, not waitForOrchestration
        return this.client._waitForTurnResult_external(
            this.lastOrchestrationId,
            this.sessionId,
            this.onUserInput,
            timeout ?? 300_000,
        );
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
        await this.client.deleteSession(this.sessionId);
    }

    async getMessages(): Promise<unknown[]> {
        return [];
    }

    async getInfo(): Promise<DurableSessionInfo> {
        return this.client._getSessionInfo(this.sessionId);
    }
}
