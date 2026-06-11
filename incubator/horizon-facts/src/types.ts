// @incubator/horizon-facts — type contracts for the EnhancedFactStore.
//
// Mirrors docs/proposals/enhancedfactstore/02-api-reference.md. The base shapes
// mirror PilotSwarm's FactStore (plus the 02 §1c additions: FactRecord.scopeKey
// and ReadFactsQuery.scopeKeys) so the enhanced store is a drop-in superset.
// Intentionally self-contained (no PilotSwarm imports) while incubating.

// ─── Base facts shapes (mirrors PilotSwarm FactStore + 02 §1c additions) ─────

export interface FactRecord {
    /** Canonical scope key (`shared:<key>` / `session:<id>:<key>`) — 02 §1c. */
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
    /** Bulk read of an explicit fact set by scope_key (02 §1c). ACL applies;
     * inaccessible/unknown keys are silently omitted. */
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

/** Carried verbatim from PilotSwarm: how visibility is resolved in the proc. */
export interface AccessContext {
    readerSessionId?: string | null;
    grantedSessionIds?: string[];
    unrestricted?: boolean;
}

/** The current PilotSwarm Facts Store API, mirrored so EnhancedFactStore is a
 * true superset. A store implementing EnhancedFactStore can be dropped in
 * wherever a FactStore is expected today. */
export interface FactStore {
    initialize(): Promise<void>;
    storeFact(input: StoreFactInput): Promise<{ key: string; shared: boolean; stored: true }>;
    readFacts(query: ReadFactsQuery, access?: AccessContext): Promise<{ count: number; facts: FactRecord[] }>;
    deleteFact(input: DeleteFactInput): Promise<{ key: string; shared: boolean; deleted: boolean }>;
    deleteSessionFactsForSession(sessionId: string): Promise<number>;
    /** Per-session non-shared facts, bucketed by namespace. */
    getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]>;
    /** Same shape, aggregated across an array of session ids (used for spawn trees). */
    getFactsStatsForSessions(sessionIds: string[]): Promise<FactsStatsRow[]>;
    /** Shared (cross-session) facts bucketed by namespace. */
    getSharedFactsStats(): Promise<FactsStatsRow[]>;
    close(): Promise<void>;
}

// ─── Retrieval (02 §3) ───────────────────────────────────────────────────────

/** Facts-store-only retrieval modes. There is NO "graph" mode — graph
 * retrieval is the separate GraphInterface (02 §5). */
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
    /** Candidate pool size per signal before fusion (default 50). The ACL
     * predicate applies INSIDE the proc, before this pool is cut. */
    candidatePool?: number;
    weights?: SearchWeights;    // default { lexical: 1, semantic: 1 }
    /** Minimum cosine similarity for semantic candidates (0..1). */
    minSemanticScore?: number;
}

/** Options for similarFacts (semantic kNN of a known fact — 02 §3). */
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

// ─── Crawl tracking (02 §3a — harvester support, PRIVILEGED) ────────────────

/** A crawled-fact receipt: the scope key plus the content hash that was read. */
export interface CrawledFactStamp {
    scopeKey: string;
    contentHash: string;
}

// ─── Embedder lifecycle (02 §4) ──────────────────────────────────────────────

export interface EmbedderStatus {
    /** True while the durable embedder loop is pending/running. */
    running: boolean;
    /** The pg_durable instance id of the embedder loop, when one exists. */
    instanceId?: string;
    /** Raw pg_durable status (pending/running/completed/cancelled/failed). */
    status?: string;
}

/** OpenAI/Azure-OpenAI-compatible embeddings endpoint (database-agnostic). */
export interface EmbeddingEndpointConfig {
    /** Full POST URL of the embeddings endpoint (including any api-version query). */
    url: string;
    /** Model/deployment name sent in the request body. */
    model: string;
    /** Vector dimension; MUST equal the `vector(N)` column dimension. */
    dim: number;
    /** Optional API key. ⚠ stored in durable vars (plaintext at rest) — accepted incubation TODO. */
    apiKey?: string;
    /** Header carrying the key. Default "api-key"; "Authorization" for OpenAI. */
    apiKeyHeader?: string;
    /** If true, prefix the key with "Bearer " (OpenAI style). Default false. */
    bearer?: boolean;
    /** Request body field carrying the text(s). Default "input". */
    inputField?: string;
    /** Extra static headers. */
    headers?: Record<string, string>;
    /** Per-request timeout (ms). Default 30_000. */
    timeoutMs?: number;
}

