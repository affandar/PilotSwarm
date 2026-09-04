import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api-client.js";
import { API_PREFIX, ApiError } from "../src/protocol.js";

function jsonResponse(payload, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => payload,
    };
}

function createClient({ responses = [], token = null, onUnauthorized, onForbidden } = {}) {
    const calls = [];
    const client = new ApiClient({
        apiUrl: "https://portal.example.com/",
        getAccessToken: async () => token,
        onUnauthorized,
        onForbidden,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (responses.length === 0) throw new Error("no scripted response left");
            return responses.shift();
        },
    });
    return { client, calls };
}

test("apiUrl trailing slashes are stripped", () => {
    const { client } = createClient();
    assert.equal(client.apiUrl, "https://portal.example.com");
});

test("call() builds request from the operations table and unwraps the envelope", async () => {
    const { client, calls } = createClient({
        responses: [jsonResponse({ ok: true, result: [{ sessionId: "s1" }] })],
        token: "tok-1",
    });
    const result = await client.call("listSessions");
    assert.deepEqual(result, [{ sessionId: "s1" }]);
    assert.equal(calls[0].url, `https://portal.example.com${API_PREFIX}/sessions`);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.headers.authorization, "Bearer tok-1");
});

test("call() posts JSON bodies with content-type", async () => {
    const { client, calls } = createClient({
        responses: [jsonResponse({ ok: true, result: { sessionId: "s2" } })],
    });
    await client.call("createSession", { model: "m1" });
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].options.body), { model: "m1" });
    assert.equal(calls[0].options.headers.authorization, undefined);
});

test("401 fires onUnauthorized and throws ApiError", async () => {
    let unauthorized = 0;
    const { client } = createClient({
        responses: [jsonResponse({ ok: false, error: "Unauthorized" }, { status: 401 })],
        onUnauthorized: () => { unauthorized += 1; },
    });
    await assert.rejects(client.call("listSessions"), (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 401);
        return true;
    });
    assert.equal(unauthorized, 1);
});

// v0.5.14 (105e78f): onForbidden is an ADMISSION signal, not a per-op one. A
// 403 on a normal operation (e.g. a non-owner renaming) throws to the caller
// but must NOT flip the app to the access-denied gate; only the admission
// probes (/auth/me, /bootstrap) do that.
test("a per-operation 403 throws the server reason without firing onForbidden", async () => {
    let reason = null;
    const { client } = createClient({
        responses: [jsonResponse({ ok: false, error: { code: "FORBIDDEN", message: "not on the allowlist" } }, { status: 403 })],
        onForbidden: (message) => { reason = message; },
    });
    await assert.rejects(client.call("listSessions"), /not on the allowlist/);
    assert.equal(reason, null);
});

test("a 403 on the admission probe fires onForbidden with the server reason", async () => {
    let reason = null;
    const { client } = createClient({
        responses: [jsonResponse({ ok: false, error: { code: "FORBIDDEN", message: "not on the allowlist" } }, { status: 403 })],
        onForbidden: (message) => { reason = message; },
    });
    await assert.rejects(client.getAuthContext(), /not on the allowlist/);
    assert.equal(reason, "not on the allowlist");
});

test("structured error envelopes surface code and message", async () => {
    const { client } = createClient({
        responses: [jsonResponse({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "nope" } }, { status: 404 })],
    });
    await assert.rejects(client.call("getSession", { sessionId: "missing" }), (error) => {
        assert.equal(error.code, "SESSION_NOT_FOUND");
        assert.equal(error.status, 404);
        assert.equal(error.message, "nope");
        return true;
    });
});

test("ok:false with 200 status still throws", async () => {
    const { client } = createClient({
        responses: [jsonResponse({ ok: false, error: "boom" })],
    });
    await assert.rejects(client.call("listSessions"), /boom/);
});

test("getAuthConfig is public (no auth header)", async () => {
    const { client, calls } = createClient({
        responses: [jsonResponse({ enabled: false, provider: "none" })],
        token: "tok-1",
    });
    const config = await client.getAuthConfig();
    assert.equal(config.provider, "none");
    assert.equal(calls[0].options.headers, undefined);
});

// ── WebSocket lifecycle with a scripted fake ──────────────────────────

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.listeners = new Map();
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }

    emit(type, event = {}) {
        for (const handler of this.listeners.get(type) || []) handler(event);
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open", {});
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close(code = 1000, reason = "") {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close", { code, reason });
    }
}

