/**
 * The viewer spine — the authz matrix for agent inspect tools, plus the
 * grep-guard that keeps it from being bypassed by the next tool someone adds.
 *
 * Why this suite exists: `createInspectTools` used to take no principal at
 * all. `agentIdentity` decided everything, the tuner bypassed the only
 * scoping rule that existed (`if (isTuner) return null`), and
 * `list_all_sessions` called `catalog.listSessions()` unfiltered — its
 * `owner_query` / `owner_kind` parameters are arguments the MODEL chooses,
 * never enforcement. That was sound while the sole holder was an ownerless
 * system session, and a privilege-escalation path the moment a user-owned
 * session held the bundle.
 *
 * Every assertion below was confirmed to FAIL against the pre-spine code
 * before the fix landed; a security test never seen red proves nothing.
 *
 * Run: node --test test/unit/inspect-viewer-spine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createInspectTools, NO_VIEWER } from "../../dist/inspect-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../../src/inspect-tools.ts");

const ALICE = { provider: "entra", subject: "alice" };
const BOB = { provider: "entra", subject: "bob" };

/**
 * A catalog holding four sessions: Alice's private one, Bob's private one,
 * Bob's shared-read one, and a system session.
 */
function fakeCatalog() {
    const rows = [
        { sessionId: "alice-own", title: "Alice's", owner: ALICE, isSystem: false, state: "idle", createdAt: new Date(0) },
        { sessionId: "bob-private", title: "Bob's private", owner: BOB, isSystem: false, state: "idle", createdAt: new Date(0) },
        { sessionId: "bob-shared", title: "Bob's shared", owner: BOB, isSystem: false, state: "idle", createdAt: new Date(0) },
        { sessionId: "sys", title: "Sweeper", owner: null, isSystem: true, agentId: "sweeper", state: "idle", createdAt: new Date(0) },
    ];
    const visibility = { "alice-own": "private", "bob-private": "private", "bob-shared": "shared_read", sys: "private" };
    return {
        calls: { listSessions: 0, getSessionAccess: 0 },
        async listSessions() { this.calls.listSessions += 1; return rows; },
        async getSession(id) { return rows.find((r) => r.sessionId === id) ?? null; },
        async getDescendantSessionIds() { return []; },
        async getSessionAccess(sessionId, viewer) {
            this.calls.getSessionAccess += 1;
            const row = rows.find((r) => r.sessionId === sessionId);
            if (!row) return null;
            return {
                rootSessionId: sessionId,
                isSystem: row.isSystem,
                visibility: visibility[sessionId],
                owner: row.owner,
                viewerIsOwner: Boolean(row.owner && viewer
                    && row.owner.provider === viewer.provider && row.owner.subject === viewer.subject),
                viewerShareAccess: null,
            };
        },
        async getSessionMetricSummary() { return { tokensInput: 1 }; },
        async getUserStats() { return { users: [], windowStart: null, earliestSessionCreatedAt: null }; },
        async getFleetStats() { return { sessions: 1 }; },
    };
}

/** Build the diagnostic bundle acting as `viewer`, and index it by tool name. */
function toolsFor(viewer, catalog = fakeCatalog()) {
    const tools = createInspectTools({
        catalog,
        agentIdentity: "agent-tuner",   // the only current holder of the bundle
        resolveViewer: () => viewer,
    });
    return { catalog, byName: new Map(tools.map((t) => [t.name, t])) };
}

const asUser = (u) => ({ ...u, isAdmin: false, isSystemPrincipal: false });
const asAdmin = (u) => ({ ...u, isAdmin: true, isSystemPrincipal: false });
const asSystem = () => ({ provider: "system", subject: "system", isAdmin: false, isSystemPrincipal: true });

// ── RULE 1: lists are scoped ──────────────────────────────────────

test("list_all_sessions returns only what the viewer may read", async () => {
    const { byName } = toolsFor(asUser(ALICE));
    const result = await byName.get("list_all_sessions").handler({});
    const ids = result.sessions.map((s) => s.sessionId).sort();
    // Alice's own, Bob's shared_read, and the system session — which IS
    // readable to every user by deployment default (SESSIONS_SYSTEM_VISIBILITY,
    // "read" unless set to "admin"), exactly as the portal's own session list
    // shows it. Q2 was "match the UI", and this is the UI.
    // NOT Bob's private one.
    assert.deepEqual(ids, ["alice-own", "bob-shared", "sys"]);
    assert.ok(!ids.includes("bob-private"));
});

test("the model's own owner filters cannot widen the scope", async () => {
    // This is the exact pre-fix hole: owner_kind/owner_query were the model's
    // choice, and the tool description tells it to leave them unset.
    const { byName } = toolsFor(asUser(ALICE));
    const result = await byName.get("list_all_sessions").handler({
        owner_query: "bob", owner_kind: "user", include_system: true, limit: 500,
    });
    const ids = result.sessions.map((s) => s.sessionId);
    assert.ok(!ids.includes("bob-private"), "a model-supplied filter must not reach another user's private session");
    assert.ok(!ids.includes("sys"), "nor a system session");
});

test("an admin sees everything, and the System principal is unrestricted", async () => {
    for (const viewer of [asAdmin(ALICE), asSystem()]) {
        const { byName } = toolsFor(viewer);
        const result = await byName.get("list_all_sessions").handler({ include_system: true });
        assert.equal(result.sessions.length, 4, "all four rows");
    }
});

