import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";

const schema = `ps_test_capability_store_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const pool = new pg.Pool({ connectionString: url, max: 3 });
const sessionId = randomUUID();
let catalog;

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
    await catalog.createSession(sessionId, { model: "test-model", owner: { provider: "test", subject: "owner" } });
});

afterAll(async () => {
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

describe("durable session capability storage", () => {
    it("installs Base V2 Off while retaining user overrides and an empty capability state", async () => {
        const definition = (await pool.query(`SELECT default_enabled, default_allow_user_override
            FROM "${schema}".feature_flags WHERE feature_key='agents.base_v2'`)).rows[0];
        expect(definition).toEqual({ default_enabled: false, default_allow_user_override: true });
        expect((await pool.query(`SELECT enabled, allow_user_override FROM "${schema}".feature_flag_settings
            WHERE feature_key='agents.base_v2' AND scope='cluster'`)).rows)
            .toEqual([{ enabled: false, allow_user_override: true }]);
        await expect(catalog.getSessionCapabilities(sessionId)).resolves.toEqual({ revision: 0, selections: [] });
    });

    it("uses compare-and-set revisions so concurrent writers cannot lose an update", async () => {
        const first = { revision: 1, selections: [{ sourceId: "one", sourceRef: "cap1.first", tools: ["a"], mcpServers: [] }] };
        await expect(catalog.saveSessionCapabilities(sessionId, 0, first)).resolves.toBe(true);
        await expect(catalog.getSessionCapabilities(sessionId)).resolves.toEqual(first);

        const left = { revision: 2, selections: [{ ...first.selections[0], tools: ["a", "b"] }] };
        const right = { revision: 2, selections: [{ ...first.selections[0], tools: ["a", "c"] }] };
        const outcomes = await Promise.all([
            catalog.saveSessionCapabilities(sessionId, 1, left),
            catalog.saveSessionCapabilities(sessionId, 1, right),
        ]);
        expect(outcomes.filter(Boolean)).toHaveLength(1);
        expect([left, right]).toContainEqual(await catalog.getSessionCapabilities(sessionId));
    });

    it("rejects malformed stored state and cascades state when its session is deleted", async () => {
        await pool.query(`UPDATE "${schema}".session_capabilities SET state='{"revision":2,"selections":"bad"}'::jsonb
            WHERE session_id=$1`, [sessionId]);
        await expect(catalog.getSessionCapabilities(sessionId)).rejects.toThrow(/invalid durable capability state/i);
        await pool.query(`DELETE FROM "${schema}".sessions WHERE session_id=$1`, [sessionId]);
        expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".session_capabilities
            WHERE session_id=$1`, [sessionId])).rows[0].count).toBe(0);
    });
});