function createWsClient({ token = null } = {}) {
    FakeWebSocket.instances = [];
    const client = new ApiClient({
        apiUrl: "https://portal.example.com",
        getAccessToken: async () => token,
        fetchImpl: async () => jsonResponse({ ok: true, result: {} }),
        WebSocketImpl: FakeWebSocket,
    });
    return client;
}

test("subscribeSession connects, subscribes, and dispatches events", async () => {
    const client = createWsClient({ token: "tok" });
    const events = [];
    client.subscribeSession("s1", (event) => events.push(event));

    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.url, "wss://portal.example.com/api/v1/ws");
    assert.deepEqual(socket.protocols, ["access_token", "tok"]);

    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(socket.sent, [{ type: "subscribeSession", sessionId: "s1" }]);

    socket.emit("message", { data: JSON.stringify({ type: "sessionEvent", sessionId: "s1", event: { seq: 1 } }) });
    assert.deepEqual(events, [{ seq: 1 }]);
    await client.stop();
});

test("reconnect resubscribes active sessions and log tails", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = createWsClient();
    client.subscribeSession("s1", () => {});
    client.subscribeLogs(() => {});

    await new Promise((resolve) => setImmediate(resolve));
    const first = FakeWebSocket.instances[0];
    first.open();
    await new Promise((resolve) => setImmediate(resolve));

    first.close(1006, "network");
    t.mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));

    const second = FakeWebSocket.instances[1];
    assert.ok(second, "a reconnect socket should be created");
    second.open();
    await new Promise((resolve) => setImmediate(resolve));
    const types = second.sent.map((message) => message.type).sort();
    assert.deepEqual(types, ["subscribeLogs", "subscribeSession"]);
    await client.stop();
});

test("close 4401 invokes onUnauthorized and suppresses reconnect", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let unauthorized = 0;
    const client = new ApiClient({
        apiUrl: "https://portal.example.com",
        fetchImpl: async () => jsonResponse({ ok: true, result: {} }),
        WebSocketImpl: FakeWebSocket,
        onUnauthorized: () => { unauthorized += 1; },
    });
    FakeWebSocket.instances = [];
    client.subscribeSession("s1", () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));

    socket.close(4401, "Unauthorized");
    assert.equal(unauthorized, 1);
    t.mock.timers.tick(5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakeWebSocket.instances.length, 1, "no reconnect after 4401");
    await client.stop();
});

test("reconnect survives a getAccessToken rejection during connect", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    FakeWebSocket.instances = [];
    let tokenCalls = 0;
    const client = new ApiClient({
        apiUrl: "https://portal.example.com",
        // Reject on the reconnect attempt, succeed after.
        getAccessToken: async () => {
            tokenCalls += 1;
            if (tokenCalls === 2) throw new Error("token endpoint down");
            return "tok";
        },
        fetchImpl: async () => jsonResponse({ ok: true, result: {} }),
        WebSocketImpl: FakeWebSocket,
    });
    client.subscribeSession("s1", () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const first = FakeWebSocket.instances[0];
    first.open();
    await new Promise((resolve) => setImmediate(resolve));

    // Drop → reconnect attempt #1 rejects inside getAccessToken (no socket
    // is ever constructed), which must still schedule another retry.
    first.close(1006, "network");
    t.mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakeWebSocket.instances.length, 1, "no socket built on the failed attempt");

    // Retry #2 succeeds.
    t.mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    const second = FakeWebSocket.instances[1];
    assert.ok(second, "a later reconnect eventually builds a socket");
    second.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(second.sent, [{ type: "subscribeSession", sessionId: "s1" }]);
    await client.stop();
});

test("onResubscribe fires after reconnect so consumers can replay", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    FakeWebSocket.instances = [];
    const client = createWsClient();
    let resubscribes = 0;
    client.subscribeSession("s1", () => {}, () => { resubscribes += 1; });
    await new Promise((resolve) => setImmediate(resolve));
    const first = FakeWebSocket.instances[0];
    first.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resubscribes, 0, "no resubscribe on the initial connect");

    first.close(1006, "network");
    t.mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    FakeWebSocket.instances[1].open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resubscribes, 1, "resubscribe fires once on reconnect");
    await client.stop();
});

