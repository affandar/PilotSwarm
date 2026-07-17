import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Cross-viewer group-leak scan over the portal's REST read surface: in-process
 * portal server against local Postgres, dev-auth personas via `Bearer dev:<name>`.
 *
 * Group placements are a viewer's PRIVATE organization. When alice shares a
 * session she placed in one of her groups, NOTHING bob receives — list rows,
 * session detail, access snapshot, or the events catch-up/history payloads the
 * portal polls — may carry any group-shaped key or alice's group id string.
 * The only tolerated group key is bob's own viewerGroupId, and it must be
 * null/absent until bob places the session himself.
 */

const DATABASE_URL =
    process.env.PS_TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const runId = crypto.randomBytes(4).toString("hex");
const CMS_SCHEMA = `wt_leak_cms_${runId}`;
const DUROXIDE_SCHEMA = `wt_leak_dx_${runId}`;
const FACTS_SCHEMA = `wt_leak_facts_${runId}`;

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
let pool = null;

async function bootServer() {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.PILOTSWARM_CMS_SCHEMA = CMS_SCHEMA;
    process.env.PILOTSWARM_DUROXIDE_SCHEMA = DUROXIDE_SCHEMA;
    process.env.PILOTSWARM_FACTS_SCHEMA = FACTS_SCHEMA;
    process.env.SESSION_STATE_DIR = stateDir;
    process.env.WORKERS = "0";
    process.env.PORTAL_TUI_MODE = "local";
    process.env.PORTAL_AUTH_PROVIDER = "dev";
    process.env.PORTAL_AUTH_DEV_ALLOW = "true";
    process.env.AUTHZ_ENFORCE_OWNERSHIP = "true";
    process.env.PS_MODEL_PROVIDERS_PATH = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../sdk/test/fixtures/model-providers.test.json",
    );
    if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = "dummy-group-leak-test-token";
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
    const text = await response.text();
    return { status: response.status, text, payload: JSON.parse(text) };
}

async function ok(persona, method, apiPath, body) {
    const { status, text, payload } = await api(persona, method, apiPath, body);
    assert.equal(status, 200, `${method} ${apiPath} as ${persona}: ${text}`);
    assert.equal(payload.ok, true);
    return { result: payload.result, payload, text };
}

before(async () => {
    if (!pgAvailable) return;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-group-leak-"));
    await bootServer();
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
});

after(async () => {
    await stopServer();
    if (pgAvailable) {
        const cleanupPool = pool ?? new pg.Pool({ connectionString: DATABASE_URL });
        try {
            for (const schema of [CMS_SCHEMA, DUROXIDE_SCHEMA, FACTS_SCHEMA]) {
                await cleanupPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            }
        } finally {
            await cleanupPool.end();
        }
        pool = null;
    }
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

// ── Recursive key scan ───────────────────────────────────────────

/** Every key matching /group/i anywhere in a parsed payload, with its path. */
function collectGroupKeys(value, keyPath = "$", found = []) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectGroupKeys(item, `${keyPath}[${index}]`, found));
    } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            if (/group/i.test(key)) found.push({ path: `${keyPath}.${key}`, key, value: child });
            collectGroupKeys(child, `${keyPath}.${key}`, found);
        }
    }
    return found;
}

/**
 * A recipient's payload may carry group-shaped keys ONLY as its own
 * viewerGroupId, and only when that placement is empty (null).
 */
function assertNoForeignGroupKeys(payload, label) {
    const offenders = collectGroupKeys(payload)
        .filter((hit) => !(hit.key === "viewerGroupId" && hit.value == null));
    assert.deepEqual(
        offenders.map((hit) => `${hit.path}=${JSON.stringify(hit.value)}`),
        [],
        `${label}: group-shaped keys leaked to the recipient`,
    );
}

// The REST read surface the portal drives for an open session: list rows,
// the paginated management list, session detail, the access snapshot, the
// events catch-up poll, and the events history pager.
const readSurface = (sessionId) => [
    "/sessions",
    `/sessions/${sessionId}`,
    `/sessions/${sessionId}/access`,
    "/management/sessions?limit=50",
    `/management/sessions/${sessionId}/events`,
    `/management/sessions/${sessionId}/events?afterSeq=0&limit=100`,
    `/management/sessions/${sessionId}/events-before?beforeSeq=1000000&limit=100`,
];

