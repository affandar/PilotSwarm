import { WebSocketServer } from "ws";
import { authenticateToken, extractToken } from "../auth.js";

/**
 * The Web API streaming endpoint: session events and the live log tail.
 *
 * One connection handler serves both `/api/v1/ws` (the product API) and the
 * legacy `/portal-ws` (which additionally answers the portal-only `theme`
 * message). Vocabulary:
 *   client -> server: subscribeSession | unsubscribeSession |
 *                     subscribeLive | unsubscribeLive |
 *                     subscribeLogs | unsubscribeLogs
 *   server -> client: ready | subscribedSession | sessionEvent |
 *                     subscribedLive | live | subscribedLogs | logEntry | error
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
        // Messages that arrive while auth is still being resolved (a client
        // that sends `subscribeCanvas` on `open`) must not be lost: the real
        // handler is attached only after the awaits below. Buffer them and
        // replay once it is. Measured before this: the share view lost its
        // subscribe about half the time.
        const early = [];
        let buffering = true;
        const earlyListener = (raw) => { if (buffering) early.push(raw); };
        ws.on("message", earlyListener);
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
        const liveSubscriptions = new Map();
        const liveSubscriptionGeneration = new Map();
        let logUnsubscribe = null;
        let accessCheckPending = false;
        // An open socket must not preserve a revoked grant indefinitely.
        // One bounded check per subscribed session per interval, not per delta;
        // session/live/canvas subscriptions share the same check.
        const accessRevalidateTimer = !shareScope && runtime.authz?.enforce
            ? setInterval(async () => {
                if (accessCheckPending || ws.readyState !== ws.OPEN) return;
                accessCheckPending = true;
                try {
                    const ids = new Set([...sessionSubscriptions.keys(), ...canvasSubscriptions.keys(), ...liveSubscriptions.keys()]);
                    for (const sessionId of ids) {
                        try {
                            await runtime.authorizeSessionSubscribe(sessionId, auth);
                        } catch {
                            sessionSubscriptions.get(sessionId)?.();
                            sessionSubscriptions.delete(sessionId);
                            canvasSubscriptions.get(sessionId)?.();
                            canvasSubscriptions.delete(sessionId);
                            liveSubscriptions.get(sessionId)?.unsubscribe();
                            liveSubscriptions.delete(sessionId);
                            liveSubscriptionGeneration.set(sessionId, (liveSubscriptionGeneration.get(sessionId) || 0) + 1);
                            send({ type: "error", scope: "session", sessionId, code: "ACCESS_REVOKED", error: "Session not found." });
                        }
                    }
                } finally { accessCheckPending = false; }
            }, Math.max(1, Number(process.env.PILOTSWARM_SESSION_REVALIDATE_MS) || 5_000))
            : null;
        accessRevalidateTimer?.unref?.();

        const send = (message) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(message));
            }
        };
        const sendSubscriptionError = (scope, sessionId, error) => {
            const denied = [403, 404].includes(error?.status) || ["FORBIDDEN", "NOT_FOUND"].includes(error?.code);
            send({ type: "error", scope, sessionId, ...(denied ? { code: "ACCESS_REVOKED" } : {}),
                error: denied ? "Session not found." : error?.message || String(error) });
        };

        send({ type: "ready" });

        // The real handler is registered synchronously right below. Stop
        // buffering NOW (so nothing is delivered twice) and replay what was
        // buffered after this tick, when the handler exists.
        buffering = false;
        setImmediate(() => {
            ws.off("message", earlyListener);
            for (const raw of early.splice(0)) ws.emit("message", raw, false);
        });

        ws.on("message", async (raw) => {
            let message;
            try {
                message = JSON.parse(String(raw));
            } catch {
                return;
            }

            const type = String(message?.type || "");
            if (!shareScope && type.startsWith("subscribe")
                && new Set([...sessionSubscriptions.keys(), ...canvasSubscriptions.keys(), ...liveSubscriptions.keys()]).size >= 64
                && !sessionSubscriptions.has(message.sessionId) && !canvasSubscriptions.has(message.sessionId) && !liveSubscriptions.has(message.sessionId)) {
                send({ type: "error", scope: "session", error: "Too many subscriptions." });
                return;
            }
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
                    // A bearer is never told the session id: the token IS the
                    // address, and the share view does not need it.
                    const unsubscribe = plane.subscribe(sessionId, (update) => {
                        if (Number(update?.slot) !== shareScope.slot) return;
                        send({ type: "canvasLive", ...update });
                    });
                    canvasSubscriptions.set(sessionId, unsubscribe);
                    send({ type: "subscribedCanvas" });
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
                    sendSubscriptionError("session", sessionId, error);
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
                    sendSubscriptionError("canvas", sessionId, error);
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

            if (type === "subscribeLive") {
                const sessionId = String(message?.sessionId || "").trim();
                const topics = [...new Set(Array.isArray(message?.topics)
                    ? message.topics.map((topic) => String(topic || "").trim())
                    : [])];
                if (!sessionId || topics.length === 0 || topics.length > 16
                    || topics.some((topic) => !/^[a-z][a-z0-9_.:-]{0,63}$/.test(topic))) {
                    send({ type: "error", scope: "live", sessionId, error: "invalid live subscription" });
                    return;
                }
                const generation = (liveSubscriptionGeneration.get(sessionId) || 0) + 1;
                liveSubscriptionGeneration.set(sessionId, generation);
                const previous = liveSubscriptions.get(sessionId);
                if (previous) {
                    previous.unsubscribe();
                    liveSubscriptions.delete(sessionId);
                }
                const plane = runtime.livePlane;
                if (!plane?.available) {
                    send({ type: "error", scope: "live", sessionId, error: "live plane unavailable" });
                    return;
                }
                try {
                    await runtime.start();
                    if (typeof runtime.authorizeSessionSubscribe === "function") {
                        await runtime.authorizeSessionSubscribe(sessionId, auth);
                    }
                    if (liveSubscriptionGeneration.get(sessionId) !== generation) return;

                    // Subscribe before reading the burst so no notification is
                    // lost in between. Buffer until the snapshot is sent to
                    // preserve burst-before-live ordering for the browser.
                    let bursting = true;
                    const queued = [];
                    const unsubscribe = plane.subscribe(sessionId, topics, (update) => {
                        if (liveSubscriptionGeneration.get(sessionId) !== generation) return;
                        // Bound both the initial read queue and a slow socket.
                        // Reconnect performs an authoritative snapshot burst.
                        if (queued.length >= 128 || ws.bufferedAmount > 1_048_576) {
                            ws.close(1013, "Live consumer is too slow; reconnect for a snapshot");
                            return;
                        }
                        if (bursting) queued.push(update);
                        else send({ type: "live", ...update });
                    });
                    liveSubscriptions.set(sessionId, { generation, unsubscribe });
                    const rows = typeof runtime.getLive === "function"
                        ? await runtime.getLive(sessionId, topics)
                        : [];
                    if (liveSubscriptionGeneration.get(sessionId) !== generation) {
                        unsubscribe();
                        const current = liveSubscriptions.get(sessionId);
                        if (current?.generation === generation) liveSubscriptions.delete(sessionId);
                        return;
                    }
                    const burstSeq = new Map();
                    for (const row of rows || []) {
                        const seq = Number(row.seq) || 0;
                        burstSeq.set(row.topic, seq);
                        send({
                            type: "live",
                            sessionId,
                            topic: row.topic,
                            seq,
                            kind: "snapshot",
                            data: row.payload || {},
                            updatedAt: row.updatedAt,
                        });
                    }
                    bursting = false;
                    for (const update of queued) {
                        const seen = burstSeq.get(update.topic) || 0;
                        if (update.seq != null && Number(update.seq) <= seen) continue;
                        if (update.seq != null) burstSeq.set(update.topic, Number(update.seq));
                        send({ type: "live", ...update });
                    }
                    queued.length = 0;
                    send({ type: "subscribedLive", sessionId, topics });
                } catch (error) {
                    const current = liveSubscriptions.get(sessionId);
                    if (current?.generation === generation) {
                        current.unsubscribe();
                        liveSubscriptions.delete(sessionId);
                    }
                    if (liveSubscriptionGeneration.get(sessionId) !== generation) return;
                    sendSubscriptionError("live", sessionId, error);
                }
                return;
            }

            if (type === "unsubscribeLive") {
                const sessionId = String(message?.sessionId || "").trim();
                liveSubscriptionGeneration.set(sessionId, (liveSubscriptionGeneration.get(sessionId) || 0) + 1);
                const subscription = liveSubscriptions.get(sessionId);
                if (subscription) {
                    subscription.unsubscribe();
                    liveSubscriptions.delete(sessionId);
                }
                return;
            }

            if (type === "publishLive") {
                send({ type: "error", scope: "live", error: "live publishing is server-only" });
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
            if (accessRevalidateTimer) clearInterval(accessRevalidateTimer);
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
            for (const subscription of liveSubscriptions.values()) {
                try { subscription.unsubscribe(); } catch {}
            }
            liveSubscriptions.clear();
            liveSubscriptionGeneration.clear();
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
