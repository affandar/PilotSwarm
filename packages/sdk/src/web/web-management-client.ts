import type { ApiClient } from "pilotswarm-sdk/api";
import {
    PilotSwarmWebOptions,
    createApiClientFromOptions,
    webModeUnsupported,
} from "./api-connection.js";

const WAIT_SLICE_MS = 25_000;

function toIso(value: unknown): unknown {
    return value instanceof Date ? value.toISOString() : value;
}

/**
 * PilotSwarmManagementClient in web mode: the management surface over the
 * Web API. Constructed via `new PilotSwarmManagementClient({ apiUrl, … })`.
 *
 * Methods without an API equivalent (low-level command plumbing, graph/
 * retrieval observability, session dumps) throw `WEB_MODE_UNSUPPORTED`
 * errors — they remain direct-mode-only until a remote consumer needs them.
 *
 * User-profile methods operate on the **authenticated** principal; the
 * explicit `principal` argument accepted by the direct client is ignored
 * because the server derives identity from the request's auth context.
 */
export class WebPilotSwarmManagementClient {
    /** @internal */
    readonly _api: ApiClient;
    private started = false;

    constructor(options: PilotSwarmWebOptions) {
        this._api = createApiClientFromOptions(options);
    }

    async start(): Promise<void> {
        if (this.started) return;
        await this._api.start();
        await this._api.health();
        this.started = true;
    }

    async stop(): Promise<void> {
        this.started = false;
        await this._api.stop();
    }

    // ── Session listing ─────────────────────────────────────────────────

    async listSessions(): Promise<any[]> {
        return this._api.call("listSessions");
    }

    async listSessionsPage(opts: { limit?: number; cursor?: { updatedAt: number; sessionId: string } | null; includeDeleted?: boolean } = {}): Promise<any> {
        return this._api.call("listSessionsPage", {
            limit: opts.limit,
            cursor: opts.cursor ?? undefined,
            includeDeleted: opts.includeDeleted,
        });
    }

    async getSession(sessionId: string): Promise<any> {
        return this._api.call("getSession", { sessionId });
    }

    // ── Session actions ─────────────────────────────────────────────────

    async renameSession(sessionId: string, title: string): Promise<void> {
        await this._api.call("renameSession", { sessionId, title });
    }

    async cancelSession(sessionId: string): Promise<void> {
        await this._api.call("cancelSession", { sessionId });
    }

    async completeSession(sessionId: string, reason?: string): Promise<void> {
        await this._api.call("completeSession", { sessionId, reason });
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this._api.call("deleteSession", { sessionId });
    }

    async stopSessionTurn(sessionId: string, opts: { reason?: string; timeoutMs?: number } = {}): Promise<any> {
        return this._api.call("stopSessionTurn", { sessionId, options: opts });
    }

    async setSessionModel(sessionId: string, model: string, opts: { reasoningEffort?: string | null; source?: string } = {}): Promise<void> {
        await this._api.call("setSessionModel", { sessionId, options: { model, ...opts } });
    }

    async restartSystemSession(agentIdOrSessionId: string, options: Record<string, unknown>): Promise<any> {
        return this._api.call("restartSystemSession", { agentIdOrSessionId, options });
    }

    // ── Session groups ──────────────────────────────────────────────────

    async createSessionGroup(input: Record<string, unknown>): Promise<any> {
        return this._api.call("createSessionGroup", { input });
    }

    async listSessionGroups(): Promise<any[]> {
        return this._api.call("listSessionGroups");
    }

    async updateSessionGroup(groupId: string, patch: Record<string, unknown>): Promise<any> {
        return this._api.call("updateSessionGroup", { groupId, patch });
    }

    async assignSessionsToGroup(groupId: string, sessionIds: string[]): Promise<void> {
        await this._api.call("assignSessionsToGroup", { groupId, sessionIds });
    }

    async moveSessionsToGroup(groupId: string | null, sessionIds: string[]): Promise<void> {
        await this._api.call("moveSessionsToGroup", { groupId, sessionIds });
    }

    async deleteSessionGroup(groupId: string): Promise<void> {
        await this._api.call("deleteSessionGroup", { groupId });
    }

    async cancelSessionGroup(groupId: string, reason?: string): Promise<void> {
        await this._api.call("cancelSessionGroup", { groupId, reason });
    }

