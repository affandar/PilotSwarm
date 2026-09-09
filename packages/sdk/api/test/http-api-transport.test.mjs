import test from "node:test";
import assert from "node:assert/strict";
import { HttpApiTransport } from "../src/http-api-transport.js";
import { API_PREFIX } from "../src/protocol.js";

function jsonResponse(payload, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => payload,
    };
}

function createTransport({ responses = [] } = {}) {
    const calls = [];
    const transport = new HttpApiTransport({
        apiUrl: "https://portal.example.com",
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (responses.length === 0) throw new Error("no scripted response left");
            return responses.shift();
        },
    });
    return { transport, calls };
}

test("session subscription forwards native task snapshots transiently and releases both live topics", () => {
    const { transport } = createTransport();
    const callbacks = new Map();
    const released = [];
    transport.api.subscribeSession = () => () => released.push("events");
    transport.api.subscribeCanvasLive = () => () => released.push("canvas");
    transport.api.subscribeLive = (sessionId, topic, handler) => {
        assert.equal(sessionId, "s1");
        callbacks.set(topic, handler);
        return () => released.push(topic);
    };
    const events = [];
    const off = transport.subscribeSession("s1", event => events.push(event));
    assert.deepEqual([...callbacks.keys()], ["turn", "native-tasks"]);
    const payload = { ownerId: "owner", revision: 4, phase: "live", tasks: [{ id: "call", status: "running" }] };
    callbacks.get("native-tasks")({ kind: "snapshot", seq: 9, updatedAt: "2026-09-08T00:00:00Z", data: payload });
    callbacks.get("native-tasks")({ kind: "signal" });
    assert.deepEqual(events, [{ eventType: "session.native_tasks_tick", sessionId: "s1", transient: true,
        liveSeq: 9, liveUpdatedAt: "2026-09-08T00:00:00Z", data: payload }]);
    callbacks.get("native-tasks")({ kind: "unavailable" });
    assert.deepEqual(events.at(-1).data, { phase: "unavailable" });
    off();
    assert.deepEqual(released, ["events", "canvas", "turn", "native-tasks"]);
});

test("placeSessionsInGroup posts sessionIds + groupId to the place route", async () => {
    const results = [{ rootSessionId: "a", placed: true, reason: null }];
    const { transport, calls } = createTransport({
        responses: [jsonResponse({ ok: true, result: results })],
    });
    const returned = await transport.placeSessionsInGroup(["a", "b"], "g1");
    assert.deepEqual(returned, results);
    assert.equal(calls[0].url, `https://portal.example.com${API_PREFIX}/management/session-groups/place`);
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { groupId: "g1", sessionIds: ["a", "b"] });
});

test("placeSessionsInGroup normalizes undefined groupId to null (ungroup)", async () => {
    const { transport, calls } = createTransport({
        responses: [jsonResponse({ ok: true, result: [] })],
    });
    await transport.placeSessionsInGroup(["a"]);
    assert.deepEqual(JSON.parse(calls[0].options.body), { groupId: null, sessionIds: ["a"] });
});

test("move/assign alias wrappers return the per-root result array", async () => {
    const results = [{ rootSessionId: "a", placed: false, reason: "not_found" }];
    const { transport } = createTransport({
        responses: [
            jsonResponse({ ok: true, result: results }),
            jsonResponse({ ok: true, result: results }),
        ],
    });
    assert.deepEqual(await transport.moveSessionsToGroup(null, ["a"]), results);
    assert.deepEqual(await transport.assignSessionsToGroup("g1", ["a"]), results);
});
