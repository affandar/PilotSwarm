import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Placement authz matrix over the real HTTP stack: in-process portal server
 * against local Postgres, dev-auth personas via `Bearer dev:<name>`.
 *
 * Groups are a viewer's PRIVATE organization: read access to a session is
 * enough to place it into one of YOUR OWN groups; the target-group ownership
 * check is always enforced (both AUTHZ_ENFORCE_OWNERSHIP modes); nobody ever
 * sees another viewer's groups or placements.
 */

const DATABASE_URL =
    process.env.PS_TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const runId = crypto.randomBytes(4).toString("hex");
const CMS_SCHEMA = `wt_place_cms_${runId}`;
const DUROXIDE_SCHEMA = `wt_place_dx_${runId}`;
const FACTS_SCHEMA = `wt_place_facts_${runId}`;

const pgAvailable = await (async () => {
    const probe = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
    try {
        await probe.connect();
        await probe.end();
        return true;
    } catch {
        await probe.end().catch(() => {});
        return false;
    }
})();

const SKIP = pgAvailable ? false : `local Postgres not reachable at ${DATABASE_URL}`;

let server = null;
let baseUrl = "";
let stateDir = null;

async function bootServer({ enforce }) {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.PILOTSWARM_CMS_SCHEMA = CMS_SCHEMA;
    process.env.PILOTSWARM_DUROXIDE_SCHEMA = DUROXIDE_SCHEMA;
    process.env.PILOTSWARM_FACTS_SCHEMA = FACTS_SCHEMA;
    process.env.SESSION_STATE_DIR = stateDir;
    process.env.WORKERS = "0";
    process.env.PORTAL_TUI_MODE = "local";
    process.env.PORTAL_AUTH_PROVIDER = "dev";
    process.env.PORTAL_AUTH_DEV_ALLOW = "true";
    process.env.AUTHZ_ENFORCE_OWNERSHIP = enforce ? "true" : "false";
    process.env.PS_MODEL_PROVIDERS_PATH = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../sdk/test/fixtures/model-providers.test.json",
    );
    if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = "dummy-placement-test-token";
    const { startServer } = await import("../server.js");
    server = await startServer({ port: 0 });
    baseUrl = `http://localhost:${server.address().port}`;
}

async function stopServer() {
    if (server?.stopPortal) await server.stopPortal();
    server = null;
}

async function api(persona, method, apiPath, body) {
    const response = await fetch(`${baseUrl}/api/v1${apiPath}`, {
        method,
        headers: { authorization: `Bearer dev:${persona}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
}

async function ok(persona, method, apiPath, body) {
    const { status, payload } = await api(persona, method, apiPath, body);
    assert.equal(status, 200, `${method} ${apiPath} as ${persona}: ${JSON.stringify(payload)}`);
    assert.equal(payload.ok, true);
    return payload.result;
}

before(async () => {
    if (!pgAvailable) return;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-placement-"));
    await bootServer({ enforce: true });
});

after(async () => {
    await stopServer();
    if (pgAvailable) {
        const pool = new pg.Pool({ connectionString: DATABASE_URL });
        try {
            for (const schema of [CMS_SCHEMA, DUROXIDE_SCHEMA, FACTS_SCHEMA]) {
                await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            }
        } finally {
            await pool.end();
        }
    }
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

// Shared state built up across the sequential tests below.
const groups = {}; // persona -> groupId
let sessionId = null; // alice's shared session

test("each persona creates their own group", { skip: SKIP }, async () => {
    for (const persona of ["alice", "bob", "carol", "dave", "ada"]) {
        const group = await ok(persona, "POST", "/management/session-groups", {
            input: { title: `${persona}'s group` },
        });
        assert.ok(group.groupId, `${persona} group created`);
        groups[persona] = group.groupId;
    }
});

