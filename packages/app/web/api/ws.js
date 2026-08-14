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
        // Canvas share tokens FIRST: presenting `?canvasShare=<token>` makes
        // this a token-bearer connection, full stop — it never falls back to
        // portal auth (on no-auth deployments anonymous auth SUCCEEDS, and a
        // fallback would silently upgrade a link bearer to a full-auth
        // connection — or, just as bad, break the share protocol by routing
        // it through the authed branch). A token connection may do exactly
        // one thing: subscribe to its canvas's plane pings, slot-filtered.
        // An invalid token closes 4401, indistinguishable from missing auth.
        const shareToken = new URL(req.url || "/", "http://localhost").searchParams.get("canvasShare");
        let shareScope = null;
        let shareRevalidateTimer = null;
        let auth = null;
        if (shareToken) {
            if (typeof runtime.resolveCanvasShareToken === "function") {
                shareScope = await runtime.resolveCanvasShareToken(shareToken).catch(() => null);
            }
            if (!shareScope) {
                ws.close(4401, "Unauthorized");
                return;
            }
            // Revocation has a bounded latency for OPEN sockets: the owner's
            // reset/remove replaces the hash row, and this re-validation
            // notices within the interval and closes the connection. Without
            // it, an already-connected bearer would keep receiving pings for
            // the connection's whole lifetime after the link died.
            const revalidateMs = Math.max(1, Number(process.env.PILOTSWARM_SHARE_REVALIDATE_MS) || 60_000);
            shareRevalidateTimer = setInterval(() => {
                runtime.resolveCanvasShareToken(shareToken)
                    .then((scope) => {
                        if (!scope || scope.sessionId !== shareScope.sessionId || scope.slot !== shareScope.slot) {
                            ws.close(4403, "Link no longer valid");
                        }
                    })
                    .catch(() => { /* transient — next tick retries */ });
            }, revalidateMs);
            if (shareRevalidateTimer.unref) shareRevalidateTimer.unref();
        } else {
            auth = await authenticateToken(extractToken(req), req);
            if (!auth.ok) {
                ws.close(auth.status === 403 ? 4403 : 4401, auth.error || (auth.status === 403 ? "Forbidden" : "Unauthorized"));
                return;
            }
        }
        // Same sign-in role capture as the HTTP `requireAuth` path. This is
        // the OTHER authenticated entry point, and it must not be forgotten:
        // a client that connects once and then lives on the socket would
        // otherwise never re-confirm its role, and the worker — which expires
        // stale observations — would quietly drop that user's agent sessions
        // to non-admin while the portal still showed them as admin.
        if (!shareScope && auth) runtime.noteSignInRole?.(auth);

        const sessionSubscriptions = new Map();
        const canvasSubscriptions = new Map();
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
            if (shareScope) {
                // The whole share-scope protocol: subscribe to THE canvas the
                // token names. No session events, no logs, no other sessions.
                if (type === "subscribeCanvas") {
                    // The bearer does not know (and is never told) the
                    // session id — the token IS the address. An absent or
                    // matching id subscribes the token's canvas; anything
                    // else is refused.
                    const requested = String(message?.sessionId || "").trim();
                    const sessionId = requested || shareScope.sessionId;
                    if (sessionId !== shareScope.sessionId || canvasSubscriptions.has(sessionId)) return;
                    const plane = runtime.canvasPlane;
                    if (!plane?.available) {
                        send({ type: "error", scope: "canvas", sessionId, error: "canvas plane unavailable" });
                        return;
                    }
                    const unsubscribe = plane.subscribe(sessionId, (update) => {
                        if (Number(update?.slot) !== shareScope.slot) return;
                        send({ type: "canvasLive", sessionId, ...update });
                    });
                    canvasSubscriptions.set(sessionId, unsubscribe);
                    send({ type: "subscribedCanvas", sessionId });
                } else if (type === "unsubscribeCanvas") {
                    const unsubscribe = canvasSubscriptions.get(shareScope.sessionId);
                    if (unsubscribe) {
                        unsubscribe();
                        canvasSubscriptions.delete(shareScope.sessionId);
                    }
                } else {
                    send({ type: "error", scope: "share", error: "share connections may only subscribe to their canvas" });
                }
                return;
            }
            if (type === "subscribeSession") {
                const sessionId = String(message?.sessionId || "").trim();
                if (!sessionId || sessionSubscriptions.has(sessionId)) return;
                try {
                    await runtime.start();
                    // Ownership/visibility gate: live events are a content
                    // read, same predicate as the REST catch-up path.
                    if (typeof runtime.authorizeSessionSubscribe === "function") {
                        await runtime.authorizeSessionSubscribe(sessionId, auth);
                    }
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

            if (type === "subscribeCanvas") {
                const sessionId = String(message?.sessionId || "").trim();
                if (!sessionId || canvasSubscriptions.has(sessionId)) return;
                const plane = runtime.canvasPlane;
                if (!plane?.available) {
                    send({ type: "error", scope: "canvas", sessionId, error: "canvas plane unavailable" });
                    return;
                }
                try {
                    await runtime.start();
                    // A canvas subscription is a session content read — the
                    // exact predicate live events use.
                    if (typeof runtime.authorizeSessionSubscribe === "function") {
                        await runtime.authorizeSessionSubscribe(sessionId, auth);
                    }
                    const unsubscribe = plane.subscribe(sessionId, (update) => {
                        send({ type: "canvasLive", sessionId, ...update });
                    });
                    canvasSubscriptions.set(sessionId, unsubscribe);
                    send({ type: "subscribedCanvas", sessionId });
                } catch (error) {
                    send({ type: "error", scope: "canvas", sessionId, error: error?.message || String(error) });
                }
                return;
            }

            if (type === "unsubscribeCanvas") {
                const sessionId = String(message?.sessionId || "").trim();
                const unsubscribe = canvasSubscriptions.get(sessionId);
                if (unsubscribe) {
                    unsubscribe();
                    canvasSubscriptions.delete(sessionId);
                }
                return;
            }

            if (type === "subscribeLogs") {
                if (logUnsubscribe) return;
                try {
                    await runtime.start();
                    // Log tail is fleet-wide observability: admin-gated.
                    if (typeof runtime.authorizeLogSubscribe === "function") {
                        await runtime.authorizeLogSubscribe(auth);
                    }
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
            if (shareRevalidateTimer) clearInterval(shareRevalidateTimer);
            for (const unsubscribe of sessionSubscriptions.values()) {
                try {
                    unsubscribe();
                } catch {}
            }
            sessionSubscriptions.clear();
            for (const unsubscribe of canvasSubscriptions.values()) {
                try {
                    unsubscribe();
                } catch {}
            }
            canvasSubscriptions.clear();
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
