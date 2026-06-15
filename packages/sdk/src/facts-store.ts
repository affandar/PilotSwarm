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
    /**
     * Canonical scope key (`shared:<key>` / `session:<id>:<key>`).
     * Exposed so graph `evidence` arrays can reference a real fact and resolve
     * back via `readFacts({ scopeKeys })` (enhancedfactstore 02 §1c).
     */
    scopeKey: string;
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
    /**
     * Bulk read of an explicit fact set by scope_key (enhancedfactstore 02 §1c).
     * ACL applies as for any read; inaccessible/unknown keys are silently
     * omitted. This is how graph `evidence` arrays resolve back into facts.
     */
    scopeKeys?: string[];
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

/** How visibility is resolved inside the read/search procs. */
export interface AccessContext {
    readerSessionId?: string | null;
    grantedSessionIds?: string[];
    unrestricted?: boolean;
}

/**
 * A crawled-fact receipt: the scope key plus the content hash that was read.
 * The crawl queue is base-store bookkeeping (enhancedfactstore 07 D3) that feeds
 * whatever `GraphStore` is configured; it requires no extension.
 */
export interface CrawledFactStamp {
    scopeKey: string;
    contentHash: string;
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
    readFacts(query: ReadFactsQuery, access?: AccessContext): Promise<{
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
    /**
     * PRIVILEGED crawl-queue read (base-store bookkeeping, enhancedfactstore 07 D3):
     * facts not yet incorporated into a graph (`last_crawled_at IS NULL`), across
     * ALL scopes. Each returned fact carries its `contentHash` — the receipt for
     * `markFactsCrawled`. Only useful when a graph harvester is running; inert
     * otherwise.
     */
    readUncrawledFacts(opts?: { namespace?: string; limit?: number }): Promise<{
        count: number;
        facts: (FactRecord & { contentHash: string })[];
    }>;
    /**
     * PRIVILEGED crawl-queue write: stamp `last_crawled_at = now()` — but only
     * where `content_hash` still equals the supplied hash (read→mark race guard).
     * Mismatches are skipped, not errors.
     */
    markFactsCrawled(stamps: CrawledFactStamp[]): Promise<{ marked: number; skipped: number }>;
    close(): Promise<void>;
}

// ─── EnhancedFactStore contract (enhancedfactstore 02 §3/§3a/§4) ─────────────
//
// The SDK OWNS these contracts; concrete providers (e.g. @pilotswarm/horizon-store's
// HorizonDBFactStore) IMPLEMENT them. The runtime programs to the base FactStore
// and narrows to EnhancedFactStore by capability detection (isEnhancedFactStore).

/** Facts-store-only retrieval modes. There is NO "graph" mode — graph
 * retrieval is the separate GraphStore (see graph-store.ts). */
export type SearchMode = "lexical" | "semantic" | "hybrid";

/** Relative weights for hybrid fusion. A missing signal contributes 0. */
export interface SearchWeights {
    lexical?: number;
    semantic?: number;
}

export interface SearchOpts {
    mode?: SearchMode;          // default "hybrid"
    scope?: ReadFactsQuery["scope"];
    namespace?: string;         // key-prefix filter, e.g. "skills"
    tags?: string[];
    limit?: number;             // default 20
    /** Candidate pool size per signal before fusion (default 50). ACL applies
     * INSIDE the proc, before this pool is cut. */
    candidatePool?: number;
    weights?: SearchWeights;
    /** Minimum cosine similarity for semantic candidates (0..1). */
    minSemanticScore?: number;
}

/** Options for similarFacts (semantic kNN of a known fact). */
export interface SimilarOpts {
    k?: number;                 // top-k neighbours (default 8)
    minScore?: number;          // cosine floor (0..1)
    namespace?: string;
}

/** One fused, ACL-resolved hit. */
export interface ScoredFact extends FactRecord {
    /** Final fused score (higher = better). */
    score: number;
    /** Per-signal contributions, for debugging/tuning fusion. */
    signals: { lexical?: number; semantic?: number };
}

export interface SearchResult {
    count: number;
    mode: SearchMode;
    facts: ScoredFact[];
}

export interface EmbedderStatus {
    running: boolean;
    instanceId?: string;
    status?: string;
}

/** OpenAI/Azure-OpenAI-compatible embeddings endpoint (database-agnostic). */
export interface EmbeddingEndpointConfig {
    url: string;
    model: string;
    dim: number;
    apiKey?: string;
    apiKeyHeader?: string;
    bearer?: boolean;
    inputField?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
}

/** Capability descriptor advertised by an EnhancedFactStore. Graph is NOT here
 * — it is the separate `graphStore` injection (enhancedfactstore 07 D2). */
export interface FactsCapabilities {
    search: boolean;
    embedder: boolean;
}

/**
 * Strict superset of `FactStore` adding multi-signal retrieval, semantic
 * similarity, and the durable embedder lifecycle. The crawl queue lives on the
 * base `FactStore` (07 D3), so it is inherited, not redeclared here.
 */
export interface EnhancedFactStore extends FactStore {
    /** Capability descriptor read by the runtime to gate enhanced tools. */
    readonly capabilities: FactsCapabilities;

    /** Retrieval over the FACTS STORE ONLY: lexical (BM25) / semantic / hybrid. */
    searchFacts(query: string, opts?: SearchOpts, access?: AccessContext): Promise<SearchResult>;