test("alice creates a session and grants bob write, carol read", { skip: SKIP }, async () => {
    const created = await ok("alice", "POST", "/sessions", {});
    sessionId = created.sessionId;
    assert.ok(sessionId);
    await ok("alice", "POST", `/sessions/${sessionId}/shares`, {
        user: { provider: "dev", subject: "bob" }, access: "write",
    });
    await ok("alice", "POST", `/sessions/${sessionId}/shares`, {
        user: { provider: "dev", subject: "carol" }, access: "read",
    });
});

test("owner, write grantee, and read grantee can each place the session into THEIR OWN group", { skip: SKIP }, async () => {
    for (const persona of ["alice", "bob", "carol"]) {
        const result = await ok(persona, "POST", "/management/session-groups/place", {
            groupId: groups[persona], sessionIds: [sessionId],
        });
        assert.deepEqual(result, [{ rootSessionId: sessionId, placed: true, reason: null }], persona);
    }
});

test("stranger on an unreadable session: not placed, indistinguishable from an unknown id", { skip: SKIP }, async () => {
    const unreadable = await ok("dave", "POST", "/management/session-groups/place", {
        groupId: groups.dave, sessionIds: [sessionId],
    });
    const unknown = await ok("dave", "POST", "/management/session-groups/place", {
        groupId: groups.dave, sessionIds: ["no-such-session"],
    });
    assert.deepEqual(unreadable, [{ rootSessionId: sessionId, placed: false, reason: "not_found" }]);
    assert.deepEqual(unknown, [{ rootSessionId: "no-such-session", placed: false, reason: "not_found" }]);
});

test("cross-user target group is always 403 — strangers, grantees, and admins alike", { skip: SKIP }, async () => {
    for (const persona of ["bob", "dave", "ada"]) {
        const { status, payload } = await api(persona, "POST", "/management/session-groups/place", {
            groupId: groups.alice, sessionIds: [sessionId],
        });
        assert.equal(status, 403, `${persona} into alice's group`);
        assert.equal(payload.error.code, "FORBIDDEN");
        assert.match(payload.error.message, /not found or not owned/i);
    }
});

test("deprecated aliases behave identically to placeSessionsInGroup", { skip: SKIP }, async () => {
    const assign = await ok("bob", "POST", `/management/session-groups/${groups.bob}/assign`, {
        sessionIds: [sessionId],
    });
    assert.deepEqual(assign, [{ rootSessionId: sessionId, placed: true, reason: null }]);

    const move = await ok("alice", "POST", "/management/session-groups/move", {
        groupId: groups.alice, sessionIds: [sessionId],
    });
    assert.deepEqual(move, [{ rootSessionId: sessionId, placed: true, reason: null }]);

    const crossAssign = await api("dave", "POST", `/management/session-groups/${groups.alice}/assign`, {
        sessionIds: [sessionId],
    });
    assert.equal(crossAssign.status, 403);
    const crossMove = await api("dave", "POST", "/management/session-groups/move", {
        groupId: groups.alice, sessionIds: [sessionId],
    });
    assert.equal(crossMove.status, 403);
});

test("listSessionGroups is viewer-scoped for everyone — admins see their own organization only", { skip: SKIP }, async () => {
    const aliceGroups = await ok("alice", "GET", "/management/session-groups");
    assert.deepEqual(aliceGroups.map((g) => g.groupId), [groups.alice]);
    assert.equal(aliceGroups[0].memberCount, 1);

    const adaGroups = await ok("ada", "GET", "/management/session-groups");
    assert.deepEqual(adaGroups.map((g) => g.groupId), [groups.ada], "admin sees only their own groups");
});

