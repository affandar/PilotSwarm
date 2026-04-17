/**
 * Facts Schema Migrator — thin wrapper over the shared pg-migrator.
 *
 * @module
 */

import { runMigrations } from "./pg-migrator.js";
import { FACTS_MIGRATIONS } from "./facts-migrations.js";

const FACTS_LOCK_SEED = 0x66_61_63; // "fac"

/**
 * Run all pending Facts migrations against the given schema.
 *
 * @param pool   - node-postgres pool
 * @param schema - target schema name (e.g. "pilotswarm_facts")
 */
export async function runFactsMigrations(pool: any, schema: string): Promise<void> {
    await runMigrations(pool, schema, FACTS_MIGRATIONS(schema), FACTS_LOCK_SEED);
}
