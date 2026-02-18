import type {
    DurableCopilotClientOptions,
    DurableSessionConfig,
    DurableSessionStatus,
    DurableSessionInfo,
    TurnInput,
    UserInputHandler,
} from "./types.js";
import { SessionManager } from "./session-manager.js";
import { SessionBlobStore } from "./blob-store.js";
import { createRunAgentTurnActivity, createDehydrateActivity, createHydrateActivity } from "./activity.js";
import { durableSessionOrchestration } from "./orchestration.js";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Runtime, Client } = require("duroxide");

const ORCHESTRATION_NAME = "durable-session";
const ACTIVITY_NAME = "runAgentTurn";

/**
 * A durable Copilot client.
 *
 * Mirrors the Copilot SDK's CopilotClient API — createSession, resumeSession,
 * listSessions, deleteSession — but adds durability via duroxide. Sessions
 * survive process restarts, support durable timers, and can run across
 * multiple nodes.
 *
 * @example
 * ```typescript
 * import { DurableCopilotClient, defineTool } from "durable-copilot-sdk";
 *
 * const client = new DurableCopilotClient({
 *     store: "sqlite::memory:",
 *     githubToken: process.env.GITHUB_TOKEN,
 * });
 *
 * await client.start();
 *
 * const session = await client.createSession({
 *     tools: [getWeather],
 *     systemMessage: "You are a helpful assistant.",
 * });
 *
 * const response = await session.sendAndWait("Check the weather in NYC");
 * console.log(response);
 *
 * await client.stop();
 * ```
 */
export class DurableCopilotClient {
    private config: Required<
        Pick<DurableCopilotClientOptions, "waitThreshold" | "maxIterations">
    > &
        DurableCopilotClientOptions;

    private sessionManager: SessionManager | null = null;
    private blobStore: SessionBlobStore | null = null;
    /** True when blobConnectionString is configured — independent of whether blobStore is instantiated. */
    private blobEnabled: boolean;
    private runtime: any = null;
    private duroxideClient: any = null;
    private sessionConfigs = new Map<string, DurableSessionConfig>();
    /** Tracks which sessions have a running orchestration (instance ID). */
    private activeOrchestrations = new Map<string, string>();
    private started = false;

