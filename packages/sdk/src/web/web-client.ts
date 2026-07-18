import type { ApiClient } from "pilotswarm-sdk/api";
import type { SessionEvent } from "../cms.js";
import type {
    PilotSwarmSessionInfo,
    SessionResponsePayload,
    UserInputHandler,
} from "../types.js";
import {
    PilotSwarmWebOptions,
    createApiClientFromOptions,
    webModeUnsupported,
} from "./api-connection.js";

const WAIT_SLICE_MS = 10_000;
const EVENT_POLL_LIMIT = 200;

export type WebSessionEventHandler = (event: SessionEvent) => void;

function createAbortError(message: string, reason?: unknown): Error {
    if (reason instanceof Error) return reason;
    const error = new Error(typeof reason === "string" && reason ? reason : message);
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) throw createAbortError(message, signal.reason);
}

/**
 * PilotSwarmClient in web mode: the same session-handle programming model as
 * the direct client, implemented entirely over the Web API. Constructed via
 * `new PilotSwarmClient({ apiUrl, … })`.
 */
export class WebPilotSwarmClient {
    /** @internal */
    readonly _api: ApiClient;
    private started = false;

    constructor(options: PilotSwarmWebOptions) {
        this._api = createApiClientFromOptions(options);
    }

    async start(): Promise<void> {
        if (this.started) return;
        // Reset the WS lifecycle (a prior stop() latched it closed) and fail
        // fast on unreachable/misconfigured hosts.
        await this._api.start();
        await this._api.health();
        this.started = true;
    }

    async stop(): Promise<void> {
        this.started = false;
        await this._api.stop();
    }

    async createSession(config?: {
        model?: string;
        reasoningEffort?: string;
        contextTier?: string;
        groupId?: string | null;
        onUserInputRequest?: UserInputHandler;
    } & Record<string, unknown>): Promise<WebPilotSwarmSession> {
        for (const key of ["sessionId", "parentSessionId", "agentId", "toolNames", "nestingLevel"]) {
            if (config && (config as any)[key] !== undefined) {
                throw webModeUnsupported(`createSession({ ${key} })`, "agent-bound sessions use createSessionForAgent; worker-side options are direct-mode only");
            }
        }
        const view = await this._api.call("createSession", {
            model: config?.model,
            reasoningEffort: config?.reasoningEffort,
            contextTier: config?.contextTier,
            groupId: config?.groupId,
            capabilities: (config as any)?.capabilities ?? undefined,
        });
        return new WebPilotSwarmSession(view.sessionId, this._api, config?.onUserInputRequest);
    }

    async createSessionForAgent(agentName: string, opts?: {
        model?: string;
        reasoningEffort?: string;
        contextTier?: string;
        title?: string;
        splash?: string;
        splashMobile?: string;
        initialPrompt?: string;
        groupId?: string | null;
        onUserInputRequest?: UserInputHandler;
    }): Promise<WebPilotSwarmSession> {
        const view = await this._api.call("createSessionForAgent", {
            agentName,
            model: opts?.model,
            reasoningEffort: opts?.reasoningEffort,
            contextTier: opts?.contextTier,
            title: opts?.title,
            splash: opts?.splash,
            splashMobile: opts?.splashMobile,
            initialPrompt: opts?.initialPrompt,
            groupId: opts?.groupId,
            capabilities: (opts as any)?.capabilities ?? undefined,
        });
        return new WebPilotSwarmSession(view.sessionId, this._api, opts?.onUserInputRequest);
    }

    async resumeSession(sessionId: string, config?: { onUserInputRequest?: UserInputHandler }): Promise<WebPilotSwarmSession> {
        const view = await this._api.call("getSession", { sessionId });
        if (!view) throw new Error(`Session not found: ${sessionId}`);
        return new WebPilotSwarmSession(sessionId, this._api, config?.onUserInputRequest);
    }

    async listSessions(): Promise<unknown[]> {
        return this._api.call("listSessions");
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this._api.call("deleteSession", { sessionId });
    }

    async cancelPendingMessage(sessionId: string, clientMessageIds: string[]): Promise<void> {
        await this._api.call("cancelPendingMessage", { sessionId, clientMessageIds });
    }

    createSystemSession(): never {
        throw webModeUnsupported("createSystemSession", "system sessions are managed by the deployment");
    }
}

