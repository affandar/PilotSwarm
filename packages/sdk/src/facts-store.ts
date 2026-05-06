/**
 * Facts Store — persistent key/value memory for agents and sessions.
 *
 * Facts live in PostgreSQL and are designed for:
 *   - session-scoped durable memory
 *   - shared cross-agent knowledge
 *   - session cleanup when a session is deleted
 */

import { runFactsMigrations } from "./facts-migrator.js";
import { globalDbMetrics } from "./db-metrics.js";

async function measureDbCall<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
        const result = await fn();
        globalDbMetrics.record(key, Date.now() - t0);
        return result;
    } catch (err) {
        globalDbMetrics.record(key, Date.now() - t0, true);
        throw err;
    }
}

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
const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_PG_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_PG_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_PG_IDLE_TIMEOUT_MS = 30_000;

function resolveEnvInt(varName: string, defaultVal: number, env: Record<string, string | undefined> = process.env, minVal = 0): number {
    const raw = env[varName];
    if (!raw) return defaultVal;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < minVal) return defaultVal;
    return parsed;
}

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
    env: Record<string, string | undefined> = process.env,
): Promise<FactStore> {
    if (storeUrl.startsWith("postgres://") || storeUrl.startsWith("postgresql://")) {
        return PgFactStore.create(storeUrl, schema, env);
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

    static async create(
        connectionString: string,
        schema?: string,
        env: Record<string, string | undefined> = process.env,
    ): Promise<PgFactStore> {
        const { default: pg } = await import("pg");

        const parsed = new URL(connectionString);
        const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
            .includes(parsed.searchParams.get("sslmode") ?? "");
        parsed.searchParams.delete("sslmode");

        const stmtTimeout = resolveEnvInt("PG_STATEMENT_TIMEOUT_MS", 0, env);
        const pool = new pg.Pool({
            connectionString: parsed.toString(),
            max: resolveEnvInt("DB_POOL_MAX", DEFAULT_DB_POOL_MAX, env, 1),
            connectionTimeoutMillis: resolveEnvInt("PG_CONNECTION_TIMEOUT_MS", DEFAULT_PG_CONNECTION_TIMEOUT_MS, env),
            idleTimeoutMillis: resolveEnvInt("PG_IDLE_TIMEOUT_MS", DEFAULT_PG_IDLE_TIMEOUT_MS, env),
            query_timeout: resolveEnvInt("PG_QUERY_TIMEOUT_MS", DEFAULT_PG_QUERY_TIMEOUT_MS, env),
            ...(stmtTimeout > 0 ? { statement_timeout: stmtTimeout } : {}),
            ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        });

        pool.on("error", (err: Error) => {
            console.error("[facts] pool idle client error (non-fatal):", err.message);
        });

        return new PgFactStore(pool, schema ?? DEFAULT_SCHEMA);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        return measureDbCall("facts.initialize", async () => {
            await runFactsMigrations(this.pool, this.sql.schema);
            this.initialized = true;
        });
    }

    async storeFact(input: StoreFactInput): Promise<{ key: string; shared: boolean; stored: true }> {
        return measureDbCall("facts.storeFact", async () => {
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
        });
    }

    async readFacts(
        query: ReadFactsQuery,
        access?: { readerSessionId?: string | null; grantedSessionIds?: string[]; unrestricted?: boolean },
    ): Promise<{ count: number; facts: FactRecord[] }> {
        return measureDbCall("facts.readFacts", async () => {
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
        });
    }

    async deleteFact(input: DeleteFactInput): Promise<{ key: string; shared: boolean; deleted: boolean }> {
        return measureDbCall("facts.deleteFact", async () => {
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
        });
    }

    async deleteSessionFactsForSession(sessionId: string): Promise<number> {
        return measureDbCall("facts.deleteSessionFactsForSession", async () => {
            const { rows } = await this.pool.query(
                `SELECT ${this.sql.fn.deleteSessionFacts}($1) AS deleted_count`,
                [sessionId],
            );
            return Number(rows[0]?.deleted_count) || 0;
        });
    }

    async getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]> {
        return measureDbCall("facts.getSessionFactsStats", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionFactsStats}($1)`,
                [sessionId],
            );
            return rows.map(rowToFactsStatsRow);
        });
    }

    async getFactsStatsForSessions(sessionIds: string[]): Promise<FactsStatsRow[]> {
        if (!sessionIds || sessionIds.length === 0) return [];
        return measureDbCall("facts.getFactsStatsForSessions", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getFactsStatsForSessions}($1)`,
                [sessionIds],
            );
            return rows.map(rowToFactsStatsRow);
        });
    }

    async getSharedFactsStats(): Promise<FactsStatsRow[]> {
        return measureDbCall("facts.getSharedFactsStats", async () => {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSharedFactsStats}()`,
            );
            return rows.map(rowToFactsStatsRow);
        });
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
