import pkg from "pg";
const { Pool } = pkg;
import { runSessionFsMigrations } from "./migrator.js";

export interface PgSessionFsStoreOptions {
    /** node-postgres connection string. */
    connectionString: string;
    /** Schema to host all SessionFs tables/procs. Created if missing. */
    schema: string;
    /** Optional pool overrides. */
    poolMax?: number;
}

/**
 * Owns the Postgres pool and the schema lifecycle for one SessionFs store.
 *
 * Multiple sessions share one store. Each session's data is isolated by
 * `session_id` rows in the schema's tables.
 *
 * The store does not implement `SessionFsProvider` itself — call
 * {@link createPgSessionFsProvider} for a per-session provider.
 */
export class PgSessionFsStore {
    readonly schema: string;
    readonly pool: any;
    private initialized = false;

    constructor(opts: PgSessionFsStoreOptions) {
        if (!opts.connectionString) throw new Error("connectionString is required");
        if (!opts.schema) throw new Error("schema is required");
        this.schema = opts.schema;
        this.pool = new Pool({
            connectionString: opts.connectionString,
            max: opts.poolMax ?? 10,
        });
    }

    /** Apply migrations. Idempotent. */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        await runSessionFsMigrations(this.pool, this.schema);
        this.initialized = true;
    }

    /** Drop the schema (and all data). Useful for tests. */
    async dropSchema(): Promise<void> {
        await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
        this.initialized = false;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    /** Drop a single session's data without dropping the schema. */
    async dropSession(sessionId: string): Promise<void> {
        await this.pool.query(
            `SELECT "${this.schema}".fs_drop_session($1)`,
            [sessionId],
        );
    }
}