// ─── The enhanced store (02 §3, §3a, §4) ─────────────────────────────────────

export interface EnhancedFactStore extends FactStore {
    /**
     * Retrieval over the FACTS STORE ONLY: lexical (BM25) / semantic / hybrid.
     * `query` is interpreted by `opts.mode` — keywords for lexical, natural
     * language for semantic, both for hybrid. ACL applies inside the proc,
     * before ranking/LIMIT.
     */
    searchFacts(query: string, opts?: SearchOpts, access?: AccessContext): Promise<SearchResult>;

    /**
     * Semantic nearest-neighbours of a known fact (cosine kNN over the stored
     * vector — no re-embed). An existing-but-inaccessible anchor returns empty,
     * indistinguishable from an unknown key.
     */
    similarFacts(scopeKey: string, opts?: SimilarOpts, access?: AccessContext): Promise<SearchResult>;

    /**
     * PRIVILEGED harvester read: facts not yet incorporated into the graph
     * (`last_crawled_at IS NULL`), across ALL scopes. Each returned fact
     * carries its contentHash — the receipt for markFactsCrawled.
     */
    /**
     * PRIVILEGED harvester read of the crawl queue: facts not yet incorporated
     * (`last_crawled_at IS NULL`), across ALL scopes. Each returned fact
     * carries its contentHash — the receipt for markFactsCrawled.
     *
     * `embeddedOnly` gates the queue to facts that already have an embedding
     * (`embedding IS NOT NULL`): un-embedded facts are SKIPPED this read and
     * stay queued, reappearing once the in-DB embed loop fills them in. Use it
     * for similarity-refined harvesting, where a fact must be embedded before
     * it can be similarity-searched.
     */
    readUncrawledFacts(opts?: { namespace?: string; limit?: number; embeddedOnly?: boolean }):
        Promise<{ count: number; facts: (FactRecord & { contentHash: string })[] }>;

    /**
     * PRIVILEGED harvester write: stamp `last_crawled_at = now()` — but only
     * where content_hash still equals the supplied hash (read→mark race guard).
     * Mismatches are skipped, not errors.
     */
    markFactsCrawled(stamps: CrawledFactStamp[]): Promise<{ marked: number; skipped: number }>;

    /** Record/replace the endpoint config in durable variables. If the loop is
     * running, RESTARTS it to apply the new config (vars are captured at
     * df.start — pg_durable contract), unless `restartIfRunning` is false. */
    configureEmbedder(
        endpoint: EmbeddingEndpointConfig,
        opts?: { restartIfRunning?: boolean },
    ): Promise<EmbedderStatus>;

    /** Start the single eternal batch-embedding loop. Idempotent and
     * advisory-locked: concurrent/repeated calls converge on exactly one
     * running loop per schema. initialize() calls this automatically when an
     * embedding endpoint is configured. */
    startEmbedder(opts?: { intervalSeconds?: number; batch?: number }): Promise<EmbedderStatus>;

    /** Cancel the loop. No-op if already stopped. */
    stopEmbedder(reason?: string): Promise<EmbedderStatus>;

    /** Current lifecycle state. */
    embedderStatus(): Promise<EmbedderStatus>;
}

// ─── Open graph (02 §5) ──────────────────────────────────────────────────────

export interface GraphNodeInput {
    kind: string;            // free text: person, patch, file, ...
    name: string;
    aliases?: string[];      // merged into existing aliases on upsert
    evidence?: string[];     // OPTIONAL fact scope_keys; unioned on upsert (EVIDENCED_BY anchors)
    agentId: string;
}

