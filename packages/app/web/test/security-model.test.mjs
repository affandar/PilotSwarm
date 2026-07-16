import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSessionAccess, loadAuthzConfig, normalizeVisibility, relationFor } from "../authz.js";
import { createDevAuthProvider, parseDevRoster } from "../auth/providers/dev.js";

// Personas mirror the dev roster.
const snap = (over = {}) => ({
    rootSessionId: "root", isSystem: false, visibility: "private",
    owner: { provider: "dev", subject: "alice", displayName: "Alice Anderson", email: "alice@dev.local" },
    viewerIsOwner: false, viewerShareAccess: null, ...over,
});

test("S1 read: owner, grants, and deployment-shared can read; stranger on private cannot (404)", () => {
    const readable = { isAdmin: false, systemReadable: true };
    assert.equal(evaluateSessionAccess("session:read", snap({ viewerIsOwner: true }), readable).allowed, true);
    assert.equal(evaluateSessionAccess("session:read", snap({ viewerShareAccess: "read" }), readable).allowed, true);
    assert.equal(evaluateSessionAccess("session:read", snap({ viewerShareAccess: "write" }), readable).allowed, true);
    assert.equal(evaluateSessionAccess("session:read", snap({ visibility: "shared_read" }), readable).allowed, true);
    assert.equal(evaluateSessionAccess("session:read", snap({ visibility: "shared_write" }), readable).allowed, true);
    const stranger = evaluateSessionAccess("session:read", snap(), readable);
    assert.equal(stranger.allowed, false);
    assert.equal(stranger.notFound, true, "invisible session must 404, not 403 (no existence oracle)");
});

test("S2 read grant: read allowed, write refused with an actionable reason", () => {
    const s = snap({ viewerShareAccess: "read" });
    assert.equal(evaluateSessionAccess("session:read", s, { isAdmin: false }).allowed, true);
    const write = evaluateSessionAccess("session:write", s, { isAdmin: false });
    assert.equal(write.allowed, false);
    assert.match(write.reason, /write access is required/i);
    assert.match(write.reason, /Alice Anderson/, "names the owner to ask");
});

test("S3 write grant: write allowed, manage/destroy/share refused (owner-only)", () => {
    const s = snap({ viewerShareAccess: "write" });
    assert.equal(evaluateSessionAccess("session:write", s, { isAdmin: false }).allowed, true);
    for (const cls of ["session:manage", "session:destroy", "session:share"]) {
        const d = evaluateSessionAccess(cls, s, { isAdmin: false });
        assert.equal(d.allowed, false, `${cls} denied for a write grantee`);
        assert.match(d.reason, /owner/i);
    }
});

test("owner can manage/destroy/share their own tree", () => {
    const s = snap({ viewerIsOwner: true });
    for (const cls of ["session:read", "session:write", "session:manage", "session:destroy", "session:share"]) {
        assert.equal(evaluateSessionAccess(cls, s, { isAdmin: false }).allowed, true, cls);
    }
});

test("admin passes everything; break-glass flagged only on non-owned private", () => {
    const priv = evaluateSessionAccess("session:read", snap(), { isAdmin: true });
    assert.equal(priv.allowed, true);
    assert.equal(priv.breakGlass, true, "admin read of a private non-owned session is break-glass");

    const shared = evaluateSessionAccess("session:read", snap({ visibility: "shared_read" }), { isAdmin: true });
    assert.ok(!shared.breakGlass, "no break-glass when the session was already visible");

    const own = evaluateSessionAccess("session:manage", snap({ viewerIsOwner: true }), { isAdmin: true });
    assert.ok(!own.breakGlass);
});

test("system sessions: read when visible, 404 when hidden, write always denied", () => {
    const sys = snap({ isSystem: true, owner: null });
    assert.equal(evaluateSessionAccess("session:read", sys, { isAdmin: false, systemReadable: true }).allowed, true);
    const hiddenRead = evaluateSessionAccess("session:read", sys, { isAdmin: false, systemReadable: false });
    assert.equal(hiddenRead.notFound, true);
    // hidden system: writes 404 (no existence oracle); visible system: writes 403
    assert.equal(evaluateSessionAccess("session:write", sys, { isAdmin: false, systemReadable: false }).notFound, true);
    assert.equal(evaluateSessionAccess("session:write", sys, { isAdmin: false, systemReadable: true }).allowed, false);
});

test("null snapshot returns allowed (id-less op); the runtime gate handles unresolvable ids separately", () => {
    assert.equal(evaluateSessionAccess("session:read", null, { isAdmin: false }).allowed, true);
});