/**
 * Session handle over the Web API. Mirrors `PilotSwarmSession`:
 * `send`/`wait`/`sendAndWait`, event subscription (`on`), and lifecycle.
 *
 * Turn results are observed through the same status/latest-response
 * signals the direct client reads from the orchestration runtime — served
 * here by `GET …/status/wait` (long poll) and `GET …/latest-response`.
 */
export class WebPilotSwarmSession {
    readonly sessionId: string;
    private api: ApiClient;
    private onUserInput?: UserInputHandler;
    private pendingTurn = false;

    private lastSeenVersion = 0;
    private lastSeenIteration = -1;
    private lastSeenResponseVersion = 0;
    private seeded = false;

    // Event subscription state: catch-up fetch (with live events buffered
    // until it completes to avoid a race), then WebSocket push. On every
    // reconnect the catch-up re-runs so events missed during the outage are
    // replayed — the correctness mechanism behind WS acceleration.
    private handlers = new Map<string | null, Set<WebSessionEventHandler>>();
    private lastSeenSeq = 0;
    private wsUnsubscribe: (() => void) | null = null;
    private catchingUp = false;
    private liveBuffer: SessionEvent[] = [];

    /** @internal */
    constructor(sessionId: string, api: ApiClient, onUserInput?: UserInputHandler) {
        this.sessionId = sessionId;
        this.api = api;
        this.onUserInput = onUserInput;
    }

    async send(prompt: string, opts?: { clientMessageIds?: string[] }): Promise<void> {
        // Seed the turn-tracking cursors from the current live status before
        // the first turn from this handle, so wait() accepts only results
        // produced by our own prompt — not a previous turn's (on a resumed
        // session) or a server-side bootstrap turn (createSessionForAgent
        // with initialPrompt). Mirrors resumeSession() in the direct client.
        await this._seedTurnCursors();
        await this.api.call("sendMessage", {
            sessionId: this.sessionId,
            prompt,
            options: opts?.clientMessageIds ? { clientMessageIds: opts.clientMessageIds } : {},
        });
        this.pendingTurn = true;
    }

    private async _seedTurnCursors(force = false): Promise<void> {
        if (this.seeded && !force) return;
        this.seeded = true;
        try {
            const status: any = await this.api.call("getSessionStatus", { sessionId: this.sessionId });
            const version = Number(status?.customStatusVersion) || 0;
            if (force) this.lastSeenVersion = version;
            else if (version > this.lastSeenVersion) this.lastSeenVersion = version;
            const customStatus = status?.customStatus && typeof status.customStatus === "object" ? status.customStatus : null;
            if (customStatus) {
                if (typeof customStatus.iteration === "number") this.lastSeenIteration = customStatus.iteration;
                else if (force) this.lastSeenIteration = -1;
                const responseVersion = Number(customStatus.responseVersion) || 0;
                if (force) this.lastSeenResponseVersion = responseVersion;
                else if (responseVersion > this.lastSeenResponseVersion) this.lastSeenResponseVersion = responseVersion;
            } else if (force) {
                this.lastSeenIteration = -1;
                this.lastSeenResponseVersion = 0;
            }
        } catch {
            // Best-effort, like the direct client: a fresh session has no
            // status yet, and a failure here just means we start from zero.
        }
    }

    async sendAndWait(
        prompt: string,
        timeout?: number,
        onIntermediateContent?: (content: string) => void,
        opts?: { signal?: AbortSignal },
    ): Promise<string | undefined> {
        // Reusing a handle after fire-and-forget sends must not let an older
        // completed response satisfy this new wait.
        await this._seedTurnCursors(true);
        await this.send(prompt);
        return this._waitForTurnResult(timeout ?? 300_000, onIntermediateContent, opts?.signal);
    }

    async wait(timeout?: number, opts?: { signal?: AbortSignal }): Promise<string | undefined> {
        if (!this.pendingTurn) throw new Error("No pending turn. Call send() first.");
        return this._waitForTurnResult(timeout ?? 300_000, undefined, opts?.signal);
    }