// ── RULE 2: direct reads refuse ───────────────────────────────────

test("reading another user's private session is refused, and refuses as NOT FOUND", async () => {
    const { byName } = toolsFor(asUser(ALICE));
    const result = await byName.get("read_session_info").handler({ session_id: "bob-private" });
    assert.ok(result.error, "must not return the row");
    // Shape matters: a refusal that says "forbidden" confirms the id exists.
    assert.match(result.error, /not found/i);
});

test("every per-session diagnostic tool refuses a foreign session, not just read_session_info", async () => {
    const { byName } = toolsFor(asUser(ALICE));
    for (const name of [
        "read_session_info",
        "read_session_metric_summary",
        "read_session_tokens_by_model",
        "read_session_tree_stats",
        "read_session_skill_usage",
    ]) {
        const tool = byName.get(name);
        if (!tool) continue;
        const result = await tool.handler({ session_id: "bob-private" });
        assert.ok(result?.error, `${name} must refuse a session the viewer cannot read`);
    }
});

test("the viewer's own session, and a shared one, are readable", async () => {
    const { byName } = toolsFor(asUser(ALICE));
    for (const id of ["alice-own", "bob-shared"]) {
        const result = await byName.get("read_session_info").handler({ session_id: id });
        assert.ok(!result.error, `${id} should be readable: ${result.error}`);
    }
});

// ── RULE 3: fleet aggregates are admin-only ───────────────────────

test("fleet-wide aggregates refuse a plain user", async () => {
    const { byName } = toolsFor(asUser(ALICE));
    for (const name of ["read_fleet_stats", "read_user_stats", "read_fleet_skill_usage", "read_fleet_retrieval_usage", "read_fleet_graph_node_usage"]) {
        const tool = byName.get(name);
        if (!tool) continue;
        const result = await tool.handler({});
        assert.ok(result?.error, `${name} leaks fleet-wide activity to a non-admin`);
        assert.match(result.error, /administrators only/i);
    }
});

test("fleet aggregates serve an admin", async () => {
    const { byName } = toolsFor(asAdmin(ALICE));
    const result = await byName.get("read_fleet_stats").handler({});
    assert.ok(!result?.error, "an admin must still get fleet totals");
});

// ── Failing closed ────────────────────────────────────────────────

test("no resolver at all reads NOTHING (an omission must not grant)", async () => {
    const catalog = fakeCatalog();
    const tools = createInspectTools({ catalog, agentIdentity: "agent-tuner" });
    const byName = new Map(tools.map((t) => [t.name, t]));

    const listed = await byName.get("list_all_sessions").handler({});
    assert.equal(listed.sessions.length, 0, "a forgotten resolver must yield an empty list, not the fleet");

    const read = await byName.get("read_session_info").handler({ session_id: "alice-own" });
    assert.ok(read.error, "and no direct read");
});

test("a resolver that throws fails closed", async () => {
    const catalog = fakeCatalog();
    const tools = createInspectTools({
        catalog,
        agentIdentity: "agent-tuner",
        resolveViewer: () => { throw new Error("users table unreachable"); },
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const listed = await byName.get("list_all_sessions").handler({});
    assert.equal(listed.sessions.length, 0, "an outage must not widen access");
});

test("an identity-less viewer is treated as no viewer", async () => {
    const { byName } = toolsFor({ provider: "", subject: "", isAdmin: false, isSystemPrincipal: false });
    const listed = await byName.get("list_all_sessions").handler({});
    assert.equal(listed.sessions.length, 0);
});

test("NO_VIEWER is the least privilege, and is frozen", async () => {
    assert.equal(NO_VIEWER.isAdmin, false);
    assert.equal(NO_VIEWER.isSystemPrincipal, false);
    assert.ok(Object.isFrozen(NO_VIEWER), "a shared sentinel must not be mutable");
});

// ── The grep-guard ────────────────────────────────────────────────

test("no session-touching tool bypasses all three rules", () => {
    const source = readFileSync(SOURCE, "utf8");
    const RULES = ["ensureVisible(", "requireAdmin(", "ensureSelfOrDescendant(", "scopeSessions("];
    const ungated = [];

    const opener = /defineTool\("([a-z_]+)", \{/g;
    let match;
    const marks = [];
    while ((match = opener.exec(source)) !== null) marks.push({ name: match[1], at: match.index });

    for (let i = 0; i < marks.length; i += 1) {
        const body = source.slice(marks[i].at, marks[i + 1]?.at ?? source.length);
        if (!body.includes("session_id")) continue;          // not session-scoped
        if (!RULES.some((rule) => body.includes(rule))) ungated.push(marks[i].name);
    }

    assert.deepEqual(
        ungated, [],
        `these tools take a session_id but route through none of the three rules — `
        + `add ensureVisible/requireAdmin, or explain why in a comment and extend this guard: ${ungated.join(", ")}`,
    );
});

test("the identity-keyed bypass is gone and does not come back", () => {
    const source = readFileSync(SOURCE, "utf8");
    // The literal shape of the old hole: an early return keyed on WHO the
    // agent is rather than WHAT its owner may see.
    // Ignore comment lines — the removal is deliberately DOCUMENTED where the
    // hole used to be, and that prose must not trip its own guard.
    const code = source
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
    assert.ok(
        !/if\s*\(\s*isTuner\s*\)\s*return\s+null/.test(code),
        "the `if (isTuner) return null` scoping bypass must stay deleted",
    );
});
