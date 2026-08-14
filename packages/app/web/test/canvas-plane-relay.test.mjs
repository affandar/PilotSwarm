// The canvas-plane relay against a REAL Postgres LISTEN/NOTIFY round trip:
// schema filtering, per-session fan-out, unsubscribe, and patch passthrough.
//
// Needs DATABASE_URL (the local dev Postgres). Skips cleanly without it so
// the suite stays green in environments with no database.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createCanvasPlane } from "../api/canvas-plane.js";

const DB = process.env.DATABASE_URL || "";
const CHANNEL = "pilotswarm_canvas_live_relay_test";

test("relay round trip: NOTIFY → subscriber, schema-filtered, patch passthrough", { skip: !DB && "DATABASE_URL not set" }, async () => {
    const plane = createCanvasPlane({ connectionString: DB, schema: "relay_test_schema", channel: CHANNEL });
    assert.equal(plane.available, true);
    await plane.start();

    const sender = new pg.Client({ connectionString: DB });
    await sender.connect();
    try {
        const got = [];
        const gotOther = [];
        const unsubscribe = plane.subscribe("sess-a", (u) => got.push(u));
        plane.subscribe("sess-b", (u) => gotOther.push(u));
        await new Promise((r) => setTimeout(r, 150)); // LISTEN settles

        const send = (payload) => sender.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(payload)]);
        await send({ schema: "relay_test_schema", sessionId: "sess-a", slot: 1, seq: 1, kind: "data", patch: { g: 1 } });
        await send({ schema: "relay_test_schema", sessionId: "sess-a", slot: 1, seq: 2, kind: "doc" });
        await send({ schema: "SOME_OTHER_SCHEMA", sessionId: "sess-a", slot: 1, seq: 3, kind: "data" });
        await send({ schema: "relay_test_schema", sessionId: "sess-unwatched", slot: 1, seq: 1, kind: "data" });

        const deadline = Date.now() + 5_000;
        while (got.length < 2 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(got.length, 2, "own-schema, own-session pings only");
        assert.deepEqual(got[0], { slot: 1, seq: 1, kind: "data", patch: { g: 1 } });
        assert.deepEqual(got[1], { slot: 1, seq: 2, kind: "doc" });
        assert.equal(gotOther.length, 0, "fan-out is per session");

        unsubscribe();
        await send({ schema: "relay_test_schema", sessionId: "sess-a", slot: 1, seq: 4, kind: "data" });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(got.length, 2, "unsubscribed sockets hear nothing");
    } finally {
        await sender.end();
        await plane.stop();
    }
});

test("without a connection string the plane reports unavailable and subscribe is inert", async () => {
    const plane = createCanvasPlane({ connectionString: "" });
    assert.equal(plane.available, false);
    await plane.start();
    const off = plane.subscribe("s", () => {});
    off();
    await plane.stop();
});