test("session DTOs carry the viewer's own placement as viewerGroupId and never a groupId key", { skip: SKIP }, async () => {
    const aliceRow = (await ok("alice", "GET", "/sessions")).find((s) => s.sessionId === sessionId);
    assert.equal(aliceRow.viewerGroupId, groups.alice);
    assert.ok(!("groupId" in aliceRow), "list rows must not carry groupId");

    const bobRow = (await ok("bob", "GET", "/sessions")).find((s) => s.sessionId === sessionId);
    assert.equal(bobRow.viewerGroupId, groups.bob, "bob sees his own placement, not alice's");

    const carolView = await ok("carol", "GET", `/sessions/${sessionId}`);
    assert.equal(carolView.viewerGroupId, groups.carol);
    assert.ok(!("groupId" in carolView));

    const page = await ok("alice", "GET", "/management/sessions?limit=50");
    const pageRow = page.sessions.find((s) => s.sessionId === sessionId);
    assert.equal(pageRow.viewerGroupId, groups.alice);
    assert.ok(!("groupId" in pageRow));

    const aliceAccess = await ok("alice", "GET", `/sessions/${sessionId}/access`);
    assert.equal(aliceAccess.viewerGroupId, groups.alice);
    const bobAccess = await ok("bob", "GET", `/sessions/${sessionId}/access`);
    assert.equal(bobAccess.viewerGroupId, groups.bob);
});

test("point-read 404 is identical for unknown and unreadable sessions", { skip: SKIP }, async () => {
    const unreadable = await api("dave", "GET", `/sessions/${sessionId}`);
    const unknown = await api("dave", "GET", "/sessions/no-such-session");
    assert.equal(unreadable.status, 404);
    assert.deepEqual(unreadable.payload, unknown.payload, "no existence oracle");
});

test("ungroup (groupId null) clears only the caller's placement", { skip: SKIP }, async () => {
    const result = await ok("alice", "POST", "/management/session-groups/place", {
        groupId: null, sessionIds: [sessionId],
    });
    assert.deepEqual(result, [{ rootSessionId: sessionId, placed: true, reason: null }]);

    const aliceView = await ok("alice", "GET", `/sessions/${sessionId}`);
    assert.equal(aliceView.viewerGroupId ?? null, null);
    const bobView = await ok("bob", "GET", `/sessions/${sessionId}`);
    assert.equal(bobView.viewerGroupId, groups.bob, "bob's placement survives alice's ungroup");
});

test("createSession pre-validates a creator-supplied groupId as the caller's own group", { skip: SKIP }, async () => {
    for (const groupId of [groups.bob, "no-such-group"]) {
        const { status, payload } = await api("alice", "POST", "/sessions", { groupId });
        assert.equal(status, 403, `create into ${groupId}`);
        assert.equal(payload.error.code, "FORBIDDEN");
        assert.match(payload.error.message, /not found or not owned/i);
    }

    const created = await ok("alice", "POST", "/sessions", { groupId: groups.alice });
    const view = await ok("alice", "GET", `/sessions/${created.sessionId}`);
    assert.equal(view.viewerGroupId, groups.alice, "creator placement lands in the same transaction");
});

test("flip to AUTHZ_ENFORCE_OWNERSHIP=false", { skip: SKIP }, async () => {
    await stopServer();
    await bootServer({ enforce: false });
});

test("enforce=false: any admitted caller can place any live session into their own group", { skip: SKIP }, async () => {
    const result = await ok("dave", "POST", "/management/session-groups/place", {
        groupId: groups.dave, sessionIds: [sessionId],
    });
    assert.deepEqual(result, [{ rootSessionId: sessionId, placed: true, reason: null }]);
    const daveView = await ok("dave", "GET", `/sessions/${sessionId}`);
    assert.equal(daveView.viewerGroupId, groups.dave);
    assert.ok(!("groupId" in daveView));
});

test("enforce=false: cross-user target group is still 403", { skip: SKIP }, async () => {
    const { status, payload } = await api("dave", "POST", "/management/session-groups/place", {
        groupId: groups.alice, sessionIds: [sessionId],
    });
    assert.equal(status, 403);
    assert.equal(payload.error.code, "FORBIDDEN");
});

test("enforce=false: group listing stays viewer-scoped", { skip: SKIP }, async () => {
    const aliceGroups = await ok("alice", "GET", "/management/session-groups");
    assert.deepEqual(aliceGroups.map((g) => g.groupId), [groups.alice]);
});