    constructor(options: DurableCopilotClientOptions) {
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
            maxIterations: options.maxIterations ?? 50,
        };
        this.blobEnabled = !!options.blobConnectionString;
    }

    // ─── Session Management (mirrors CopilotClient) ─────────────

    /**
     * Create a new durable session.
     * Mirrors `CopilotClient.createSession()`.
     */
    async createSession(
        config?: DurableSessionConfig
    ): Promise<DurableSession> {
        const sessionId = config?.sessionId ?? crypto.randomUUID();

        // Store config so the activity can access it
        if (config) {
            this.sessionConfigs.set(sessionId, config);
        }

        return new DurableSession(sessionId, this);
    }

    /**
     * Resume an existing durable session.
     * Mirrors `CopilotClient.resumeSession()`.
     */
    async resumeSession(
        sessionId: string,
        config?: DurableSessionConfig
    ): Promise<DurableSession> {
        if (config) {
            this.sessionConfigs.set(sessionId, config);
        }
        return new DurableSession(sessionId, this);
    }

    /**
     * List all durable sessions.
     * Mirrors `CopilotClient.listSessions()`.
     */
    async listSessions(): Promise<DurableSessionInfo[]> {
        // TODO: query duroxide orchestrations
        return [];
    }

    /**
     * Delete a durable session and its state.
     * Mirrors `CopilotClient.deleteSession()`.
     */
    async deleteSession(sessionId: string): Promise<void> {
        this.sessionConfigs.delete(sessionId);
        if (this.sessionManager) {
            await this.sessionManager.destroySession(sessionId);
        }
    }

    // ─── Server Lifecycle ────────────────────────────────────────

    /**
     * Start the duroxide worker runtime.
     * Registers orchestrations and activities, then begins polling for work.
     */
    async start(): Promise<void> {
        if (this.started) return;

        if (!this.config.githubToken) {
            throw new Error(
                "DurableCopilotClient.start() requires githubToken."
            );
        }

        // 1. Create duroxide provider
        const provider = await this._createProvider();

        // 2. Create session manager
        this.sessionManager = new SessionManager(this.config.githubToken);

        // 2a. Create blob store if connection string provided
        if (this.config.blobConnectionString) {
            this.blobStore = new SessionBlobStore(
                this.config.blobConnectionString,
                this.config.blobContainer ?? "copilot-sessions"
            );
        }

        // 3. Create runtime with session affinity support
        this.runtime = new Runtime(provider, {
            dispatcherPollIntervalMs: 10,
            logLevel: this.config.logLevel ?? "error",
            maxSessionsPerRuntime: this.config.maxSessionsPerRuntime ?? 50,
            sessionIdleTimeoutMs: this.config.sessionIdleTimeoutMs ?? 300_000,
            workerNodeId: this.config.workerNodeId,
        });

        // 4. Create client for starting orchestrations
        this.duroxideClient = new Client(provider);

        // 5. Register activity (closes over sessionManager, sessionConfigs, blobStore)
        const activityFn = createRunAgentTurnActivity(
            this.sessionManager,
            this.sessionConfigs,
            this.blobStore,
            this.config.checkpointFrequencyMs ?? 60_000,
        );
        this.runtime.registerActivity(ACTIVITY_NAME, activityFn);

        // 5a. Register dehydrate/hydrate activities if blob store is configured
        if (this.blobStore) {
            this.runtime.registerActivity(
                "dehydrateSession",
                createDehydrateActivity(this.sessionManager, this.blobStore)
            );
            this.runtime.registerActivity(
                "hydrateSession",
                createHydrateActivity(this.blobStore)
            );
        }

        // 6. Register orchestration
        this.runtime.registerOrchestration(
            ORCHESTRATION_NAME,
            durableSessionOrchestration
        );

        // 7. Start runtime in background (non-blocking)
        const runtimePromise = this.runtime.start();
        this.started = true;

        // Don't await — runtime.start() blocks until shutdown
        runtimePromise.catch((err: any) => {
            console.error("[DurableCopilotClient] Runtime error:", err);
        });

        // 8. Register SIGTERM handler for graceful shutdown (K8s pod termination)
        const gracefulShutdown = async () => {
            await this._gracefulShutdown();
            process.exit(0);
        };
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);

        // Give the runtime a moment to initialize
        await new Promise((r) => setTimeout(r, 200));
    }

    /**
     * Start in client-only mode (no runtime worker).
     *
     * Creates a duroxide Client for enqueuing orchestrations and reading
     * results, but does NOT start a Runtime. Use this when runtime workers
     * run elsewhere (e.g., AKS pods) and this process only needs to submit
     * work and poll for results.
     *
     * Does not require githubToken — workers hold the token.
     */
    async startClientOnly(): Promise<void> {
        if (this.started) return;

        const provider = await this._createProvider();
        this.duroxideClient = new Client(provider);
        this.started = true;
    }

    /**
     * Gracefully shut down the worker runtime.
     * Mirrors `CopilotClient.stop()`.
     */
    async stop(): Promise<void> {
        if (this.runtime) {
            await this.runtime.shutdown(5000);
            this.runtime = null;
        }
        if (this.sessionManager) {
            await this.sessionManager.shutdown();
            this.sessionManager = null;
        }
        this.blobStore = null;
        this.started = false;
    }

    /**
     * Graceful shutdown: dehydrate all active sessions to blob, then stop.
     * Called on SIGTERM/SIGINT for zero-loss pod termination.
     * @internal
     */
    private async _gracefulShutdown(): Promise<void> {
        if (this.blobStore && this.sessionManager) {
            const activeIds = this.sessionManager.activeSessionIds();
            if (activeIds.length > 0) {
                console.error(
                    `[DurableCopilotClient] Dehydrating ${activeIds.length} active sessions before shutdown...`
                );
                await Promise.allSettled(
                    activeIds.map(async (id) => {
                        try {
                            await this.sessionManager!.destroySession(id);
                            await this.blobStore!.dehydrate(id, { reason: "shutdown" });
                        } catch (err: any) {
                            console.error(
                                `[DurableCopilotClient] Failed to dehydrate session ${id}: ${err.message}`
                            );
                        }
                    })
                );
            }
        }
        await this.stop();
    }

    /** @internal — send message and wait for response */
    async _startAndWait(
        sessionId: string,
        prompt: string,
        timeout?: number,
        onIntermediateContent?: (content: string) => void
    ): Promise<string | undefined> {
        if (!this.duroxideClient) {
            throw new Error("Client not started. Call start() first.");
        }

        const orchestrationId = `session-${sessionId}`;
        const config = this.sessionConfigs.get(sessionId);
        const effectiveTimeout = timeout ?? 300_000;

        if (!this.activeOrchestrations.has(sessionId)) {
            // First message — start the long-lived orchestration
            const input: TurnInput & Record<string, unknown> = {
                sessionId,
                prompt,
                waitThreshold: this.config.waitThreshold,
                maxIterations: this.config.maxIterations,
                iteration: 0,
                systemMessage: typeof config?.systemMessage === "string"
                    ? config.systemMessage
                    : config?.systemMessage?.content,
                model: config?.model,
                blobEnabled: this.blobEnabled,
                dehydrateThreshold: this.config.dehydrateThreshold ?? 30,
                idleTimeout: this.config.dehydrateOnIdle ?? 30,
                inputGracePeriod: this.config.dehydrateOnInputRequired ?? 30,
            };

            await this.duroxideClient.startOrchestration(
                orchestrationId,
                ORCHESTRATION_NAME,
                input
            );
            this.activeOrchestrations.set(sessionId, orchestrationId);
        } else {
            // Subsequent message — raise event on existing orchestration
            await this.duroxideClient.raiseEvent(
                orchestrationId,
                "next-message",
                { prompt }
            );
        }

        // Poll for the response by watching for new ActivityCompleted events
        return this._pollForTurnResponse(
            orchestrationId,
            sessionId,
            config?.onUserInputRequest,
            effectiveTimeout,
            onIntermediateContent
        );
    }

    /**
     * Poll orchestration history for the latest runAgentTurn response.
     * Handles input_required events via user callback + raiseEvent.
     * @internal
     */
    private async _pollForTurnResponse(
        orchestrationId: string,
        sessionId: string,
        onUserInputRequest: UserInputHandler | undefined,
        timeout: number,
        onIntermediateContent?: (content: string) => void
    ): Promise<string | undefined> {
        const deadline = Date.now() + timeout;
        let lastSeenActivityCount = 0;
        let lastSeenExecId: string | null = null;
        let waitingForInputResponse = false;

        // Count existing completed activities before this turn
        try {
            const execs = await this.duroxideClient.listExecutions(orchestrationId);
            if (execs.length > 0) {
                lastSeenExecId = execs[execs.length - 1];
                const history = await this.duroxideClient.readExecutionHistory(
                    orchestrationId, lastSeenExecId
                );
                lastSeenActivityCount = history.filter(
                    (e: any) => e.kind === "ActivityCompleted"
                ).length;
            }
        } catch {}

        while (Date.now() < deadline) {
            const status = await this.duroxideClient.getStatus(orchestrationId);

            if (status.status === "Failed") {
                throw new Error(status.error ?? "Orchestration failed");
            }

            // Get latest execution history
            const execs = await this.duroxideClient.listExecutions(orchestrationId);
            if (execs.length === 0) {
                await new Promise((r) => setTimeout(r, 200));
                continue;
            }
            const execId = execs[execs.length - 1];

            // Reset counters when execution changes (continueAsNew)
            if (lastSeenExecId !== null && execId !== lastSeenExecId) {
                lastSeenActivityCount = 0;
                waitingForInputResponse = false;
            }
            lastSeenExecId = execId;

            const history = await this.duroxideClient.readExecutionHistory(
                orchestrationId, execId
            );

            // Find new ActivityCompleted events
            const activityEvents = history.filter(
                (e: any) => e.kind === "ActivityCompleted"
            );

            for (let i = lastSeenActivityCount; i < activityEvents.length; i++) {
                const event = activityEvents[i];
                try {
                    const data = JSON.parse(event.data);
                    const result = typeof data.result === "string"
                        ? JSON.parse(data.result) : data;

                    if (result.type === "completed") {
                        lastSeenActivityCount = activityEvents.length;
                        return result.content;
                    }

                    if (result.type === "input_required" && onUserInputRequest && !waitingForInputResponse) {
                        const response = await onUserInputRequest(
                            { question: result.question, choices: result.choices, allowFreeform: result.allowFreeform },
                            { sessionId }
                        );
                        await this.duroxideClient.raiseEvent(
                            orchestrationId, "user-input", response
                        );
                        waitingForInputResponse = true;
                        lastSeenActivityCount = activityEvents.length;
                    }

                    if (result.type === "wait" && result.content) {
                        // Intermediate content from a wait cycle — emit and keep polling
                        if (onIntermediateContent) onIntermediateContent(result.content);
                        lastSeenActivityCount = activityEvents.length;
                    }
                } catch {}
            }

            if (activityEvents.length > lastSeenActivityCount) {
                lastSeenActivityCount = activityEvents.length;
            }

            // Reset input response flag if we moved to a new execution (continueAsNew)
            if (waitingForInputResponse) {
                const inputReq = DurableCopilotClient._findInputRequired(history);
                if (!inputReq) waitingForInputResponse = false;
            }

            await new Promise((r) => setTimeout(r, 200));
        }

        throw new Error(`Timeout waiting for response (${timeout}ms)`);
    }

    /** Parse ActivityCompleted events to find input_required results. @internal */
    private static _findInputRequired(
        history: any[]
    ): { question: string; choices?: string[]; allowFreeform?: boolean } | null {
        for (let i = history.length - 1; i >= 0; i--) {
            const event = history[i];
            if (event.kind === "ActivityCompleted" && event.data) {
                try {
                    const data = JSON.parse(event.data);
                    // data is either the result directly or wrapped in { result: "..." }
                    const result =
                        typeof data.result === "string"
                            ? JSON.parse(data.result)
                            : data;
                    if (result.type === "input_required") {
                        return {
                            question: result.question,
                            choices: result.choices,
                            allowFreeform: result.allowFreeform,
                        };
                    }
                } catch {
                    // Not valid JSON, skip
                }
            }
        }
        return null;
    }

    /** @internal — send message without waiting (for scaled mode polling) */
    async _startTurn(
        sessionId: string,
        prompt: string
    ): Promise<string> {
        if (!this.duroxideClient) {
            throw new Error("Client not started. Call start() first.");
        }

        const orchestrationId = `session-${sessionId}`;
        const config = this.sessionConfigs.get(sessionId);

        if (!this.activeOrchestrations.has(sessionId)) {
            // First message — start the long-lived orchestration
            const input: TurnInput & Record<string, unknown> = {
                sessionId,
                prompt,
                waitThreshold: this.config.waitThreshold,
                maxIterations: this.config.maxIterations,
                iteration: 0,
                systemMessage: typeof config?.systemMessage === "string"
                    ? config.systemMessage
                    : config?.systemMessage?.content,
                model: config?.model,
                blobEnabled: this.blobEnabled,
                dehydrateThreshold: this.config.dehydrateThreshold ?? 30,
                idleTimeout: this.config.dehydrateOnIdle ?? 30,
                inputGracePeriod: this.config.dehydrateOnInputRequired ?? 30,
            };

            await this.duroxideClient.startOrchestration(
                orchestrationId,
                ORCHESTRATION_NAME,
                input
            );
            this.activeOrchestrations.set(sessionId, orchestrationId);
        } else {
            // Subsequent message — raise event on existing orchestration
            await this.duroxideClient.raiseEvent(
                orchestrationId,
                "next-message",
                { prompt }
            );
        }

        return orchestrationId;
    }

    /** @internal — get the duroxide client for status queries */
    _getDuroxideClient() {
        return this.duroxideClient;
    }

    private async _createProvider(): Promise<any> {
        const store = this.config.store;
        if (store === "sqlite::memory:") {
            return SqliteProvider.inMemory();
        } else if (store.startsWith("sqlite://")) {
            return SqliteProvider.open(store);
        } else if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            return PostgresProvider.connect(store);
        }
        throw new Error(`Unsupported store URL: ${store}`);
    }
}

