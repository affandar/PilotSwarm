import { ApiClient } from "./api-client.js";

function toIso(value) {
    return value instanceof Date ? value.toISOString() : value;
}

function unsupported(name, hint) {
    return () => {
        throw new Error(`${name} is not available on this client${hint ? ` (${hint})` : ""}`);
    };
}

/**
 * The shared-UI transport surface (what `pilotswarm/ui-core` consumes) over
 * the PilotSwarm Web API. Used by the browser portal and by the TUI's API
 * mode; both inject their environment-specific conveniences (artifact
 * save-to-disk / browser download, open-in-app) via `options.host`.
 */
export class HttpApiTransport {
    constructor(options = {}) {
        this.api = options.api instanceof ApiClient ? options.api : new ApiClient(options);
        this.bootstrap = null;
        const host = options.host || {};
        if (host.saveArtifactDownload) this.saveArtifactDownload = host.saveArtifactDownload.bind(null, this);
        else this.saveArtifactDownload = unsupported("saveArtifactDownload", "no host download handler");
        if (host.uploadArtifactFromPath) this.uploadArtifactFromPath = host.uploadArtifactFromPath.bind(null, this);
        if (host.openPathInDefaultApp) this.openPathInDefaultApp = host.openPathInDefaultApp;
        if (host.openUrlInDefaultBrowser) this.openUrlInDefaultBrowser = host.openUrlInDefaultBrowser;
        this.artifactExportDirectory = host.artifactExportDirectory || null;
    }

    async start() {
        await this.api.start();
        this.bootstrap = await this.api.getBootstrap();
    }

    async stop() {
        await this.api.stop();
    }

    // ── Bootstrap-backed getters ────────────────────────────────────────

    getWorkerCount() {
        return this.bootstrap?.workerCount ?? null;
    }

    getLogConfig() {
        return this.bootstrap?.logConfig || null;
    }

    getModelsByProvider() {
        return this.bootstrap?.modelsByProvider || [];
    }

    getDefaultModel() {
        return this.bootstrap?.defaultModel || null;
    }

    getAuthContext() {
        return this.bootstrap?.auth || {
            principal: null,
            authorization: { allowed: false, role: null, reason: "Auth context unavailable", matchedGroups: [] },
        };
    }

    async listCreatableAgents() {
        return this.bootstrap?.creatableAgents || this.api.call("listCreatableAgents");
    }

    getSessionCreationPolicy() {
        return this.bootstrap?.sessionCreationPolicy || null;
    }

    // ── Sessions ────────────────────────────────────────────────────────

    async listSessions() {
        return this.api.call("listSessions");
    }

    async listSessionsPage(opts = {}) {
        return this.api.call("listSessionsPage", {
            limit: opts?.limit,
            cursor: opts?.cursor ?? undefined,
            includeDeleted: opts?.includeDeleted,
        });
    }

    async getSession(sessionId) {
        return this.api.call("getSession", { sessionId });
    }

    // ── Session sharing / access (security model) ────────────────────────
    async getSessionAccess(sessionId) {
        return this.api.call("getSessionAccess", { sessionId });
    }

    async setSessionVisibility(sessionId, visibility) {
        return this.api.call("setSessionVisibility", { sessionId, visibility });
    }

    async grantSessionShare(sessionId, user, access) {
        return this.api.call("grantSessionShare", { sessionId, user, access });
    }

    async revokeSessionShare(sessionId, user) {
        return this.api.call("revokeSessionShare", { sessionId, user });
    }

    async listSessionShares(sessionId) {
        return this.api.call("listSessionShares", { sessionId });
    }

    async listKnownUsers(opts = {}) {
        return this.api.call("listKnownUsers", { limit: opts?.limit });
    }

    async listAuthzAudit(opts = {}) {
        return this.api.call("listAuthzAudit", { limit: opts?.limit, sessionId: opts?.sessionId });
    }

    async createSession(options = {}) {
        return this.api.call("createSession", options);
    }

