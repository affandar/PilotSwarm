import { API_PREFIX, ApiError, WS_PATH, artifactDownloadPath, buildOperationRequest } from "./protocol.js";
import { jsonMergePatch } from "./canvas-live-mirror.js";

const RECONNECT_DELAY_MS = 1500;

function normalizeApiUrl(apiUrl) {
    const raw = String(apiUrl || "").trim();
    if (!raw) throw new Error("ApiClient requires an apiUrl");
    return raw.replace(/\/+$/, "");
}

function toWebSocketUrl(apiUrl) {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${WS_PATH}`;
    url.search = "";
    return url.toString();
}

async function readErrorEnvelope(response) {
    let message = response.statusText || `HTTP ${response.status}`;
    let code = response.status === 401 ? "UNAUTHORIZED" : response.status === 403 ? "FORBIDDEN" : "INTERNAL_ERROR";
    let candidates;
    try {
        const payload = await response.json();
        const error = payload?.error;
        if (typeof error === "string" && error) message = error;
        else if (error && typeof error === "object") {
            if (error.message) message = error.message;
            if (error.code) code = error.code;
            if (Array.isArray(error.candidates)) candidates = error.candidates;
        } else if (payload?.message) {
            message = payload.message;
        }
    } catch {}
    return new ApiError(message, { code, status: response.status, candidates });
}

/**
 * Typed low-level client for the PilotSwarm Web API.
 *
 * Isomorphic: runs in browsers and Node. `fetch` and `WebSocket` come from
 * the global environment unless injected (`fetchImpl` / `WebSocketImpl`).
 */
export class ApiClient {
    constructor({
        apiUrl,
        getAccessToken,
        onUnauthorized,
        onForbidden,
        fetchImpl,
        WebSocketImpl,
    } = {}) {
        this.apiUrl = normalizeApiUrl(apiUrl);
        this.getAccessToken = typeof getAccessToken === "function" ? getAccessToken : async () => null;
        this.onUnauthorized = typeof onUnauthorized === "function" ? onUnauthorized : () => {};
        this.onForbidden = typeof onForbidden === "function" ? onForbidden : () => {};
        this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
        this.WebSocketImpl = WebSocketImpl || globalThis.WebSocket;

        this.socket = null;
        this.socketOpenPromise = null;
        this.reconnectTimer = null;
        this.stopped = false;
        this.hasConnected = false;
        this.sessionSubscribers = new Map();
        this.sessionResubscribeHandlers = new Map();
        this.logSubscribers = new Set();
        this.canvasSubscribers = new Map();
        this.liveSubscribers = new Map();
        this.liveSequences = new Map();
        this.liveRefetches = new Map();
        this.liveValues = new Map();
        this.liveRefetchTargets = new Map();
    }

    // ── HTTP ────────────────────────────────────────────────────────────

    async authHeaders(extra = {}) {
        // Bounded: a token getter that neither resolves nor rejects (wedged
        // silent renewal) must not hang every REST call behind it — proceed
        // tokenless after 12s and let the server's 401 drive re-auth.
        const token = await Promise.race([
            Promise.resolve().then(() => this.getAccessToken()).catch(() => null),
            new Promise((resolve) => {
                const t = setTimeout(() => resolve(null), 12_000);
                if (typeof t?.unref === "function") t.unref();
            }),
        ]);
        const headers = { ...extra };
        if (token) headers.authorization = `Bearer ${token}`;
        return headers;
    }

    async request(method, pathWithQuery, { body, headers, authProbe = false } = {}) {
        const requestHeaders = await this.authHeaders(headers || {});
        if (body !== undefined && !requestHeaders["content-type"]) {
            requestHeaders["content-type"] = "application/json";
        }
        const response = await this.fetchImpl(`${this.apiUrl}${pathWithQuery}`, {
            method,
            headers: requestHeaders,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (response.status === 401) {
            this.onUnauthorized();
            throw await readErrorEnvelope(response);
        }
        if (response.status === 403) {
            const error = await readErrorEnvelope(response);
            // Only an ADMISSION probe (/auth/me, /bootstrap) flips the whole
            // app to the "access denied" gate. A per-operation 403 (e.g. a
            // non-owner tries to rename) is a normal authz denial — throw it so
            // the caller surfaces it inline, don't sign the user out of the app.
            if (authProbe) this.onForbidden(error.message || "Forbidden");
            throw error;
        }
        if (!response.ok) {
            throw await readErrorEnvelope(response);
        }
        const payload = await response.json();
        if (payload && payload.ok === false) {
            const error = payload.error;
            throw new ApiError(
                (typeof error === "object" ? error?.message : error) || "Request failed",
                { code: (typeof error === "object" && error?.code) || "INTERNAL_ERROR", status: response.status },
            );
        }
        return payload?.result !== undefined ? payload.result : payload;
    }

    /** Invoke a protocol operation by name with rpc-shaped params. */
    async call(name, params = {}) {
        const { method, path, query, body } = buildOperationRequest(name, params);
        // Avoid URLSearchParams.prototype.size (absent on Safari 16 / iOS 16,
        // which the portal build targets); toString() is universally supported.
        const queryString = query.toString();
        const suffix = queryString ? `?${queryString}` : "";
        return this.request(method, `${path}${suffix}`, body !== null ? { body } : {});
    }

    // ── Bespoke (non-table) endpoints ───────────────────────────────────

    async health() {
        return this.request("GET", `${API_PREFIX}/health`);
    }

    /** Public: no token required. */
    async getAuthConfig() {
        const response = await this.fetchImpl(`${this.apiUrl}${API_PREFIX}/auth/config`, { method: "GET" });
        if (!response.ok) throw await readErrorEnvelope(response);
        return response.json();
    }

    async getAuthContext() {
        return this.request("GET", `${API_PREFIX}/auth/me`, { authProbe: true });
    }

    async getBootstrap() {
        return this.request("GET", `${API_PREFIX}/bootstrap`, { authProbe: true });
    }

    /** Raw artifact download; returns the Response for streaming/blob use. */
    async downloadArtifactResponse(sessionId, filename) {
        const headers = await this.authHeaders();
        const response = await this.fetchImpl(`${this.apiUrl}${artifactDownloadPath(sessionId, filename)}`, {
            method: "GET",
            headers,
        });
        if (response.status === 401) {
            this.onUnauthorized();
            throw await readErrorEnvelope(response);
        }
        if (response.status === 403) {
            // Per-artifact denial (no access to this session) — surface inline,
            // don't flip the whole app to the admission gate.
            throw await readErrorEnvelope(response);
        }
        if (!response.ok) throw await readErrorEnvelope(response);
        return response;
    }

    async downloadAgentPackageResponse(name, { semver, scope, ownerProvider, ownerSubject } = {}) {
        const query = new URLSearchParams();
        if (semver) query.set("semver", semver);
        if (scope) query.set("scope", scope);
        if (ownerProvider) query.set("ownerProvider", ownerProvider);
        if (ownerSubject) query.set("ownerSubject", ownerSubject);
        const suffix = query.toString() ? `?${query}` : "";
        const headers = await this.authHeaders();
        const response = await this.fetchImpl(
            `${this.apiUrl}${API_PREFIX}/agent-packages/${encodeURIComponent(name)}/download${suffix}`,
            { method: "GET", headers },
        );
        if (response.status === 401) this.onUnauthorized();
        if (!response.ok) throw await readErrorEnvelope(response);
        return response;
    }

    // ── WebSocket (session events + log tail) ───────────────────────────

    async start() {
        this.stopped = false;
    }

    async stop() {
        this.stopped = true;
        this.hasConnected = false;
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
        this.sessionResubscribeHandlers.clear();
        this.logSubscribers.clear();
        this.canvasSubscribers.clear();
        this.liveSubscribers.clear();
        this.liveSequences.clear();
        this.liveRefetches.clear();
        this.liveValues.clear();
        this.liveRefetchTargets.clear();
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        if (this.sessionSubscribers.size === 0
            && this.logSubscribers.size === 0
            && this.canvasSubscribers.size === 0
            && this.liveSubscribers.size === 0) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.ensureSocket().catch(() => {});
        }, RECONNECT_DELAY_MS);
    }

    async ensureSocket() {
        if (this.stopped) return null;
        const WebSocketImpl = this.WebSocketImpl;
        if (!WebSocketImpl) throw new Error("No WebSocket implementation available");
        if (this.socket && this.socket.readyState === WebSocketImpl.OPEN) {
            return this.socket;
        }
        if (this.socketOpenPromise) {
            return this.socketOpenPromise;
        }

        this.socketOpenPromise = (async () => {
            let socket;
            try {
                const token = await this.getAccessToken();
                const socketUrl = toWebSocketUrl(this.apiUrl);
                socket = token
                    // A subprotocol value must be an RFC 6455 token: no ":"
                    // (dev tokens are `dev:<persona>`), no spaces. Percent-
                    // encoding keeps every JWT byte-identical (base64url has
                    // nothing to escape) and makes the others legal; the
                    // server decodes.
                    ? new WebSocketImpl(socketUrl, ["access_token", encodeURIComponent(token)])
                    : new WebSocketImpl(socketUrl);
            } catch (error) {
                // getAccessToken rejected or the constructor threw before any
                // socket exists — no close/error event will fire, so schedule
                // the retry here or the connection dies permanently.
                this.socket = null;
                this.scheduleReconnect();
                throw error;
            }
            this.socket = socket;

            socket.addEventListener("message", (event) => {
                try {
                    const message = JSON.parse(String(event.data || ""));
                    if (message.type === "error" && message.code === "ACCESS_REVOKED" && message.sessionId) {
                        for (const key of this.liveValues.keys()) {
                            if (key.startsWith(`${message.sessionId}\u0000`)) this.liveValues.delete(key);
                        }
                        for (const key of this.liveSubscribers.keys()) {
                            const [sessionId, topic] = key.split("\u0000");
                            if (sessionId !== message.sessionId) continue;
                            // Use the normal invalidation path: besides the
                            // retained value it invalidates an in-flight gap
                            // fetch, so its older authorized reply cannot
                            // repopulate a revoked live-only subscription.
                            void this.handleLiveMessage({ kind: "unavailable", sessionId, topic, accessRevoked: true });
                        }
                        for (const handler of this.sessionSubscribers.get(message.sessionId) || []) {
                            handler({ eventType: "session.access_revoked", sessionId: message.sessionId });
                        }
                        return;
                    }
                    if (message.type === "sessionEvent") {
                        const handlers = this.sessionSubscribers.get(message.sessionId);
                        if (handlers) {
                            for (const handler of handlers) handler(message.event);
                        }
                        return;
                    }
                    if (message.type === "logEntry") {
                        for (const handler of this.logSubscribers) handler(message.entry);
                        return;
                    }
                    if (message.type === "canvasLive") {
                        const handlers = this.canvasSubscribers.get(message.sessionId);
                        if (handlers) {
                            for (const handler of handlers) handler(message);
                        }
                        return;
                    }
                    if (message.type === "live") {
                        void this.handleLiveMessage(message);
                        return;
                    }
                    // A canvas-scope error (plane unavailable, authz change,
                    // server rollback) releases the mirror's takeover of that
                    // session — otherwise legacy events would stay suppressed
                    // against a plane that will never push again: a frozen
                    // canvas.
                    if (message.type === "error" && message.scope === "canvas" && message.sessionId) {
                        const handlers = this.canvasSubscribers.get(message.sessionId);
                        if (handlers) {
                            for (const handler of handlers) handler({ kind: "unavailable", sessionId: message.sessionId });
                        }
                    }
                    if (message.type === "error" && message.scope === "live" && message.sessionId) {
                        for (const key of this.liveSubscribers.keys()) {
                            if (!key.startsWith(`${message.sessionId}\u0000`)) continue;
                            void this.handleLiveMessage({ kind: "unavailable", sessionId: message.sessionId, topic: key.split("\u0000")[1] });
                        }
                    }
                } catch {}
            });

            socket.addEventListener("close", (event) => {
                this.socket = null;
                this.socketOpenPromise = null;
                for (const [key, handlers] of this.liveSubscribers) {
                    const [sessionId, topic] = key.split("\u0000");
                    for (const handler of handlers) {
                        try { handler({ kind: "unavailable", sessionId, topic }); } catch {}
                    }
                }
                this.liveValues.clear();
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
                    if (event.code === 4401) reject(new ApiError("Unauthorized", { code: "UNAUTHORIZED", status: 401 }));
                    if (event.code === 4403) reject(new ApiError(event.reason || "Forbidden", { code: "FORBIDDEN", status: 403 }));
                }, { once: true });
            });

            const isReconnect = this.hasConnected;
            this.hasConnected = true;
            this.resubscribeAll(isReconnect);
            return socket;
        })();

        try {
            return await this.socketOpenPromise;
        } finally {
            if (!this.socket || this.socket.readyState !== WebSocketImpl.OPEN) {
                this.socketOpenPromise = null;
            }
        }
    }

    socketSend(message) {
        if (this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }

    async handleLiveMessage(message) {
        const key = `${message.sessionId}\u0000${message.topic}`;
        const handlers = this.liveSubscribers.get(key);
        if (!handlers || handlers.size === 0) return;
        if (message.kind === "unavailable") {
            this.liveSequences.delete(key);
            this.liveValues.delete(key);
            this.liveRefetches.delete(key);
            this.liveRefetchTargets.delete(key);
            for (const handler of handlers) { try { handler(message); } catch {} }
            return;
        }
        if (message.kind === "signal") {
            for (const handler of handlers) {
                try { handler(message); } catch {}
            }
            return;
        }

        const seq = Number(message.seq);
        if (!Number.isFinite(seq) || seq < 1) return;
        const previous = this.liveSequences.get(key);
        if (previous != null && seq === previous) return;
        if (message.kind === "snapshot" && previous != null && seq < previous) return;

        // A patch is meaningful only against its immediate predecessor. The
        // subscribe burst is a snapshot, so no predecessor means a missed
        // burst too. Collapse concurrent gaps into one authoritative read.
        if (message.kind === "patch" && (previous == null || seq !== previous + 1)) {
            if (seq > Number(this.liveRefetchTargets.get(key)?.seq || 0)) {
                this.liveRefetchTargets.set(key, message);
            }
            if (!this.liveRefetches.has(key)) {
                const allowSequenceReset = previous != null && seq < previous;
                const refetch = this.call("getLive", {
                    sessionId: message.sessionId,
                    topics: [message.topic],
                }).then((rows) => {
                    const row = (rows || []).find((candidate) => candidate?.topic === message.topic);
                    const currentHandlers = this.liveSubscribers.get(key);
                    // The last subscriber may have left and a new subscription
                    // for the same key may already exist. Do not let the old
                    // request inject its snapshot into that new subscription.
                    if (!row || currentHandlers !== handlers || currentHandlers.size === 0
                        || this.liveRefetches.get(key) !== refetch) return;
                    const snapshotSeq = Number(row.seq);
                    if (!Number.isFinite(snapshotSeq) || snapshotSeq < 1) return;
                    const seen = this.liveSequences.get(key);
                    if (seen != null && (
                        (!allowSequenceReset && snapshotSeq <= seen)
                        || (allowSequenceReset && (snapshotSeq === seen || (snapshotSeq < seen && seen !== previous)))
                    )) return;
                    this.liveSequences.set(key, snapshotSeq);
                    const snapshot = {
                        type: "live",
                        sessionId: message.sessionId,
                        topic: message.topic,
                        seq: snapshotSeq,
                        kind: "snapshot",
                        data: row.payload || {},
                        ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
                    };
                    this.liveValues.set(key, snapshot);
                    for (const handler of currentHandlers) {
                        try { handler(snapshot); } catch {}
                    }
                }).catch(() => {
                    // A later notification retries the authoritative read;
                    // durable session events remain the product fallback.
                }).finally(() => {
                    // A replacement subscription can already have started a
                    // newer refetch for this key; do not erase its guard.
                    if (this.liveRefetches.get(key) === refetch) {
                        this.liveRefetches.delete(key);
                        const latest = this.liveRefetchTargets.get(key);
                        this.liveRefetchTargets.delete(key);
                        // A notification that arrived DURING the read may be
                        // newer than its snapshot. Do not lose that last tick.
                        if (latest && latest !== message && this.liveSubscribers.get(key) === handlers) {
                            void this.handleLiveMessage(latest);
                        }
                    }
                });
                this.liveRefetches.set(key, refetch);
            }
            await this.liveRefetches.get(key);
            return;
        }

        this.liveSequences.set(key, seq);
        this.liveValues.set(key, {
            ...message, kind: "snapshot",
            data: message.kind === "patch"
                ? jsonMergePatch(this.liveValues.get(key)?.data || {}, message.data || {})
                : message.data,
        });
        for (const handler of handlers) {
            try { handler(message); } catch {}
        }
    }

    resubscribeAll(isReconnect = false) {
        if (isReconnect) {
            this.liveSequences.clear();
            this.liveValues.clear();
            this.liveRefetches.clear();
            this.liveRefetchTargets.clear();
        }
        for (const sessionId of this.sessionSubscribers.keys()) {
            this.socketSend({ type: "subscribeSession", sessionId });
            // On a RECONNECT, live delivery resumes but events emitted during
            // the outage were missed. Signal consumers so they can replay via
            // events?afterSeq. Not on the first connect — the consumer does its
            // own initial catch-up then.
            if (isReconnect) {
                for (const onResubscribe of this.sessionResubscribeHandlers.get(sessionId) || []) {
                    try {
                        onResubscribe();
                    } catch {}
                }
            }
        }
        if (this.logSubscribers.size > 0) {
            this.socketSend({ type: "subscribeLogs" });
        }
        for (const sessionId of this.canvasSubscribers.keys()) {
            this.socketSend({ type: "subscribeCanvas", sessionId });
        }
        const liveBySession = new Map();
        for (const key of this.liveSubscribers.keys()) {
            const [sessionId, topic] = key.split("\u0000");
            if (!liveBySession.has(sessionId)) liveBySession.set(sessionId, []);
            liveBySession.get(sessionId).push(topic);
        }
        for (const [sessionId, topics] of liveBySession) {
            this.socketSend({ type: "subscribeLive", sessionId, topics });
        }
    }

    /**
     * Register a subscription and make sure the server knows about it: when
     * the socket is already open, send the subscribe message directly;
     * otherwise connect, and resubscribeAll() announces it on open.
     */
    announceSubscription(message) {
        if (this.socket && this.socket.readyState === this.WebSocketImpl?.OPEN) {
            this.socketSend(message);
            return;
        }
        this.ensureSocket().catch(() => {});
    }

    /**
     * Subscribe to a session's events. `onResubscribe` (optional) fires after
     * every reconnect so the caller can replay events missed during the
     * outage — WS delivery is an acceleration path; replay is the correctness
     * mechanism.
     */
    subscribeSession(sessionId, handler, onResubscribe) {
        if (!this.sessionSubscribers.has(sessionId)) {
            this.sessionSubscribers.set(sessionId, new Set());
        }
        const handlers = this.sessionSubscribers.get(sessionId);
        handlers.add(handler);
        if (typeof onResubscribe === "function") {
            if (!this.sessionResubscribeHandlers.has(sessionId)) {
                this.sessionResubscribeHandlers.set(sessionId, new Set());
            }
            this.sessionResubscribeHandlers.get(sessionId).add(onResubscribe);
        }
        this.announceSubscription({ type: "subscribeSession", sessionId });

        return () => {
            handlers.delete(handler);
            const resubHandlers = this.sessionResubscribeHandlers.get(sessionId);
            if (resubHandlers && typeof onResubscribe === "function") resubHandlers.delete(onResubscribe);
            if (handlers.size === 0) {
                this.sessionSubscribers.delete(sessionId);
                this.sessionResubscribeHandlers.delete(sessionId);
                this.socketSend({ type: "unsubscribeSession", sessionId });
            }
        };
    }

    /**
     * Canvas-plane pushes for one session: `{slot, seq, kind, patch?}` per
     * write, straight off the database's NOTIFY — no poll cadence. A server
     * without the plane answers with an error message the caller treats as
     * "not supported"; durable events remain the fallback either way.
     */
    subscribeCanvasLive(sessionId, handler) {
        if (!this.canvasSubscribers.has(sessionId)) {
            this.canvasSubscribers.set(sessionId, new Set());
        }
        const handlers = this.canvasSubscribers.get(sessionId);
        handlers.add(handler);
        this.announceSubscription({ type: "subscribeCanvas", sessionId });
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.canvasSubscribers.delete(sessionId);
                this.socketSend({ type: "unsubscribeCanvas", sessionId });
            }
        };
    }

    /** Subscribe to one generic live-plane topic for a session. */
    subscribeLive(sessionId, topic, handler) {
        const normalizedSessionId = String(sessionId || "").trim();
        const normalizedTopic = String(topic || "").trim();
        if (!normalizedSessionId || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(normalizedTopic)) {
            throw new Error("subscribeLive requires a session id and valid topic");
        }
        const key = `${normalizedSessionId}\u0000${normalizedTopic}`;
        const alreadySubscribed = this.liveSubscribers.has(key);
        if (!alreadySubscribed && [...this.liveSubscribers.keys()].filter((candidate) => candidate.startsWith(`${normalizedSessionId}\u0000`)).length >= 16) {
            throw new Error("At most 16 live topics per session are supported");
        }
        if (!this.liveSubscribers.has(key)) this.liveSubscribers.set(key, new Set());
        const handlers = this.liveSubscribers.get(key);
        handlers.add(handler);
        const topics = [];
        for (const candidate of this.liveSubscribers.keys()) {
            const [sid, liveTopic] = candidate.split("\u0000");
            if (sid === normalizedSessionId) topics.push(liveTopic);
        }
        if (!alreadySubscribed) this.announceSubscription({ type: "subscribeLive", sessionId: normalizedSessionId, topics });
        else if (this.liveValues.has(key)) {
            try { handler(this.liveValues.get(key)); } catch {}
        }
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            handlers.delete(handler);
            if (handlers.size > 0 || this.liveSubscribers.get(key) !== handlers) return;
            this.liveSubscribers.delete(key);
            this.liveSequences.delete(key);
            this.liveRefetches.delete(key);
            this.liveRefetchTargets.delete(key);
            this.liveValues.delete(key);
            const remaining = [];
            for (const candidate of this.liveSubscribers.keys()) {
                const [sid, liveTopic] = candidate.split("\u0000");
                if (sid === normalizedSessionId) remaining.push(liveTopic);
            }
            this.socketSend({ type: "unsubscribeLive", sessionId: normalizedSessionId });
            if (remaining.length > 0) {
                this.socketSend({ type: "subscribeLive", sessionId: normalizedSessionId, topics: remaining });
            }
        };
    }

    subscribeLogs(handler) {
        this.logSubscribers.add(handler);
        this.announceSubscription({ type: "subscribeLogs" });

        return () => {
            this.logSubscribers.delete(handler);
            if (this.logSubscribers.size === 0) {
                this.socketSend({ type: "unsubscribeLogs" });
            }
        };
    }
}
