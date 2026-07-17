/**
 * Migration 0034 — private per-user session-group placements.
 *
 * DB-only (no workers, no LLM): throwaway schema, full migration chain via
 * PgSessionCatalog.initialize(), then the placement semantics
 * (docs/proposals/private-session-groups-and-deep-links.md):
 *
 *  - placement matrix: owner / write grantee / read grantee place a shared
 *    tree into THEIR OWN groups; strangers are denied under enforce
 *    semantics (p_is_admin=false) and allowed under permissive semantics
 *    (the runtime passes admin OR NOT enforce as p_is_admin)
 *  - child ids normalize to the tree root; duplicates dedupe to one outcome
 *  - cross-user group targets rejected structurally, in BOTH modes
 *  - revocation retains the placement; re-share restores it; viewer-scoped
 *    group counts exclude unreadable roots meanwhile
 *  - group delete cascades only that owner's placements, never sessions
 *  - system trees are not placeable; hard session delete cascades placements
 *  - placement never touches sessions.updated_at
 *  - concurrency: conflicting places upsert-resolve; a group delete racing
 *    a place fails with a clean FK error, not a crash
 *  - unknown and unreadable ids produce identical not_found outcomes
 *
 * Personas mirror the dev auth provider roster: alice owns, bob has a write
 * grant, carol a read grant, dave is a stranger.
 *
 * Run: npx vitest run test/local/session-group-placements.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const SCHEMA = `t0034p_${Date.now().toString(36)}`;

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

const viewer = (p, isAdmin = false) => ({ provider: p.provider, subject: p.subject, isAdmin });
const placement = (p) => ({ provider: p.provider, subject: p.subject });

describe("session group placements (0034)", () => {
    let catalog;
    let rawPool;
    let aliceRoot, aliceChild, systemRoot;
    const gAlice = `g-alice-${Date.now()}`;
    const gAlice2 = `g-alice2-${Date.now()}`;
    const gBob = `g-bob-${Date.now()}`;
    const gCarol = `g-carol-${Date.now()}`;

    const placementRows = async (where, params) => {
        const { rows } = await rawPool.query(
            `SELECT user_id, root_session_id, group_id FROM "${SCHEMA}".user_session_group_placements WHERE ${where}`,
            params,
        );
        return rows;
    };

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize();
        const { default: pg } = await import("pg");
        rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

        aliceRoot = `sess-root-${Date.now()}`;
        aliceChild = `${aliceRoot}-child`;
        systemRoot = `sess-system-${Date.now()}`;

        await catalog.createSession(aliceRoot, { model: "m", owner: ALICE });
        await catalog.createSession(aliceChild, { model: "m", parentSessionId: aliceRoot, owner: ALICE });
        await catalog.createSession(systemRoot, { model: "m", isSystem: true });
        await catalog.grantSessionShare(aliceRoot, BOB, "write", ALICE);
        await catalog.grantSessionShare(aliceRoot, CAROL, "read", ALICE);

        await catalog.createSessionGroup({ groupId: gAlice, title: "Alice group", owner: ALICE });
        await catalog.createSessionGroup({ groupId: gAlice2, title: "Alice group 2", owner: ALICE });
        await catalog.createSessionGroup({ groupId: gBob, title: "Bob group", owner: BOB });
        await catalog.createSessionGroup({ groupId: gCarol, title: "Carol group", owner: CAROL });
    });

    afterAll(async () => {
        try {
            await rawPool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        } finally {
            await rawPool?.end();
            await catalog?.close?.();
        }
    });

    // ── Placement matrix ─────────────────────────────────────────

    it("owner places a root in their own group; the placement is viewer-private", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(ALICE), [aliceRoot], gAlice);
        expect(results).toEqual([{ rootSessionId: aliceRoot, placed: true, reason: null }]);

        // The placement viewer sees it; reads without a placement viewer do not.
        const withPlacement = await catalog.getSession(aliceRoot, placement(ALICE));
        expect(withPlacement.groupId).toBe(gAlice);
        const withoutPlacement = await catalog.getSession(aliceRoot);
        expect(withoutPlacement.groupId).toBeNull();

        // Group membership rides the root: children list too, but only the
        // root row carries the placement-sourced group id.
        const members = await catalog.listGroupSessions(gAlice, placement(ALICE));
        const ids = members.map((r) => r.sessionId).sort();
        expect(ids).toEqual([aliceRoot, aliceChild].sort());
        expect(members.find((r) => r.sessionId === aliceRoot).groupId).toBe(gAlice);
        expect(members.find((r) => r.sessionId === aliceChild).groupId).toBeNull();

        // Foreign viewers never see alice's group.
        const bobGroups = await catalog.listSessionGroups(viewer(BOB));
        expect(bobGroups.some((g) => g.groupId === gAlice)).toBe(false);
    });

    it("write and read grantees organize the shared tree into their own groups (enforce semantics)", async () => {
        const bobResults = await catalog.placeSessionsInGroup(viewer(BOB), [aliceRoot], gBob);
        expect(bobResults).toEqual([{ rootSessionId: aliceRoot, placed: true, reason: null }]);
        const carolResults = await catalog.placeSessionsInGroup(viewer(CAROL), [aliceRoot], gCarol);
        expect(carolResults).toEqual([{ rootSessionId: aliceRoot, placed: true, reason: null }]);

        // Same root, three private placements — each viewer sees only theirs.
        expect((await catalog.getSession(aliceRoot, placement(ALICE))).groupId).toBe(gAlice);
        expect((await catalog.getSession(aliceRoot, placement(BOB))).groupId).toBe(gBob);
        expect((await catalog.getSession(aliceRoot, placement(CAROL))).groupId).toBe(gCarol);

        const bobGroups = await catalog.listSessionGroups(viewer(BOB));
        expect(bobGroups.find((g) => g.groupId === gBob)?.memberCount).toBe(1);
        const aliceGroups = await catalog.listSessionGroups(viewer(ALICE));
        expect(aliceGroups.find((g) => g.groupId === gAlice)?.memberCount).toBe(1);
    });

    it("stranger: denied under enforce, allowed under permissive; unknown and unreadable are indistinguishable", async () => {
        const gDave = `g-dave-${Date.now()}`;
        await catalog.createSessionGroup({ groupId: gDave, title: "Dave group", owner: DAVE });

        const denied = await catalog.placeSessionsInGroup(viewer(DAVE, false), [aliceRoot], gDave);
        expect(denied).toEqual([{ rootSessionId: aliceRoot, placed: false, reason: "not_found" }]);

        const missing = await catalog.placeSessionsInGroup(viewer(DAVE, false), ["sess-does-not-exist"], gDave);
        expect(missing).toEqual([{ rootSessionId: "sess-does-not-exist", placed: false, reason: "not_found" }]);

        // Same shape either way — no existence oracle.
        expect({ placed: denied[0].placed, reason: denied[0].reason })
            .toEqual({ placed: missing[0].placed, reason: missing[0].reason });

        // Permissive mode: the runtime passes admin OR NOT enforce as isAdmin.
        const allowed = await catalog.placeSessionsInGroup(viewer(DAVE, true), [aliceRoot], gDave);
        expect(allowed).toEqual([{ rootSessionId: aliceRoot, placed: true, reason: null }]);
        await catalog.placeSessionsInGroup(viewer(DAVE, true), [aliceRoot], null);
    });

    // ── Root normalization / dedupe ──────────────────────────────

    it("child ids normalize to the tree root and duplicates dedupe to one outcome", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(ALICE), [aliceChild, aliceRoot, aliceChild], gAlice);
        expect(results).toEqual([{ rootSessionId: aliceRoot, placed: true, reason: null }]);
        expect(await placementRows(
            `root_session_id = $1 AND group_id = $2`,
            [aliceRoot, gAlice],
        )).toHaveLength(1);
    });

    // ── Structural cross-user rejection ──────────────────────────

    it("cross-user group targets are rejected in both modes, indistinguishably from missing groups", async () => {
        const bobRoot = `sess-bob-${Date.now()}`;
        await catalog.createSession(bobRoot, { model: "m", owner: BOB });

        await expect(catalog.placeSessionsInGroup(viewer(BOB, false), [bobRoot], gAlice))
            .rejects.toThrow(/not found or is not owned/i);
        // The target-group ownership check is ALWAYS enforced — admin included.
        await expect(catalog.placeSessionsInGroup(viewer(BOB, true), [bobRoot], gAlice))
            .rejects.toThrow(/not found or is not owned/i);
        await expect(catalog.placeSessionsInGroup(viewer(BOB, true), [bobRoot], "g-does-not-exist"))
            .rejects.toThrow(/not found or is not owned/i);
    });

    it("createSession with a foreign group fails structurally and rolls back the session row", async () => {
        const badCreate = `sess-bad-create-${Date.now()}`;
        await expect(catalog.createSession(badCreate, { model: "m", owner: BOB, groupId: gAlice }))
            .rejects.toThrow(/not found or is not owned/i);
        expect(await catalog.getSession(badCreate)).toBeNull();
    });

    it("createSession with the creator's own group places the root in the same transaction", async () => {
        const grouped = `sess-grouped-${Date.now()}`;
        await catalog.createSession(grouped, { model: "m", owner: ALICE, groupId: gAlice2 });
        expect((await catalog.getSession(grouped, placement(ALICE))).groupId).toBe(gAlice2);
    });

    // ── System sessions ──────────────────────────────────────────

    it("system trees are not placeable", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(ALICE, true), [systemRoot], gAlice);
        expect(results).toEqual([{ rootSessionId: systemRoot, placed: false, reason: "system" }]);
    });

    // ── Revocation lifecycle ─────────────────────────────────────

    it("revocation retains the placement but drops it from counts; re-share restores it", async () => {
        await catalog.revokeSessionShare(aliceRoot, { provider: CAROL.provider, subject: CAROL.subject });

        const revoked = await catalog.listSessionGroups(viewer(CAROL));
        expect(revoked.find((g) => g.groupId === gCarol)?.memberCount).toBe(0);
        // The placement row itself is retained.
        expect(await placementRows(`root_session_id = $1 AND group_id = $2`, [aliceRoot, gCarol])).toHaveLength(1);

        await catalog.grantSessionShare(aliceRoot, CAROL, "read", ALICE);
        const restored = await catalog.listSessionGroups(viewer(CAROL));
        expect(restored.find((g) => g.groupId === gCarol)?.memberCount).toBe(1);
        expect((await catalog.getSession(aliceRoot, placement(CAROL))).groupId).toBe(gCarol);
    });

    // ── sessions table untouched ─────────────────────────────────

    it("placement and unplacement never touch sessions.updated_at", async () => {
        const before = await rawPool.query(
            `SELECT updated_at FROM "${SCHEMA}".sessions WHERE session_id = $1`,
            [aliceRoot],
        );
        await catalog.placeSessionsInGroup(viewer(ALICE), [aliceRoot], gAlice2);
        await catalog.placeSessionsInGroup(viewer(ALICE), [aliceRoot], null);
        await catalog.placeSessionsInGroup(viewer(ALICE), [aliceRoot], gAlice);
        const after = await rawPool.query(
            `SELECT updated_at FROM "${SCHEMA}".sessions WHERE session_id = $1`,
            [aliceRoot],
        );
        expect(after.rows[0].updated_at.getTime()).toBe(before.rows[0].updated_at.getTime());
    });

    // ── Unplace scoping ──────────────────────────────────────────

    it("ungrouping removes only the caller's placement", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(ALICE), [aliceRoot], null);
        expect(results).toEqual([{ rootSessionId: aliceRoot, placed: true, reason: null }]);
        expect((await catalog.getSession(aliceRoot, placement(ALICE))).groupId).toBeNull();
        // Bob's and carol's placements of the same root are untouched.
        expect((await catalog.getSession(aliceRoot, placement(BOB))).groupId).toBe(gBob);
        expect((await catalog.getSession(aliceRoot, placement(CAROL))).groupId).toBe(gCarol);
        await catalog.placeSessionsInGroup(viewer(ALICE), [aliceRoot], gAlice);
    });

    // ── Delete cascades ──────────────────────────────────────────

    it("deleting a non-empty group cascades only that owner's placements, never sessions", async () => {
        expect(await catalog.deleteSessionGroup(gBob)).toBe(true);
        // Bob's placement is gone; the session and other viewers' placements remain.
        expect(await placementRows(`group_id = $1`, [gBob])).toHaveLength(0);
        expect(await catalog.getSession(aliceRoot)).not.toBeNull();
        expect((await catalog.getSession(aliceRoot, placement(ALICE))).groupId).toBe(gAlice);
        expect((await catalog.getSession(aliceRoot, placement(CAROL))).groupId).toBe(gCarol);
        expect((await catalog.listSessionGroups(viewer(BOB))).some((g) => g.groupId === gBob)).toBe(false);
    });

    it("hard session delete cascades placements", async () => {
        const hardRoot = `sess-hard-${Date.now()}`;
        await catalog.createSession(hardRoot, { model: "m", owner: ALICE });
        await catalog.placeSessionsInGroup(viewer(ALICE), [hardRoot], gAlice);
        expect(await placementRows(`root_session_id = $1`, [hardRoot])).toHaveLength(1);

        await rawPool.query(`DELETE FROM "${SCHEMA}".session_metrics WHERE session_id = $1`, [hardRoot]);
        await rawPool.query(`DELETE FROM "${SCHEMA}".sessions WHERE session_id = $1`, [hardRoot]);
        expect(await placementRows(`root_session_id = $1`, [hardRoot])).toHaveLength(0);
    });

    // ── Concurrency ──────────────────────────────────────────────

    it("two conflicting concurrent places upsert-resolve to exactly one placement", async () => {
        const concRoot = `sess-conc-${Date.now()}`;
        await catalog.createSession(concRoot, { model: "m", owner: ALICE });

        const [a, b] = await Promise.all([
            catalog.placeSessionsInGroup(viewer(ALICE), [concRoot], gAlice),
            catalog.placeSessionsInGroup(viewer(ALICE), [concRoot], gAlice2),
        ]);
        expect(a).toEqual([{ rootSessionId: concRoot, placed: true, reason: null }]);
        expect(b).toEqual([{ rootSessionId: concRoot, placed: true, reason: null }]);

        const rows = await placementRows(`root_session_id = $1`, [concRoot]);
        expect(rows).toHaveLength(1);
        expect([gAlice, gAlice2]).toContain(rows[0].group_id);
    });

    it("a group delete racing a place fails with a clean FK error, not a crash", async () => {
        const gRace = `g-race-${Date.now()}`;
        const raceRoot = `sess-race-${Date.now()}`;
        await catalog.createSessionGroup({ groupId: gRace, title: "Race group", owner: ALICE });
        await catalog.createSession(raceRoot, { model: "m", owner: ALICE });

        const client = await rawPool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`DELETE FROM "${SCHEMA}".session_groups WHERE group_id = $1`, [gRace]);
            // The place sees the not-yet-committed group, passes the ownership
            // check, and blocks on the FK row lock until the delete commits.
            const racing = catalog.placeSessionsInGroup(viewer(ALICE), [raceRoot], gRace);
            await new Promise((resolve) => setTimeout(resolve, 300));
            await client.query("COMMIT");
            await expect(racing).rejects.toThrow(/foreign key|not found or is not owned/i);
        } finally {
            client.release();
        }

        // Clean failure: the session is intact and still placeable.
        expect(await catalog.getSession(raceRoot)).not.toBeNull();
        const retry = await catalog.placeSessionsInGroup(viewer(ALICE), [raceRoot], gAlice);
        expect(retry).toEqual([{ rootSessionId: raceRoot, placed: true, reason: null }]);
    });
});