    async createSessionForAgent(agentName, options = {}) {
        return this.api.call("createSessionForAgent", { agentName, ...options });
    }

    async deleteSession(sessionId) {
        return this.api.call("deleteSession", { sessionId });
    }

    async renameSession(sessionId, title) {
        return this.api.call("renameSession", { sessionId, title });
    }

    async cancelSession(sessionId) {
        return this.api.call("cancelSession", { sessionId });
    }

    async completeSession(sessionId, reason) {
        return this.api.call("completeSession", { sessionId, reason });
    }

    async restartSystemSession(agentIdOrSessionId, options = {}) {
        return this.api.call("restartSystemSession", { agentIdOrSessionId, options });
    }

    async setSessionModel(sessionId, options = {}) {
        return this.api.call("setSessionModel", { sessionId, options });
    }

    async stopSessionTurn(sessionId, options = {}) {
        return this.api.call("stopSessionTurn", { sessionId, options });
    }

    // ── Messaging ───────────────────────────────────────────────────────

    async sendMessage(sessionId, prompt, options = {}) {
        return this.api.call("sendMessage", { sessionId, prompt, options });
    }

    async sendAnswer(sessionId, answer) {
        return this.api.call("sendAnswer", { sessionId, answer });
    }

    async cancelPendingMessage(sessionId, clientMessageIds) {
        return this.api.call("cancelPendingMessage", { sessionId, clientMessageIds });
    }

    // ── Session groups ──────────────────────────────────────────────────

    async listSessionGroups() {
        return this.api.call("listSessionGroups");
    }

    async createSessionGroup(input) {
        return this.api.call("createSessionGroup", { input });
    }

    async updateSessionGroup(groupId, patch) {
        return this.api.call("updateSessionGroup", { groupId, patch });
    }

    async assignSessionsToGroup(groupId, sessionIds) {
        return this.api.call("assignSessionsToGroup", { groupId, sessionIds });
    }

    async moveSessionsToGroup(groupId, sessionIds) {
        return this.api.call("moveSessionsToGroup", { groupId: groupId ?? null, sessionIds });
    }

    async placeSessionsInGroup(sessionIds, groupId) {
        return this.api.call("placeSessionsInGroup", { groupId: groupId ?? null, sessionIds });
    }

    async deleteSessionGroup(groupId) {
        return this.api.call("deleteSessionGroup", { groupId });
    }

    async cancelSessionGroup(groupId, reason) {
        return this.api.call("cancelSessionGroup", { groupId, reason });
    }

    async completeSessionGroup(groupId, options = {}) {
        return this.api.call("completeSessionGroup", { groupId, options });
    }

    async getChildOutcome(childSessionId) {
        return this.api.call("getChildOutcome", { childSessionId });
    }

    async listChildOutcomes(parentSessionId) {
        return this.api.call("listChildOutcomes", { parentSessionId });
    }

    // ── Stats / telemetry ───────────────────────────────────────────────

    async getOrchestrationStats(sessionId) {
        return this.api.call("getOrchestrationStats", { sessionId });
    }

    async getSessionMetricSummary(sessionId) {
        return this.api.call("getSessionMetricSummary", { sessionId });
    }

    async getSessionTokensByModel(sessionId) {
        return this.api.call("getSessionTokensByModel", { sessionId });
    }

    async getSessionTreeStats(sessionId) {
        return this.api.call("getSessionTreeStats", { sessionId });
    }

    async getFleetStats(opts) {
        return this.api.call("getFleetStats", {
            includeDeleted: opts?.includeDeleted,
            since: toIso(opts?.since),
        });
    }

    async getUserStats(opts) {
        return this.api.call("getUserStats", {
            includeDeleted: opts?.includeDeleted,
            since: toIso(opts?.since),
        });
    }

    async getTopEventEmitters(opts = {}) {
        return this.api.call("getTopEventEmitters", {
            since: toIso(opts?.since),
            limit: opts?.limit,
        });
    }

    async getSessionSkillUsage(sessionId, opts) {
        return this.api.call("getSessionSkillUsage", { sessionId, since: toIso(opts?.since) });
    }

