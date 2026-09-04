/** Generic ephemeral live plane (migration 0073) against real PostgreSQL. */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assertEqual } from "../helpers/assertions.js";
import { withClient } from "../helpers/local-workers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

async function withCatalog(fn) {
    const env = await getEnv();
    const catalog = await createCatalog(env);
    try { await fn({ catalog, env }); } finally { await catalog.close(); }
}

async function freshSession(catalog) {
    const sessionId = randomUUID();
    await catalog.createSession(sessionId, {});
    return sessionId;
}

async function listenerFor(env, sessionId) {
    const client = new pg.Client({ connectionString: env.store });
    const received = [];
    await client.connect();
    client.on("notification", (message) => {
        try {
            const parsed = JSON.parse(message.payload);
            if (parsed.sessionId === sessionId) received.push(parsed);
        } catch {}
    });
    await client.query("LISTEN pilotswarm_live");
    return { client, received };
}

async function waitFor(array, count, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (array.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe("generic live plane on PostgreSQL", () => {
    it("an enabled worker publishes live/idle while keeping deltas out of durable history", { timeout: 180_000 }, async () => {
        const previous = process.env.PILOTSWARM_LIVE_TURN;
        process.env.PILOTSWARM_LIVE_TURN = "1";
        try {
            await withCatalog(async ({ catalog, env }) => {
                await withClient(env, async (client) => {
                    const session = await client.createSession(ONEWORD_CONFIG);
                    const { client: listener, received } = await listenerFor(env, session.sessionId);
                    try {
                        const response = await session.sendAndWait("What is the capital of France?", 120_000);
                        assert.match(response.toLowerCase(), /paris/);
                        const deadline = Date.now() + 10_000;
                        let row;
                        do {
                            [row] = await catalog.getLive(session.sessionId, ["turn"]);
                            if (row?.payload?.phase === "idle") break;
                            await new Promise((resolve) => setTimeout(resolve, 25));
                        } while (Date.now() < deadline);
                        assert.equal(row?.payload?.phase, "idle");
                        assert.equal(typeof row.payload.streamId, "string");
                        assert.ok(received.some((update) => update.topic === "turn" && update.data?.phase === "live"));
                        const events = await catalog.getSessionEvents(session.sessionId);
                        assert.ok(events.some((event) => event.eventType === "assistant.message"));
                        assert.equal(events.some((event) => /(?:_delta|live_tick)$/.test(event.eventType)), false);
                    } finally {
                        await listener.end();
                    }
                });
            });
        } finally {
            if (previous === undefined) delete process.env.PILOTSWARM_LIVE_TURN;
            else process.env.PILOTSWARM_LIVE_TURN = previous;
        }
    });

    it("an older schema reports unavailable and reads/publishes as a no-op", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const missing = await catalog.constructor.create(env.store, `${env.cmsSchema}_pre_0073`);
            try {
                assertEqual(await missing.liveAvailable(), false);
                assertEqual(await missing.publishLive("missing", "turn", { snapshot: { text: "x" } }, "writer"), null);
                assertEqual((await missing.getLive("missing")).length, 0);
            } finally {
                await missing.close();
            }
        });
    });

    it("probes availability, filters topics, patches atomically, and snapshots replace", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            assertEqual(await catalog.liveAvailable(), true);
            assertEqual((await catalog.getLive(randomUUID())).length, 0);
            const sessionId = await freshSession(catalog);
            const first = await catalog.publishLive(sessionId, "turn", { snapshot: {
                a: { b: 1, c: 2 }, list: [1, 2], gone: true,
            } }, "writer");
            assertEqual(first.seq, 1);
            const second = await catalog.publishLive(sessionId, "turn", { patch: {
                a: { b: 9, d: 3 }, list: [7], gone: null,
            } }, "writer");
            assertEqual(second.seq, 2);
            assertEqual(JSON.stringify(second.payload), JSON.stringify({ a: { b: 9, c: 2, d: 3 }, list: [7] }));
            await catalog.publishLive(sessionId, "presence", { snapshot: { online: true } }, "writer");
            assertEqual((await catalog.getLive(sessionId)).length, 2);
            assertEqual((await catalog.getLive(sessionId, ["turn"])).length, 1);

            const replaced = await catalog.publishLive(sessionId, "turn", { snapshot: { only: "this" } }, "writer-2");
            assertEqual(replaced.seq, 3);
            assertEqual(JSON.stringify(replaced.payload), JSON.stringify({ only: "this" }));
        });
    });

    it("concurrent patches compose and mint one consecutive seq each", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            await catalog.publishLive(sessionId, "turn", { snapshot: {} }, "seed");
            await Promise.all(Array.from({ length: 20 }, (_, index) => (
                catalog.publishLive(sessionId, "turn", { patch: { [`writer${index}`]: index } }, `w${index}`)
            )));
            const [row] = await catalog.getLive(sessionId, ["turn"]);
            assertEqual(row.seq, 21);
            for (let index = 0; index < 20; index += 1) assertEqual(row.payload[`writer${index}`], index);
        });
    });

    it("size refusal changes neither row nor seq and never notifies", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            await catalog.publishLive(sessionId, "turn", { snapshot: { safe: true } }, "writer");
            const { client, received } = await listenerFor(env, sessionId);
            try {
                const refused = await catalog.publishLive(sessionId, "turn", {
                    patch: { tooBig: "x".repeat(262_145) },
                }, "writer");
                assertEqual(refused.refused, true);
                await new Promise((resolve) => setTimeout(resolve, 250));
                assertEqual(received.length, 0);
                const [row] = await catalog.getLive(sessionId, ["turn"]);
                assertEqual(row.seq, 1);
                assertEqual(JSON.stringify(row.payload), JSON.stringify({ safe: true }));
            } finally {
                await client.end();
            }
        });
    });

    it("small writes notify inline, large envelopes use pointers, and signal retains no row", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            const { client, received } = await listenerFor(env, sessionId);
            try {
                await catalog.publishLive(sessionId, "turn", { patch: { text: "hello" } }, "writer");
                await catalog.publishLive(sessionId, "turn", { patch: { text: "x".repeat(10_000) } }, "writer");
                await catalog.publishLive(sessionId, "presence", { signal: true }, "writer");
                await waitFor(received, 3);
                assertEqual(received.length, 3);
                assertEqual(received[0].schema, env.cmsSchema);
                assertEqual(received[0].kind, "patch");
                assertEqual(received[0].data.text, "hello");
                assertEqual(received[1].seq, 2);
                assertEqual(received[1].data, undefined, "large notification is a row pointer");
                assertEqual(received[2].kind, "signal");
                assertEqual(received[2].seq, null);
                assertEqual((await catalog.getLive(sessionId, ["presence"])).length, 0, "signals write no retained row");
            } finally {
                await client.end();
            }
        });
    });

    it("soft deletion retains live state; hard deletion cascades it", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            await catalog.publishLive(sessionId, "turn", { snapshot: { phase: "idle" } }, "writer");
            await catalog.softDeleteSession(sessionId);
            assertEqual((await catalog.getLive(sessionId)).length, 1);
            await catalog.pool.query(`DELETE FROM "${env.cmsSchema}".sessions WHERE session_id = $1`, [sessionId]);
            assertEqual((await catalog.getLive(sessionId)).length, 0);
        });
    });

    it("validates topics, mode cardinality, and object payloads", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            await assert.rejects(() => catalog.publishLive(sessionId, "BAD TOPIC", { signal: true }, "writer"), /Invalid live topic/);
            await assert.rejects(() => catalog.publishLive(sessionId, "turn", { patch: {}, snapshot: {} }, "writer"), /exactly one/);
            await assert.rejects(() => catalog.publishLive(sessionId, "turn", { signal: false }, "writer"), /signal must be true/);
            await assert.rejects(() => catalog.publishLive(sessionId, "turn", { snapshot: [] }, "writer"), /must be an object/);
            await assert.rejects(() => catalog.getLive(sessionId, "turn"), /topics must be an array/i);
        });
    });

    it("a runtime table rollback invalidates a positive probe and degrades immediately", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            assertEqual(await catalog.liveAvailable(), true);
            await catalog.pool.query(`DROP TABLE "${env.cmsSchema}".live_state`);
            assertEqual(await catalog.publishLive(sessionId, "turn", { snapshot: { text: "ignored" } }, "writer"), null);
            assertEqual((await catalog.getLive(sessionId)).length, 0);
            assertEqual(await catalog.liveAvailable(), false);
        });
    });
});
