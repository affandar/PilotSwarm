// pilotswarm-horizon-store — type contracts.
//
// These contracts are OWNED BY THE SDK (`pilotswarm-sdk`, enhancedfactstore 07
// P1). This module re-exports them so the provider's own files keep importing
// from a single local `./types.js` while the DEFINITIONS live in the SDK. The
// provider IMPLEMENTS these contracts; it does not define them.
//
// Type-only re-exports (no runtime cost; no import cycle — the SDK does not
// depend on this package).

export type {
    // base facts
    FactRecord,
    StoreFactInput,
    StoredFactResult,
    ReadFactsQuery,
    DeleteFactInput,
    DeletedFactResult,
    DeletedFactsResult,
    FactsNamespace,
    FactsStatsRow,
    FactsTombstoneStats,
    ForcePurgeFactsInput,
    AccessContext,
    FactStore,
    SetFactsCrawledInput,
    SetFactsCrawledScopeKey,
    // enhanced retrieval + embedder
    EnhancedFactStore,
    FactsCapabilities,
    SearchMode,
    SearchWeights,
    SearchOpts,
    SimilarOpts,
    ScoredFact,
    SearchResult,
    EmbedderStatus,
    EmbedderLoopStatus,
    EmbeddingEndpointConfig,
    // graph
    GraphStore,
    GraphNodeInput,
    GraphEdgeInput,
    GraphNamespaceQuery,
    GraphNodeQuery,
    GraphEdgeQuery,
    GraphNodeRef,
    GraphNodeHit,
    GraphEdgeRef,
    GraphEdgeHit,
    GraphEvidenceRemovalResult,
    SubGraph,
    // graph namespace registry
    GraphNamespaceFrontmatter,
    GraphNamespaceInfo,
    GraphNamespaceInput,
    GraphNamespaceListQuery,
    GraphNamespaceDeleteResult,
} from "pilotswarm-sdk";

// scopeKeyAccessible is a tiny pure helper. We keep a provider-LOCAL copy rather
// than re-export it from "pilotswarm-sdk" at RUNTIME: the SDK's barrel
// (pilotswarm-sdk/index) pulls in the worker/client/duroxide/pg module graph, and
// a runtime re-export would drag all of that into this provider's runtime (whose
// only runtime dep is `pg`). Type-only imports above are erased and cost nothing.
import type { AccessContext } from "pilotswarm-sdk";

/**
 * Whether a fact scope_key is readable under the given access context, decided
 * purely from the key's shape: `shared:` always passes; `session:<id>:` passes
 * iff `<id>` is the reader's or a granted session; unrestricted passes all.
 * Malformed `session:` keys fail closed. (Mirror of the SDK helper; kept local
 * to avoid a runtime dependency on the SDK barrel.)
 */
export function scopeKeyAccessible(scopeKey: string, access?: AccessContext): boolean {
    if (access?.unrestricted) return true;
    if (scopeKey.startsWith("shared:")) return true;
    if (scopeKey.startsWith("session:")) {
        const rest = scopeKey.slice("session:".length);
        const sep = rest.indexOf(":");
        if (sep <= 0) return false;
        const sessionId = rest.slice(0, sep);
        if (access?.readerSessionId && sessionId === access.readerSessionId) return true;
        if (access?.grantedSessionIds?.includes(sessionId)) return true;
    }
    return false;
}

/**
 * @deprecated The graph is its own interface `GraphStore` (07 D2). Alias kept
 * for the provider's internal back-compat; prefer `GraphStore`.
 */
export type { GraphStore as GraphInterface } from "pilotswarm-sdk";