/**
 * A durable session handle.
 *
 * Mirrors the Copilot SDK's CopilotSession API — send, sendAndWait,
 * abort, destroy, getMessages — but operations are routed through
 * duroxide orchestrations for durability.
 */
export class DurableSession {
    readonly sessionId: string;
    private client: DurableCopilotClient;
    /** The orchestration ID of the most recent `send()` call. */
    lastOrchestrationId?: string;

    /** @internal */
    constructor(sessionId: string, client: DurableCopilotClient) {
        this.sessionId = sessionId;
        this.client = client;
    }

    /**
     * Send a message and wait for the agent to respond.
     * Mirrors `CopilotSession.sendAndWait()`.
     * @param onIntermediateContent — callback for intermediate content (e.g., partial results from long-running tasks)
     */
    async sendAndWait(
        prompt: string,
        timeout?: number,
        onIntermediateContent?: (content: string) => void
    ): Promise<string | undefined> {
        return this.client._startAndWait(this.sessionId, prompt, timeout, onIntermediateContent);
    }

    /**
     * Send a message without waiting for a response.
     * Mirrors `CopilotSession.send()`.
     */
    async send(prompt: string): Promise<void> {
        this.lastOrchestrationId = await this.client._startTurn(
            this.sessionId,
            prompt
        );
    }

