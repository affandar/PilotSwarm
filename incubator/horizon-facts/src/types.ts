// @incubator/horizon-facts — type contracts for the enhanced facts interface.
//
// This mirrors the shape of PilotSwarm's FactStore so the enhanced store can be
// a drop-in superset later. It is intentionally self-contained (no PilotSwarm
// imports) while incubating.

// ─── Base facts shapes (mirrors PilotSwarm FactStore, kept local) ───────────

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

/** Carried verbatim from PilotSwarm: how visibility is resolved in the proc. */
export interface AccessContext {
    readerSessionId?: string | null;
    grantedSessionIds?: string[];
    unrestricted?: boolean;
}

/**
 * The current PilotSwarm Facts Store API, mirrored verbatim so EnhancedFactStore
 * is a true superset. An adapter that implements EnhancedFactStore can be dropped
 * in wherever a FactStore is expected today.
 */
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

// ─── Enhanced retrieval shapes ──────────────────────────────────────────────

export type SearchMode = "lexical" | "semantic" | "graph" | "hybrid";

/** Relative weights for hybrid fusion. Missing signals contribute 0. */
export interface SearchWeights {
    lexical?: number;
    semantic?: number;
    graph?: number;
}

export interface SearchOpts {
    mode?: SearchMode;          // default "hybrid"
    scope?: ReadFactsQuery["scope"];
    namespace?: string;         // e.g. "skills" — maps to key prefix filter
    tags?: string[];
    limit?: number;             // default 20
    /** Candidate pool size per signal before fusion (default 50). */
    candidatePool?: number;
    weights?: SearchWeights;    // default { lexical: 1, semantic: 1, graph: 0.5 }
    /** Minimum cosine similarity for semantic candidates (0..1). */
    minSemanticScore?: number;
}

export interface RelatedOpts {
    k?: number;                 // top-k neighbours (default 8)
    minScore?: number;          // default 0.75
    namespace?: string;
}

export interface LineageOpts {
    query?: string;             // optional relevance ranking within the lineage
    mode?: SearchMode;          // how to rank within lineage (default "hybrid")
    limit?: number;
    /** Graph traversal direction across SPAWNED edges. */
    direction?: "ancestors" | "descendants" | "both"; // default "both"
}

/** One fused, ACL-resolved hit. */
export interface ScoredFact extends FactRecord {
    /** Final fused score (higher = better). */
    score: number;
    /** Per-signal contributions, for debugging/tuning fusion. */
    signals: {
        lexical?: number;
        semantic?: number;
        graph?: number;
    };
}

export interface SearchResult {
    count: number;
    mode: SearchMode;
    facts: ScoredFact[];
}

// ─── The enhanced store ─────────────────────────────────────────────────────

export interface EnhancedFactStore extends FactStore {
    // Inherits the full current Facts Store API from FactStore (storeFact,
    // readFacts, deleteFact, stats, …). The three methods below are additive
    // retrieval modes; nothing in the base API changes.

    /** Unified retrieval across lexical / semantic / graph signals. */
    searchFacts(query: string, opts: SearchOpts, access: AccessContext): Promise<SearchResult>;

    /** Semantic neighbours of a known fact via RELATED_TO, ACL-filtered. */
    relatedFacts(scopeKey: string, opts: RelatedOpts, access: AccessContext): Promise<SearchResult>;

    /** Lineage-scoped retrieval over the spawn tree (AGE), then ACL-filtered. */
    lineageFacts(sessionId: string, opts: LineageOpts, access: AccessContext): Promise<SearchResult>;
}

// ─── Open graph crawler interface (see CRAWLER.md) ──────────────────────────
//
// An LLM harvesting agent discovers entities and asserts free-form relationships
// with NO fixed ontology. The interface bakes in "search → resolve → assert"
// and enforces mandatory provenance so the open graph stays trustworthy.

