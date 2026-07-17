/**
 * Migration 0034 — deployment-wide visibility placement parity.
 *
 * DB-only (no workers, no LLM): throwaway schema, full migration chain via
 * PgSessionCatalog.initialize(), then the placement/visibility contract
 * (docs/proposals/private-session-groups-and-deep-links.md):
 *
 *  - a stranger may place a tree whose ROOT visibility is shared_read or
 *    shared_write into their own group even under enforce semantics
 *    (p_is_admin=false) — deployment-wide readability grants organizability;
 *    the placement stays viewer-private (the owner never sees it)
 *  - a stranger CANNOT place a private tree with no targeted share
 *    (reason 'not_found')
 *  - viewer-scoped group counts include the shared-visibility roots the
 *    viewer placed
 *  - the not_found oracle fix: unknown ids and unreadable ids are
 *    indistinguishable (both echo the INPUT id, never the resolved root),
 *    and two child probes of one private tree return TWO separate rows so
 *    co-membership never leaks
 *
 * Personas mirror the dev auth provider roster: alice owns, dave is a
 * stranger with no share.
 *
 * Run: npx vitest run test/local/session-group-placement-visibility.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const SCHEMA = `t0034pv_${Date.now().toString(36)}`;

const persona = (id) => ({
    provider: "dev",
    subject: id,
    email: `${id}@dev.local`,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
});
const ALICE = persona("alice");
const DAVE = persona("dave");

const viewer = (p, isAdmin = false) => ({ provider: p.provider, subject: p.subject, isAdmin });
const placement = (p) => ({ provider: p.provider, subject: p.subject });

describe("session group placement visibility parity (0034)", () => {
    let catalog;
    let rawPool;
    let sharedReadRoot, sharedWriteRoot, privateRoot, privateChildA, privateChildB;
    const gDave = `g-dave-${Date.now()}`;

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize();
        const { default: pg } = await import("pg");
        rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

        sharedReadRoot = `sess-sread-${Date.now()}`;
        sharedWriteRoot = `sess-swrite-${Date.now()}`;
        privateRoot = `sess-priv-${Date.now()}`;
        privateChildA = `${privateRoot}-childA`;
        privateChildB = `${privateRoot}-childB`;

        await catalog.createSession(sharedReadRoot, { model: "m", owner: ALICE, visibility: "shared_read" });
        await catalog.createSession(sharedWriteRoot, { model: "m", owner: ALICE, visibility: "shared_write" });
        await catalog.createSession(privateRoot, { model: "m", owner: ALICE });
        await catalog.createSession(privateChildA, { model: "m", parentSessionId: privateRoot, owner: ALICE });
        await catalog.createSession(privateChildB, { model: "m", parentSessionId: privateRoot, owner: ALICE });

        await catalog.createSessionGroup({ groupId: gDave, title: "Dave group", owner: DAVE });
    });

    afterAll(async () => {
        try {
            await rawPool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        } finally {
            await rawPool?.end();
            await catalog?.close?.();
        }
    });

    // ── Shared-visibility roots are placeable by any viewer, privately ────

    it("a stranger places a shared_read root under enforce; the placement is private to them", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(DAVE, false), [sharedReadRoot], gDave);
        expect(results).toEqual([{ rootSessionId: sharedReadRoot, placed: true, reason: null }]);

        // Dave's placement rides only Dave's viewer; the owner never sees it.
        expect((await catalog.getSession(sharedReadRoot, placement(DAVE))).groupId).toBe(gDave);
        expect((await catalog.getSession(sharedReadRoot, placement(ALICE))).groupId).toBeNull();
        expect((await catalog.getSession(sharedReadRoot)).groupId).toBeNull();
    });

    it("a stranger places a shared_write root under enforce; the placement is private to them", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(DAVE, false), [sharedWriteRoot], gDave);
        expect(results).toEqual([{ rootSessionId: sharedWriteRoot, placed: true, reason: null }]);

        expect((await catalog.getSession(sharedWriteRoot, placement(DAVE))).groupId).toBe(gDave);
        expect((await catalog.getSession(sharedWriteRoot, placement(ALICE))).groupId).toBeNull();
        expect((await catalog.getSession(sharedWriteRoot)).groupId).toBeNull();
    });

    // ── Private roots need a targeted share ──────────────────────────────

    it("a stranger cannot place a private root with no targeted share", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(DAVE, false), [privateRoot], gDave);
        expect(results).toEqual([{ rootSessionId: privateRoot, placed: false, reason: "not_found" }]);
        expect((await catalog.getSession(privateRoot, placement(DAVE))).groupId).toBeNull();
    });

    // ── Viewer-scoped counts include placed shared roots ─────────────────

    it("viewer-scoped group counts include the shared-visibility roots the viewer placed", async () => {
        const daveGroups = await catalog.listSessionGroups(viewer(DAVE));
        expect(daveGroups.find((g) => g.groupId === gDave)?.memberCount).toBe(2);

        // Foreign groups are never returned to the owner.
        const aliceGroups = await catalog.listSessionGroups(viewer(ALICE));
        expect(aliceGroups.some((g) => g.groupId === gDave)).toBe(false);
    });

    // ── not_found oracle fix: no existence, no co-membership leak ─────────

    it("a child probe of a private tree is byte-identical to an unknown-id probe", async () => {
        const childProbe = await catalog.placeSessionsInGroup(viewer(DAVE, false), [privateChildA], gDave);
        expect(childProbe).toEqual([{ rootSessionId: privateChildA, placed: false, reason: "not_found" }]);

        const unknownProbe = await catalog.placeSessionsInGroup(viewer(DAVE, false), ["sess-unknown-xyz"], gDave);
        expect(unknownProbe).toEqual([{ rootSessionId: "sess-unknown-xyz", placed: false, reason: "not_found" }]);

        // The echoed id is the INPUT id, never the resolved root — same shape either way.
        expect({ placed: childProbe[0].placed, reason: childProbe[0].reason })
            .toEqual({ placed: unknownProbe[0].placed, reason: unknownProbe[0].reason });
    });

    it("two co-tree child probes of a private tree return two rows, echoing inputs without collapsing to the root", async () => {
        const results = await catalog.placeSessionsInGroup(viewer(DAVE, false), [privateChildA, privateChildB], gDave);
        expect(results).toHaveLength(2);
        expect(results.every((r) => r.placed === false && r.reason === "not_found")).toBe(true);
        expect(results.map((r) => r.rootSessionId).sort()).toEqual([privateChildA, privateChildB].sort());
        // The shared root is never revealed, so co-membership does not leak.
        expect(results.some((r) => r.rootSessionId === privateRoot)).toBe(false);
    });
});
