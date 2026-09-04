import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { EventEmitter } from "node:events";
import { createLivePlane } from "../api/live-plane.js";

const DB = process.env.DATABASE_URL || "";
const CHANNEL = "pilotswarm_live_relay_test";
const RECONNECT_CHANNEL = "pilotswarm_live_reconnect_test";

test("relay fans out by session and topic, filters schema, and resolves pointers", { skip: !DB && "DATABASE_URL not set" }, async () => {
    const reads = [];
    const updatedAt = "2026-09-04T00:00:00.000Z";
    const plane = createLivePlane({
        connectionString: DB,
        schema: "live_relay_schema",
        channel: CHANNEL,
        getLive: async (sessionId, topics) => {
            reads.push([sessionId, topics]);
            return [{ topic: topics[0], seq: 8, payload: { whole: true }, updatedBy: "test", updatedAt }];
        },
    });
    await plane.start();
    await plane.start();
    const sender = new pg.Client({ connectionString: DB });
    await sender.connect();
    try {
        const turn = [];
        const presence = [];
        const other = [];
        const off = plane.subscribe("s1", ["turn"], (update) => turn.push(update));
        plane.subscribe("s1", ["presence"], (update) => presence.push(update));
        plane.subscribe("s2", ["turn"], (update) => other.push(update));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const { rows: listeners } = await sender.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND datname = current_database()
                AND query = $1`,
            [`LISTEN ${CHANNEL}`],
        );
        assert.equal(listeners[0].n, 1, "start and subscriptions share exactly one LISTEN connection");
        const notify = (payload) => sender.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(payload)]);
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "turn", seq: 1, kind: "patch", data: { text: "a" } });
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "presence", seq: 2, kind: "signal" });
        await notify({ schema: "wrong_schema", sessionId: "s1", topic: "turn", seq: 3, kind: "patch", data: { ignored: true } });
        await notify({ schema: "live_relay_schema", sessionId: "s2", topic: "presence", seq: 4, kind: "signal" });
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "turn", seq: 8, kind: "patch" });

        const deadline = Date.now() + 5_000;
        while ((turn.length < 2 || presence.length < 1) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.deepEqual(turn, [
            { sessionId: "s1", topic: "turn", seq: 1, kind: "patch", data: { text: "a" } },
            { sessionId: "s1", topic: "turn", seq: 8, kind: "snapshot", data: { whole: true }, updatedAt },
        ]);
        assert.deepEqual(presence, [{ sessionId: "s1", topic: "presence", seq: 2, kind: "signal" }]);
        assert.deepEqual(other, []);
        assert.deepEqual(reads, [["s1", ["turn"]]]);

        off();
        await notify({ schema: "live_relay_schema", sessionId: "s1", topic: "turn", seq: 9, kind: "signal" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(turn.length, 2, "unsubscribe removes the exact (session, topic) handler");
    } finally {
        await sender.end();
        await plane.stop();
    }
});

test("without a connection string the live relay degrades to an inert plane", async () => {
    const plane = createLivePlane({ connectionString: "" });
    assert.equal(plane.available, false);
    await plane.start();
    plane.subscribe("s1", ["turn"], () => { throw new Error("must stay inert"); })();
    await plane.stop();
});

test("relay reconnects after its LISTEN backend is terminated", { skip: !DB && "DATABASE_URL not set" }, async () => {
    const plane = createLivePlane({
        connectionString: DB,
        schema: "live_relay_schema",
        channel: RECONNECT_CHANNEL,
    });
    const sender = new pg.Client({ connectionString: DB });
    await sender.connect();
    await plane.start();
    const seen = [];
    plane.subscribe("s-reconnect", ["turn"], (update) => seen.push(update));
    try {
        const { rows } = await sender.query(
            `SELECT pid FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND datname = current_database()
                AND query = $1
              ORDER BY backend_start DESC
              LIMIT 1`,
            [`LISTEN ${RECONNECT_CHANNEL}`],
        );
        assert.ok(rows[0]?.pid, "the relay owns one discoverable LISTEN backend");
        await sender.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);

        const deadline = Date.now() + 6_000;
        let attempt = 0;
        while (!seen.some((update) => update.data?.recovered) && Date.now() < deadline) {
            attempt += 1;
            await new Promise((resolve) => setTimeout(resolve, 250));
            await sender.query("SELECT pg_notify($1, $2)", [RECONNECT_CHANNEL, JSON.stringify({
                schema: "live_relay_schema",
                sessionId: "s-reconnect",
                topic: "turn",
                seq: attempt,
                kind: "snapshot",
                data: { recovered: true },
            })]);
        }
        assert.equal(seen.at(-1)?.data?.recovered, true);
    } finally {
        await sender.end();
        await plane.stop();
    }
});

test("reconnect refreshes a missed idle without waiting for another notification", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const clients = [];
    const seen = [];
    const plane = createLivePlane({
        connectionString: "test", schema: "test",
        createClient: () => {
            const client = new EventEmitter();
            client.connect = async () => {};
            client.query = async () => {};
            client.end = async () => {};
            clients.push(client);
            return client;
        },
        getLive: async () => [{ topic: "turn", seq: 1, payload: { phase: "idle" } }],
    });
    await plane.start();
    plane.subscribe("s1", ["turn"], (update) => seen.push(update));
    clients[0].emit("notification", { payload: JSON.stringify({ schema: "test", sessionId: "s1", topic: "turn", seq: 99, kind: "snapshot", data: { phase: "live" } }) });
    clients[0].emit("error", new Error("connection lost"));
    t.mock.timers.tick(1000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(seen.map((update) => [update.kind, update.data?.phase]), [
        ["snapshot", "live"], ["unavailable", undefined], ["snapshot", "idle"],
    ]);
    await plane.stop();
});

test("a slow pointer read cannot regress a newer inline snapshot", async () => {
    const client = new EventEmitter();
    client.connect = async () => {};
    client.query = async () => {};
    client.end = async () => {};
    let resolve;
    const seen = [];
    const plane = createLivePlane({ connectionString: "test", schema: "test", createClient: () => client,
        getLive: () => new Promise((r) => { resolve = r; }),
    });
    await plane.start();
    plane.subscribe("s1", ["turn"], (update) => seen.push(update));
    const notify = (seq, data) => client.emit("notification", { payload: JSON.stringify({ schema: "test", sessionId: "s1", topic: "turn", seq, kind: "snapshot", data }) });
    notify(1);
    notify(2, { text: "new" });
    resolve([{ topic: "turn", seq: 1, payload: { text: "old" } }]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen.map((update) => update.data.text), ["new"]);
    await plane.stop();
});
