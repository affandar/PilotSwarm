import pg from "pg";

/**
 * The canvas-plane relay: one LISTEN connection to the CMS primary, fanned
 * out to WebSocket subscribers by session id.
 *
 * Deliberately a PURE fan-out. The NOTIFY payload already carries everything
 * a viewer needs ({slot, seq, kind} and, for small patches, the patch
 * itself); when it does not (big patch, PUT, doc), the ping is a pointer and
 * the BROWSER fetches the snapshot through the authorized REST path
 * (getCanvasLive). No queries here, no state worth losing, so any number of
 * relay processes scale with zero coordination — NOTIFY broadcasts to all.
 *
 * Connection discipline (the dispatcher-freeze lesson): TCP keepalive on the
 * client, a 30 s liveness probe, and reconnect-with-backoff. Subscriptions
 * live in process memory, so a reconnect needs no re-reads — browsers detect
 * any missed seq and resync themselves.
 */
export function createCanvasPlane({
    connectionString = process.env.DATABASE_URL,
    schema = process.env.PILOTSWARM_CMS_SCHEMA || "copilot_sessions",
    channel = "pilotswarm_canvas_live",
} = {}) {
    const subscribers = new Map(); // sessionId -> Set<cb>
    let client = null;
    let stopped = false;
    let probeTimer = null;
    let reconnectDelay = 1_000;

    const available = Boolean(connectionString);

    async function connect() {
        if (stopped || !available) return;
        const next = new pg.Client({ connectionString, keepAlive: true });
        try {
            await next.connect();
            await next.query(`LISTEN ${channel}`);
        } catch {
            try { await next.end(); } catch { /* already dead */ }
            scheduleReconnect();
            return;
        }
        client = next;
        reconnectDelay = 1_000;
        next.on("notification", (msg) => {
            let payload;
            try {
                payload = JSON.parse(msg.payload || "");
            } catch {
                return;
            }
            // Multi-schema deployments (and test suites) share the channel;
            // the payload names its schema so we never cross streams.
            if (payload?.schema && payload.schema !== schema) return;
            const handlers = subscribers.get(payload?.sessionId);
            if (!handlers) return;
            const update = {
                slot: Number(payload.slot),
                seq: Number(payload.seq),
                kind: payload.kind === "doc" ? "doc" : "data",
                ...(payload.patch && typeof payload.patch === "object" ? { patch: payload.patch } : {}),
            };
            for (const cb of handlers) {
                try { cb(update); } catch { /* one bad socket must not stop the fan-out */ }
            }
        });
        const onGone = () => {
            if (client === next) client = null;
            scheduleReconnect();
        };
        next.on("error", onGone);
        next.on("end", onGone);
    }

    function scheduleReconnect() {
        if (stopped) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
        setTimeout(() => { void connect(); }, delay);
    }

    return {
        available,
        async start() {
            if (!available) return;
            await connect();
            // Liveness probe: a LISTEN connection can die silently behind
            // NAT/pools. A failed probe triggers the error path → reconnect.
            probeTimer = setInterval(() => {
                if (client) client.query("SELECT 1").catch(() => { /* error handler reconnects */ });
            }, 30_000);
            if (probeTimer.unref) probeTimer.unref();
        },
        subscribe(sessionId, cb) {
            const key = String(sessionId || "").trim();
            if (!key) return () => {};
            if (!subscribers.has(key)) subscribers.set(key, new Set());
            subscribers.get(key).add(cb);
            return () => {
                const handlers = subscribers.get(key);
                if (!handlers) return;
                handlers.delete(cb);
                if (handlers.size === 0) subscribers.delete(key);
            };
        },
        async stop() {
            stopped = true;
            if (probeTimer) clearInterval(probeTimer);
            subscribers.clear();
            if (client) {
                try { await client.end(); } catch { /* going down anyway */ }
                client = null;
            }
        },
    };
}