    async completeSessionGroup(groupId: string, options: Record<string, unknown> = {}): Promise<void> {
        await this._api.call("completeSessionGroup", { groupId, options });
    }

    listGroupSessions(): never {
        throw webModeUnsupported("listGroupSessions", "filter listSessions/listSessionsPage by groupId instead");
    }

    // ── Child contracts ─────────────────────────────────────────────────

    async getChildOutcome(childSessionId: string): Promise<any> {
        return this._api.call("getChildOutcome", { childSessionId });
    }

    async listChildOutcomes(parentSessionId: string): Promise<any[]> {
        return this._api.call("listChildOutcomes", { parentSessionId });
    }

    // ── Events & history ────────────────────────────────────────────────

    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number, eventTypes?: string[]): Promise<any[]> {
        return this._api.call("getSessionEvents", { sessionId, afterSeq, limit, eventTypes });
    }

    async getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number, eventTypes?: string[]): Promise<any[]> {
        return this._api.call("getSessionEventsBefore", { sessionId, beforeSeq, limit, eventTypes });
    }

    async getTopEventEmitters(opts: { since: Date; limit?: number }): Promise<any[]> {
        return this._api.call("getTopEventEmitters", { since: toIso(opts.since), limit: opts.limit });
    }

    async getExecutionHistory(sessionId: string, executionId?: number): Promise<any> {
        return this._api.call("getExecutionHistory", { sessionId, executionId });
    }

    // ── Status & responses ──────────────────────────────────────────────

    async getSessionStatus(sessionId: string): Promise<any> {
        return this._api.call("getSessionStatus", { sessionId });
    }

    async waitForStatusChange(
        sessionId: string,
        afterVersion: number,
        _pollIntervalMs?: number,
        timeoutMs?: number,
        opts?: { signal?: AbortSignal },
    ): Promise<any> {
        const deadline = Date.now() + (timeoutMs ?? 30_000);
        let latest: any = null;
        while (Date.now() < deadline) {
            if (opts?.signal?.aborted) throw new Error(`Status wait aborted (${sessionId})`);
            const sliceMs = Math.max(1_000, Math.min(deadline - Date.now(), WAIT_SLICE_MS));
            latest = await this._api.call("waitForStatusChange", { sessionId, afterVersion, timeoutMs: sliceMs });
            if ((Number(latest?.customStatusVersion) || 0) > afterVersion) return latest;
        }
        return latest ?? this.getSessionStatus(sessionId);
    }

    async getLatestResponse(sessionId: string): Promise<any> {
        return this._api.call("getLatestResponse", { sessionId });
    }

    // ── Messaging ───────────────────────────────────────────────────────

    async sendMessage(sessionId: string, prompt: string, options: { clientMessageIds?: string[] } = {}): Promise<void> {
        await this._api.call("sendMessage", { sessionId, prompt, options });
    }

    async sendAnswer(sessionId: string, answer: string): Promise<void> {
        await this._api.call("sendAnswer", { sessionId, answer });
    }

    async cancelPendingMessage(sessionId: string, clientMessageIds: string[]): Promise<void> {
        await this._api.call("cancelPendingMessage", { sessionId, clientMessageIds });
    }

    // ── Metrics & stats ─────────────────────────────────────────────────

    async getOrchestrationStats(sessionId: string): Promise<any> {
        return this._api.call("getOrchestrationStats", { sessionId });
    }

    async getSessionMetricSummary(sessionId: string): Promise<any> {
        return this._api.call("getSessionMetricSummary", { sessionId });
    }

    async getSessionTokensByModel(sessionId: string): Promise<any[]> {
        return this._api.call("getSessionTokensByModel", { sessionId });
    }

    async getSessionTreeStats(sessionId: string): Promise<any> {
        return this._api.call("getSessionTreeStats", { sessionId });
    }

    async getFleetStats(opts: { includeDeleted?: boolean; since?: Date } = {}): Promise<any> {
        return this._api.call("getFleetStats", { includeDeleted: opts.includeDeleted, since: toIso(opts.since) });
    }

    async getUserStats(opts: { includeDeleted?: boolean; since?: Date } = {}): Promise<any> {
        return this._api.call("getUserStats", { includeDeleted: opts.includeDeleted, since: toIso(opts.since) });
    }

    // ── Skills usage ────────────────────────────────────────────────────

    async getSessionSkillUsage(sessionId: string, opts: { since?: Date } = {}): Promise<any[]> {
        return this._api.call("getSessionSkillUsage", { sessionId, since: toIso(opts.since) });
    }

    async getSessionTreeSkillUsage(sessionId: string, opts: { since?: Date } = {}): Promise<any> {
        return this._api.call("getSessionTreeSkillUsage", { sessionId, since: toIso(opts.since) });
    }

    async getFleetSkillUsage(opts: { since?: Date; includeDeleted?: boolean } = {}): Promise<any> {
        return this._api.call("getFleetSkillUsage", { since: toIso(opts.since), includeDeleted: opts.includeDeleted });
    }

    async getFleetRetrievalUsage(opts: { since?: Date; includeDeleted?: boolean } = {}): Promise<any> {
        return this._api.call("getFleetRetrievalUsage", { since: toIso(opts.since), includeDeleted: opts.includeDeleted });
    }

    // ── Facts ───────────────────────────────────────────────────────────

    async getSessionFactsStats(sessionId: string): Promise<any> {
        return this._api.call("getSessionFactsStats", { sessionId });
    }

    async getSessionTreeFactsStats(sessionId: string): Promise<any> {
        return this._api.call("getSessionTreeFactsStats", { sessionId });
    }

    async getSharedFactsStats(): Promise<any> {
        return this._api.call("getSharedFactsStats");
    }

    async getFactsTombstoneStats(opts: { ttlSeconds?: number } = {}): Promise<any> {
        return this._api.call("getFactsTombstoneStats", { ttlSeconds: opts.ttlSeconds });
    }

    async pruneDeletedSummaries(olderThan: Date): Promise<any> {
        return this._api.call("pruneDeletedSummaries", { olderThan: toIso(olderThan) });
    }

    // ── User profile (authenticated principal) ──────────────────────────

    async getUserProfile(_principal?: unknown): Promise<any> {
        return this._api.call("getCurrentUserProfile");
    }

    async setUserProfileSettings(_principal: unknown, settings: Record<string, unknown>): Promise<any> {
        return this._api.call("setCurrentUserProfileSettings", { settings });
    }

    async setUserGitHubCopilotKey(_principal: unknown, key: string | null): Promise<any> {
        return this._api.call("setCurrentUserGitHubCopilotKey", { key });
    }

    // ── Models (async in web mode — always `await`) ─────────────────────

    async listModels(): Promise<any[]> {
        return this._api.call("listModels");
    }

    async getModelsByProvider(): Promise<any[]> {
        return this._api.call("getModelsByProvider");
    }

    async getDefaultModel(): Promise<string | undefined> {
        return this._api.call("getDefaultModel");
    }

    // ── Direct-mode-only surfaces ───────────────────────────────────────

    sendCommand(): never {
        throw webModeUnsupported("sendCommand", "low-level command plumbing is direct-mode only");
    }

    getCommandResponse(): never {
        throw webModeUnsupported("getCommandResponse", "low-level command plumbing is direct-mode only");
    }

    dumpSession(): never {
        throw webModeUnsupported("dumpSession");
    }

    getSessionGraphSearches(): never {
        throw webModeUnsupported("getSessionGraphSearches");
    }

    getSessionRetrievalUsage(): never {
        throw webModeUnsupported("getSessionRetrievalUsage");
    }

    getSessionTreeRetrievalUsage(): never {
        throw webModeUnsupported("getSessionTreeRetrievalUsage");
    }

    getSessionGraphNodeUsage(): never {
        throw webModeUnsupported("getSessionGraphNodeUsage");
    }

    getFleetGraphNodeUsage(): never {
        throw webModeUnsupported("getFleetGraphNodeUsage");
    }

    getSessionGraphEdgeSearchUsage(): never {
        throw webModeUnsupported("getSessionGraphEdgeSearchUsage");
    }

    getEmbedderStatus(): never {
        throw webModeUnsupported("getEmbedderStatus");
    }

    normalizeModel(): never {
        throw webModeUnsupported("normalizeModel", "model normalization happens server-side");
    }

    getModelCredentialStatus(): never {
        throw webModeUnsupported("getModelCredentialStatus", "credential checks happen server-side");
    }
}
