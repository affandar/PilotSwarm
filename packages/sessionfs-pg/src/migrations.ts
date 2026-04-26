import { migration_0001_schema } from "./migration_0001_schema.js";
import { migration_0002_procs } from "./migration_0002_procs.js";
import type { MigrationEntry } from "./_pg-migrator.js";

/** Ordered, idempotent migrations for the Postgres SessionFs store. */
export function SESSIONFS_MIGRATIONS(schema: string): MigrationEntry[] {
    return [
        { version: "0001", name: "schema", sql: migration_0001_schema(schema) },
        { version: "0002", name: "stored_procs", sql: migration_0002_procs(schema) },
    ];
}
