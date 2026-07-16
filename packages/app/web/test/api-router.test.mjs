import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { OPERATIONS } from "pilotswarm-sdk/api";
import { createApiRouter } from "../api/router.js";

function createHarness({ callImpl, role = "user" } = {}) {
    const calls = [];
    const runtime = {
        started: true,
        mode: "local",
        async start() {},
        async getBootstrap() {
            return { mode: "local", workerCount: 1 };
        },
        async downloadArtifactBinary(sessionId, filename) {
            return { contentType: "application/octet-stream", body: Buffer.from(`${sessionId}:${filename}`) };
        },
        async call(name, params, authContext) {
            calls.push({ name, params, authContext });
            if (callImpl) return callImpl(name, params);
            return { echoed: name };
        },
    };
    const requireAuth = (req, _res, next) => {
        req.auth = { principal: { provider: "none", subject: "unknown" }, authorization: { allowed: true, role, reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, () => {
            const baseUrl = `http://localhost:${server.address().port}`;
            resolve({ baseUrl, calls, close: () => new Promise((done) => server.close(done)) });
        });
    });
}

test("every operation in the table is routable and dispatches by name", async () => {
    // Admin role so Tier-2 admin ops also dispatch (their gating is covered separately).
    const { baseUrl, calls, close } = await createHarness({ role: "admin" });
    try {
        for (const op of OPERATIONS) {
            const path = op.path.replace(/:([\w]+)/g, "test-$1");
            const response = await fetch(`${baseUrl}/api/v1${path}`, {
                method: op.method,
                headers: { "content-type": "application/json" },
                ...(op.method === "GET" || op.method === "DELETE" ? {} : { body: "{}" }),
            });
            assert.equal(response.status, 200, `${op.method} ${path} should bind (${op.name})`);
            const payload = await response.json();
            assert.equal(payload.ok, true, `${op.name} envelope`);
        }
        const dispatched = calls.map((call) => call.name);
        assert.deepEqual([...new Set(dispatched)].sort(), OPERATIONS.map((op) => op.name).sort());
    } finally {
        await close();
    }
});

