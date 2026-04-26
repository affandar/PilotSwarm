import { runMigrations } from "./_pg-migrator.js";
import { SESSIONFS_MIGRATIONS } from "./migrations.js";

/**
 * Lock seed for SessionFs migrations. Different from CMS (0x636D73) and Facts
 * so concurrent runners on different schemas in the same DB don't block each
 * other.
 */
const SESSIONFS_LOCK_SEED = 0x66_73_66_73; // "fsfs"

/** Run all pending SessionFs migrations against the given schema. */
export async function runSessionFsMigrations(pool: any, schema: string): Promise<void> {
    await runMigrations(pool, schema, SESSIONFS_MIGRATIONS(schema), SESSIONFS_LOCK_SEED);
}
