/**
 * Migration 0034 backfill — legacy sessions.group_id → per-user placements.
 *
 * Applies the chain only up to 0033, seeds legacy group data with raw SQL
 * (roots + conflicting children, an owner-mismatch root, ownerless groups
 * with consistent and conflicting owners, an unowned root, a soft-deleted
 * root), then applies the full list and asserts:
 *
 *  - placements exist for live grouped ROOTS whose owner is the group owner
 *  - children never get placements, even with conflicting legacy group_ids
 *  - an ownerless group whose live roots share one owner ADOPTS that owner
 *  - an ownerless group with conflicting root owners stays quarantined
 *    (no owner row, no placements, absent from viewer-scoped listings)
 *  - owner-mismatch and unowned roots are skipped
 *  - re-running the migration list (including a forced re-apply of 0034)
 *    is idempotent
 *
 * Run: npx vitest run test/local/session-group-placement-migration.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { runMigrations } from "../../dist/pg-migrator.js";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const SCHEMA = `t0034m_${Date.now().toString(36)}`;
const CMS_LOCK_SEED = 0x63_6d_73;

describe("session group placement migration (0034 backfill)", () => {
    let pool;
    let aliceId, bobId;

    const G_ALICE = "g-alice";
    const G_BOB = "g-bob";
    const G_ADOPT = "g-adopt";
    const G_CONFLICT = "g-conflict";

    const q = (text, params) => pool.query(text, params);

    const insertUser = async (subject) => {
        const { rows } = await q(
            `INSERT INTO "${SCHEMA}".users (provider, subject, email, display_name)
             VALUES ('dev', $1, $1 || '@dev.local', initcap($1)) RETURNING user_id`,
            [subject],
        );
        return rows[0].user_id;
    };

    const insertGroup = async (groupId, ownerUserId) => {
        await q(
            `INSERT INTO "${SCHEMA}".session_groups (group_id, title) VALUES ($1, $1)`,
            [groupId],
        );
        if (ownerUserId != null) {
            await q(
                `INSERT INTO "${SCHEMA}".session_group_owners (group_id, user_id) VALUES ($1, $2)`,
                [groupId, ownerUserId],
            );
        }
    };

    const insertSession = async (sessionId, { parent = null, groupId = null, ownerUserId = null, deleted = false } = {}) => {
        await q(
            `INSERT INTO "${SCHEMA}".sessions (session_id, parent_session_id, group_id, root_session_id, deleted_at)
             VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END)`,
            [sessionId, parent, groupId, parent ? parent : sessionId, deleted],
        );
        if (ownerUserId != null) {
            await q(
                `INSERT INTO "${SCHEMA}".session_owners (session_id, user_id) VALUES ($1, $2)`,
                [sessionId, ownerUserId],
            );
        }
    };

    const allPlacements = async () => {
        const { rows } = await q(
            `SELECT u.subject, p.root_session_id, p.group_id
             FROM "${SCHEMA}".user_session_group_placements p
             JOIN "${SCHEMA}".users u ON u.user_id = p.user_id
             ORDER BY p.root_session_id`,
        );
        return rows.map((r) => `${r.subject}:${r.root_session_id}:${r.group_id}`);
    };

    const EXPECTED_PLACEMENTS = [
        "alice:r-adopt-a:g-adopt",
        "alice:r-adopt-b:g-adopt",
        "alice:r-grouped:g-alice",
    ];

    beforeAll(async () => {
        const { default: pg } = await import("pg");
        pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

        const migrations = CMS_MIGRATIONS(SCHEMA);
        const cutoff = migrations.findIndex((m) => m.version === "0034");
        expect(cutoff).toBeGreaterThan(0);
        await runMigrations(pool, SCHEMA, migrations.slice(0, cutoff), CMS_LOCK_SEED);

        aliceId = await insertUser("alice");
        bobId = await insertUser("bob");

        await insertGroup(G_ALICE, aliceId);
        await insertGroup(G_BOB, bobId);
        await insertGroup(G_ADOPT, null);
        await insertGroup(G_CONFLICT, null);

        // Root in alice's group with a consistent child and a child carrying
        // a CONFLICTING legacy group_id (children are never placed).
        await insertSession("r-grouped", { groupId: G_ALICE, ownerUserId: aliceId });
        await insertSession("c-consistent", { parent: "r-grouped", groupId: G_ALICE, ownerUserId: aliceId });
        await insertSession("c-conflicting", { parent: "r-grouped", groupId: G_BOB, ownerUserId: aliceId });

        // Owner-mismatch root: alice's session sitting in bob's group.
        await insertSession("r-mismatch", { groupId: G_BOB, ownerUserId: aliceId });

        // Ownerless group whose live roots all resolve to alice — adopts.
        await insertSession("r-adopt-a", { groupId: G_ADOPT, ownerUserId: aliceId });
        await insertSession("r-adopt-b", { groupId: G_ADOPT, ownerUserId: aliceId });

        // Ownerless group with conflicting root owners — quarantined.
        await insertSession("r-conflict-a", { groupId: G_CONFLICT, ownerUserId: aliceId });
        await insertSession("r-conflict-b", { groupId: G_CONFLICT, ownerUserId: bobId });

        // Unowned root in a grouped state — skipped.
        await insertSession("r-unowned", { groupId: G_ALICE });

        // Soft-deleted grouped root — ignored entirely.
        await insertSession("r-deleted", { groupId: G_ALICE, ownerUserId: aliceId, deleted: true });

        await runMigrations(pool, SCHEMA, migrations, CMS_LOCK_SEED);
    });

    afterAll(async () => {
        try {
            await pool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        } finally {
            await pool?.end();
        }
    });

    it("backfills placements for live grouped roots whose owner matches the group owner", async () => {
        expect(await allPlacements()).toEqual(EXPECTED_PLACEMENTS);
    });

    it("skips owner-mismatch, unowned, quarantined, soft-deleted roots and all children", async () => {
        const placements = await allPlacements();
        for (const absent of ["c-consistent", "c-conflicting", "r-mismatch", "r-conflict-a", "r-conflict-b", "r-unowned", "r-deleted"]) {
            expect(placements.some((p) => p.includes(`:${absent}:`))).toBe(false);
        }
    });

    it("adopts the single consistent owner for an ownerless group", async () => {
        const { rows } = await q(
            `SELECT user_id FROM "${SCHEMA}".session_group_owners WHERE group_id = $1`,
            [G_ADOPT],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe(aliceId);
    });

    it("quarantines the conflicting-owner group: no owner row, absent from viewer-scoped listings", async () => {
        const { rows } = await q(
            `SELECT user_id FROM "${SCHEMA}".session_group_owners WHERE group_id = $1`,
            [G_CONFLICT],
        );
        expect(rows).toHaveLength(0);

        const { rows: aliceGroups } = await q(
            `SELECT group_id, member_count FROM "${SCHEMA}".cms_list_session_groups($1, $2, $3)`,
            ["dev", "alice", false],
        );
        const aliceGroupIds = aliceGroups.map((g) => g.group_id).sort();
        expect(aliceGroupIds).toEqual([G_ADOPT, G_ALICE].sort());
        expect(aliceGroups.find((g) => g.group_id === G_ALICE).member_count).toBe(1);
        expect(aliceGroups.find((g) => g.group_id === G_ADOPT).member_count).toBe(2);

        const { rows: bobGroups } = await q(
            `SELECT group_id FROM "${SCHEMA}".cms_list_session_groups($1, $2, $3)`,
            ["dev", "bob", false],
        );
        expect(bobGroups.map((g) => g.group_id)).toEqual([G_BOB]);
    });

    it("re-running the migration list is idempotent, including a forced 0034 re-apply", async () => {
        const migrations = CMS_MIGRATIONS(SCHEMA);

        // Plain second run: 0034 already recorded, nothing re-executes.
        await runMigrations(pool, SCHEMA, migrations, CMS_LOCK_SEED);
        expect(await allPlacements()).toEqual(EXPECTED_PLACEMENTS);

        // Forced re-apply: drop the version record so 0034's SQL runs again
        // against the migrated state — every statement must be idempotent.
        await q(`DELETE FROM "${SCHEMA}".schema_migrations WHERE version = '0034'`);
        await runMigrations(pool, SCHEMA, migrations, CMS_LOCK_SEED);
        expect(await allPlacements()).toEqual(EXPECTED_PLACEMENTS);

        const { rows } = await q(
            `SELECT user_id FROM "${SCHEMA}".session_group_owners WHERE group_id = $1`,
            [G_ADOPT],
        );
        expect(rows).toHaveLength(1);
    });
});