    on(eventType: string, handler: WebSessionEventHandler): () => void;
    on(handler: WebSessionEventHandler): () => void;
    on(eventTypeOrHandler: string | WebSessionEventHandler, handler?: WebSessionEventHandler): () => void {
        const key = typeof eventTypeOrHandler === "function" ? null : eventTypeOrHandler;
        const fn = typeof eventTypeOrHandler === "function" ? eventTypeOrHandler : handler!;

        if (!this.handlers.has(key)) this.handlers.set(key, new Set());
        this.handlers.get(key)!.add(fn);
        this._startEventDelivery();

        return () => {
            const set = this.handlers.get(key);
            if (set) {
                set.delete(fn);
                if (set.size === 0) this.handlers.delete(key);
            }
            if (this.handlers.size === 0) this._stopEventDelivery();
        };
    }

    async sendEvent(eventName: string, data: unknown): Promise<void> {
        await this.api.call("sendSessionEvent", { sessionId: this.sessionId, eventName, data });
    }

    async cancelPendingMessage(clientMessageIds: string[]): Promise<void> {
        const ids = (clientMessageIds || []).filter((id): id is string => typeof id === "string" && Boolean(id));
        if (ids.length === 0) return;
        await this.api.call("cancelPendingMessage", { sessionId: this.sessionId, clientMessageIds: ids });
    }

    async abort(): Promise<void> {
        await this.api.call("cancelSession", { sessionId: this.sessionId });
    }

    async destroy(): Promise<void> {
        this._stopEventDelivery();
        await this.api.call("deleteSession", { sessionId: this.sessionId });
    }

    async getMessages(limit?: number): Promise<SessionEvent[]> {
        return this.api.call("getSessionEvents", { sessionId: this.sessionId, limit });
    }

    async getInfo(): Promise<PilotSwarmSessionInfo> {
        return this.api.call("getSession", { sessionId: this.sessionId });
    }

    // ─── Turn result waiting ─────────────────────────────────────────────

    private async _waitForTurnResult(
        timeout: number,
        onIntermediateContent?: (content: string) => void,
        signal?: AbortSignal,
    ): Promise<string | undefined> {
        const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
        const label = `WebPilotSwarmSession wait aborted (${this.sessionId})`;

        while (Date.now() < deadline) {
            throwIfAborted(signal, label);
            const remaining = deadline === Infinity ? WAIT_SLICE_MS : Math.min(deadline - Date.now(), WAIT_SLICE_MS);
            if (remaining <= 0) break;

            let status: any;
            try {
                status = await this.api.call("waitForStatusChange", {
                    sessionId: this.sessionId,
                    afterVersion: this.lastSeenVersion,
                    timeoutMs: Math.max(1_000, remaining),
                });
            } catch (error) {
                throwIfAborted(signal, label);
                // Permanent errors (auth, bad request) must propagate — retrying
                // them just hangs. Only transient faults (network, 5xx) fall
                // through to a status-based recovery check.
                const httpStatus = Number((error as any)?.status);
                if (httpStatus >= 400 && httpStatus < 500) throw error;
                // Transient: consult the current status so a terminal
                // orchestration that stopped emitting is still detected
                // (mirrors the direct client's getStatus fallback).
                await new Promise((resolve) => setTimeout(resolve, 1_000));
                throwIfAborted(signal, label);
                try {
                    status = await this.api.call("getSessionStatus", { sessionId: this.sessionId });
                } catch {
                    continue;
                }
            }
            throwIfAborted(signal, label);

            const version = Number(status?.customStatusVersion) || 0;
            if (version < this.lastSeenVersion) {
                // The orchestration was restarted (continue-as-new). Reset.
                this.lastSeenIteration = -1;
            }
            this.lastSeenVersion = version;

            const customStatus = status?.customStatus && typeof status.customStatus === "object"
                ? status.customStatus
                : null;

            if (customStatus) {
                if (customStatus.intermediateContent && onIntermediateContent) {
                    onIntermediateContent(customStatus.intermediateContent);
                }

                if (customStatus.turnResult && customStatus.iteration > this.lastSeenIteration) {
                    this.lastSeenIteration = customStatus.iteration;
                    const result = customStatus.turnResult;
                    if (result.type === "completed") {
                        if (onIntermediateContent) onIntermediateContent(result.content);
                        if (customStatus.status === "idle") {
                            this.pendingTurn = false;
                            return result.content;
                        }
                    }
                    if (result.type === "input_required" && this.onUserInput) {
                        const answer = await this.onUserInput(
                            { question: result.question, choices: result.choices, allowFreeform: result.allowFreeform },
                            { sessionId: this.sessionId },
                        );
                        throwIfAborted(signal, label);
                        await this.api.call("sendAnswer", { sessionId: this.sessionId, answer: answer.answer });
                        continue;
                    }
                }

                const responseVersion = Number(customStatus.responseVersion) || 0;
                if (responseVersion > this.lastSeenResponseVersion) {
                    const response: SessionResponsePayload | null = await this.api.call("getLatestResponse", {
                        sessionId: this.sessionId,
                    });
                    this.lastSeenResponseVersion = Math.max(this.lastSeenResponseVersion, response?.version ?? responseVersion);

                    if (response?.type === "completed" && response.content) {
                        if (onIntermediateContent) onIntermediateContent(response.content);
                        if (customStatus.status === "idle" || customStatus.status === "completed") {
                            this.pendingTurn = false;
                            return response.content;
                        }
                    }
                    if (response?.type === "error" && response.content) {
                        this.pendingTurn = false;
                        throw new Error(response.content);
                    }
                    if (response?.type === "wait" && response.content && onIntermediateContent) {
                        onIntermediateContent(response.content);
                    }
                    if (response?.type === "input_required" && response.question && this.onUserInput) {
                        const answer = await this.onUserInput(
                            { question: response.question, choices: response.choices, allowFreeform: response.allowFreeform },
                            { sessionId: this.sessionId },
                        );
                        throwIfAborted(signal, label);
                        await this.api.call("sendAnswer", { sessionId: this.sessionId, answer: answer.answer });
                        continue;
                    }
                }
            }

            if (status?.orchestrationStatus === "Failed") {
                this.pendingTurn = false;
                throw new Error("Orchestration failed");
            }
            if (status?.orchestrationStatus === "Completed") {
                this.pendingTurn = false;
                return customStatus?.turnResult?.type === "completed" ? customStatus.turnResult.content : undefined;
            }
        }

        throwIfAborted(signal, label);
        throw new Error(`Timeout waiting for response (${timeout}ms)`);
    }