test("unsubscribe stops delivery and sends unsubscribeSession when last handler leaves", async () => {
    const client = createWsClient();
    const seen = [];
    const unsubscribe = client.subscribeSession("s1", (event) => seen.push(event));
    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));

    unsubscribe();
    assert.deepEqual(socket.sent.at(-1), { type: "unsubscribeSession", sessionId: "s1" });
    socket.emit("message", { data: JSON.stringify({ type: "sessionEvent", sessionId: "s1", event: { seq: 9 } }) });
    assert.deepEqual(seen, []);
    await client.stop();
});

test("live subscriptions are grouped per session and fan out by topic", async () => {
    const client = createWsClient();
    const turn = [];
    const presence = [];
    const offTurn = client.subscribeLive("s1", "turn", (message) => turn.push(message));
    const offPresence = client.subscribeLive("s1", "presence", (message) => presence.push(message));
    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(socket.sent, [{ type: "subscribeLive", sessionId: "s1", topics: ["turn", "presence"] }]);

    socket.emit("message", { data: JSON.stringify({
        type: "live", sessionId: "s1", topic: "turn", seq: 1, kind: "snapshot", data: { text: "hi" },
    }) });
    assert.equal(turn.length, 1);
    assert.equal(presence.length, 0);

    offTurn();
    assert.deepEqual(socket.sent.slice(-2), [
        { type: "unsubscribeLive", sessionId: "s1" },
        { type: "subscribeLive", sessionId: "s1", topics: ["presence"] },
    ]);
    offPresence();
    await client.stop();
});

test("a duplicate live seq is ignored and a patch gap performs one snapshot refetch", async () => {
    FakeWebSocket.instances = [];
    let refetches = 0;
    const client = new ApiClient({
        apiUrl: "https://portal.example.com",
        WebSocketImpl: FakeWebSocket,
        fetchImpl: async (url) => {
            assert.match(url, /\/management\/sessions\/s1\/live\?topics=/);
            refetches += 1;
            return jsonResponse({ ok: true, result: [{ topic: "turn", seq: 4, payload: { text: "whole" } }] });
        },
    });
    const seen = [];
    client.subscribeLive("s1", "turn", (message) => seen.push(message));
    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));

    const emit = (seq, kind, data) => socket.emit("message", { data: JSON.stringify({
        type: "live", sessionId: "s1", topic: "turn", seq, kind, data,
    }) });
    emit(1, "snapshot", { text: "one" });
    emit(1, "snapshot", { text: "duplicate" });
    emit(3, "patch", { text: "three" });
    emit(4, "patch", { text: "four" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(refetches, 1, "concurrent gap notifications collapse into one read");
    assert.deepEqual(seen.map((message) => [message.seq, message.kind, message.data.text]), [
        [1, "snapshot", "one"],
        [4, "snapshot", "whole"],
    ]);
    await client.stop();
});

test("a live-only socket reconnects and resubscribes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = createWsClient();
    client.subscribeLive("s1", "turn", () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const first = FakeWebSocket.instances[0];
    first.open();
    await new Promise((resolve) => setImmediate(resolve));
    first.close(1006, "network");
    t.mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    const second = FakeWebSocket.instances[1];
    assert.ok(second, "live subscribers keep the reconnect loop alive");
    second.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(second.sent, [{ type: "subscribeLive", sessionId: "s1", topics: ["turn"] }]);
    await client.stop();
});

test("a lower patch seq after an unlogged-table reset refetches and accepts the new lineage", async () => {
    FakeWebSocket.instances = [];
    const client = new ApiClient({
        apiUrl: "https://portal.example.com",
        WebSocketImpl: FakeWebSocket,
        fetchImpl: async () => jsonResponse({ ok: true, result: [
            { topic: "turn", seq: 1, payload: { text: "after restart" } },
        ] }),
    });
    const seen = [];
    client.subscribeLive("s1", "turn", (message) => seen.push(message));
    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit("message", { data: JSON.stringify({
        type: "live", sessionId: "s1", topic: "turn", seq: 99, kind: "snapshot", data: { text: "before restart" },
    }) });
    socket.emit("message", { data: JSON.stringify({
        type: "live", sessionId: "s1", topic: "turn", seq: 1, kind: "patch", data: { text: "after restart" },
    }) });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.map((message) => [message.seq, message.data.text]), [
        [99, "before restart"], [1, "after restart"],
    ]);
    await client.stop();
});

