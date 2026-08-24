import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { runMigrations } from "../../dist/pg-migrator.js";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const SCHEMA = `t0058m_${randomBytes(4).toString("hex")}`;
const CMS_LOCK_SEED = 0x63_6d_73;

const q = (pool, text, params = []) => pool.query(text, params);

describe("legacy GitHub Copilot provider migration (0058)", () => {
    let pool;
    let aliceId;
    let bobId;

    beforeAll(async () => {
        pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
        const migrations = CMS_MIGRATIONS(SCHEMA);
        const cutoff = migrations.findIndex((migration) => migration.version === "0058");
        expect(cutoff).toBeGreaterThan(0);
        await runMigrations(pool, SCHEMA, migrations.slice(0, cutoff), CMS_LOCK_SEED);

        const insertUser = async (provider, subject, key) => {
            const { rows } = await q(pool,
                `INSERT INTO "${SCHEMA}".users (provider, subject, email, display_name, github_copilot_key)
                 VALUES ($1,$2,$2 || '@example.test',initcap($2),$3) RETURNING user_id`,
                [provider, subject, key]);
            return Number(rows[0].user_id);
        };
        aliceId = await insertUser("entra", "alice", "github_pat_alice");
        bobId = await insertUser("entra", "bob", "github_pat_bob");
        await insertUser("entra", "keyless", null);
        await insertUser("system", "system", "github_pat_system");

        for (const [sessionId, ownerId] of [["alice-session", aliceId], ["bob-session", bobId]]) {
            await q(pool,
                `INSERT INTO "${SCHEMA}".sessions (session_id, model, state)
                 VALUES ($1,'github-copilot:claude-opus-5','idle')`, [sessionId]);
            await q(pool,
                `INSERT INTO "${SCHEMA}".session_owners (session_id, user_id) VALUES ($1,$2)`,
                [sessionId, ownerId]);
        }
        await q(pool,
            `INSERT INTO "${SCHEMA}".sessions (session_id, model, state)
             VALUES ('historical-session','github-copilot:claude-opus-5','completed')`);
        await q(pool,
            `INSERT INTO "${SCHEMA}".session_owners (session_id, user_id)
             VALUES ('historical-session',$1)`, [aliceId]);
        await runMigrations(pool, SCHEMA, migrations, CMS_LOCK_SEED);
    }, 180_000);

    afterAll(async () => {
        if (!pool) return;
        await q(pool, `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await pool.end();
    });

    it("creates one private provider per populated regular-user key and rewrites active models", async () => {
        const { rows: providers } = await q(pool,
            `SELECT p.name, p.type_id, p.class, p.owner_user_id, p.display_name, p.system_use_enabled,
                    secret_ref->>'value' = u.github_copilot_key AS key_preserved
               FROM "${SCHEMA}".provider_instances p
               JOIN "${SCHEMA}".users u ON u.user_id = p.owner_user_id
              ORDER BY p.owner_user_id`);
        expect(providers).toEqual([
            { name: `ghcp-u${aliceId}`, type_id: "github-copilot", class: "personal", owner_user_id: String(aliceId), display_name: "My GitHub Copilot", system_use_enabled: false, key_preserved: true },
            { name: `ghcp-u${bobId}`, type_id: "github-copilot", class: "personal", owner_user_id: String(bobId), display_name: "My GitHub Copilot", system_use_enabled: false, key_preserved: true },
        ]);
        const { rows: sessions } = await q(pool,
            `SELECT session_id, model FROM "${SCHEMA}".sessions ORDER BY session_id`);
        expect(sessions).toEqual([
            { session_id: "alice-session", model: `ghcp-u${aliceId}:claude-opus-5` },
            { session_id: "bob-session", model: `ghcp-u${bobId}:claude-opus-5` },
            { session_id: "historical-session", model: "github-copilot:claude-opus-5" },
        ]);
    });

    it("retains legacy keys and reports migration status for rollback", async () => {
        const { rows } = await q(pool,
            `SELECT * FROM "${SCHEMA}".cms_provider_legacy_key_migration_status()`);
        expect(rows[0]).toEqual({
            regular_keys: "2",
            migrated_regular_keys: "2",
            system_key_present: true,
            system_key_adopted: false,
        });
        const { rows: keyRows } = await q(pool,
            `SELECT count(*)::int AS count FROM "${SCHEMA}".users
              WHERE github_copilot_key IS NOT NULL`);
        expect(keyRows[0].count).toBe(3);
    });

    it("requires an admin to claim the synthetic System key into their own provider", async () => {
        await expect(q(pool,
            `SELECT * FROM "${SCHEMA}".cms_provider_adopt_system_github_key('system-ghcp','System GitHub Copilot',$1,FALSE)`,
            [aliceId])).rejects.toThrow(/PROVIDER_FORBIDDEN/);

        const attempts = await Promise.allSettled([
            q(pool, `SELECT * FROM "${SCHEMA}".cms_provider_adopt_system_github_key('system-ghcp-a','System GitHub Copilot',$1,TRUE)`, [aliceId]),
            q(pool, `SELECT * FROM "${SCHEMA}".cms_provider_adopt_system_github_key('system-ghcp-b','System GitHub Copilot',$1,TRUE)`, [bobId]),
        ]);
        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
        const winner = attempts.find((attempt) => attempt.status === "fulfilled").value.rows[0];
        expect(winner).toMatchObject({ type_id: "github-copilot", class: "personal" });
        const { rows: stored } = await q(pool,
            `SELECT p.system_use_enabled,
                    p.secret_ref->>'value' = u.github_copilot_key AS key_preserved
               FROM "${SCHEMA}".provider_instances p
               JOIN "${SCHEMA}".users u ON u.provider='system' AND u.subject='system'
              WHERE p.name=$1`, [winner.name]);
        expect(stored[0]).toEqual({ system_use_enabled: true, key_preserved: true });

        const { rows: status } = await q(pool,
            `SELECT * FROM "${SCHEMA}".cms_provider_legacy_key_migration_status()`);
        expect(status[0].system_key_adopted).toBe(true);

        await expect(q(pool,
            `SELECT * FROM "${SCHEMA}".cms_provider_adopt_system_github_key('bob-system-ghcp',NULL,$1,TRUE)`,
            [bobId])).rejects.toThrow(/already been adopted/);
    });

    it("is idempotent when migration 0058 is replayed", async () => {
        await q(pool, `DELETE FROM "${SCHEMA}".schema_migrations WHERE version='0058'`);
        await runMigrations(pool, SCHEMA, CMS_MIGRATIONS(SCHEMA), CMS_LOCK_SEED);
        const { rows } = await q(pool,
            `SELECT count(*)::int AS count FROM "${SCHEMA}".provider_instances`);
        expect(rows[0].count).toBe(3);
    });

    it("migration provenance never prevents the owner from deleting a provider", async () => {
        await q(pool, `SELECT "${SCHEMA}".cms_provider_delete($1,$2,FALSE)`, [`ghcp-u${bobId}`, bobId]);
        const { rows } = await q(pool,
            `SELECT count(*)::int AS count, max(provider_name) AS provider_name
               FROM "${SCHEMA}".provider_legacy_key_migrations
              WHERE source_kind='user' AND source_user_id=$1`, [bobId]);
        expect(rows[0]).toEqual({ count: 1, provider_name: null });

        await q(pool, `DELETE FROM "${SCHEMA}".schema_migrations WHERE version='0058'`);
        await runMigrations(pool, SCHEMA, CMS_MIGRATIONS(SCHEMA), CMS_LOCK_SEED);
        const { rows: providers } = await q(pool,
            `SELECT count(*)::int AS count FROM "${SCHEMA}".provider_instances
              WHERE name=$1`, [`ghcp-u${bobId}`]);
        expect(providers[0].count).toBe(0);
    });

    it("keeps rollback metadata for active session model rewrites", async () => {
        const { rows } = await q(pool,
            `SELECT "${SCHEMA}".cms_provider_rollback_legacy_session_models(TRUE) AS restored`);
        expect(rows[0].restored).toBe(2);
        const { rows: sessions } = await q(pool,
            `SELECT DISTINCT model FROM "${SCHEMA}".sessions
              WHERE session_id IN ('alice-session','bob-session')`);
        expect(sessions).toEqual([{ model: "github-copilot:claude-opus-5" }]);
    });
});