test("path, query, and body params are collected with declared types", async () => {
    const { baseUrl, calls, close } = await createHarness();
    try {
        const cursor = { updatedAt: 123, sessionId: "abc" };
        await fetch(`${baseUrl}/api/v1/management/sessions?limit=5&includeDeleted=true&cursor=${encodeURIComponent(JSON.stringify(cursor))}`);
        const page = calls.find((call) => call.name === "listSessionsPage");
        assert.deepEqual(page.params, { limit: 5, includeDeleted: true, cursor });

        await fetch(`${baseUrl}/api/v1/sessions/s1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "hi", options: { clientMessageIds: ["m1"] }, ignored: "x" }),
        });
        const send = calls.find((call) => call.name === "sendMessage");
        assert.deepEqual(send.params, { sessionId: "s1", prompt: "hi", options: { clientMessageIds: ["m1"] } });
        assert.equal(send.authContext.principal.subject, "unknown", "auth context reaches the dispatcher");

        const eventTypes = ["user.message", "assistant.message", "system.message"];
        await fetch(`${baseUrl}/api/v1/management/sessions/s2/events-before?beforeSeq=100&limit=50&eventTypes=${encodeURIComponent(JSON.stringify(eventTypes))}`);
        const before = calls.find((call) => call.name === "getSessionEventsBefore");
        assert.deepEqual(before.params, { sessionId: "s2", beforeSeq: 100, limit: 50, eventTypes });

        await fetch(`${baseUrl}/api/v1/management/sessions/s2/events?afterSeq=5`);
        const after = calls.find((call) => call.name === "getSessionEvents");
        assert.deepEqual(after.params, { sessionId: "s2", afterSeq: 5 }, "omitted eventTypes stays absent");
    } finally {
        await close();
    }
});

test("runtime errors map to the structured envelope with sensible statuses", async () => {
    const { baseUrl, close } = await createHarness({
        callImpl: (name) => {
            if (name === "getSession") {
                throw Object.assign(new Error("nope"), { code: "PORTAL_AUTH_REQUIRED" });
            }
            if (name === "listSessionsPage") {
                throw new Error("listSessionsPage cursor.updatedAt must be a finite number");
            }
            if (name === "setSessionModel") {
                throw new Error("Unknown model: gpt-9-nonexistent");
            }
            throw new Error("kaboom");
        },
    });
    try {
        const authRequired = await fetch(`${baseUrl}/api/v1/sessions/x`);
        assert.equal(authRequired.status, 401);
        assert.equal((await authRequired.json()).error.code, "PORTAL_AUTH_REQUIRED");

        const validation = await fetch(`${baseUrl}/api/v1/management/sessions`);
        assert.equal(validation.status, 400, "runtime validation errors map to 400");

        // Model validation is a client error: the message is the value, so it
        // must map to 400 and survive to the caller (not genericize to 500).
        const unknownModel = await fetch(`${baseUrl}/api/v1/management/sessions/s1/model`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ options: { model: "gpt-9-nonexistent" } }),
        });
        assert.equal(unknownModel.status, 400, "unknown model maps to 400");
        assert.match((await unknownModel.json()).error.message, /Unknown model/, "message preserved");

        const boom = await fetch(`${baseUrl}/api/v1/models`);
        assert.equal(boom.status, 500);
        assert.equal((await boom.json()).error.code, "INTERNAL_ERROR");

        const malformedCursor = await fetch(`${baseUrl}/api/v1/management/sessions?cursor=%7Bnope`);
        assert.equal(malformedCursor.status, 400, "malformed json query rejected before dispatch");
    } finally {
        await close();
    }
});

test("traversal-shaped id path params are rejected before dispatch", async () => {
    const { baseUrl, calls, close } = await createHarness();
    try {
        // %2F decodes to "/" in the path param; a separator or ".." must never
        // reach the filesystem artifact store. Express rejects some shapes with
        // a routing 404 and our guard rejects the rest with 400 — either way
        // the request never dispatches.
        for (const badId of ["..%2F..%2Fetc", "a%2Fb", "%2e%2e"]) {
            const res = await fetch(`${baseUrl}/api/v1/sessions/${badId}/artifacts/x/text`);
            assert.ok(res.status === 400 || res.status === 404, `rejected ${badId} (got ${res.status})`);
            const dl = await fetch(`${baseUrl}/api/v1/sessions/${badId}/artifacts/x/download`);
            assert.ok(dl.status === 400 || dl.status === 404, `download rejected ${badId} (got ${dl.status})`);
        }
        assert.equal(calls.length, 0, "no traversal id reached the dispatcher");
    } finally {
        await close();
    }
});

test("admin-flagged operations require the admin role", async () => {
    // Default harness principal is role "user" — admin ops must 403 before dispatch.
    const { baseUrl, calls, close } = await createHarness();
    try {
        const purge = await fetch(`${baseUrl}/api/v1/facts/purge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: {} }),
        });
        assert.equal(purge.status, 403, "forcePurgeFacts requires admin");
        assert.equal((await purge.json()).error.code, "FORBIDDEN");
        assert.ok(!calls.some((c) => c.name === "forcePurgeFacts"), "admin op never dispatched for a non-admin");
    } finally {
        await close();
    }
});

test("admin operations dispatch for an admin principal", async () => {
    const { baseUrl, calls, close } = await createHarness({ role: "admin" });
    try {
        const res = await fetch(`${baseUrl}/api/v1/facts/purge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: { cutoff: "2020-01-01" } }),
        });
        assert.equal(res.status, 200, "admin passes the gate");
        assert.ok(calls.some((c) => c.name === "forcePurgeFacts"), "admin op dispatched");
    } finally {
        await close();
    }
});

test("no-auth (anonymous) callers pass the admin gate", async () => {
    // No-auth deployments resolve role "anonymous" = full access; admin ops must dispatch.
    const { baseUrl, calls, close } = await createHarness({ role: "anonymous" });
    try {
        const res = await fetch(`${baseUrl}/api/v1/facts/embedder/start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 200, "no-auth admin op dispatches");
        assert.ok(calls.some((c) => c.name === "startFactsEmbedder"), "admin op reached the dispatcher in no-auth mode");
    } finally {
        await close();
    }
});