    /** Semantic nearest-neighbours of a known fact (no re-embed). An
     * existing-but-inaccessible anchor returns empty (≡ unknown key). */
    similarFacts(scopeKey: string, opts?: SimilarOpts, access?: AccessContext): Promise<SearchResult>;

    /** Record/replace the embedding endpoint; restarts a running loop. */
    configureEmbedder(endpoint: EmbeddingEndpointConfig, opts?: { restartIfRunning?: boolean }): Promise<EmbedderStatus>;
    /** Start the single eternal batch-embedding loop. Idempotent. */
    startEmbedder(opts?: { intervalSeconds?: number; batch?: number }): Promise<EmbedderStatus>;
    /** Cancel the loop. No-op if already stopped. */
    stopEmbedder(reason?: string): Promise<EmbedderStatus>;
    /** Current lifecycle state. */
    embedderStatus(): Promise<EmbedderStatus>;
}

/**
 * Thrown when an enhanced/graph method is called on a store that does not
 * support it. Providers don't grow throwing stubs (Liskov / ISP — 07 D1); this
 * is retained only for callers that bypass the `isEnhancedFactStore` guard and
 * hard-cast a base store.
 */
export class EnhancedFactsUnsupportedError extends Error {
    constructor(method: string) {
        super(
            `${method} is not supported by this fact store. It is a base FactStore ` +
            `(not an EnhancedFactStore). Guard with isEnhancedFactStore(store) before calling.`,
        );
        this.name = "EnhancedFactsUnsupportedError";
    }
}

/**
 * Structural type guard: is this store an `EnhancedFactStore` (search + embedder)
 * rather than a plain `FactStore`? The runtime asks this once at worker boot and
 * threads the answer through — it never sniffs per turn. Graph presence is a
 * SEPARATE question (`!!graphStore`), not derived from the fact store.
 */
export function isEnhancedFactStore(store: FactStore): store is EnhancedFactStore {
    const s = store as any;
    return typeof s.searchFacts === "function"
        && typeof s.similarFacts === "function"
        && typeof s.configureEmbedder === "function"
        && typeof s.startEmbedder === "function"
        && typeof s.stopEmbedder === "function"
        && typeof s.embedderStatus === "function"
        && typeof s.capabilities === "object"
        && s.capabilities !== null
        && typeof s.capabilities.search === "boolean"
        && typeof s.capabilities.embedder === "boolean";
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
            readUncrawledFacts:        `${schema}.facts_read_uncrawled`,
            markFactsCrawled:          `${schema}.facts_mark_crawled`,
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
        access?: AccessContext,
    ): Promise<{ count: number; facts: FactRecord[] }> {
        const readerSessionId = access?.readerSessionId ?? null;
        const grantedSessionIds = access?.grantedSessionIds ?? [];
        const unrestricted = access?.unrestricted === true;
        const scope = query.scope ?? "accessible";
        const keyPattern = normalizeLikePattern(query.keyPattern) ?? null;
        const maxRows = query.limit ?? 50;
        // Distinguish "no scopeKeys filter" (undefined → null) from "read exactly
        // these facts" (an array — even empty → narrows). An empty array must
        // return nothing, never widen the read (governance: scopeKeys only narrows).
        const scopeKeys = query.scopeKeys === undefined ? null : query.scopeKeys;

        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.readFacts}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
                scopeKeys,
            ],
        );

        return {
            count: rows.length,
            facts: rows.map(mapFactRow),
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

    async readUncrawledFacts(
        opts: { namespace?: string; limit?: number } = {},
    ): Promise<{ count: number; facts: (FactRecord & { contentHash: string })[] }> {
        // Literal key prefix (NOT a LIKE pattern) — the proc uses starts_with so
        // any `_` / `%` in the namespace are matched literally, not as wildcards.
        const nsPrefix = opts.namespace ?? null;
        const limit = opts.limit ?? 20;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.readUncrawledFacts}($1, $2)`,
            [nsPrefix, limit],
        );
        return {
            count: rows.length,
            facts: rows.map((row: any) => ({
                ...mapFactRow(row),
                contentHash: String(row.content_hash ?? ""),
            })),
        };
    }

    async markFactsCrawled(
        stamps: CrawledFactStamp[],
    ): Promise<{ marked: number; skipped: number }> {
        for (const s of stamps) {
            if (!s || typeof s.scopeKey !== "string" || typeof s.contentHash !== "string") {
                throw new Error(
                    "markFactsCrawled: every stamp requires { scopeKey, contentHash } " +
                    "(the receipt returned by readUncrawledFacts).",
                );
            }
        }
        if (stamps.length === 0) return { marked: 0, skipped: 0 };
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.markFactsCrawled}($1::jsonb)`,
            [JSON.stringify(stamps)],
        );
        return {
            marked: Number(rows[0]?.marked) || 0,
            skipped: Number(rows[0]?.skipped) || 0,
        };
    }

    async close(): Promise<void> {
        try {
            await this.pool.end();
        } catch {}
    }
}

/** Map a PG facts row to a FactRecord (shared by readFacts + readUncrawledFacts). */
function mapFactRow(row: any): FactRecord {
    return {
        scopeKey: row.scope_key,
        key: row.key,
        value: row.value,
        agentId: row.agent_id ?? null,
        sessionId: row.session_id ?? null,
        shared: row.shared === true,
        tags: Array.isArray(row.tags) ? row.tags : [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
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
