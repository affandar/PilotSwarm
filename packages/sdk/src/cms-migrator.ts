/**
 * CMS Schema Migrator — versioned SQL migrations for the session catalog.
 *
 * Replaces the ad hoc ALTER TABLE approach with ordered, transactional migrations
 * tracked in a `schema_migrations` table. Uses a PostgreSQL advisory lock to
 * prevent concurrent workers from double-applying migrations.
 *
 * @module
 */

import { CMS_MIGRATIONS } from "./cms-migrations.js";

export interface MigrationEntry {
    version: string;
    name: string;
    sql: string;
}

/**
 * Run all pending CMS migrations against the given schema.
 *
 * @param pool - node-postgres pool
 * @param schema - target schema name (e.g. "copilot_sessions")
 */
export async function runCmsMigrations(pool: any, schema: string): Promise<void> {
    // 1. Acquire advisory lock first to serialize all schema bootstrap work.
    //    The lock key is derived from the schema name so different schemas don't block each other.
    const lockKey = hashSchemaName(schema);
    const client = await pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1)", [lockKey]);

        // 2. Ensure schema exists (inside lock — no concurrent race)
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        // 3. Ensure migration-tracking table exists
        const migrationsTable = `"${schema}".schema_migrations`;
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${migrationsTable} (
                version     TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        // 4. Read applied versions
        const { rows: applied } = await client.query(
            `SELECT version FROM ${migrationsTable} ORDER BY version`,
        );
        const appliedSet = new Set(applied.map((r: any) => r.version));

        // 5. Apply pending migrations in order
        const migrations = CMS_MIGRATIONS(schema);
        for (const migration of migrations) {
            if (appliedSet.has(migration.version)) continue;

            try {
                await client.query("BEGIN");
                await client.query(migration.sql);
                await client.query(
                    `INSERT INTO ${migrationsTable} (version, name) VALUES ($1, $2)`,
                    [migration.version, migration.name],
                );
                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {});
                throw err;
            }
        }
    } finally {
        // 6. Release advisory lock
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
        client.release();
    }
}

/** Stable 32-bit hash of a schema name for advisory lock key. */
function hashSchemaName(schema: string): number {
    let hash = 0x63_6D_73; // "cms"
    for (let i = 0; i < schema.length; i++) {
        hash = ((hash << 5) - hash + schema.charCodeAt(i)) | 0;
    }
    return hash;
}
