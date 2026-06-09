function encodePathSegment(value) {
    return encodeURIComponent(String(value || ""));
}

function encodeBytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

async function readErrorMessage(response) {
    try {
        const payload = await response.json();
        return payload?.error || payload?.message || response.statusText;
    } catch {
        return response.statusText || `HTTP ${response.status}`;
    }
}

export class BrowserPortalTransport {
    constructor({ getAccessToken, getDownstreamToken, onUnauthorized, onForbidden }) {
        this.getAccessToken = typeof getAccessToken === "function" ? getAccessToken : async () => null;
        // Phase 3 (user-OBO): null when no downstream scope is configured or
        // the auth provider doesn't support OBO. The transport ships a
        // principal-only envelope in that case.
        this.getDownstreamToken = typeof getDownstreamToken === "function" ? getDownstreamToken : async () => null;
        this.onUnauthorized = typeof onUnauthorized === "function" ? onUnauthorized : () => {};
        this.onForbidden = typeof onForbidden === "function" ? onForbidden : () => {};
        this.bootstrap = null;
        this.socket = null;
        this.socketOpenPromise = null;
        this.reconnectTimer = null;
        this.stopped = false;
        this.sessionSubscribers = new Map();
        this.logSubscribers = new Set();
        // Phase 6 (FR-011): per-session debounce timestamps for the
        // interactive downstream-token re-acquisition triggered by
        // `interaction_required` outcomes. Capped to ~5 entries to bound
        // memory; oldest entries are evicted on overflow.
        this.lastInteractiveReauthAtBySession = new Map();
        this.interactiveReauthInFlight = false;
    }

    async start() {
        this.stopped = false;
        this.bootstrap = await this.fetchJson("/api/bootstrap", { method: "GET" });
        await this.ensureSocket();
    }

