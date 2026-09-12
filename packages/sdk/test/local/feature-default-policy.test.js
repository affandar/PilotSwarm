import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { nativeTasksDefaultPolicyMigration } from "../../src/migrations/native-tasks-default-policy-0078.ts";

const schema = `ps_test_feature_default_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const pool = new pg.Pool({ connectionString: url, max: 2 });
let catalog;

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
});

afterAll(async () => {
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

describe("native task installation policy", () => {
    it("stamps an Off cluster setting that users may override", async () => {
        const definition = (await pool.query(`
            SELECT default_enabled, default_allow_user_override, revision
            FROM "${schema}".feature_flags WHERE feature_key = 'copilot.native_tasks'`)).rows[0];
        expect(definition).toEqual({ default_enabled: false, default_allow_user_override: true, revision: "2" });

        const settings = (await pool.query(`
            SELECT scope, user_id, enabled, allow_user_override, revision, updated_by
            FROM "${schema}".feature_flag_settings WHERE feature_key = 'copilot.native_tasks'`)).rows;
        expect(settings).toEqual([{
            scope: "cluster", user_id: null, enabled: false, allow_user_override: true,
            revision: "2", updated_by: "migration:0078",
        }]);
    });

    it("is idempotent when initialization is repeated", async () => {
        await catalog.initialize();
        const { rows } = await pool.query(`
            SELECT count(*)::int AS count, min(revision)::text AS revision
            FROM "${schema}".feature_flag_settings WHERE feature_key = 'copilot.native_tasks' AND scope = 'cluster'`);
        expect(rows).toEqual([{ count: 1, revision: "2" }]);
    });

    it("updates code defaults without replacing an existing cluster policy", async () => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`UPDATE "${schema}".feature_flags
                SET default_allow_user_override = false, revision = 7
                WHERE feature_key = 'copilot.native_tasks'`);
            await client.query(`UPDATE "${schema}".feature_flag_settings
                SET enabled = true, allow_user_override = false, revision = 7, updated_by = 'admin'
                WHERE feature_key = 'copilot.native_tasks' AND scope = 'cluster'`);
            await client.query(nativeTasksDefaultPolicyMigration(schema));
            expect((await client.query(`SELECT default_enabled, default_allow_user_override, revision
                FROM "${schema}".feature_flags WHERE feature_key = 'copilot.native_tasks'`)).rows)
                .toEqual([{ default_enabled: false, default_allow_user_override: true, revision: "8" }]);
            expect((await client.query(`SELECT enabled, allow_user_override, revision, updated_by
                FROM "${schema}".feature_flag_settings WHERE feature_key = 'copilot.native_tasks' AND scope = 'cluster'`)).rows)
                .toEqual([{ enabled: true, allow_user_override: false, revision: "7", updated_by: "admin" }]);
        } finally {
            await client.query("ROLLBACK");
            client.release();
        }
    });
});
