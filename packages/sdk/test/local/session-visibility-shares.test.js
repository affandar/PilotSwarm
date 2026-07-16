/**
 * Migration 0029 — session visibility, shares, root stamping, authz audit.
 *
 * DB-only (no workers, no LLM): throwaway schema, full migration chain via
 * PgSessionCatalog.initialize(), then the security-model predicates
 * (docs/proposals/user-admin-security-model.md):
 *
 *  - root_session_id stamping across spawn chains (access resolves at root)
 *  - visibility enum on roots; children resolve through their root
 *  - targeted shares (grant / update / revoke / list), stored on the root
 *  - cms_get_session_access snapshots (owner / share / system / missing)
 *  - viewer-scoped listing (paged + non-paged) — the S1 visibility table
 *    from docs/proposals/dev-auth-provider-and-multiuser-test-plan.md
 *  - authz audit append + read
 *
 * Personas mirror the dev auth provider roster: alice owns, bob has a write
 * grant, carol a read grant, dave is a stranger.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/session-visibility-shares.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `t0029_${Date.now().toString(36)}`;

const persona = (id) => ({
    provider: "dev",
    subject: id,
    email: `${id}@dev.local`,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
});
const ALICE = persona("alice");
const BOB = persona("bob");
const CAROL = persona("carol");
const DAVE = persona("dave");

const viewer = (p) => ({ provider: p.provider, subject: p.subject });

describe.skipIf(!DATABASE_URL)("session visibility + shares (0029)", () => {
    let catalog;
    // Alice's fixture trees, created once in beforeAll.
    let privateRoot, privateChild, sharedReadRoot, sharedWriteRoot, systemRoot;

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize();

        privateRoot = `sess-priv-${Date.now()}`;
        privateChild = `${privateRoot}-child`;
        sharedReadRoot = `sess-sread-${Date.now()}`;
        sharedWriteRoot = `sess-swrite-${Date.now()}`;
        systemRoot = `sess-system-${Date.now()}`;

        await catalog.createSession(privateRoot, { model: "m", owner: ALICE });
        await catalog.createSession(privateChild, { model: "m", parentSessionId: privateRoot, owner: ALICE });
        await catalog.createSession(sharedReadRoot, { model: "m", owner: ALICE, visibility: "shared_read" });
        await catalog.createSession(sharedWriteRoot, { model: "m", owner: ALICE, visibility: "shared_write" });
        await catalog.createSession(systemRoot, { model: "m", isSystem: true });

        // Targeted grants on the PRIVATE tree: bob writes, carol reads.
        await catalog.grantSessionShare(privateRoot, BOB, "write", ALICE);
        await catalog.grantSessionShare(privateRoot, CAROL, "read", ALICE);
    });

    afterAll(async () => {
        try {
            const { default: pg } = await import("pg");
            const p = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
            await p.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
            await p.end();
        } finally {
            await catalog?.close?.();
        }
    });

    // ── Root stamping ────────────────────────────────────────────

    it("stamps root_session_id: self for roots, root for children and grandchildren", async () => {
        const grandchild = `${privateRoot}-grandchild`;
        await catalog.createSession(grandchild, { model: "m", parentSessionId: privateChild, owner: ALICE });

        const [root, child, grand] = await Promise.all([
            catalog.getSession(privateRoot),
            catalog.getSession(privateChild),
            catalog.getSession(grandchild),
        ]);
        expect(root.rootSessionId).toBe(privateRoot);
        expect(child.rootSessionId).toBe(privateRoot);
        expect(grand.rootSessionId).toBe(privateRoot);
    });

    it("defaults visibility to private; honors the create-time value; rejects junk to private", async () => {
        expect((await catalog.getSession(privateRoot)).visibility).toBe("private");
        expect((await catalog.getSession(sharedReadRoot)).visibility).toBe("shared_read");
        expect((await catalog.getSession(sharedWriteRoot)).visibility).toBe("shared_write");

        const junk = `sess-junk-${Date.now()}`;
        await catalog.createSession(junk, { model: "m", owner: ALICE, visibility: "everything" });
        expect((await catalog.getSession(junk)).visibility).toBe("private");
    });

    // ── Visibility + share mutations resolve at the root ─────────

    it("setSessionVisibility on a CHILD applies to the root", async () => {
        const tree = `sess-vischild-${Date.now()}`;
        const child = `${tree}-c`;
        await catalog.createSession(tree, { model: "m", owner: ALICE });
        await catalog.createSession(child, { model: "m", parentSessionId: tree, owner: ALICE });

        await catalog.setSessionVisibility(child, "shared_read");
        expect((await catalog.getSession(tree)).visibility).toBe("shared_read");
        // The child row's own column is untouched — access always resolves via root.
        expect((await catalog.getSession(child)).visibility).toBe("private");
    });

    it("refuses visibility changes and shares on system sessions", async () => {
        await expect(catalog.setSessionVisibility(systemRoot, "shared_read")).rejects.toThrow(/system/i);
        await expect(catalog.grantSessionShare(systemRoot, BOB, "read", ALICE)).rejects.toThrow(/system/i);
    });

    it("grants land on the root even when granted via a child; upsert updates access", async () => {
        // Grant via the CHILD id — must land on the root.
        await catalog.grantSessionShare(privateChild, DAVE, "read", ALICE);
        let shares = await catalog.listSessionShares(privateRoot);
        const dave = shares.find((s) => s.subject === DAVE.subject);
        expect(dave?.access).toBe("read");

        // Upsert to write.
        await catalog.grantSessionShare(privateRoot, DAVE, "write", ALICE);
        shares = await catalog.listSessionShares(privateChild); // list via child resolves root too
        expect(shares.find((s) => s.subject === DAVE.subject)?.access).toBe("write");

        // Revoke, and confirm gone.
        await catalog.revokeSessionShare(privateChild, viewer(DAVE));
        shares = await catalog.listSessionShares(privateRoot);
        expect(shares.find((s) => s.subject === DAVE.subject)).toBeUndefined();
    });

    // ── Access snapshots ─────────────────────────────────────────

    it("access snapshot: owner, write grantee, read grantee, stranger — including via child ids", async () => {
        const aliceAccess = await catalog.getSessionAccess(privateChild, viewer(ALICE));
        expect(aliceAccess.rootSessionId).toBe(privateRoot);
        expect(aliceAccess.viewerIsOwner).toBe(true);
        expect(aliceAccess.visibility).toBe("private");
        expect(aliceAccess.owner.subject).toBe(ALICE.subject);

        const bobAccess = await catalog.getSessionAccess(privateChild, viewer(BOB));
        expect(bobAccess.viewerIsOwner).toBe(false);
        expect(bobAccess.viewerShareAccess).toBe("write");

        const carolAccess = await catalog.getSessionAccess(privateRoot, viewer(CAROL));
        expect(carolAccess.viewerShareAccess).toBe("read");

        const daveAccess = await catalog.getSessionAccess(privateRoot, viewer(DAVE));
        expect(daveAccess.viewerIsOwner).toBe(false);
        expect(daveAccess.viewerShareAccess).toBeNull();
        expect(daveAccess.visibility).toBe("private");
    });

    it("access snapshot: system flag reported; missing and soft-deleted sessions yield null", async () => {
        const sys = await catalog.getSessionAccess(systemRoot, viewer(ALICE));
        expect(sys.isSystem).toBe(true);
        expect(sys.owner).toBeNull();

        expect(await catalog.getSessionAccess("sess-does-not-exist", viewer(ALICE))).toBeNull();

        const doomed = `sess-doomed-${Date.now()}`;
        await catalog.createSession(doomed, { model: "m", owner: ALICE });
        await catalog.softDeleteSession(doomed);
        expect(await catalog.getSessionAccess(doomed, viewer(ALICE))).toBeNull();
    });

    // ── Viewer-scoped listing (the S1 table) ─────────────────────

    const idsOf = (rows) => new Set(rows.map((r) => r.sessionId));

    it("S1: alice (owner) sees all her trees", async () => {
        const ids = idsOf(await catalog.listSessionsVisible(viewer(ALICE)));
        expect(ids.has(privateRoot)).toBe(true);
        expect(ids.has(privateChild)).toBe(true);
        expect(ids.has(sharedReadRoot)).toBe(true);
        expect(ids.has(sharedWriteRoot)).toBe(true);
    });

    it("S1: bob (write grant) sees the private tree plus deployment-shared trees", async () => {
        const ids = idsOf(await catalog.listSessionsVisible(viewer(BOB)));
        expect(ids.has(privateRoot)).toBe(true);
        expect(ids.has(privateChild)).toBe(true); // children ride the root's grant
        expect(ids.has(sharedReadRoot)).toBe(true);
        expect(ids.has(sharedWriteRoot)).toBe(true);
    });

    it("S1: dave (stranger) sees only deployment-shared trees; system per flag", async () => {
        const visible = await catalog.listSessionsVisible(viewer(DAVE));
        const ids = idsOf(visible);
        expect(ids.has(privateRoot)).toBe(false);
        expect(ids.has(privateChild)).toBe(false);
        expect(ids.has(sharedReadRoot)).toBe(true);
        expect(ids.has(sharedWriteRoot)).toBe(true);
        expect(ids.has(systemRoot)).toBe(true); // systemVisible defaults true

        const noSystem = idsOf(await catalog.listSessionsVisible({ ...viewer(DAVE), systemVisible: false }));
        expect(noSystem.has(systemRoot)).toBe(false);
    });

    it("S1 paged: viewer filtering matches the non-paged predicate; NULL viewer is unfiltered", async () => {
        const paged = idsOf(await catalog.listSessionsPage({ limit: 200, viewer: viewer(DAVE) }));
        expect(paged.has(privateRoot)).toBe(false);
        expect(paged.has(sharedReadRoot)).toBe(true);

        const unfiltered = idsOf(await catalog.listSessionsPage({ limit: 200 }));
        expect(unfiltered.has(privateRoot)).toBe(true);
    });

    // ── Audit ────────────────────────────────────────────────────

    it("records and reads authz audit entries, newest first, session-scoped", async () => {
        await catalog.recordAuthzAudit({
            actor: { provider: BOB.provider, subject: BOB.subject, display: BOB.displayName },
            action: "sendMessage",
            sessionId: privateRoot,
            decision: "deny",
            reason: "no write access",
            details: { op: "sendMessage" },
        });
        await catalog.recordAuthzAudit({
            actor: { provider: "dev", subject: "ada", display: "Ada Admin" },
            action: "getSession",
            sessionId: privateRoot,
            decision: "break_glass",
            reason: "admin read of non-owned private session",
        });

        const entries = await catalog.listAuthzAudit({ sessionId: privateRoot, limit: 10 });
        expect(entries.length).toBe(2);
        expect(entries[0].decision).toBe("break_glass"); // newest first
        expect(entries[1].decision).toBe("deny");
        expect(entries[1].actorSubject).toBe(BOB.subject);
        expect(entries[1].details.op).toBe("sendMessage");

        const all = await catalog.listAuthzAudit({ limit: 10 });
        expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("audit query by root returns rows recorded against child sessions of the tree (NEW-2)", async () => {
        // A break-glass read of a CHILD session is recorded against the child id.
        await catalog.recordAuthzAudit({
            actor: { provider: "dev", subject: "ada", display: "Ada Admin" },
            action: "getSessionEvents",
            sessionId: privateChild,
            decision: "break_glass",
            reason: "admin read of a child session",
        });
        // Querying the ROOT surfaces it (owner sees their whole tree's audit).
        const rootView = await catalog.listAuthzAudit({ sessionId: privateRoot, limit: 50 });
        expect(rootView.some((r) => r.sessionId === privateChild && r.decision === "break_glass")).toBe(true);
    });

    // ── 0032: email-keyed grants adopted on first sighting ─────────
    // The share UX is a free text box: a grant may target someone who has
    // never signed in, keyed (provider, subject = typed email). On the
    // grantee's first sighting with that email, the placeholder folds into
    // the real principal.
    it("adopts an email-keyed grant when the grantee first signs in", async () => {
        const EVE = persona("eve"); // real principal: subject 'eve', email 'eve@dev.local'
        const adoptRoot = `sess-adopt-${Date.now()}`;
        await catalog.createSession(adoptRoot, { model: "m", owner: ALICE });

        // Alice grants by EMAIL before eve has ever signed in — the grant
        // path stores what it was typed (placeholder subject = the email).
        await catalog.grantSessionShare(
            adoptRoot,
            { provider: "dev", subject: EVE.email, email: null, displayName: null },
            "write",
        );

        // Real-eve identity sees nothing yet: the placeholder is a different key.
        const before = await catalog.getSessionAccess(adoptRoot, viewer(EVE));
        expect(before.viewerShareAccess).toBeNull();

        // First sighting: eve's first session create carries her email.
        await catalog.createSession(`sess-eve-${Date.now()}`, { model: "m", owner: EVE });

        // The grant now binds to the real principal, keyed by her subject.
        const after = await catalog.getSessionAccess(adoptRoot, viewer(EVE));
        expect(after.viewerShareAccess).toBe("write");
        const shares = await catalog.listSessionShares(adoptRoot);
        expect(shares.some((r) => r.subject === EVE.subject)).toBe(true);
        expect(shares.some((r) => r.subject === EVE.email)).toBe(false);
    });

    it("keeps the stronger access when placeholder and real grants overlap", async () => {
        const FRANK = persona("frank");
        const overlapRoot = `sess-overlap-${Date.now()}`;
        await catalog.createSession(overlapRoot, { model: "m", owner: ALICE });

        // Real-keyed read grant AND an email-keyed write grant on the same tree.
        await catalog.grantSessionShare(overlapRoot, { provider: "dev", subject: FRANK.subject, email: null, displayName: null }, "read");
        await catalog.grantSessionShare(overlapRoot, { provider: "dev", subject: FRANK.email, email: null, displayName: null }, "write");

        // First sighting merges the placeholder; write (the stronger) wins.
        await catalog.createSession(`sess-frank-${Date.now()}`, { model: "m", owner: FRANK });
        const after = await catalog.getSessionAccess(overlapRoot, viewer(FRANK));
        expect(after.viewerShareAccess).toBe("write");
        const shares = await catalog.listSessionShares(overlapRoot);
        expect(shares.filter((r) => r.subject === FRANK.subject || r.subject === FRANK.email).length).toBe(1);
    });

    // ── 0033: a grant never overwrites the grantee's directory identity ──
    it("a share grant cannot overwrite an existing user's directory name/email", async () => {
        const VICTIM = persona("victim"); // display "Victim", email "victim@dev.local"
        // Victim's own sighting establishes their directory identity.
        await catalog.createSession(`sess-victim-${Date.now()}`, { model: "m", owner: VICTIM });

        // Attacker (Alice) grants on her OWN session, targeting the victim with
        // forged display fields — the pre-0033 directory-tampering vector.
        const attackRoot = `sess-attack-${Date.now()}`;
        await catalog.createSession(attackRoot, { model: "m", owner: ALICE });
        await catalog.grantSessionShare(
            attackRoot,
            { provider: VICTIM.provider, subject: VICTIM.subject, email: "evil@attacker.test", displayName: "IT Admin" },
            "read",
        );

        // Victim's stored identity is untouched.
        const dir = await catalog.listKnownUsers({ limit: 500 });
        const victimRow = dir.find((u) => u.provider === VICTIM.provider && u.subject === VICTIM.subject);
        expect(victimRow).toBeTruthy();
        expect(victimRow.displayName).toBe(VICTIM.displayName);
        expect(victimRow.email).toBe(VICTIM.email);
        // The grant still took effect (access granted), just without identity writes.
        const grantAccess = await catalog.getSessionAccess(attackRoot, viewer(VICTIM));
        expect(grantAccess.viewerShareAccess).toBe("read");
    });

    it("a grant to a never-seen user creates a display-less directory placeholder", async () => {
        const GHOST = persona("ghostuser"); // never sighted
        const root = `sess-ghost-${Date.now()}`;
        await catalog.createSession(root, { model: "m", owner: ALICE });
        await catalog.grantSessionShare(
            root,
            { provider: GHOST.provider, subject: GHOST.subject, email: "spoof@x.test", displayName: "Fake Name" },
            "read",
        );
        // display_name IS NULL → excluded from the directory (no fake-named entry).
        const dir = await catalog.listKnownUsers({ limit: 500 });
        expect(dir.some((u) => u.subject === GHOST.subject)).toBe(false);
        // But the grant is real.
        const shares = await catalog.listSessionShares(root);
        expect(shares.some((r) => r.subject === GHOST.subject && r.access === "read")).toBe(true);
    });
});
