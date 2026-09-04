import pg from "pg";

/**
 * Generic live-plane relay: one LISTEN connection per portal process, fanned
 * out by (sessionId, topic). Large notifications are pointers; getLive reads
 * the retained row before delivery.
 */
export function createLivePlane({
    connectionString = process.env.DATABASE_URL,
    schema = process.env.PILOTSWARM_CMS_SCHEMA || "copilot_sessions",
    channel = "pilotswarm_live",
    getLive = null,
    createClient = (options) => new pg.Client(options),
} = {}) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(channel)) {
        throw new Error("Invalid live-plane channel");
    }
    const subscribers = new Map();
    let client = null;
    let started = false;
    let stopped = false;
    let probeTimer = null;
    let reconnectTimer = null;
    let reconnectDelay = 1_000;
    let connecting = false;
    let epoch = 0;
    const deliveredSeq = new Map();
    const pointerReads = new Map();
    const available = Boolean(connectionString);

    const keyFor = (sessionId, topic) => `${sessionId}\u0000${topic}`;

    async function deliver(payload) {
        if (!payload?.sessionId || !payload?.topic) return;
        if (payload.schema !== schema || stopped) return;
        const key = keyFor(payload.sessionId, payload.topic);
        const handlers = subscribers.get(key);
        if (!handlers || handlers.size === 0) return;

        let update = {
            sessionId: String(payload.sessionId),
            topic: String(payload.topic),
            seq: payload.seq == null ? null : Number(payload.seq),
            kind: payload.kind === "signal" ? "signal" : payload.kind === "patch" ? "patch" : "snapshot",
            ...(payload.data && typeof payload.data === "object" ? { data: payload.data } : {}),
            ...(payload.updatedAt ? { updatedAt: payload.updatedAt } : {}),
        };
        if (update.kind !== "signal" && update.data === undefined) {
            if (typeof getLive !== "function") return;
            if (pointerReads.has(key)) {
                pointerReads.get(key).latest = payload;
                return;
            }
            const read = { latest: payload };
            pointerReads.set(key, read);
            const readEpoch = epoch;
            try {
                let requested;
                do {
                    requested = read.latest;
                    const rows = await getLive(update.sessionId, [update.topic]);
                    if (stopped || epoch !== readEpoch || subscribers.get(key) !== handlers) return;
                    const row = (rows || []).find((candidate) => candidate?.topic === update.topic);
                    if (row) await deliver({ ...payload, seq: Number(row.seq), kind: "snapshot", data: row.payload || {}, updatedAt: row.updatedAt });
                } while (requested !== read.latest);
            } catch {
                // Ephemeral reads are best effort; durable replay is unchanged.
            } finally {
                if (pointerReads.get(key) === read) pointerReads.delete(key);
            }
            return;
        }
        if (update.kind !== "signal") {
            if (!Number.isSafeInteger(update.seq) || update.seq <= (deliveredSeq.get(key) || 0)) return;
            deliveredSeq.set(key, update.seq);
        }
        for (const callback of [...handlers]) {
            try { callback(update); } catch { /* isolate sockets */ }
        }
    }

    async function connect() {
        if (stopped || !available || client || connecting) return;
        connecting = true;
        reconnectTimer = null;
        const next = createClient({ connectionString, keepAlive: true, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
        // Error listeners must exist while connect/LISTEN are still pending.
        const onGone = () => {
            if (client === next) {
                client = null;
                void next.end().catch(() => {});
            }
            scheduleReconnect();
        };
        next.on("error", onGone);
        next.on("end", onGone);
        try {
            await next.connect();
            await next.query(`LISTEN ${channel}`);
            if (stopped) {
                await next.end();
                return;
            }
        } catch {
            try { await next.end(); } catch {}
            scheduleReconnect();
            return;
        } finally {
            connecting = false;
        }
        client = next;
        const isReconnect = epoch++ > 0;
        deliveredSeq.clear();
        pointerReads.clear();
        reconnectDelay = 1_000;
        next.on("notification", (message) => {
            let payload;
            try { payload = JSON.parse(message.payload || ""); } catch { return; }
            void deliver(payload);
        });
        if (isReconnect) {
            for (const [key, handlers] of subscribers) {
                const [sessionId, topic] = key.split("\u0000");
                // Release stale previews even when an UNLOGGED table was
                // emptied by restart, then refresh events missed by LISTEN.
                for (const callback of handlers) {
                    try { callback({ sessionId, topic, kind: "unavailable" }); } catch {}
                }
                void deliver({ schema, sessionId, topic, kind: "snapshot" });
            }
        }
    }

    function scheduleReconnect() {
        if (stopped || reconnectTimer) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
        reconnectTimer = setTimeout(() => { void connect(); }, delay);
        reconnectTimer.unref?.();
    }

    return {
        available,
        async start() {
            if (!available || stopped || started) return;
            started = true;
            await connect();
            probeTimer = setInterval(() => {
                const current = client;
                if (current) current.query("SELECT 1").catch(() => {
                    if (client !== current) return;
                    client = null;
                    void current.end().catch(() => {});
                    scheduleReconnect();
                });
            }, 30_000);
            probeTimer.unref?.();
        },
        subscribe(sessionId, topics, callback) {
            const cleanSessionId = String(sessionId || "").trim();
            const cleanTopics = [...new Set((topics || []).map((topic) => String(topic || "").trim()))];
            if (!cleanSessionId || cleanTopics.length === 0) return () => {};
            for (const topic of cleanTopics) {
                const key = keyFor(cleanSessionId, topic);
                if (!subscribers.has(key)) subscribers.set(key, new Set());
                subscribers.get(key).add(callback);
            }
            return () => {
                for (const topic of cleanTopics) {
                    const key = keyFor(cleanSessionId, topic);
                    const handlers = subscribers.get(key);
                    if (!handlers) continue;
                    handlers.delete(callback);
                    if (handlers.size === 0) {
                        subscribers.delete(key);
                        deliveredSeq.delete(key);
                        pointerReads.delete(key);
                    }
                }
            };
        },
        async stop() {
            stopped = true;
            if (probeTimer) clearInterval(probeTimer);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            subscribers.clear();
            if (client) {
                try { await client.end(); } catch {}
                client = null;
            }
        },
    };
}
