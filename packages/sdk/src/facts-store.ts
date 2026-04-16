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

export interface FactStore {
    initialize(): Promise<void>;
    storeFact(input: StoreFactInput): Promise<{
        key: string;
        shared: boolean;
        stored: true;
    }>;
    readFacts(query: ReadFactsQuery, access?: { readerSessionId?: string | null; grantedSessionIds?: string[] }): Promise<{
        count: number;
        facts: FactRecord[];
    }>;
    deleteFact(input: DeleteFactInput): Promise<{
        key: string;
        shared: boolean;
        deleted: boolean;
    }>;
    deleteSessionFactsForSession(sessionId: string): Promise<number>;
    close(): Promise<void>;
}

const DEFAULT_SCHEMA = "pilotswarm_facts";

function sqlForSchema(schema: string) {
    return {
        schema,
        fn: {
            storeFact:            `${schema}.facts_store_fact`,
            readFacts:            `${schema}.facts_read_facts`,
            deleteFact:           `${schema}.facts_delete_fact`,
            deleteSessionFacts:   `${schema}.facts_delete_session_facts`,
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

export async function createFactStoreForUrl(storeUrl: string, schema?: string): Promise<FactStore> {
    if (storeUrl.startsWith("postgres://") || storeUrl.startsWith("postgresql://")) {
        return PgFactStore.create(storeUrl, schema);
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

    static async create(connectionString: string, schema?: string): Promise<PgFactStore> {
        const { default: pg } = await import("pg");

        const parsed = new URL(connectionString);
        const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
            .includes(parsed.searchParams.get("sslmode") ?? "");
        parsed.searchParams.delete("sslmode");

        const pool = new pg.Pool({
            connectionString: parsed.toString(),
            max: 3,
            ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        });

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
        access?: { readerSessionId?: string | null; grantedSessionIds?: string[] },
    ): Promise<{ count: number; facts: FactRecord[] }> {
        const readerSessionId = access?.readerSessionId ?? null;
        const grantedSessionIds = access?.grantedSessionIds ?? [];
        const scope = query.scope ?? "accessible";
        const keyPattern = normalizeLikePattern(query.keyPattern) ?? null;
        const maxRows = query.limit ?? 50;

        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.readFacts}($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                scope,
                readerSessionId,
                grantedSessionIds.length > 0 ? grantedSessionIds : null,
                keyPattern,
                query.tags && query.tags.length > 0 ? query.tags : null,
                query.sessionId ?? null,
                query.agentId ?? null,
                maxRows,
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

    async close(): Promise<void> {
        try {
            await this.pool.end();
        } catch {}
    }
}
