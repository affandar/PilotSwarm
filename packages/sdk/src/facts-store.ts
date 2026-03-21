/**
 * Facts Store — persistent key/value memory for agents and sessions.
 *
 * Facts live in PostgreSQL and are designed for:
 *   - session-scoped durable memory
 *   - shared cross-agent knowledge
 *   - session cleanup when a session is deleted
 */

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
    const table = `${schema}.facts`;
    return {
        schema,
        table,
        createSchema: `CREATE SCHEMA IF NOT EXISTS ${schema}`,
        createTable: `
CREATE TABLE IF NOT EXISTS ${table} (
    id          BIGSERIAL PRIMARY KEY,
    scope_key   TEXT NOT NULL UNIQUE,
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    agent_id    TEXT,
    session_id  TEXT,
    shared      BOOLEAN NOT NULL DEFAULT FALSE,
    transient   BOOLEAN NOT NULL DEFAULT FALSE,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT (shared AND transient))
)`,
        createIndexes: [
            `CREATE INDEX IF NOT EXISTS idx_${schema}_facts_key ON ${table}(key)`,
            `CREATE INDEX IF NOT EXISTS idx_${schema}_facts_tags ON ${table} USING GIN (tags)`,
            `CREATE INDEX IF NOT EXISTS idx_${schema}_facts_session ON ${table}(session_id)`,
            `CREATE INDEX IF NOT EXISTS idx_${schema}_facts_agent ON ${table}(agent_id)`,
            `CREATE INDEX IF NOT EXISTS idx_${schema}_facts_shared ON ${table}(shared)`,
            `CREATE INDEX IF NOT EXISTS idx_${schema}_facts_transient ON ${table}(transient)`,
        ],
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

        await this.pool.query(this.sql.createSchema);
        await this.pool.query(this.sql.createTable);
        for (const idx of this.sql.createIndexes) {
            await this.pool.query(idx);
        }

        try {
            await this.pool.query(`ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS scope_key TEXT`);
            await this.pool.query(`ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT FALSE`);
            await this.pool.query(`ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS transient BOOLEAN NOT NULL DEFAULT FALSE`);
            await this.pool.query(`ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`);
            await this.pool.query(`ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
            await this.pool.query(`ALTER TABLE ${this.sql.table} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
        } catch {}

        try {
            await this.pool.query(
                `UPDATE ${this.sql.table}
                 SET scope_key = CASE
                     WHEN shared THEN 'shared:' || key
                     ELSE 'session:' || COALESCE(session_id, '') || ':' || key
                 END
                 WHERE scope_key IS NULL`,
            );
        } catch {}

        this.initialized = true;
    }

    async storeFact(input: StoreFactInput): Promise<{ key: string; shared: boolean; stored: true }> {
        const shared = input.shared === true;

        const scopeKey = computeScopeKey(input.key, shared, input.sessionId);

        await this.pool.query(
            `INSERT INTO ${this.sql.table}
                (scope_key, key, value, agent_id, session_id, shared, transient, tags)
             VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (scope_key) DO UPDATE SET
                value = EXCLUDED.value,
                agent_id = EXCLUDED.agent_id,
                session_id = EXCLUDED.session_id,
                shared = EXCLUDED.shared,
                transient = EXCLUDED.transient,
                tags = EXCLUDED.tags,
                updated_at = now()`,
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
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        const readerSessionId = access?.readerSessionId ?? null;
        const grantedSessionIds = access?.grantedSessionIds ?? [];
        const scope = query.scope ?? "accessible";

        if (scope === "shared") {
            conditions.push("shared = TRUE");
        } else if (scope === "session") {
            if (!readerSessionId) {
                return { count: 0, facts: [] };
            }
            conditions.push(`shared = FALSE AND session_id = $${idx++}`);
            params.push(readerSessionId);
        } else if (readerSessionId) {
            // "accessible" or "descendants" — include reader's own facts + shared
            const visibleParts = [`shared = TRUE`, `(shared = FALSE AND session_id = $${idx++})`];
            params.push(readerSessionId);
            // Include granted descendant session IDs in the visibility set
            if (grantedSessionIds.length > 0) {
                const placeholders = grantedSessionIds.map(() => `$${idx++}`).join(", ");
                visibleParts.push(`(shared = FALSE AND session_id IN (${placeholders}))`);
                params.push(...grantedSessionIds);
            }
            conditions.push(`(${visibleParts.join(" OR ")})`);
        } else {
            conditions.push("shared = TRUE");
        }

        const keyPattern = normalizeLikePattern(query.keyPattern);
        if (keyPattern) {
            conditions.push(`key LIKE $${idx++}`);
            params.push(keyPattern);
        }
        if (query.tags && query.tags.length > 0) {
            conditions.push(`tags @> $${idx++}`);
            params.push(query.tags);
        }
        if (query.sessionId) {
            conditions.push(`session_id = $${idx++}`);
            params.push(query.sessionId);
        }
        if (query.agentId) {
            conditions.push(`agent_id = $${idx++}`);
            params.push(query.agentId);
        }

        const maxRows = query.limit ?? 50;
        const sql = `SELECT key, value, agent_id, session_id, shared, tags, created_at, updated_at
                     FROM ${this.sql.table}
                     WHERE ${conditions.join(" AND ")}
                     ORDER BY updated_at DESC
                     LIMIT ${maxRows}`;

        const { rows } = await this.pool.query(sql, params);
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
        const { rowCount } = await this.pool.query(
            `DELETE FROM ${this.sql.table} WHERE scope_key = $1`,
            [scopeKey],
        );
        return {
            key: input.key,
            shared,
            deleted: rowCount > 0,
        };
    }

    async deleteSessionFactsForSession(sessionId: string): Promise<number> {
        const { rowCount } = await this.pool.query(
            `DELETE FROM ${this.sql.table}
             WHERE session_id = $1
               AND shared = FALSE`,
            [sessionId],
        );
        return rowCount ?? 0;
    }

    async close(): Promise<void> {
        try {
            await this.pool.end();
        } catch {}
    }
}