    async getSessionTreeSkillUsage(sessionId, opts) {
        return this.api.call("getSessionTreeSkillUsage", { sessionId, since: toIso(opts?.since) });
    }

    async getFleetSkillUsage(opts) {
        return this.api.call("getFleetSkillUsage", {
            includeDeleted: opts?.includeDeleted,
            since: toIso(opts?.since),
        });
    }

    async getFleetRetrievalUsage(opts) {
        return this.api.call("getFleetRetrievalUsage", {
            includeDeleted: opts?.includeDeleted,
            since: toIso(opts?.since),
        });
    }

    async getSessionFactsStats(sessionId) {
        return this.api.call("getSessionFactsStats", { sessionId });
    }

    async getSessionTreeFactsStats(sessionId) {
        return this.api.call("getSessionTreeFactsStats", { sessionId });
    }

    async getSharedFactsStats() {
        return this.api.call("getSharedFactsStats");
    }

    async getFactsTombstoneStats(opts = {}) {
        return this.api.call("getFactsTombstoneStats", { ttlSeconds: opts.ttlSeconds });
    }

    async pruneDeletedSummaries(olderThan) {
        return this.api.call("pruneDeletedSummaries", { olderThan: toIso(olderThan) });
    }

    // ── User profile ────────────────────────────────────────────────────

    async getCurrentUserProfile() {
        return this.api.call("getCurrentUserProfile");
    }

    async setCurrentUserProfileSettings({ settings } = {}) {
        return this.api.call("setCurrentUserProfileSettings", {
            settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {},
        });
    }

    async setCurrentUserGitHubCopilotKey({ key } = {}) {
        return this.api.call("setCurrentUserGitHubCopilotKey", {
            key: typeof key === "string" ? key : null,
        });
    }

    async setSystemGitHubCopilotKey({ key } = {}) {
        return this.api.call("setSystemGitHubCopilotKey", {
            key: typeof key === "string" ? key : null,
        });
    }

    async getSystemGitHubCopilotKeyStatus() {
        return this.api.call("getSystemGitHubCopilotKeyStatus");
    }

    // ── Models ──────────────────────────────────────────────────────────

    async listModels() {
        return this.api.call("listModels");
    }

    // ── Events / history ────────────────────────────────────────────────

    async getSessionEvents(sessionId, afterSeq, limit, eventTypes) {
        return this.api.call("getSessionEvents", { sessionId, afterSeq, limit, eventTypes });
    }

    async getSessionEventsBefore(sessionId, beforeSeq, limit, eventTypes) {
        return this.api.call("getSessionEventsBefore", { sessionId, beforeSeq, limit, eventTypes });
    }

    async getExecutionHistory(sessionId, executionId) {
        return this.api.call("getExecutionHistory", { sessionId, executionId });
    }

    async exportExecutionHistory(sessionId) {
        return this.api.call("exportExecutionHistory", { sessionId });
    }

    // ── Artifacts ───────────────────────────────────────────────────────

    async listArtifacts(sessionId) {
        return this.api.call("listArtifacts", { sessionId });
    }

    async getArtifactMetadata(sessionId, filename) {
        return this.api.call("getArtifactMetadata", { sessionId, filename });
    }

    async deleteArtifact(sessionId, filename) {
        return this.api.call("deleteArtifact", { sessionId, filename });
    }

    async downloadArtifact(sessionId, filename) {
        return this.api.call("downloadArtifact", { sessionId, filename });
    }

    async uploadArtifactContent(sessionId, filename, content, contentType, contentEncoding) {
        return this.api.call("uploadArtifact", { sessionId, filename, content, contentType, contentEncoding });
    }

    getArtifactExportDirectory() {
        return this.artifactExportDirectory || "Downloads";
    }

    // ── Streaming ───────────────────────────────────────────────────────

    subscribeSession(sessionId, handler) {
        return this.api.subscribeSession(sessionId, handler);
    }

    startLogTail(handler) {
        return this.api.subscribeLogs(handler);
    }
}
