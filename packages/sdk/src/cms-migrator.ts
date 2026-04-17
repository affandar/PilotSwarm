/**
 * CMS Schema Migrator — thin wrapper over the shared pg-migrator.
 *
 * @module
 */

import { runMigrations } from "./pg-migrator.js";
import { CMS_MIGRATIONS } from "./cms-migrations.js";

export type { MigrationEntry } from "./pg-migrator.js";

const CMS_LOCK_SEED = 0x63_6D_73; // "cms"

/**
 * Run all pending CMS migrations against the given schema.
 *
 * @param pool   - node-postgres pool
 * @param schema - target schema name (e.g. "copilot_sessions")
 */
export async function runCmsMigrations(pool: any, schema: string): Promise<void> {
    await runMigrations(pool, schema, CMS_MIGRATIONS(schema), CMS_LOCK_SEED);
}
