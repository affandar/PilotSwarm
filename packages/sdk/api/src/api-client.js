import { API_PREFIX, ApiError, WS_PATH, artifactDownloadPath, buildOperationRequest } from "./protocol.js";

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
    try {
        const payload = await response.json();
        const error = payload?.error;
        if (typeof error === "string" && error) message = error;
        else if (error && typeof error === "object") {
            if (error.message) message = error.message;
            if (error.code) code = error.code;
        } else if (payload?.message) {
            message = payload.message;
        }
    } catch {}
    return new ApiError(message, { code, status: response.status });
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
    }

    // ── HTTP ────────────────────────────────────────────────────────────

    async authHeaders(extra = {}) {
        const token = await this.getAccessToken();
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
        this.logSubscribers.clear();
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        if (this.sessionSubscribers.size === 0 && this.logSubscribers.size === 0) return;
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
                    ? new WebSocketImpl(socketUrl, ["access_token", token])
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
                    if (message.type === "sessionEvent") {
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

    resubscribeAll(isReconnect = false) {
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