async function assertRecipientSurfaceClean(persona, sessionId, groupIds, label) {
    for (const apiPath of readSurface(sessionId)) {
        const { payload, text } = await ok(persona, "GET", apiPath);
        assertNoForeignGroupKeys(payload, `${label} GET ${apiPath}`);
        for (const groupId of groupIds) {
            assert.ok(
                !text.includes(groupId),
                `${label} GET ${apiPath}: foreign group id ${groupId} present in raw JSON`,
            );
        }
    }
}

// Shared state across the sequential tests below.
const aliceGroupIds = [];
let sessionId = null;

test("alice creates a session inside her group and shares it with bob", { skip: SKIP }, async () => {
    const { result: group } = await ok("alice", "POST", "/management/session-groups", {
        input: { title: "alice private group" },
    });
    assert.ok(group.groupId);
    aliceGroupIds.push(group.groupId);

    const { result: created } = await ok("alice", "POST", "/sessions", { groupId: group.groupId });
    sessionId = created.sessionId;
    assert.ok(sessionId);

    // Seed a realistic transcript directly in CMS (no workers in this
    // harness) so the events endpoints return real rows to scan.
    await pool.query(`SELECT ${CMS_SCHEMA}.cms_record_events($1, $2::jsonb, $3)`, [
        sessionId,
        JSON.stringify([
            { eventType: "user.message", data: { role: "user", content: "hello from alice" } },
            { eventType: "assistant.message", data: { role: "assistant", content: "hi alice" } },
            { eventType: "session.state", data: { state: "idle" } },
        ]),
        "group-leak-test",
    ]);

    await ok("alice", "POST", `/sessions/${sessionId}/shares`, {
        user: { provider: "dev", subject: "bob" }, access: "read",
    });
});

test("scan control: alice's own responses DO carry her viewerGroupId", { skip: SKIP }, async () => {
    const detail = await ok("alice", "GET", `/sessions/${sessionId}`);
    assert.equal(detail.result.viewerGroupId, aliceGroupIds[0]);
    assert.ok(detail.text.includes(aliceGroupIds[0]), "raw JSON carries the owner's own group id");

    // The recursive scanner must be able to see that key — otherwise a clean
    // scan of bob's payloads would prove nothing.
    const hits = collectGroupKeys(detail.payload);
    assert.ok(
        hits.some((hit) => hit.key === "viewerGroupId" && hit.value === aliceGroupIds[0]),
        "scanner finds the owner's viewerGroupId",
    );

    const { result: rows } = await ok("alice", "GET", "/sessions");
    const row = rows.find((candidate) => candidate.sessionId === sessionId);
    assert.equal(row.viewerGroupId, aliceGroupIds[0], "list row carries the owner's placement");
});

test("bob sees the shared session and its events, with no group anywhere", { skip: SKIP }, async () => {
    const { result: rows } = await ok("bob", "GET", "/sessions");
    assert.ok(rows.some((row) => row.sessionId === sessionId), "share is visible to bob");

    const { result: events } = await ok("bob", "GET", `/management/sessions/${sessionId}/events`);
    assert.ok(events.length >= 3, "events catch-up returns the seeded transcript");

    const detail = await ok("bob", "GET", `/sessions/${sessionId}`);
    assert.equal(detail.result.viewerGroupId ?? null, null, "bob has not placed the session");

    await assertRecipientSurfaceClean("bob", sessionId, aliceGroupIds, "before re-place");
});

test("bob's surface stays clean after alice re-places the session", { skip: SKIP }, async () => {
    const { result: second } = await ok("alice", "POST", "/management/session-groups", {
        input: { title: "alice second group" },
    });
    aliceGroupIds.push(second.groupId);

    const { result: placed } = await ok("alice", "POST", "/management/session-groups/place", {
        groupId: second.groupId, sessionIds: [sessionId],
    });
    assert.deepEqual(placed, [{ rootSessionId: sessionId, placed: true, reason: null }]);

    const { result: moved } = await ok("alice", "POST", "/management/session-groups/move", {
        groupId: aliceGroupIds[0], sessionIds: [sessionId],
    });
    assert.deepEqual(moved, [{ rootSessionId: sessionId, placed: true, reason: null }]);

    const detail = await ok("alice", "GET", `/sessions/${sessionId}`);
    assert.equal(detail.result.viewerGroupId, aliceGroupIds[0], "alice's placement moved");

    await assertRecipientSurfaceClean("bob", sessionId, aliceGroupIds, "after re-place");
});
