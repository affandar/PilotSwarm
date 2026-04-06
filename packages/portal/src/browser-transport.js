function encodePathSegment(value) {
    return encodeURIComponent(String(value || ""));
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
    constructor({ getAccessToken, onUnauthorized }) {
        this.getAccessToken = typeof getAccessToken === "function" ? getAccessToken : async () => null;
        this.onUnauthorized = typeof onUnauthorized === "function" ? onUnauthorized : () => {};
        this.bootstrap = null;
        this.socket = null;
        this.socketOpenPromise = null;
        this.reconnectTimer = null;
        this.stopped = false;
        this.sessionSubscribers = new Map();
        this.logSubscribers = new Set();
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
        return this.fetchJson("/api/rpc", {
            method: "POST",
            body: JSON.stringify({ method, params }),
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

    async getSession(sessionId) {
        return this.rpc("getSession", { sessionId });
    }

    async getOrchestrationStats(sessionId) {
        return this.rpc("getOrchestrationStats", { sessionId });
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

    async renameSession(sessionId, title) {
        return this.rpc("renameSession", { sessionId, title });
    }

    async cancelSession(sessionId) {
        return this.rpc("cancelSession", { sessionId });
    }

    async completeSession(sessionId, reason) {
        return this.rpc("completeSession", { sessionId, reason });
    }

    async deleteSession(sessionId) {
        return this.rpc("deleteSession", { sessionId });
    }

    async listModels() {
        return this.rpc("listModels");
    }

    async listArtifacts(sessionId) {
        return this.rpc("listArtifacts", { sessionId });
    }

    async downloadArtifact(sessionId, filename) {
        return this.rpc("downloadArtifact", { sessionId, filename });
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

    async exportExecutionHistory(sessionId) {
        return this.rpc("exportExecutionHistory", { sessionId });
    }

    async getSessionEvents(sessionId, afterSeq, limit) {
        return this.rpc("getSessionEvents", { sessionId, afterSeq, limit });
    }

    async getSessionEventsBefore(sessionId, beforeSeq, limit) {
        return this.rpc("getSessionEventsBefore", { sessionId, beforeSeq, limit });
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