    /**
     * Wait for the session to reach a terminal state.
     */
    async wait(timeout?: number): Promise<string | undefined> {
        if (!this.lastOrchestrationId) {
            throw new Error("No pending turn. Call send() first.");
        }

        const duroxideClient = this.client._getDuroxideClient();
        const effectiveTimeout = timeout ?? 300_000;
        const result = await duroxideClient.waitForOrchestration(
            this.lastOrchestrationId,
            effectiveTimeout
        );

        if (result.status === "Completed") {
            return result.output;
        } else if (result.status === "Failed") {
            throw new Error(result.error ?? "Orchestration failed");
        }

        return undefined;
    }

    /**
     * Send an event to the session (e.g., user input response).
     */
    async sendEvent(eventName: string, data: unknown): Promise<void> {
        const duroxideClient = this.client._getDuroxideClient();
        if (duroxideClient && this.lastOrchestrationId) {
            await duroxideClient.raiseEvent(
                this.lastOrchestrationId,
                eventName,
                data
            );
        }
    }

    /**
     * Abort the current in-flight operation.
     * Mirrors `CopilotSession.abort()`.
     */
    async abort(): Promise<void> {
        // TODO: raise abort event to orchestration
    }

    /**
     * Destroy the session and release resources.
     * Mirrors `CopilotSession.destroy()`.
     */
    async destroy(): Promise<void> {
        await this.client.deleteSession(this.sessionId);
    }

    /**
     * Get the conversation messages for this session.
     * Mirrors `CopilotSession.getMessages()`.
     */
    async getMessages(): Promise<unknown[]> {
        // TODO: read from Copilot session files
        return [];
    }

    /**
     * Get detailed info about this durable session.
     */
    async getInfo(): Promise<DurableSessionInfo> {
        // TODO: query duroxide orchestration state
        return {
            sessionId: this.sessionId,
            status: "pending",
            createdAt: new Date(),
            updatedAt: new Date(),
            iterations: 0,
        };
    }

    /**
     * Schedule a recurring invocation of this session.
     */
    async schedule(
        schedule: { cron: string } | { every: number }
    ): Promise<void> {
        // TODO: create duroxide orchestration with timer loop
    }
}