export interface GraphEdgeInput {
    fromKey: string;         // node_key
    toKey: string;
    predicate: string;       // free text, e.g. "revives argument from"
    confidence?: number;     // 0..1, default 1.0
    evidence?: string[];     // OPTIONAL; unioned on upsert (edge provenance, property array)
    agentId: string;
    model?: string;
}

export interface GraphNodeQuery {
    kind?: string;
    nameLike?: string;       // lexical match on name/aliases (no embeddings)
    /** Fact scopeKeys OR node keys anchoring the query. Fact seeds pivot via
     * EVIDENCED_BY (inaccessible fact seeds are IGNORED — treated unknown);
     * node seeds expand directly. */
    seeds?: string[];
    depth?: number;          // hops to expand from seeds, clamped 1..5
    minConfidence?: number;
    limit?: number;
}

export interface GraphEdgeQuery {
    predicate?: string;      // EXACT text (app-owned ontology)
    predicateKey?: string;   // EXACT normalized key (preferred)
    fromKey?: string;        // anchor endpoints (explore mode)
    toKey?: string;
    minConfidence?: number;
    limit?: number;
}

export interface GraphNodeRef {
    nodeKey: string;
    kind: string;
    name: string;
    aliases: string[];
    created: boolean;
}

export interface GraphNodeHit {
    nodeKey: string;
    kind: string;
    name: string;
    aliases: string[];
    /** EVIDENCED_BY fact scopeKeys, FILTERED to caller-accessible keys. */
    evidence: string[];
    score?: number;
}

export interface GraphEdgeRef {
    fromKey: string;
    toKey: string;
    predicate: string;
    predicateKey: string;
    confidence: number;
    observations: number;
    reinforced: boolean;
}

export interface GraphEdgeHit {
    fromKey: string;
    toKey: string;
    predicate: string;
    predicateKey: string;
    confidence: number;
    observations: number;
    /** ACL-filtered, as on GraphNodeHit. */
    evidence: string[];
}

export interface SubGraph {
    nodes: { nodeKey: string; kind: string; name: string }[];
    edges: { fromKey: string; toKey: string; predicate: string; confidence: number }[];
}

export interface GraphInterface {
    // read (evidence arrays ACL-filtered; inaccessible fact seeds ignored)
    searchGraphNodes(q: GraphNodeQuery, access?: AccessContext): Promise<GraphNodeHit[]>;
    searchGraphEdges(q: GraphEdgeQuery, access?: AccessContext): Promise<GraphEdgeHit[]>;
    graphNeighbourhood(nodeKey: string, depth: number, access?: AccessContext): Promise<SubGraph>;

    // write (upsert + merge; evidence OPTIONAL, unions in; reinforcement
    // counts only novel evidence — known-evidence re-asserts are no-ops)
    upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef>;
    upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef>;
    mergeGraphNodes(fromKey: string, intoKey: string, reason: string): Promise<void>;

    // delete (no cross-store cascade)
    deleteGraphNode(nodeKey: string): Promise<boolean>;
    deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string): Promise<boolean>;
}

// ─── ACL helper (syntactic scope_key check — 01 §6.1a/§6.5) ──────────────────

/**
 * Whether a fact scope_key is readable under the given access context, decided
 * purely from the key's shape: `shared:` always passes; `session:<id>:` passes
 * iff `<id>` is the reader's or a granted session; unrestricted passes all.
 * Used to filter graph `evidence` arrays and to ignore inaccessible seeds.
 */
export function scopeKeyAccessible(scopeKey: string, access?: AccessContext): boolean {
    if (access?.unrestricted) return true;
    if (scopeKey.startsWith("shared:")) return true;
    if (scopeKey.startsWith("session:")) {
        const rest = scopeKey.slice("session:".length);
        const sessionId = rest.slice(0, rest.indexOf(":"));
        if (!sessionId) return false;
        if (access?.readerSessionId && sessionId === access.readerSessionId) return true;
        if (access?.grantedSessionIds?.includes(sessionId)) return true;
    }
    return false;
}