test("cross-owner isolation: A (Alice, private) and B (Bob, private) are mutually unreachable at the user plane (404 both ways)", () => {
    // Alice's private session as seen by Bob (a stranger, not a grantee).
    const aliceSession = snap({ visibility: "private", viewerIsOwner: false, viewerShareAccess: null });
    const bobReadsAlice = evaluateSessionAccess("session:read", aliceSession, { isAdmin: false });
    assert.equal(bobReadsAlice.allowed, false);
    assert.equal(bobReadsAlice.notFound, true, "Bob cannot even see that Alice's private session exists");
    assert.equal(
        evaluateSessionAccess("session:write", aliceSession, { isAdmin: false }).notFound,
        true,
        "and a write attempt 404s too (no existence oracle)",
    );

    // Symmetrically, Bob's private session is invisible to Alice.
    const bobSession = snap({
        owner: { provider: "dev", subject: "bob", displayName: "Bob Baker", email: "bob@dev.local" },
        visibility: "private", viewerIsOwner: false, viewerShareAccess: null,
    });
    assert.equal(evaluateSessionAccess("session:read", bobSession, { isAdmin: false }).notFound, true, "Alice cannot see Bob's private session");

    // Their agents nonetheless hold a two-way conversation via the cross-session
    // message plane, which carries no ownership gate — see
    // packages/sdk/test/local/cross-session-messaging.test.js
    // ("two owners' private sessions hold a two-way conversation via agent cross-comms").
});

test("relationFor: owner / admin / collaborator", () => {
    assert.equal(relationFor(snap({ viewerIsOwner: true }), { isAdmin: false }), "owner");
    assert.equal(relationFor(snap(), { isAdmin: true }), "admin");
    assert.equal(relationFor(snap({ viewerShareAccess: "write" }), { isAdmin: false }), "collaborator");
});

test("authz config: secure defaults; SESSIONS_* overrides", () => {
    const def = loadAuthzConfig({});
    assert.equal(def.enforce, false);
    assert.equal(def.defaultVisibility, "private");
    assert.equal(def.systemVisibility, "read");
    const custom = loadAuthzConfig({ AUTHZ_ENFORCE_OWNERSHIP: "true", SESSIONS_DEFAULT_VISIBILITY: "shared_write", SESSIONS_SYSTEM_VISIBILITY: "admin" });
    assert.equal(custom.enforce, true);
    assert.equal(custom.defaultVisibility, "shared_write");
    assert.equal(custom.systemVisibility, "admin");
    assert.equal(normalizeVisibility("garbage", "private"), "private");
    assert.equal(normalizeVisibility("shared_read", "private"), "shared_read");
});

// ── Dev auth provider ────────────────────────────────────────────────────

test("dev provider fails closed without explicit opt-in, and refuses to coexist with Entra", () => {
    assert.throws(() => createDevAuthProvider({ env: {} }), /PORTAL_AUTH_DEV_ALLOW/);
    assert.throws(
        () => createDevAuthProvider({ env: { PORTAL_AUTH_DEV_ALLOW: "true", PORTAL_AUTH_ENTRA_TENANT_ID: "t" } }),
        /ENTRA/,
    );
    assert.throws(
        () => createDevAuthProvider({ env: { PORTAL_AUTH_DEV_ALLOW: "true", PORTAL_AUTH_ENTRA_ADMIN_GROUPS: "group-id" } }),
        /PORTAL_AUTH_ENTRA_ADMIN_GROUPS/,
    );
});

test("dev provider authenticates roster personas and rejects unknowns / non-dev tokens", async () => {
    const p = createDevAuthProvider({ env: { PORTAL_AUTH_DEV_ALLOW: "true" } });
    const alice = await p.authenticateRequest("dev:alice");
    assert.equal(alice.provider, "dev");
    assert.equal(alice.subject, "alice");
    assert.deepEqual(alice.roles, ["user"]);
    const ada = await p.authenticateRequest("dev:ada");
    assert.deepEqual(ada.roles, ["admin"]);
    assert.equal(await p.authenticateRequest("dev:mallory"), null, "unknown persona rejected");
    assert.equal(await p.authenticateRequest("eyJhbGciOi..."), null, "non-dev token rejected");
    assert.equal(await p.authenticateRequest(null), null);
    const pub = await p.getPublicConfig();
    assert.equal(pub.provider, "dev");
    assert.equal(pub.client.users.length, 5);
});

test("dev roster parsing validates ids/roles and dedupes", () => {
    const roster = parseDevRoster("root:admin,eve:user");
    assert.deepEqual(roster.map((r) => `${r.id}:${r.role}`), ["root:admin", "eve:user"]);
    assert.throws(() => parseDevRoster("bad id:user"), /Invalid persona id/);
    assert.throws(() => parseDevRoster("x:superuser"), /Invalid role/);
    assert.throws(() => parseDevRoster("a:user,a:admin"), /Duplicate/);
    // default roster
    assert.equal(parseDevRoster("").length, 5);
});