test("non-admin facts data-plane ops are not gated", async () => {
    const { baseUrl, calls, close } = await createHarness();
    try {
        const res = await fetch(`${baseUrl}/api/v1/facts/capabilities`);
        assert.equal(res.status, 200, "capabilities is open to any admitted caller");
        assert.ok(calls.some((c) => c.name === "factsCapabilities"));
    } finally {
        await close();
    }
});

test("unknown api routes return the NOT_FOUND envelope", async () => {
    const { baseUrl, close } = await createHarness();
    try {
        const response = await fetch(`${baseUrl}/api/v1/nope/nothing`);
        assert.equal(response.status, 404);
        const payload = await response.json();
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, "NOT_FOUND");
    } finally {
        await close();
    }
});

test("binary artifact download streams with attachment headers", async () => {
    const { baseUrl, close } = await createHarness();
    try {
        const response = await fetch(`${baseUrl}/api/v1/sessions/s1/artifacts/file.bin/download`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-disposition"), 'attachment; filename="file.bin"');
        assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "s1:file.bin");
    } finally {
        await close();
    }
});

// ── Access classification (security model) ───────────────────────────────

const VALID_ACCESS_CLASSES = new Set([
    "authed",
    "session:list", "session:create", "session:read", "session:write",
    "session:manage", "session:destroy", "session:share",
    "group:list", "group:manage",
    "facts:read", "facts:write",
    "fleet:read", "fleet:admin",
    "authz:audit",
]);

test("every protocol operation declares a known access class", () => {
    // A new op without a classification would default to "authed" in the
    // runtime gate — i.e. any admitted caller could invoke it. This lint keeps
    // the ownership model closed: adding an op forces an explicit access class.
    const unclassified = OPERATIONS.filter((op) => !op.access);
    assert.deepEqual(unclassified.map((op) => op.name), [], "every op must set `access`");

    const unknown = OPERATIONS.filter((op) => !VALID_ACCESS_CLASSES.has(op.access));
    assert.deepEqual(unknown.map((op) => `${op.name}:${op.access}`), [], "access classes must be from the known set");
});

test("every fleet:admin op is also admin-gated at the router", async () => {
    // The router hard-gates op.admin || op.access==='fleet:admin'. Verify each
    // fleet:admin op 403s for a non-admin regardless of the ownership flag.
    const fleetAdminOps = OPERATIONS.filter((op) => op.access === "fleet:admin");
    assert.ok(fleetAdminOps.length > 0, "there should be fleet:admin ops");
    const { baseUrl, calls, close } = await createHarness({ role: "user" });
    try {
        for (const op of fleetAdminOps) {
            const path = op.path.replace(/:([\w]+)/g, "test-$1");
            const res = await fetch(`${baseUrl}/api/v1${path}`, {
                method: op.method,
                headers: { "content-type": "application/json" },
                ...(op.method === "GET" || op.method === "DELETE" ? {} : { body: "{}" }),
            });
            assert.equal(res.status, 403, `${op.name} must 403 for a non-admin`);
        }
        assert.ok(!calls.some((c) => fleetAdminOps.find((op) => op.name === c.name)), "no fleet:admin op dispatched for a user");
    } finally {
        await close();
    }
});

test("session sharing ops are classified session:share", () => {
    for (const name of ["setSessionVisibility", "grantSessionShare", "revokeSessionShare", "listSessionShares"]) {
        const op = OPERATIONS.find((o) => o.name === name);
        assert.ok(op, `${name} present in the protocol table`);
        assert.equal(op.access, "session:share", `${name} must be session:share`);
    }
});
