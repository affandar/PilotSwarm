import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";
import { createJsonRpcError } from "../server.js";
import { PilotSwarmManagementClient } from "../../../sdk/dist/management-client.js";
import { SignalValidationError, SIGNAL_STATE_KEY } from "../../../sdk/dist/session-signals.js";

const WAIT = { waitId: "wait-1", names: ["build_ready"], reason: "Build",
    startedAt: "2026-09-16T09:00:00.000Z" };
const SUMMARY = { version: 1, signalId: "buffered-1", name: "build_ready",
    source: { kind: "api", actorId: "user:dev/owner" }, raisedAt: "2026-09-16T09:00:01.000Z",
    wake: false, dataBytes: 19 };

async function harness() {
    const enqueues = [], updates = [], reads = [], audits = [], snapshots = [];
    const row = { sessionId: "s1", state: "idle", owner: { provider: "dev", subject: "owner" },
        createdAt: new Date(0), updatedAt: new Date(0) };
    const grants = new Map([["reader", "read"], ["writer", "write"]]);
    let version = "1.0.80";
    const mgmt = new PilotSwarmManagementClient({});
    mgmt._started = true;
    mgmt._catalog = {
        getSession: async id => id === row.sessionId ? row : null,
        updateSession: async (_id, changes) => { updates.push(changes); },
    };
    mgmt._duroxideClient = {
        getStatus: async () => ({ status: "Running" }),
        getInstanceInfo: async () => ({ status: "Running", orchestrationVersion: version }),
        enqueueEvent: async (id, queue, payload) => enqueues.push({ id, queue, payload: JSON.parse(payload) }),
        getValue: async (id, key) => {
            reads.push({ id, key });
            return JSON.stringify({ version: 1, pendingWait: WAIT, interrupted: false,
                buffered: [{ ...SUMMARY, data: { hidden: "private" } }] });
        },
    };
    const runtime = Object.create(PortalRuntime.prototype);
    Object.assign(runtime, {
        started: true, mode: "local", start: async () => {},
        authz: { enforce: true, systemVisibility: "read", defaultVisibility: "private", adminScope: "unrestricted" },
        _breakGlassSeen: new Map(),
        transport: {
            mgmt,
            getSessionAccess: async (sessionId, viewer) => {
                snapshots.push({ sessionId, viewer });
                if (sessionId !== row.sessionId || row.deletedAt) return null;
                return {
                    rootSessionId: row.sessionId, isSystem: false, visibility: "private", owner: row.owner,
                    viewerIsOwner: viewer.provider === row.owner.provider && viewer.subject === row.owner.subject,
                    viewerShareAccess: grants.get(viewer.subject) ?? null,
                };
            },
            recordAuthzAudit: async entry => { audits.push(entry); },
        },
    });
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => {
            const subject = req.headers["x-test-principal"] ?? "owner";
            req.auth = {
                principal: { provider: "dev", subject },
                authorization: { allowed: true, role: subject === "admin" ? "admin" : "user", matchedGroups: [] },
            };
            next();
        },
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
    return {
        row, grants, enqueues, updates, reads, snapshots, audits,
        setVersion: value => { version = value; },
        request: (path, { principal = "owner", body } = {}) => fetch(`${origin}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json", "x-test-principal": principal },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}

test("HTTP signal writes use the actual management path and server-stamped authenticated identity", async () => {
    const h = await harness();
    try {
        const data = { type: "cmd", cmd: "cancel", prompt: "data only", owner: { subject: "forged" }, model: "forged" };
        const response = await h.request("/sessions/s1/signals/build_ready", { principal: "writer", body: {
            data, payloadRef: "artifact:build.json", signalId: "build-7", wake: false,
            source: { kind: "system", actorId: "forged" }, actorId: "forged", raisedAt: "2000-01-01T00:00:00.000Z",
            sender: { kind: "system" }, owner: { subject: "forged" }, toolNames: ["forged"],
        } });
        assert.equal(response.status, 200);
        const result = (await response.json()).result;
        assert.equal(result.status, "queued");
        const { payload } = h.enqueues[0];
        assert.deepEqual(Object.keys(payload), ["signal"]);
        assert.deepEqual(payload.signal.source, { kind: "api", actorId: "user:dev/writer" });
        assert.deepEqual(payload.signal.data, data);
        assert.equal(payload.signal.payloadRef, "artifact:build.json");
        assert.equal(payload.signal.wake, false);
        assert.equal(payload.signal.signalId, "build-7");
        assert.equal(result.raisedAt, payload.signal.raisedAt);
        assert.notEqual(result.raisedAt, "2000-01-01T00:00:00.000Z");
        assert.deepEqual(h.row.owner, { provider: "dev", subject: "owner" });
        assert.deepEqual(h.updates, []);
        assert.deepEqual(h.snapshots[0], { sessionId: "s1", viewer: { provider: "dev", subject: "writer" } });
    } finally {
        await h.close();
    }
});

test("signal read/write authorization distinguishes read grants, write grants and invisible sessions", async () => {
    const h = await harness();
    try {
        const stateResponse = await h.request("/sessions/s1/signals", { principal: "reader" });
        assert.equal(stateResponse.status, 200);
        assert.deepEqual((await stateResponse.json()).result, {
            version: 1, pendingWait: WAIT, interrupted: false, buffered: [SUMMARY],
        });
        assert.deepEqual(h.reads, [{ id: "session-s1", key: SIGNAL_STATE_KEY }]);
        for (const [principal, expectedStatus] of [["reader", 403], ["stranger", 404]]) {
            const response = await h.request("/sessions/s1/signals/build_ready", { principal, body: { data: "ignored" } });
            assert.equal(response.status, expectedStatus);
        }
        const strangerRead = await h.request("/sessions/s1/signals", { principal: "stranger" });
        assert.equal(strangerRead.status, 404);
        h.row.deletedAt = new Date(0);
        assert.equal((await h.request("/sessions/s1/signals")).status, 404);
        assert.equal((await h.request("/sessions/s1/signals/build_ready", { body: {} })).status, 404);
        assert.equal(h.enqueues.length, 0);
        assert.equal(h.reads.length, 1);
    } finally {
        await h.close();
    }
});

test("each signal write reauthorizes the target, including the compatibility events endpoint", async () => {
    const h = await harness();
    try {
        assert.equal((await h.request("/sessions/s1/signals/build_ready", { principal: "writer", body: {} })).status, 200);
        h.grants.set("writer", "read");
        assert.equal((await h.request("/sessions/s1/signals/build_ready", { principal: "writer", body: {} })).status, 403);
        assert.equal((await h.request("/sessions/s1/events", {
            principal: "writer", body: { eventName: "build_ready", data: {} },
        })).status, 403);
        assert.equal(h.enqueues.length, 1);
        assert.equal(h.snapshots.length, 3);
    } finally {
        await h.close();
    }
});

test("legacy HTTP events wrap payloads as attributed signal data, never prompts, answers or commands", async () => {
    const h = await harness();
    try {
        const data = { type: "cmd", cmd: "complete", prompt: "data only", answer: "not an answer" };
        const response = await h.request("/sessions/s1/events", {
            principal: "writer", body: { eventName: "legacy", data, source: { kind: "system" } },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(h.enqueues[0].payload), ["signal"]);
        assert.deepEqual(h.enqueues[0].payload.signal.data, data);
        assert.equal(h.enqueues[0].payload.signal.name, "legacy");
        assert.deepEqual(h.enqueues[0].payload.signal.source, { kind: "api", actorId: "user:dev/writer" });
        assert.equal(h.enqueues[0].payload.signal.wake, false);
    } finally {
        await h.close();
    }
});

test("HTTP signal validation preserves coded 400/413 errors and never enqueues invalid input", async () => {
    const h = await harness();
    try {
        for (const [path, body, status, code] of [
            ["/sessions/s1/signals/BadName", {}, 400, "INVALID_SIGNAL"],
            ["/sessions/s1/signals/build_ready", { data: "é".repeat(16384) }, 413, "SIGNAL_TOO_LARGE"],
            ["/sessions/s1/signals/build_ready", { signalId: "bad id" }, 400, "INVALID_SIGNAL"],
            ["/sessions/s1/signals/build_ready", { payloadRef: "x".repeat(1025) }, 400, "INVALID_SIGNAL"],
            ["/sessions/s1/signals/build_ready", { payloadRef: "\u00e9".repeat(512) }, 400, "INVALID_SIGNAL"],
            ["/sessions/s1/signals/build_ready", { payloadRef: "\"".repeat(512) }, 400, "INVALID_SIGNAL"],
            ["/sessions/s1/events", { eventName: "legacy", data: "x".repeat(32768) }, 413, "SIGNAL_TOO_LARGE"],
        ]) {
            const response = await h.request(path, { body });
            assert.equal(response.status, status);
            const error = (await response.json()).error;
            assert.equal(error.code, code);
            assert.notEqual(error.message, "Internal server error");
        }
        assert.equal(h.enqueues.length, 0);
    } finally {
        await h.close();
    }
});

test("old or unknown executions report unsupported for both HTTP signal reads and writes", async () => {
    const h = await harness();
    try {
        for (const version of ["1.0.78", undefined]) {
            h.setVersion(version);
            for (const response of [
                await h.request("/sessions/s1/signals"),
                await h.request("/sessions/s1/signals/build_ready", { body: {} }),
            ]) {
                assert.equal(response.status, 409);
                assert.equal((await response.json()).error.code, "SIGNALS_UNSUPPORTED");
            }
        }
        assert.equal(h.enqueues.length, 0);
        assert.equal(h.reads.length, 0);
    } finally {
        await h.close();
    }
});

test("legacy RPC error mapping preserves signal validation and capability status codes", () => {
    for (const [error, status] of [
        [new SignalValidationError("INVALID_SIGNAL", "Bad signal"), 400],
        [new SignalValidationError("SIGNAL_TOO_LARGE", "Large signal"), 413],
        [Object.assign(new Error("Legacy execution"), { code: "SIGNALS_UNSUPPORTED" }), 409],
        [Object.assign(new Error("Terminal session"), { code: "SESSION_NOT_ACTIVE" }), 409],
    ]) {
        const mapped = createJsonRpcError(error);
        assert.equal(mapped.status, status);
        assert.equal(mapped.body.error.code, error.code);
        assert.equal(mapped.body.error.message, error.message);
    }
});