/** A node minted by the crawler. `kind` is free text (person, patch, file, …). */
export interface EntityAssertion {
    kind: string;
    name: string;
    /** Surface forms observed for this entity (merged into aliases). */
    aliases?: string[];
    /** Facts that justify this entity's existence. */
    evidence?: string[];   // Fact scope_keys
    agentId: string;
}

export interface EntityRef {
    entityKey: string;     // canonical <kind>:<normalized-name>
    kind: string;
    name: string;
    aliases: string[];
    created: boolean;      // true if newly created, false if merged into existing
}

/** A free-form relationship. `predicate` is invented by the LLM, not enumerated. */
export interface RelAssertion {
    fromKey: string;       // entity_key OR Fact scope_key
    toKey: string;
    predicate: string;     // verbatim free text, e.g. "revives argument from"
    confidence: number;    // 0..1 for this single observation
    evidence: string[];    // REQUIRED, ≥1 Fact scope_key — no evidence ⇒ rejected
    agentId: string;
    model?: string;
}

export interface RelRef {
    fromKey: string;
    toKey: string;
    predicate: string;
    predicateKey: string;  // normalized grouping key
    confidence: number;    // combined across observations (noisy-OR)
    observations: number;
    reinforced: boolean;   // true if an existing edge was reinforced
}

export interface EntityQuery {
    kind?: string;
    /** Matches name or any alias (lexical). Used to find an anchor node. */
    nameLike?: string;
    limit?: number;
}

export interface EntityHit {
    entityKey: string;
    kind: string;
    name: string;
    aliases: string[];
    score?: number;
}

// Relationships are queried in exactly two ways (no fuzzy/semantic predicate
// matching — see CRAWLER.md §7):
//
//   1. ANCHOR-AND-EXPLORE — start from a node found by other means (fact search
//      → entity), then read its edges and discover which predicates exist.
//      Done via neighbourhood() or RelQuery with fromKey/toKey set.
//
//   2. EXACT-PREDICATE — the calling agent already knows the predicate name from
//      its OWN agreed-upon ontology (maintained in the agent layer, not here)
//      and queries that exact edge type. Done via RelQuery.predicate /
//      predicateKey. Match is exact equality, not LIKE.
export interface RelQuery {
    /** EXACT predicate text, e.g. "revives argument from" (agent-owned ontology). */
    predicate?: string;
    /** EXACT normalized predicate key, e.g. "revive_argument" (preferred, surface-stable). */
    predicateKey?: string;
    /** ANCHOR endpoints — set one or both to explore edges around a known node. */
    fromKey?: string;
    toKey?: string;
    minConfidence?: number;
    limit?: number;
}

export interface RelHit {
    fromKey: string;
    toKey: string;
    predicate: string;
    predicateKey: string;
    confidence: number;
    observations: number;
    evidence: string[];
}

export interface SubGraphNode {
    entityKey: string;
    kind: string;
    name: string;
}

export interface SubGraphEdge {
    fromKey: string;
    toKey: string;
    predicate: string;
    confidence: number;
}

export interface SubGraph {
    nodes: SubGraphNode[];
    edges: SubGraphEdge[];
}

export interface GraphCrawlerInterface {
    // search / query — two modes only:
    //   anchor-and-explore : searchEntities → neighbourhood (discover predicates)
    //   exact-predicate    : searchRelationships({ predicate | predicateKey })
    searchEntities(q: EntityQuery): Promise<EntityHit[]>;
    searchRelationships(q: RelQuery): Promise<RelHit[]>;
    neighbourhood(entityKey: string, depth: number): Promise<SubGraph>;

    // assert (provenance mandatory)
    upsertEntity(e: EntityAssertion): Promise<EntityRef>;
    assertRelationship(r: RelAssertion): Promise<RelRef>;
    linkEvidence(nodeOrEdgeKey: string, factScopeKeys: string[]): Promise<void>;
    mergeEntities(fromKey: string, intoKey: string, reason: string): Promise<void>;
}
