import { ApiClient } from "./api-client.js";
import { createCanvasLiveMirror } from "./canvas-live-mirror.js";

/**
 * Flatten an agent-package copy selector into wire params.
 * `scopeless` skips the scope field for ops whose `scope` param already
 * means something else (setAgentPackageScope's TARGET scope).
 */
function selectorParams(selector, opts = {}) {
    if (!selector || typeof selector !== "object") return {};
    return {
        ...(!opts.scopeless && selector.scope ? { scope: selector.scope } : {}),
        ...(selector.owner?.provider ? { ownerProvider: selector.owner.provider } : {}),
        ...(selector.owner?.subject ? { ownerSubject: selector.owner.subject } : {}),
    };
}

function toIso(value) {
    return value instanceof Date ? value.toISOString() : value;
}

/**
 * `getProviderStatus` takes its names as one comma-separated query value,
 * and no names at all means every provider in the caller's namespace.
 *
 * There is no way to ask for NOTHING: the server drops empty names and then
 * reads an empty list as "all of them". So an empty array is sent as no
 * parameter rather than as `names=`, which would read in a log like a filter
 * that matched nothing when the answer coming back is everything.
 */
function providerNamesParam(names) {
    if (names === undefined || names === null) return undefined;
    if (Array.isArray(names)) return names.length ? names.join(",") : undefined;
    return String(names) || undefined;
}

/**
 * A default is one tuple: provider + model + reasoning + context. A null
 * tuple clears it, and clearing has to reach the server as explicit nulls —
 * an omitted body field is dropped before it gets there, which would read as
 * "leave it alone" instead of "I want no default".
 */
