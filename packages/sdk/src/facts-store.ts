/**
 * Facts Store — persistent key/value memory for agents and sessions.
 *
 * Facts live in PostgreSQL and are designed for:
 *   - session-scoped durable memory
 *   - shared cross-agent knowledge
 *   - session cleanup when a session is deleted
 */

import { runFactsMigrations } from "./facts-migrator.js";

export interface FactRecord {
    key: string;
    value: unknown;
    agentId: string | null;
    sessionId: string | null;
    shared: boolean;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
}

export interface StoreFactInput {
    key: string;
    value: unknown;
    tags?: string[];
    shared?: boolean;
    agentId?: string | null;
    sessionId?: string | null;
}

export interface ReadFactsQuery {
    keyPattern?: string;
    tags?: string[];
    sessionId?: string;
    agentId?: string;
    limit?: number;
    scope?: "accessible" | "shared" | "session" | "descendants";
}

export interface DeleteFactInput {
    key: string;
    shared?: boolean;
    sessionId?: string | null;
}

/** Knowledge-namespace bucket used by facts stats aggregations. */
export type FactsNamespace = "skills" | "asks" | "intake" | "config" | "(other)";

/** One row of facts-stats aggregation, returned by all three facts-stats procs. */
export interface FactsStatsRow {
    namespace: FactsNamespace;
    factCount: number;
    totalValueBytes: number;
    oldestCreatedAt: Date | null;
    newestUpdatedAt: Date | null;
}

export interface FactStore {
    initialize(): Promise<void>;
    storeFact(input: StoreFactInput): Promise<{
        key: string;
        shared: boolean;
        stored: true;
    }>;
    readFacts(query: ReadFactsQuery, access?: { readerSessionId?: string | null; grantedSessionIds?: string[]; unrestricted?: boolean }): Promise<{
        count: number;
        facts: FactRecord[];
    }>;
    deleteFact(input: DeleteFactInput): Promise<{
        key: string;
        shared: boolean;
        deleted: boolean;
    }>;
    deleteSessionFactsForSession(sessionId: string): Promise<number>;
    /** Per-session non-shared facts, bucketed by namespace. */
    getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]>;
    /** Same shape, aggregated across an array of session ids (used for spawn trees). */
    getFactsStatsForSessions(sessionIds: string[]): Promise<FactsStatsRow[]>;
    /** Shared (cross-session) facts bucketed by namespace. */
    getSharedFactsStats(): Promise<FactsStatsRow[]>;
    close(): Promise<void>;
}

const DEFAULT_SCHEMA = "pilotswarm_facts";

function sqlForSchema(schema: string) {
    return {
        schema,
        fn: {
            storeFact:                 `${schema}.facts_store_fact`,
            readFacts:                 `${schema}.facts_read_facts`,
            deleteFact:                `${schema}.facts_delete_fact`,
            deleteSessionFacts:        `${schema}.facts_delete_session_facts`,
            getSessionFactsStats:      `${schema}.facts_get_session_facts_stats`,
            getFactsStatsForSessions:  `${schema}.facts_get_facts_stats_for_sessions`,
            getSharedFactsStats:       `${schema}.facts_get_shared_facts_stats`,
        },
    };
}

function computeScopeKey(key: string, shared: boolean, sessionId?: string | null): string {
    if (shared) return `shared:${key}`;
    if (!sessionId) throw new Error("Session-scoped facts require a sessionId.");
    return `session:${sessionId}:${key}`;
}

function normalizeLikePattern(pattern?: string): string | undefined {
    if (!pattern) return undefined;
    if (pattern.includes("%")) return pattern;
    if (pattern.includes("*")) return pattern.replaceAll("*", "%");
    return pattern;
}

export async function createFactStoreForUrl(
    storeUrl: string,
    schema?: string,
    opts: { useManagedIdentity?: boolean; aadUser?: string } = {},
): Promise<FactStore> {
    if (storeUrl.startsWith("postgres://") || storeUrl.startsWith("postgresql://")) {
        return PgFactStore.create(storeUrl, schema, opts);
    }
    throw new Error(
        "PilotSwarm facts require a PostgreSQL store. " +
        `Received unsupported store URL: ${storeUrl}`,
    );
}

export class PgFactStore implements FactStore {
    private pool: any;
    private initialized = false;
    private sql: ReturnType<typeof sqlForSchema>;

    private constructor(pool: any, schema: string) {
        this.pool = pool;
        this.sql = sqlForSchema(schema);
    }

    static readonly DEFAULT_POOL_MAX = 3;

