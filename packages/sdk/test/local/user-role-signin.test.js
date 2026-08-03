/**
 * Migration 0042 — the sign-in role, persisted so the WORKER can see it.
 *
 * DB-only (no workers, no LLM): throwaway schema, full migration chain via
 * PgSessionCatalog.initialize(), then the behaviours the design depends on.
 *
 * Why each block exists — these are the ways this feature breaks:
 *
 *  - `role` is a PostgreSQL keyword AND the name of a RETURNS TABLE out-column
 *    in cms_get_user_role, which is the classic PL/pgSQL shadowing footgun
 *    ("column reference is ambiguous"). It cannot be caught by tsc or by a
 *    fake catalog; only a real database answers it.
 *  - A DEMOTION must land. If the role were merged the way cms_register_user
 *    merges display fields (COALESCE, 0030), an admin would stay an admin
 *    forever. That is the single worst outcome available here.
 *  - A role-less SIGHTING must not clobber a good role. Share grants and
 *    session creates both call cms_register_user with no role at all.
 *  - `role_seen_at` records CONFIRMATION, not change — the worker's staleness
 *    ceiling is meaningless if an unchanged re-write leaves it alone.
 *  - The role must not leak into the management-facing user profile.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/user-role-signin.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `t0042_${Date.now().toString(36)}`;

const persona = (id) => ({
    provider: "dev",
    subject: id,
    email: `${id}@dev.local`,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
});
const ADA = persona("ada");
const ALICE = persona("alice");
const BOB = persona("bob");

describe.skipIf(!DATABASE_URL)("sign-in role persistence (0042)", () => {
    let catalog;

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize();
    });

    afterAll(async () => {
        try {
            const { default: pg } = await import("pg");
            const p = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
            await p.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
            await p.end();
        } catch { /* best effort */ }
        await catalog?.close?.();
    });

    // ── The read path exists and does not shadow ──────────────────────

    it("cms_get_user_role executes — the out-column named `role` does not shadow users.role", async () => {
        // If the proc's RETURNS TABLE column shadowed the table column this
        // throws "column reference \"role\" is ambiguous" at CALL time, not at
        // migration time. Nothing but a real query finds that.
        const observation = await catalog.getUserRole(ADA);
        expect(observation).toEqual({ role: null, seenAt: null });
    });

    it("an unknown principal reads as no privilege, not as an error", async () => {
        expect(await catalog.getUserRole(persona("nobody-here"))).toEqual({ role: null, seenAt: null });
        // A malformed principal is the same answer, never a throw.
        expect(await catalog.getUserRole({ provider: "", subject: "" })).toEqual({ role: null, seenAt: null });
    });

    // ── Write, read back, and change ──────────────────────────────────

    it("records a role and stamps when it was observed", async () => {
        const before = Date.now();
        const stored = await catalog.setUserRole(ADA, "admin");
        expect(stored).toBe("admin");

        const { role, seenAt } = await catalog.getUserRole(ADA);
        expect(role).toBe("admin");
        expect(seenAt).toBeInstanceOf(Date);
        // Allow generous clock slack between the app and the database.
        expect(seenAt.getTime()).toBeGreaterThan(before - 60_000);
    });

    it("a DEMOTION lands — the role is replaced, never merged", async () => {
        await catalog.setUserRole(ALICE, "admin");
        expect((await catalog.getUserRole(ALICE)).role).toBe("admin");

        await catalog.setUserRole(ALICE, "user");
        expect((await catalog.getUserRole(ALICE)).role).toBe("user");

        // ...and clearing it entirely also lands. A COALESCE-style merge
        // (which is what cms_register_user does for display fields) would
        // leave "user" here, and "admin" above.
        await catalog.setUserRole(ALICE, null);
        expect((await catalog.getUserRole(ALICE)).role).toBe(null);
    });

    it("a promotion lands too", async () => {
        await catalog.setUserRole(BOB, "user");
        await catalog.setUserRole(BOB, "admin");
        expect((await catalog.getUserRole(BOB)).role).toBe("admin");
    });

    it("role_seen_at is bumped even when the role is unchanged", async () => {
        await catalog.setUserRole(ADA, "admin");
        const first = (await catalog.getUserRole(ADA)).seenAt;
        await new Promise((r) => setTimeout(r, 25));
        await catalog.setUserRole(ADA, "admin");
        const second = (await catalog.getUserRole(ADA)).seenAt;
        // It records CONFIRMATION, not change. The worker expires stale
        // observations, so "unchanged" must still count as "still true".
        expect(second.getTime()).toBeGreaterThan(first.getTime());
    });

    // ── Normalization: unknown text is no privilege ───────────────────

    it("normalizes case and whitespace, and refuses anything outside the vocabulary", async () => {
        const cases = [
            ["  ADMIN ", "admin"],
            ["User", "user"],
            ["anonymous", "anonymous"],
            ["superadmin", null],
            ["owner", null],
            ["admin,user", null],
            ["", null],
            [null, null],
        ];
        for (const [input, expected] of cases) {
            const stored = await catalog.setUserRole(persona("norm"), input);
            expect(stored, `input ${JSON.stringify(input)}`).toBe(expected);
            expect((await catalog.getUserRole(persona("norm"))).role).toBe(expected);
        }
    });

    // ── The invariant that makes it safe to leave the role alone ──────

    it("a role-less sighting does not clobber the role", async () => {
        const carol = persona("carol");
        await catalog.setUserRole(carol, "admin");

        // Creating a session stamps the owner, which routes through
        // cms_register_user — a sighting carrying no role at all.
        const sessionId = `sess-role-${Date.now()}`;
        await catalog.createSession(sessionId, { model: "m", owner: carol });
        expect((await catalog.getUserRole(carol)).role).toBe("admin");

        // So does being granted a share, and that one carries no email or
        // display name either — the thinnest sighting there is.
        await catalog.grantSessionShare(sessionId, { provider: "dev", subject: "carol" }, "read", ALICE);
        expect((await catalog.getUserRole(carol)).role).toBe("admin");
    });

    it("a sighting still refreshes display fields, so 0030 is intact", async () => {
        const dave = { provider: "dev", subject: "dave" };
        await catalog.setUserRole(dave, "user");
        await catalog.setUserRole({ ...dave, email: "dave@dev.local", displayName: "Dave" }, "user");
        const profile = await catalog.getUserProfile(dave);
        expect(profile.email).toBe("dave@dev.local");
        expect(profile.displayName).toBe("Dave");
    });

    // ── The role is not a profile field ───────────────────────────────

    it("the role does not leak through the management-facing user profile", async () => {
        await catalog.setUserRole(ADA, "admin");
        const profile = await catalog.getUserProfile(ADA);
        expect(profile).toBeTruthy();
        // A privilege value has no business on the surface that renders the
        // Admin Console. It is readable only through the narrow getUserRole.
        expect("role" in profile).toBe(false);
        expect("roleSeenAt" in profile).toBe(false);
    });

    it("the role does not leak through listKnownUsers", async () => {
        const users = await catalog.listKnownUsers({ limit: 50 });
        expect(users.length).toBeGreaterThan(0);
        for (const u of users) {
            expect("role" in u, `listKnownUsers row for ${u.subject}`).toBe(false);
        }
    });
});
