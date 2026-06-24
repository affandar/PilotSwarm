import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDuroxideStorageProvider, migrateLegacyDuroxideSchema } from "../../src/index.ts";

const DATABASE_URL = process.env.DATABASE_URL || "";
const HAS_DB = !!DATABASE_URL;

function suffix() {
    return Math.random().toString(36).slice(2, 10);
}

async function makePool() {
    const { default: pg } = await import("pg");
    return new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
}

async function schemaExists(pool, schema) {
    const { rows } = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
        [schema],
    );
    return Boolean(rows[0]?.exists);
}

async function dropSchema(pool, schema) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

async function dropGuard(pool, guardName, targetSchema) {
    await pool.query(`DROP EVENT TRIGGER IF EXISTS "${guardName}"`).catch(() => {});
    await pool.query(`DROP FUNCTION IF EXISTS "${targetSchema}"."${guardName}_fn"() CASCADE`).catch(() => {});
}

describe.skipIf(!HAS_DB)("duroxide schema migration", () => {
    let pool;
    let legacy;
    let target;
    let guard;

    beforeEach(async () => {
        pool = await makePool();
        const tag = suffix();
        legacy = `duroxide_legacy_${tag}`;
        target = `ps_duroxide_${tag}`;
        guard = `ps_block_legacy_${tag}`;
        await dropGuard(pool, guard, target);
        await dropSchema(pool, legacy);
        await dropSchema(pool, target);
    });

    afterEach(async () => {
        if (!pool) return;
        await dropGuard(pool, guard, target);
        await dropSchema(pool, legacy);
        await dropSchema(pool, target);
        await pool.end();
    });

    it("renames a legacy PilotSwarm-owned duroxide schema to ps_duroxide", async () => {
        await pool.query(`CREATE SCHEMA "${legacy}"`);
        await pool.query(`CREATE TABLE "${legacy}".instances (id text primary key)`);
        await pool.query(`INSERT INTO "${legacy}".instances (id) VALUES ('i1')`);

        const result = await migrateLegacyDuroxideSchema(pool, {
            legacySchema: legacy,
            targetSchema: target,
            installCreateSchemaGuard: false,
        });

        expect(result).toEqual({
            migrated: true,
            legacySchema: legacy,
            targetSchema: target,
            guardInstalled: false,
        });
        expect(await schemaExists(pool, legacy)).toBe(false);
        expect(await schemaExists(pool, target)).toBe(true);
        const { rows } = await pool.query(`SELECT id FROM "${target}".instances`);
        expect(rows.map((row) => row.id)).toEqual(["i1"]);
    });

    it("is a no-op when the target schema already exists and legacy is gone", async () => {
        await pool.query(`CREATE SCHEMA "${target}"`);
        const result = await migrateLegacyDuroxideSchema(pool, {
            legacySchema: legacy,
            targetSchema: target,
            installCreateSchemaGuard: false,
        });
        expect(result.skippedReason).toBe("already-migrated");
        expect(result.migrated).toBe(false);
    });

    it("throws rather than split history when both schemas exist", async () => {
        await pool.query(`CREATE SCHEMA "${legacy}"`);
        await pool.query(`CREATE SCHEMA "${target}"`);
        await expect(migrateLegacyDuroxideSchema(pool, {
            legacySchema: legacy,
            targetSchema: target,
            installCreateSchemaGuard: false,
        })).rejects.toThrow(/target schema already exists/);
    });

    it("does not claim to install a guard without the runtime role to block", async () => {
        await pool.query(`CREATE SCHEMA "${legacy}"`);
        const result = await migrateLegacyDuroxideSchema(pool, {
            legacySchema: legacy,
            targetSchema: target,
            installCreateSchemaGuard: true,
        });
        expect(result.migrated).toBe(true);
        expect(result.guardInstalled).toBe(false);
        expect(result.guardError).toMatch(/blockedRole/);
    });

    it("installs an event-trigger guard when the database role is allowed to create event triggers", async () => {
        const { rows } = await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
        if (!rows[0]?.rolsuper) {
            console.log("  skipping event-trigger guard assertion: current role is not superuser");
            return;
        }

        await pool.query(`CREATE SCHEMA "${legacy}"`);
        const result = await migrateLegacyDuroxideSchema(pool, {
            legacySchema: legacy,
            targetSchema: target,
            installCreateSchemaGuard: true,
            blockedRole: (await pool.query("SELECT current_user AS u")).rows[0].u,
            guardName: guard,
        });
        expect(result.guardInstalled).toBe(true);
        await expect(pool.query(`CREATE SCHEMA "${legacy}"`)).rejects.toThrow(/legacy duroxide schema/);
    });

    it("refuses to start against a fresh target when legacy PilotSwarm history is still present", async () => {
        await pool.query(`CREATE SCHEMA "${legacy}"`);
        await pool.query(`CREATE TABLE "${legacy}".instances (id text primary key)`);

        await expect(getDuroxideStorageProvider("postgres").createDuroxideProvider({
            provider: "postgres",
            url: DATABASE_URL,
            schema: target,
            providerOptions: { legacySchema: legacy },
        })).rejects.toThrow(/Refusing to use/);

        expect(await schemaExists(pool, target)).toBe(false);
    });

    it("refuses to start when both target and legacy PilotSwarm history schemas exist", async () => {
        await pool.query(`CREATE SCHEMA "${legacy}"`);
        await pool.query(`CREATE TABLE "${legacy}".instances (id text primary key)`);
        await pool.query(`CREATE SCHEMA "${target}"`);

        await expect(getDuroxideStorageProvider("postgres").createDuroxideProvider({
            provider: "postgres",
            url: DATABASE_URL,
            schema: target,
            providerOptions: { legacySchema: legacy },
        })).rejects.toThrow(/legacy PilotSwarm duroxide schema/);
    });
});