    static async create(
        connectionString: string,
        schema?: string,
        opts: { useManagedIdentity?: boolean; aadUser?: string } = {},
    ): Promise<PgFactStore> {
        const { default: pg } = await import("pg");
        const { buildPgPoolConfig } = await import("./pg-pool-factory.js");

        const configuredPoolMax = Number.parseInt(process.env.PILOTSWARM_FACTS_PG_POOL_MAX ?? "", 10);
        const poolMax = Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
            ? configuredPoolMax
            : PgFactStore.DEFAULT_POOL_MAX;

        const poolConfig = buildPgPoolConfig({
            connectionString,
            useManagedIdentity: opts.useManagedIdentity,
            aadUser: opts.aadUser,
            max: poolMax,
        });

        const pool = new pg.Pool(poolConfig);

        pool.on("error", (err: Error) => {
            console.error("[facts] pool idle client error (non-fatal):", err.message);
        });

        return new PgFactStore(pool, schema ?? DEFAULT_SCHEMA);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        await runFactsMigrations(this.pool, this.sql.schema);
        this.initialized = true;
    }

    async storeFact(input: StoreFactInput): Promise<{ key: string; shared: boolean; stored: true }> {
        const shared = input.shared === true;
        const scopeKey = computeScopeKey(input.key, shared, input.sessionId);

        await this.pool.query(
            `SELECT ${this.sql.fn.storeFact}($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                scopeKey,
                input.key,
                JSON.stringify(input.value),
                input.agentId ?? null,
                input.sessionId ?? null,
                shared,
                !shared,
                input.tags ?? [],
            ],
        );

        return {
            key: input.key,
            shared,
            stored: true,
        };
    }

    async readFacts(
        query: ReadFactsQuery,
        access?: { readerSessionId?: string | null; grantedSessionIds?: string[]; unrestricted?: boolean },
    ): Promise<{ count: number; facts: FactRecord[] }> {
        const readerSessionId = access?.readerSessionId ?? null;
        const grantedSessionIds = access?.grantedSessionIds ?? [];
        const unrestricted = access?.unrestricted === true;
        const scope = query.scope ?? "accessible";
        const keyPattern = normalizeLikePattern(query.keyPattern) ?? null;
        const maxRows = query.limit ?? 50;

        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.readFacts}($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                scope,
                readerSessionId,
                grantedSessionIds.length > 0 ? grantedSessionIds : null,
                keyPattern,
                query.tags && query.tags.length > 0 ? query.tags : null,
                query.sessionId ?? null,
                query.agentId ?? null,
                maxRows,
                unrestricted,
            ],
        );

        return {
            count: rows.length,
            facts: rows.map((row: any) => ({
                key: row.key,
                value: row.value,
                agentId: row.agent_id ?? null,
                sessionId: row.session_id ?? null,
                shared: row.shared === true,
                tags: Array.isArray(row.tags) ? row.tags : [],
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            })),
        };
    }

    async deleteFact(input: DeleteFactInput): Promise<{ key: string; shared: boolean; deleted: boolean }> {
        const shared = input.shared === true;
        const scopeKey = computeScopeKey(input.key, shared, input.sessionId);
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.deleteFact}($1) AS deleted_count`,
            [scopeKey],
        );
        return {
            key: input.key,
            shared,
            deleted: Number(rows[0]?.deleted_count) > 0,
        };
    }

    async deleteSessionFactsForSession(sessionId: string): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.deleteSessionFacts}($1) AS deleted_count`,
            [sessionId],
        );
        return Number(rows[0]?.deleted_count) || 0;
    }

    async getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionFactsStats}($1)`,
            [sessionId],
        );
        return rows.map(rowToFactsStatsRow);
    }

    async getFactsStatsForSessions(sessionIds: string[]): Promise<FactsStatsRow[]> {
        if (!sessionIds || sessionIds.length === 0) return [];
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFactsStatsForSessions}($1)`,
            [sessionIds],
        );
        return rows.map(rowToFactsStatsRow);
    }

    async getSharedFactsStats(): Promise<FactsStatsRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSharedFactsStats}()`,
        );
        return rows.map(rowToFactsStatsRow);
    }

    async close(): Promise<void> {
        try {
            await this.pool.end();
        } catch {}
    }
}

/** Map a PG row to FactsStatsRow. Used by all three facts-stats procs. */
function rowToFactsStatsRow(row: any): FactsStatsRow {
    const ns = String(row.namespace ?? "(other)");
    const namespace: FactsNamespace =
        ns === "skills" || ns === "asks" || ns === "intake" || ns === "config"
            ? ns
            : "(other)";
    return {
        namespace,
        factCount: Number(row.fact_count) || 0,
        totalValueBytes: Number(row.total_value_bytes) || 0,
        oldestCreatedAt: row.oldest_created_at ? new Date(row.oldest_created_at) : null,
        newestUpdatedAt: row.newest_updated_at ? new Date(row.newest_updated_at) : null,
    };
}
