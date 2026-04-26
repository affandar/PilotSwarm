/**
 * Vendored copy of `packages/sdk/src/pg-migrator.ts`.
 *
 * Kept here so the package has zero workspace deps on the SDK and can move
 * independently. If the upstream pg-migrator changes, copy it here.
 *
 * @internal
 */

export interface MigrationEntry {
    version: string;
    name: string;
    sql: string;
}

export async function runMigrations(
    pool: any,
    schema: string,
    migrations: MigrationEntry[],
    lockSeed: number,
): Promise<void> {
    const lockKey = hashSchemaName(schema, lockSeed);
    const client = await pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1)", [lockKey]);

        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        const migrationsTable = `"${schema}".schema_migrations`;
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${migrationsTable} (
                version     TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const { rows: applied } = await client.query(
            `SELECT version FROM ${migrationsTable} ORDER BY version`,
        );
        const appliedSet = new Set(applied.map((r: any) => r.version));

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
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
        client.release();
    }
}

function hashSchemaName(schema: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < schema.length; i++) {
        hash = ((hash << 5) - hash + schema.charCodeAt(i)) | 0;
    }
    return hash;
}
