import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createConnectionHandler } from "../api/ws.js";

function fakeSocket() {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.OPEN = 1;
    ws.sent = [];
    ws.send = (raw) => ws.sent.push(JSON.parse(raw));
    ws.close = (code, reason) => { ws.closed = { code, reason }; ws.emit("close"); };
    return ws;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness(overrides = {}) {
    let callback = null;
    let unsubscribeCount = 0;
    const runtime = {
        start: async () => {},
        noteSignInRole: () => {},
        authorizeSessionSubscribe: async () => {},
        getLive: async () => [],
        livePlane: {
            available: true,
            subscribe: (_sessionId, _topics, cb) => {
                callback = cb;
                return () => { unsubscribeCount += 1; if (callback === cb) callback = null; };
            },
        },
        ...overrides,
    };
    const ws = fakeSocket();
    await createConnectionHandler(runtime)(ws, { headers: {}, url: "/api/v1/ws" });
    return { runtime, ws, getCallback: () => callback, getUnsubscribeCount: () => unsubscribeCount };
}

test("subscribeLive authorizes, sends its burst first, then buffered notifications", async () => {
    let releaseBurst;
    const burst = new Promise((resolve) => { releaseBurst = resolve; });
    const authorizations = [];
    const h = await harness({
        authorizeSessionSubscribe: async (sessionId) => { authorizations.push(sessionId); },
        getLive: async () => burst,
    });
    h.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }));
    await tick();
    assert.ok(h.getCallback(), "relay subscription is installed before the burst read");
    h.getCallback()({ sessionId: "s1", topic: "turn", seq: 2, kind: "patch", data: { text: "new" } });
    releaseBurst([{ topic: "turn", seq: 1, payload: { text: "old" } }]);
    await tick();
    await tick();

    assert.deepEqual(authorizations, ["s1"]);
    const protocol = h.ws.sent.filter((message) => ["live", "subscribedLive"].includes(message.type));
    assert.deepEqual(protocol.map((message) => [message.type, message.seq ?? null, message.kind ?? null]), [
        ["live", 1, "snapshot"],
        ["live", 2, "patch"],
        ["subscribedLive", null, null],
    ]);
});

test("a queued notification already covered by the burst is not duplicated", async () => {
    let releaseBurst;
    const burst = new Promise((resolve) => { releaseBurst = resolve; });
    const h = await harness({ getLive: async () => burst });
    h.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }));
    await tick();
    h.getCallback()({ sessionId: "s1", topic: "turn", seq: 2, kind: "patch", data: { text: "same" } });
    releaseBurst([{ topic: "turn", seq: 2, payload: { text: "same" } }]);
    await tick();
    assert.equal(h.ws.sent.filter((message) => message.type === "live").length, 1);
});

test("authorization failure and invalid topics install no relay handler", async () => {
    const denied = await harness({ authorizeSessionSubscribe: async () => { throw new Error("forbidden"); } });
    denied.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }));
    await tick();
    assert.equal(denied.getCallback(), null);
    assert.ok(denied.ws.sent.some((message) => message.type === "error" && message.scope === "live"));

    const invalid = await harness();
    invalid.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["BAD TOPIC"] }));
    await tick();
    assert.equal(invalid.getCallback(), null);
});

test("overlapping subscribeLive calls keep only the newest subscription", async () => {
    let releaseFirst;
    let calls = 0;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const h = await harness({
        authorizeSessionSubscribe: async () => {
            calls += 1;
            if (calls === 1) await first;
        },
    });
    h.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["old"] }));
    await tick();
    h.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }));
    await tick();
    releaseFirst();
    await tick();
    assert.equal(h.ws.sent.filter((message) => message.type === "subscribedLive").length, 1);
    assert.deepEqual(h.ws.sent.find((message) => message.type === "subscribedLive").topics, ["turn"]);
});

test("close unsubscribes and clients cannot publish into the live plane", async () => {
    const h = await harness();
    h.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }));
    await tick();
    h.ws.emit("message", JSON.stringify({ type: "publishLive", sessionId: "s1", topic: "turn", data: {} }));
    await tick();
    assert.ok(h.ws.sent.some((message) => message.type === "error" && /server-only/.test(message.error)));
    h.ws.emit("close");
    assert.equal(h.getUnsubscribeCount(), 1);
    assert.equal(h.getCallback(), null);
});

test("failed reauthorization removes a previously active subscription", async () => {
    let allowed = true;
    const h = await harness({ authorizeSessionSubscribe: async () => { if (!allowed) throw new Error("revoked"); } });
    const subscribe = () => h.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }));
    subscribe(); await tick();
    assert.ok(h.getCallback());
    allowed = false;
    subscribe(); await tick();
    assert.equal(h.getCallback(), null);
    assert.equal(h.getUnsubscribeCount(), 1);
});

test("initial burst queues are bounded for a slow reader", async () => {
    let resolve;
    const h = await harness({ getLive: () => new Promise((r) => { resolve = r; }) });
    h.ws.emit("message", JSON.stringify({ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }));
    await tick();
    const callback = h.getCallback();
    for (let seq = 1; seq <= 200; seq++) callback({ sessionId: "s1", topic: "turn", seq, kind: "snapshot", data: {} });
    assert.equal(h.ws.closed.code, 1013);
    assert.equal(h.getCallback(), null);
    resolve([]);
    await tick();
    assert.equal(h.ws.sent.filter((message) => message.type === "live").length, 0);
});