test("a stale live refetch cannot cross an unsubscribe and erase the replacement guard", async () => {
    FakeWebSocket.instances = [];
    const pending = [];
    const client = new ApiClient({
        apiUrl: "https://portal.example.com",
        WebSocketImpl: FakeWebSocket,
        fetchImpl: async () => new Promise((resolve) => pending.push(resolve)),
    });
    const firstSeen = [];
    const offFirst = client.subscribeLive("s1", "turn", (message) => firstSeen.push(message));
    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    const emit = (seq, kind, data) => socket.emit("message", { data: JSON.stringify({
        type: "live", sessionId: "s1", topic: "turn", seq, kind, data,
    }) });

    emit(1, "snapshot", { text: "first" });
    emit(3, "patch", { text: "old gap" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 1);

    offFirst();
    const replacementSeen = [];
    client.subscribeLive("s1", "turn", (message) => replacementSeen.push(message));
    emit(3, "patch", { text: "replacement gap" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2);

    pending[0](jsonResponse({ ok: true, result: [
        { topic: "turn", seq: 3, payload: { text: "stale" } },
    ] }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replacementSeen, [], "the old request cannot publish into replacement handlers");

    emit(4, "patch", { text: "still coalesced" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2, "the old request cannot erase the replacement refetch guard");

    pending[1](jsonResponse({ ok: true, result: [
        { topic: "turn", seq: 4, payload: { text: "current" } },
    ] }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replacementSeen.map((message) => [message.seq, message.data.text]), [[4, "current"]]);
    await client.stop();
});

test("an older pointer snapshot cannot overwrite newer live state", async () => {
    const client = createWsClient();
    const seen = [];
    client.subscribeLive("s1", "turn", (message) => seen.push(message));
    await client.handleLiveMessage({ sessionId: "s1", topic: "turn", seq: 9, kind: "snapshot", data: { text: "new" } });
    await client.handleLiveMessage({ sessionId: "s1", topic: "turn", seq: 8, kind: "snapshot", data: { text: "old" } });
    assert.deepEqual(seen.map((message) => message.data.text), ["new"]);
    await client.stop();
});

test("additional live readers get the retained value and stale cleanup is idempotent", async () => {
    const client = createWsClient();
    const off = client.subscribeLive("s1", "turn", () => {});
    await client.handleLiveMessage({ sessionId: "s1", topic: "turn", seq: 1, kind: "snapshot", data: { text: "one", keep: true } });
    await client.handleLiveMessage({ sessionId: "s1", topic: "turn", seq: 2, kind: "patch", data: { text: "two" } });
    const seen = [];
    const offSecond = client.subscribeLive("s1", "turn", (message) => seen.push(message));
    assert.deepEqual(seen[0].data, { text: "two", keep: true });
    off(); offSecond();
    const replacement = [];
    client.subscribeLive("s1", "turn", (message) => replacement.push(message));
    off();
    await client.handleLiveMessage({ sessionId: "s1", topic: "turn", seq: 3, kind: "snapshot", data: { text: "new reader" } });
    assert.equal(replacement.length, 1);
    await client.stop();
});

test("gap recovery retains the highest tick received during a slow read", async () => {
    const pending = [];
    const client = new ApiClient({ apiUrl: "https://portal.example.com", WebSocketImpl: FakeWebSocket,
        fetchImpl: () => new Promise((resolve) => pending.push(resolve)),
    });
    const seen = [];
    client.subscribeLive("s1", "turn", (message) => seen.push(message));
    const emit = (seq, kind = "patch") => client.handleLiveMessage({ sessionId: "s1", topic: "turn", seq, kind, data: { text: String(seq) } });
    await emit(1, "snapshot");
    void emit(3);
    void emit(5);
    void emit(4);
    await new Promise((resolve) => setImmediate(resolve));
    pending[0](jsonResponse({ ok: true, result: [{ topic: "turn", seq: 3, payload: { text: "3" } }] }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2, "the newer gap must be fetched even if a lower tick arrived last");
    pending[1](jsonResponse({ ok: true, result: [{ topic: "turn", seq: 5, payload: { text: "5" } }] }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.at(-1).seq, 5);
    await client.stop();
});