    // ─── Event delivery: catch-up fetch + WebSocket push ─────────────────

    private _startEventDelivery(): void {
        if (this.wsUnsubscribe) return;
        this.wsUnsubscribe = this.api.subscribeSession(
            this.sessionId,
            (event: any) => this._onLiveEvent(event as SessionEvent),
            () => { void this._catchUp(); },
        );
        void this._catchUp();
    }

    private _onLiveEvent(event: SessionEvent): void {
        if (!event || typeof event.seq !== "number") return;
        // Buffer live pushes while a catch-up fetch is in flight; otherwise a
        // push could advance lastSeenSeq past history the fetch hasn't yet
        // delivered, dropping those events.
        if (this.catchingUp) {
            this.liveBuffer.push(event);
            return;
        }
        this._ingest(event);
    }

    private _ingest(event: SessionEvent): void {
        if (event.seq <= this.lastSeenSeq) return;
        this.lastSeenSeq = event.seq;
        this._dispatch(event);
    }

    private async _catchUp(): Promise<void> {
        if (this.catchingUp) return;
        this.catchingUp = true;
        try {
            const events: SessionEvent[] = await this.api.call("getSessionEvents", {
                sessionId: this.sessionId,
                afterSeq: this.lastSeenSeq,
                limit: EVENT_POLL_LIMIT,
            });
            for (const event of events || []) this._ingest(event);
        } catch {
            // Best-effort; a later reconnect or the live stream recovers it.
        } finally {
            this.catchingUp = false;
            const buffered = this.liveBuffer.sort((a, b) => a.seq - b.seq);
            this.liveBuffer = [];
            for (const event of buffered) this._ingest(event);
        }
    }

    private _stopEventDelivery(): void {
        if (this.wsUnsubscribe) {
            this.wsUnsubscribe();
            this.wsUnsubscribe = null;
        }
        this.liveBuffer = [];
        this.catchingUp = false;
    }

    private _dispatch(event: SessionEvent): void {
        const typed = this.handlers.get(event.eventType);
        if (typed) {
            for (const fn of typed) fn(event);
        }
        const catchAll = this.handlers.get(null);
        if (catchAll) {
            for (const fn of catchAll) fn(event);
        }
    }
}