    async stop() {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            try {
                this.socket.close();
            } catch {}
        }
        this.socket = null;
        this.socketOpenPromise = null;
        this.sessionSubscribers.clear();
        this.logSubscribers.clear();
    }

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
            authorization: {
                allowed: false,
                role: null,
                reason: "Auth context unavailable",
                matchedGroups: [],
            },
        };
    }

    async fetchJson(url, options = {}) {
        const token = await this.getAccessToken();
        const headers = new Headers(options.headers || {});
        if (token) headers.set("authorization", `Bearer ${token}`);
        if (options.body && !headers.has("content-type")) {
            headers.set("content-type", "application/json");
        }

        const response = await fetch(url, {
            ...options,
            headers,
        });
        if (response.status === 401) {
            this.onUnauthorized();
            throw new Error("Unauthorized");
        }
        if (response.status === 403) {
            const message = await readErrorMessage(response);
            this.onForbidden(message || "Forbidden");
            throw new Error(message || "Forbidden");
        }
        if (!response.ok) {
            throw new Error(await readErrorMessage(response));
        }
        const payload = await response.json();
        if (payload && payload.ok === false) {
            throw new Error(payload.error || "Request failed");
        }
        return payload?.result !== undefined ? payload.result : payload;
    }

    async rpc(method, params = {}) {
        // Phase 3 (user-OBO): when the deployment configures a downstream
        // scope, attach the freshest cached/refreshed token to the RPC body's
        // auth envelope. The server middleware extracts these fields and
        // stamps them onto req.auth.principal; portal/runtime.js then
        // encrypts the token at envelope-build time so plaintext never lands
        // in the durable queue (FR-020). Sent in the JSON body — not as
        // headers — so it's covered by TLS only and not logged by reverse
        // proxies that capture request headers.
        const downstream = await this.getDownstreamToken().catch(() => null);
        const auth = downstream && downstream.accessToken
            ? {
                accessToken: downstream.accessToken,
                accessTokenExpiresAt: Number.isFinite(downstream.accessTokenExpiresAt)
                    ? downstream.accessTokenExpiresAt
                    : null,
            }
            : undefined;
        return this.fetchJson("/api/rpc", {
            method: "POST",
            body: JSON.stringify(auth ? { method, params, auth } : { method, params }),
        });
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.ensureSocket().catch(() => {});
        }, 1500);
    }

    async ensureSocket() {
        if (this.stopped) return null;
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return this.socket;
        }
        if (this.socketOpenPromise) {
            return this.socketOpenPromise;
        }

        this.socketOpenPromise = (async () => {
            const token = await this.getAccessToken();
            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            const socketUrl = `${protocol}//${window.location.host}/portal-ws`;
            const socket = token
                ? new WebSocket(socketUrl, ["access_token", token])
                : new WebSocket(socketUrl);
            this.socket = socket;

            socket.addEventListener("message", (event) => {
                try {
                    const message = JSON.parse(String(event.data || ""));
                    if (message.type === "sessionEvent") {
                        // Phase 6 (FR-011): when a tool emits an
                        // `interaction_required` outcome (or the worker
                        // synthesises one as a `system.tool_outcome` after
                        // a transport-level failure that shaped to
                        // interaction_required), trigger an interactive
                        // downstream-token acquisition so the next
                        // worker-bound RPC carries a freshly-acquired
                        // token. Debounced per session id to avoid popup
                        // storms when an agent emits the outcome multiple
                        // times in quick succession.
                        this.maybeTriggerInteractiveReauth(message.sessionId, message.event);
                        const handlers = this.sessionSubscribers.get(message.sessionId);
                        if (handlers) {
                            for (const handler of handlers) handler(message.event);
                        }
                        return;
                    }
                    if (message.type === "logEntry") {
                        for (const handler of this.logSubscribers) handler(message.entry);
                    }
                } catch {}
            });

            socket.addEventListener("close", (event) => {
                this.socket = null;
                this.socketOpenPromise = null;
                if (event.code === 4401) {
                    this.onUnauthorized();
                    return;
                }
                if (event.code === 4403) {
                    this.onForbidden(event.reason || "Forbidden");
                    return;
                }
                this.scheduleReconnect();
            });

            socket.addEventListener("error", () => {
                this.scheduleReconnect();
            });

            await new Promise((resolve, reject) => {
                socket.addEventListener("open", resolve, { once: true });
                socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
                socket.addEventListener("close", (event) => {
                    if (event.code === 4401) reject(new Error("Unauthorized"));
                    if (event.code === 4403) reject(new Error(event.reason || "Forbidden"));
                }, { once: true });
            });

            this.resubscribeAll();
            return socket;
        })();

        try {
            return await this.socketOpenPromise;
        } finally {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                this.socketOpenPromise = null;
            }
        }
    }

    resubscribeAll() {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        for (const sessionId of this.sessionSubscribers.keys()) {
            this.socket.send(JSON.stringify({ type: "subscribeSession", sessionId }));
        }
        if (this.logSubscribers.size > 0) {
            this.socket.send(JSON.stringify({ type: "subscribeLogs" }));
        }
    }

    async listSessions() {
        return this.rpc("listSessions");
    }

    async listSessionGroups() {
        return this.rpc("listSessionGroups");
    }

    async createSessionGroup(input) {
        return this.rpc("createSessionGroup", { input });
    }

    async updateSessionGroup(groupId, patch) {
        return this.rpc("updateSessionGroup", { groupId, patch });
    }

    async assignSessionsToGroup(groupId, sessionIds) {
        return this.rpc("assignSessionsToGroup", { groupId, sessionIds });
    }

    async moveSessionsToGroup(groupId, sessionIds) {
        return this.rpc("moveSessionsToGroup", { groupId: groupId ?? null, sessionIds });
    }

    async getChildOutcome(childSessionId) {
        return this.rpc("getChildOutcome", { childSessionId });
    }

    async listChildOutcomes(parentSessionId) {
        return this.rpc("listChildOutcomes", { parentSessionId });
    }

    async listSessionsPage(opts = {}) {
        return this.rpc("listSessionsPage", {
            limit: opts?.limit,
            cursor: opts?.cursor ?? null,
            includeDeleted: opts?.includeDeleted,
        });
    }

    async getSession(sessionId) {
        return this.rpc("getSession", { sessionId });
    }

    async getOrchestrationStats(sessionId) {
        return this.rpc("getOrchestrationStats", { sessionId });
    }

    async getSessionMetricSummary(sessionId) {
        return this.rpc("getSessionMetricSummary", { sessionId });
    }

    async getSessionTreeStats(sessionId) {
        return this.rpc("getSessionTreeStats", { sessionId });
    }

    async getFleetStats(opts) {
        return this.rpc("getFleetStats", {
            includeDeleted: opts?.includeDeleted,
            since: opts?.since instanceof Date ? opts.since.toISOString() : opts?.since,
        });
    }

    async getUserStats(opts) {
        return this.rpc("getUserStats", {
            includeDeleted: opts?.includeDeleted,
            since: opts?.since instanceof Date ? opts.since.toISOString() : opts?.since,
        });
    }

    async getTopEventEmitters(opts = {}) {
        return this.rpc("getTopEventEmitters", {
            since: opts?.since instanceof Date ? opts.since.toISOString() : opts?.since,
            limit: opts?.limit,
        });
    }

    async getCurrentUserProfile() {
        return this.rpc("getCurrentUserProfile", {});
    }

    async setCurrentUserProfileSettings({ settings } = {}) {
        return this.rpc("setCurrentUserProfileSettings", {
            settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {},
        });
    }

    async setCurrentUserGitHubCopilotKey({ key } = {}) {
        return this.rpc("setCurrentUserGitHubCopilotKey", {
            key: typeof key === "string" ? key : null,
        });
    }

    async getSessionSkillUsage(sessionId, opts) {
        return this.rpc("getSessionSkillUsage", {
            sessionId,
            since: opts?.since instanceof Date ? opts.since.toISOString() : opts?.since,
        });
    }

    async getSessionTreeSkillUsage(sessionId, opts) {
        return this.rpc("getSessionTreeSkillUsage", {
            sessionId,
            since: opts?.since instanceof Date ? opts.since.toISOString() : opts?.since,
        });
    }

    async getFleetSkillUsage(opts) {
        return this.rpc("getFleetSkillUsage", {
            includeDeleted: opts?.includeDeleted,
            since: opts?.since instanceof Date ? opts.since.toISOString() : opts?.since,
        });
    }

    async getSessionFactsStats(sessionId) {
        return this.rpc("getSessionFactsStats", { sessionId });
    }

    async getSessionTreeFactsStats(sessionId) {
        return this.rpc("getSessionTreeFactsStats", { sessionId });
    }

    async getSharedFactsStats() {
        return this.rpc("getSharedFactsStats", {});
    }

    async pruneDeletedSummaries(olderThan) {
        return this.rpc("pruneDeletedSummaries", {
            olderThan: olderThan instanceof Date ? olderThan.toISOString() : olderThan,
        });
    }

    async getExecutionHistory(sessionId, executionId) {
        return this.rpc("getExecutionHistory", { sessionId, executionId });
    }

    async createSession(options = {}) {
        return this.rpc("createSession", options);
    }

    async createSessionForAgent(agentName, options = {}) {
        return this.rpc("createSessionForAgent", { agentName, ...options });
    }

    async listCreatableAgents() {
        return this.bootstrap?.creatableAgents || this.rpc("listCreatableAgents");
    }

    getSessionCreationPolicy() {
        return this.bootstrap?.sessionCreationPolicy || null;
    }

    async sendMessage(sessionId, prompt, options = {}) {
        return this.rpc("sendMessage", { sessionId, prompt, options });
    }

    async sendAnswer(sessionId, answer) {
        return this.rpc("sendAnswer", { sessionId, answer });
    }

    async cancelPendingMessage(sessionId, clientMessageIds) {
        return this.rpc("cancelPendingMessage", { sessionId, clientMessageIds });
    }

    async renameSession(sessionId, title) {
        return this.rpc("renameSession", { sessionId, title });
    }

    async cancelSession(sessionId) {
        return this.rpc("cancelSession", { sessionId });
    }

    async cancelSessionGroup(groupId, reason) {
        return this.rpc("cancelSessionGroup", { groupId, reason });
    }

    async completeSession(sessionId, reason) {
        return this.rpc("completeSession", { sessionId, reason });
    }

    async completeSessionGroup(groupId, options = {}) {
        return this.rpc("completeSessionGroup", { groupId, options });
    }

    async deleteSession(sessionId) {
        return this.rpc("deleteSession", { sessionId });
    }

    async restartSystemSession(agentIdOrSessionId, options = {}) {
        return this.rpc("restartSystemSession", { agentIdOrSessionId, options });
    }

    async deleteSessionGroup(groupId) {
        return this.rpc("deleteSessionGroup", { groupId });
    }

    async listModels() {
        return this.rpc("listModels");
    }

    async listArtifacts(sessionId) {
        return this.rpc("listArtifacts", { sessionId });
    }

    async getArtifactMetadata(sessionId, filename) {
        return this.rpc("getArtifactMetadata", { sessionId, filename });
    }

    async deleteArtifact(sessionId, filename) {
        return this.rpc("deleteArtifact", { sessionId, filename });
    }

    async downloadArtifact(sessionId, filename) {
        return this.rpc("downloadArtifact", { sessionId, filename });
    }

    async uploadArtifactFromFile(sessionId, file) {
        if (!file || typeof file.name !== "string") {
            throw new Error("A browser File is required for upload");
        }
        const content = encodeBytesToBase64(new Uint8Array(await file.arrayBuffer()));
        return this.rpc("uploadArtifact", {
            sessionId,
            filename: file.name,
            content,
            contentType: file.type || undefined,
            contentEncoding: "base64",
        });
    }

    getArtifactExportDirectory() {
        return "Browser downloads";
    }

    async saveArtifactDownload(sessionId, filename) {
        const token = await this.getAccessToken();
        const headers = new Headers();
        if (token) headers.set("authorization", `Bearer ${token}`);

        const response = await fetch(
            `/api/sessions/${encodePathSegment(sessionId)}/artifacts/${encodePathSegment(filename)}/download`,
            { method: "GET", headers },
        );
        if (response.status === 401) {
            this.onUnauthorized();
            throw new Error("Unauthorized");
        }
        if (response.status === 403) {
            const message = await readErrorMessage(response);
            this.onForbidden(message || "Forbidden");
            throw new Error(message || "Forbidden");
        }
        if (!response.ok) {
            throw new Error(await readErrorMessage(response));
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = blobUrl;
        anchor.download = filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        return {
            localPath: `browser-download://${sessionId}/${filename}`,
            filename,
        };
    }

    async openUrlInDefaultBrowser(targetUrl) {
        const href = String(targetUrl || "").trim();
        if (!href) {
            throw new Error("URL cannot be empty.");
        }
        const parsedUrl = new URL(href, window.location.href);
        if (!/^https?:$/i.test(parsedUrl.protocol)) {
            throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
        }
        window.open(parsedUrl.toString(), "_blank", "noopener,noreferrer");
        return { url: parsedUrl.toString() };
    }

    async exportExecutionHistory(sessionId) {
        return this.rpc("exportExecutionHistory", { sessionId });
    }

    async getSessionEvents(sessionId, afterSeq, limit) {
        return this.rpc("getSessionEvents", { sessionId, afterSeq, limit });
    }

    async getSessionEventsBefore(sessionId, beforeSeq, limit) {
        return this.rpc("getSessionEventsBefore", { sessionId, beforeSeq, limit });
    }

    /**
     * Phase 6 (FR-011): inspect a session event for an
     * `interaction_required` outcome and, if present, fire-and-forget an
     * interactive downstream-token acquisition. The provider's popup /
     * redirect path runs to completion; on success, the cached
     * downstream token is refreshed in place and the next worker-bound
     * RPC's `getDownstreamToken({ interactive: false })` returns the
     * fresh token (FR-011, SC-006).
     *
     * Debounced per session id (one trigger per ~30 seconds) so an agent
     * that emits the outcome multiple times in quick succession does not
     * cause a popup storm. A global in-flight guard prevents two
     * sessions from racing two popups concurrently. Errors are
     * swallowed; the existing UI badge (🔐 [reauth required]) plus the
     * portal's manual sign-out/sign-in path remain available as
     * fallbacks.
     */
    maybeTriggerInteractiveReauth(sessionId, sessionEvent) {
        if (!sessionId || !sessionEvent) return;
        const data = sessionEvent.data || {};
        const eventType = sessionEvent.type;
        const isToolComplete = eventType === "tool.execution_complete"
            && data.outcome === "interaction_required";
        const isSyntheticOutcome = eventType === "system.tool_outcome"
            && data.outcome === "interaction_required";
        if (!isToolComplete && !isSyntheticOutcome) return;
        const now = Date.now();
        const last = this.lastInteractiveReauthAtBySession.get(sessionId) || 0;
        if (now - last < 30_000) return;
        if (this.interactiveReauthInFlight) return;
        if (this.lastInteractiveReauthAtBySession.size > 32) {
            const oldestKey = this.lastInteractiveReauthAtBySession.keys().next().value;
            if (oldestKey !== undefined) this.lastInteractiveReauthAtBySession.delete(oldestKey);
        }
        this.lastInteractiveReauthAtBySession.set(sessionId, now);
        this.interactiveReauthInFlight = true;
        Promise.resolve()
            .then(() => this.getDownstreamToken({ interactive: true }))
            .catch(() => null)
            .finally(() => {
                this.interactiveReauthInFlight = false;
            });
    }

    subscribeSession(sessionId, handler) {
        if (!this.sessionSubscribers.has(sessionId)) {
            this.sessionSubscribers.set(sessionId, new Set());
        }
        const handlers = this.sessionSubscribers.get(sessionId);
        handlers.add(handler);

        this.ensureSocket().then((socket) => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({ type: "subscribeSession", sessionId }));
        }).catch(() => {});

        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.sessionSubscribers.delete(sessionId);
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: "unsubscribeSession", sessionId }));
                }
            }
        };
    }

    startLogTail(handler) {
        this.logSubscribers.add(handler);
        this.ensureSocket().then((socket) => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({ type: "subscribeLogs" }));
        }).catch(() => {});

        return () => {
            this.logSubscribers.delete(handler);
            if (this.logSubscribers.size === 0 && this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: "unsubscribeLogs" }));
            }
        };
    }
}