function defaultTupleParams(tuple) {
    return {
        provider: tuple?.provider ?? null,
        model: tuple?.model ?? null,
        reasoning: tuple?.reasoning ?? null,
        context: tuple?.context ?? null,
    };
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
        // Optional: a host that can write a file offers package download too.
        // Absent on hosts with nowhere to put it, so callers feature-detect.
        if (host.saveAgentPackageDownload) this.saveAgentPackageDownload = host.saveAgentPackageDownload.bind(null, this);
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
        // Always fetch: the server unions baked agents with viewer-scoped
        // registry packages, so the bootstrap snapshot (baked-only, captured
        // at page load) would hide packages and go stale across publishes.
        try {
            return await this.api.call("listCreatableAgents");
        } catch {
            return this.bootstrap?.creatableAgents || [];
        }
    }

    // ── Agent packages (docs/proposals/agent-packages.md) ────────
    // `selector` = { scope, owner: {provider, subject} } — which same-named
    // copy the op targets (scope shadowing allows several). Optional
    // everywhere for backward compatibility; name-only falls back to the
    // registry's own-copy-then-shared walk.
    listAgentPackages() { return this.api.call("listAgentPackages"); }
    getAgentPackage(name, selector) { return this.api.call("getAgentPackage", { name, ...selectorParams(selector) }); }
    getAgentPackageTree(name, semver, selector) { return this.api.call("getAgentPackageTree", { name, ...(semver ? { semver } : {}), ...selectorParams(selector) }); }
    getAgentPackageFile(name, semver, filePath, selector) { return this.api.call("getAgentPackageFile", { name, filePath, ...(semver ? { semver } : {}), ...selectorParams(selector) }); }
    uploadAgentPackage(files, scope) { return this.api.call("uploadAgentPackage", { files, scope }); }
    listAgentWorkerState() { return this.api.call("listAgentWorkerState"); }
    listWorkers() { return this.api.call("listWorkers"); }
    setAgentPackageScope(name, scope, selector) { return this.api.call("setAgentPackageScope", { name, scope, ...selectorParams(selector, { scopeless: true }) }); }
    setAgentPackageEnabled(name, enabled, selector) { return this.api.call("setAgentPackageEnabled", { name, enabled, ...selectorParams(selector) }); }
    pinAgentPackageVersion(name, semver, selector) { return this.api.call("pinAgentPackageVersion", { name, semver, ...selectorParams(selector) }); }
    // Editors live on the shared copy only — no selector.
    grantAgentPackageEditor(name, user) { return this.api.call("grantAgentPackageEditor", { name, user }); }
    revokeAgentPackageEditor(name, user) { return this.api.call("revokeAgentPackageEditor", { name, user }); }
    listAgentPackageEditors(name) { return this.api.call("listAgentPackageEditors", { name }); }
    deleteAgentPackage(name, selector) { return this.api.call("deleteAgentPackage", { name, ...selectorParams(selector) }); }
    republishAgentPackageVersion(name, semver, targetScope, selector) { return this.api.call("republishAgentPackageVersion", { name, semver, targetScope, ...selectorParams(selector) }); }
    downloadAgentPackage(name, semver, selector) {
        return this.api.downloadAgentPackageResponse(name, {
            ...(semver ? { semver } : {}),
            ...selectorParams(selector),
        });
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

    async regenerateSession(sessionId, options = {}) {
        return this.api.call("regenerateSession", { sessionId, options });
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

    // ── Provider budgets (docs/proposals/providers-and-budgets.md) ──────
    // One method per capability in
    // docs/proposals/providers-and-budgets-surface.md. Nothing here decides
    // who may do what: every call carries the signed-in person to the
    // `cms_provider_*` procedures, and the database refuses what they may
    // not do. A refusal arrives as an ApiError with a PROVIDER_* code and a
    // message already written for a person — pass it on, do not rewrite it.
    //
    // The wire calls the provider `name` (it is a path segment); the
    // capability list calls it `provider`. These methods take the wire name
    // so a reader can line them up against the table.

    listProviders() { return this.api.call("listProviders"); }
    getProviderStatus(names) { return this.api.call("getProviderStatus", { names: providerNamesParam(names) }); }
    getProviderUsageGrid() { return this.api.call("getProviderUsageGrid"); }
    createProvider({ name, type, credentials, baseUrl, displayName } = {}) { return this.api.call("createProvider", { name, type, credentials, baseUrl, displayName }); }
    deleteProvider(name) { return this.api.call("deleteProvider", { name }); }
    createMyProvider({ name, type, credentials, baseUrl, displayName } = {}) { return this.api.call("createMyProvider", { name, type, credentials, baseUrl, displayName }); }
    deleteMyProvider(name) { return this.api.call("deleteMyProvider", { name }); }
    clearProviderRoutingDependencies(name) { return this.api.call("clearProviderRoutingDependencies", { name }); }
    setProviderLimit({ name, period, model, tokens } = {}) { return this.api.call("setProviderLimit", { name, period, model: model ?? null, tokens }); }
    removeProviderLimit({ name, period, model } = {}) { return this.api.call("removeProviderLimit", { name, period, model: model ?? undefined }); }
    setProviderAllowance({ name, pct } = {}) { return this.api.call("setProviderAllowance", { name, pct }); }
    setProviderHold({ name, untilUtc, release } = {}) { return this.api.call("setProviderHold", { name, untilUtc: untilUtc ?? null, release: release === true }); }
    getDefaults() { return this.api.call("getDefaults"); }
    getModelDefaults() { return this.api.call("getModelDefaults"); }
    setModelDefault(input) { return this.api.call("setModelDefault", input || {}); }
    setProviderSystemUse({ provider, enabled } = {}) { return this.api.call("setProviderSystemUse", { name: provider, enabled }); }
    getLegacyProviderMigrationStatus() { return this.api.call("getLegacyProviderMigrationStatus"); }
    adoptLegacySystemGitHubCopilotKey({ name, displayName } = {}) { return this.api.call("adoptLegacySystemGitHubCopilotKey", { name, displayName }); }
    setSystemModelDefault(input) { return this.api.call("setSystemModelDefault", input || {}); }
    setSystemSessionModel(input) { return this.api.call("setSystemSessionModel", input || {}); }
    clearSystemSessionModel(agentId) { return this.api.call("clearSystemSessionModel", { agentId }); }
    setClusterDefault(tuple) { return this.api.call("setClusterDefault", defaultTupleParams(tuple)); }
    setMyDefault(tuple) { return this.api.call("setMyDefault", defaultTupleParams(tuple)); }
    getProviderUsage(filters = {}) {
        return this.api.call("getProviderUsage", {
            days: filters.days,
            // "Only my own", resolved server-side from the authenticated
            // caller. A boolean cannot name anybody else, which is why the
            // chart asks this way rather than sending an id.
            mine: filters.mine === true ? true : undefined,
            ownerUserId: filters.ownerUserId ?? undefined,
            provider: filters.provider ?? undefined,
            model: filters.model ?? undefined,
            sessionId: filters.sessionId ?? undefined,
            chargeClass: filters.chargeClass ?? undefined,
            dimension: filters.dimension ?? undefined,
            limit: filters.limit,
        });
    }
    listPausedSessions() { return this.api.call("listPausedSessions"); }

    // ── Events / history ────────────────────────────────────────────────

    async getSessionEvents(sessionId, afterSeq, limit, eventTypes) {
        return this.api.call("getSessionEvents", { sessionId, afterSeq, limit, eventTypes });
    }

    async getCanvasLive(sessionId) {
        return this.api.call("getCanvasLive", { sessionId });
    }

    // The canvas KV store (door 1 — signed-in browser).
    async readCanvasKv(sessionId, slot, query = {}) {
        return this.api.call("readCanvasKv", {
            sessionId, slot,
            ...(query.prefix != null ? { prefix: query.prefix } : {}),
            ...(query.limit != null ? { limit: query.limit } : {}),
            ...(query.after != null ? { after: query.after } : {}),
            ...(query.key != null ? { key: query.key } : {}),
        });
    }

    async writeCanvasKv(sessionId, slot, ops) {
        return this.api.call("writeCanvasKv", { sessionId, slot, ops });
    }

    async setCanvasKvAccess(sessionId, slot, access) {
        return this.api.call("setCanvasKvAccess", { sessionId, slot, access });
    }

    async getCanvasShareLink(sessionId, slot) {
        return this.api.call("getCanvasShareLink", { sessionId, slot });
    }

    async resetCanvasShareLink(sessionId, slot) {
        return this.api.call("resetCanvasShareLink", { sessionId, slot: { slot } });
    }

    async removeCanvasShareLink(sessionId, slot) {
        return this.api.call("removeCanvasShareLink", { sessionId, slot: { slot } });
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

    async readArtifactBase64(sessionId, filename, maxBytes) {
        return this.api.call("readArtifactBase64", { sessionId, filename, maxBytes });
    }

    async copyArtifact(fromSessionId, fromFilename, toSessionId, toFilename) {
        return this.api.call("copyArtifact", { fromSessionId, fromFilename, toSessionId, toFilename });
    }

    async setArtifactPinned(sessionId, filename, pinned) {
        return this.api.call("setArtifactPinned", { sessionId, filename, pinned });
    }

    getArtifactExportDirectory() {
        return this.artifactExportDirectory || "Downloads";
    }

    // ── Streaming ───────────────────────────────────────────────────────

    subscribeSession(sessionId, handler) {
        // The canvas data plane rides the SAME subscription: plane pushes
        // (patch pings off the database's NOTIFY) are mirrored into complete
        // `session.canvas_data`-shaped events, so every consumer keeps its
        // whole-state contract at ~30 ms instead of the 500 ms poll floor.
        // Once a slot is plane-fed, the dual-written legacy tick events for
        // it are suppressed here — the plane already delivered fresher state
        // (same writer, written first). Everything degrades: a server
        // without the plane just never sends canvasLive messages.
        if (!this._canvasMirror) {
            this._canvasMirror = createCanvasLiveMirror({
                fetchSnapshot: (sid) => this.getCanvasLive(sid),
                emit: (sid, update) => {
                    const handlers = this._canvasEmitHandlers?.get(sid);
                    if (!handlers) return;
                    const event = {
                        eventType: "session.canvas_data",
                        sessionId: sid,
                        // TRANSIENT: no seq, never enters history — canvas
                        // state only. See controller.mergeSessionEvent.
                        transient: true,
                        data: {
                            slot: update.slot,
                            dataRev: update.seq,
                            planeSeq: update.seq,
                            payload: update.payload,
                            ...(update.patch ? { patch: update.patch } : {}),
                            sizeBytes: JSON.stringify(update.payload).length,
                        },
                    };
                    for (const h of handlers) {
                        try { h(event); } catch { /* consumer's problem */ }
                    }
                },
            });
            this._canvasEmitHandlers = new Map();
        }
        if (!this._canvasEmitHandlers.has(sessionId)) {
            this._canvasEmitHandlers.set(sessionId, new Set());
        }
        this._canvasEmitHandlers.get(sessionId).add(handler);
        const wrapped = (event) => {
            if (event?.eventType === "session.canvas_data"
                && this._canvasMirror.covers(sessionId, Number(event?.data?.slot) || 1)) {
                return; // plane-fed slot: the mirror already delivered this state
            }
            handler(event);
        };
        const unsubscribeEvents = this.api.subscribeSession(sessionId, wrapped);
        const unsubscribeCanvas = this.api.subscribeCanvasLive(sessionId, (message) => {
            if (message?.kind === "kv") {
                // A KV change: not part of the tick mirror (per-key rev, not
                // the slot seq chain). Surface it as a TRANSIENT event so the
                // canvas frame can post `canvas-kv-change` into the page.
                const handlers = this._canvasEmitHandlers?.get(sessionId);
                if (handlers) {
                    const event = {
                        eventType: "session.canvas_kv",
                        sessionId,
                        transient: true,
                        data: {
                            slot: Number(message.slot) || 1,
                            key: String(message.key ?? ""),
                            rev: Number(message.rev) || 0,
                            op: message.op === "delete" ? "delete" : "put",
                            ...(message.value !== undefined ? { value: message.value } : {}),
                        },
                    };
                    for (const h of handlers) {
                        try { h(event); } catch { /* consumer's problem */ }
                    }
                }
                return;
            }
            this._canvasMirror.onPing(sessionId, message);
            if (message?.kind === "unavailable") {
                // Propagate the release downstream: the reducer holds its own
                // takeover latch (planeSeq) and must also let legacy events
                // resume, or the canvas freezes at the last plane state.
                const handlers = this._canvasEmitHandlers?.get(sessionId);
                if (handlers) {
                    const event = { eventType: "session.canvas_plane_released", sessionId, transient: true };
                    for (const h of handlers) {
                        try { h(event); } catch { /* consumer's problem */ }
                    }
                }
            }
        });
        return () => {
            unsubscribeEvents();
            unsubscribeCanvas();
            const handlers = this._canvasEmitHandlers.get(sessionId);
            if (handlers) {
                handlers.delete(handler);
                if (handlers.size === 0) {
                    this._canvasEmitHandlers.delete(sessionId);
                    this._canvasMirror.forget(sessionId);
                }
            }
        };
    }

    startLogTail(handler) {
        return this.api.subscribeLogs(handler);
    }
}
