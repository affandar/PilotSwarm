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

test("403 fires onForbidden with the server reason", async () => {
    let reason = null;
    const { client } = createClient({
        responses: [jsonResponse({ ok: false, error: { code: "FORBIDDEN", message: "not on the allowlist" } }, { status: 403 })],
        onForbidden: (message) => { reason = message; },
    });
    await assert.rejects(client.call("listSessions"), /not on the allowlist/);
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
