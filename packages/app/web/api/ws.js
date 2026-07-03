import { WebSocketServer } from "ws";
import { authenticateToken, extractToken } from "../auth.js";

/**
 * The Web API streaming endpoint: session events and the live log tail.
 *
 * One connection handler serves both `/api/v1/ws` (the product API) and the
 * legacy `/portal-ws` (which additionally answers the portal-only `theme`
 * message). Vocabulary:
 *   client -> server: subscribeSession | unsubscribeSession | subscribeLogs | unsubscribeLogs
 *   server -> client: ready | subscribedSession | sessionEvent | subscribedLogs | logEntry | error
 *
 * Delivery here is an acceleration path — correctness comes from event
 * replay via GET /api/v1/management/sessions/:id/events?afterSeq=… after a
 * reconnect.
 */

function isSafeThemeId(value) {
    return /^[\w-]+$/u.test(String(value || ""));
}

export function createConnectionHandler(runtime, { allowThemeMessages = false } = {}) {
    return async function handleConnection(ws, req) {
        const auth = await authenticateToken(extractToken(req), req);
        if (!auth.ok) {
            ws.close(auth.status === 403 ? 4403 : 4401, auth.error || (auth.status === 403 ? "Forbidden" : "Unauthorized"));
            return;
        }

        const sessionSubscriptions = new Map();
        let logUnsubscribe = null;

        const send = (message) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(message));
            }
        };

        send({ type: "ready" });

        ws.on("message", async (raw) => {
            let message;
            try {
                message = JSON.parse(String(raw));
            } catch {
                return;
            }

            const type = String(message?.type || "");
            if (type === "subscribeSession") {
                const sessionId = String(message?.sessionId || "").trim();
                if (!sessionId || sessionSubscriptions.has(sessionId)) return;
                try {
                    await runtime.start();
                    const unsubscribe = runtime.subscribeSession(sessionId, (event) => {
                        send({ type: "sessionEvent", sessionId, event });
                    });
                    sessionSubscriptions.set(sessionId, unsubscribe);
                    send({ type: "subscribedSession", sessionId });
                } catch (error) {
                    send({ type: "error", scope: "session", sessionId, error: error?.message || String(error) });
                }
                return;
            }

            if (type === "unsubscribeSession") {
                const sessionId = String(message?.sessionId || "").trim();
                const unsubscribe = sessionSubscriptions.get(sessionId);
                if (unsubscribe) {
                    unsubscribe();
                    sessionSubscriptions.delete(sessionId);
                }
                return;
            }

            if (type === "subscribeLogs") {
                if (logUnsubscribe) return;
                try {
                    await runtime.start();
                    logUnsubscribe = runtime.startLogTail((entry) => {
                        send({ type: "logEntry", entry });
                    });
                    send({ type: "subscribedLogs" });
                } catch (error) {
                    send({ type: "error", scope: "logs", error: error?.message || String(error) });
                }
                return;
            }

            if (type === "unsubscribeLogs") {
                if (logUnsubscribe) {
                    logUnsubscribe();
                    logUnsubscribe = null;
                }
                return;
            }

            if (allowThemeMessages && type === "theme" && isSafeThemeId(message?.themeId)) {
                send({ type: "themeAck", themeId: message.themeId });
            }
        });

        ws.on("close", () => {
            for (const unsubscribe of sessionSubscriptions.values()) {
                try {
                    unsubscribe();
                } catch {}
            }
            sessionSubscriptions.clear();
            if (logUnsubscribe) {
                try {
                    logUnsubscribe();
                } catch {}
                logUnsubscribe = null;
            }
        });
    };
}

/**
 * Mount WebSocket endpoints on the shared HTTP server.
 *
 * Multiple path-bound WebSocketServers cannot share one HTTP server (each
 * competes for the 'upgrade' event), so this routes upgrades manually with
 * noServer-mode servers — one per endpoint.
 *
 * @param {import("node:http").Server} server
 * @param {object} runtime
 * @param {Array<{ path: string, allowThemeMessages?: boolean }>} endpoints
 * @returns {WebSocketServer[]}
 */
export function attachWebSockets(server, runtime, endpoints) {
    const byPath = new Map(endpoints.map(({ path, allowThemeMessages = false }) => {
        const wss = new WebSocketServer({ noServer: true });
        wss.on("connection", createConnectionHandler(runtime, { allowThemeMessages }));
        return [path, wss];
    }));

    server.on("upgrade", (req, socket, head) => {
        const { pathname } = new URL(req.url || "/", "http://localhost");
        const wss = byPath.get(pathname);
        if (!wss) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    });

    return [...byPath.values()];
}
