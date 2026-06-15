/**
 * Graph Store — the OPTIONAL open knowledge graph contract (enhancedfactstore
 * 07 D2).
 *
 * The graph is a SEPARATE, independently injected interface — NOT part of
 * `EnhancedFactStore` and NOT a capability on the fact store. The SDK owns this
 * contract; a concrete provider (e.g. @pilotswarm/horizon-store's
 * `HorizonDBGraphStore`, AGE-backed) implements it. The runtime registers graph
 * tools iff a `graphStore` was injected (`!!graphStore`) — there is no
 * fact-store sniff.
 *
 * The graph stores ids + structure only (never fact values or ACLs). Evidence
 * scope_keys are opaque pointers; resolving them back to fact values is the
 * caller's tool-layer composition:
 *   graphStore.searchGraphNodes(...) -> scopeKeys -> factStore.readFacts({ scopeKeys })
 *
 * @module
 */

import type { AccessContext } from "./facts-store.js";

// ─── Write inputs ────────────────────────────────────────────────────────────

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

// ─── Read inputs ─────────────────────────────────────────────────────────────

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

// ─── Read outputs ────────────────────────────────────────────────────────────

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

// ─── The graph store ─────────────────────────────────────────────────────────

export interface GraphStore {
    initialize(): Promise<void>;
    close(): Promise<void>;

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

/**
 * Structural guard for the construction-time bundled-provider reuse decision
 * only (a single provider object that backs both facts and graph). Graph TOOL
 * gating is `!!graphStore` — a separate injection — never this sniff.
 */
export function isGraphStore(s: unknown): s is GraphStore {
    return typeof (s as any)?.searchGraphNodes === "function"
        && typeof (s as any)?.upsertGraphNode === "function";
}

// ─── ACL helper (syntactic scope_key check) ──────────────────────────────────

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
        // Require a real `<id>:<key>` shape; malformed keys fail closed.
        const sep = rest.indexOf(":");
        if (sep <= 0) return false;
        const sessionId = rest.slice(0, sep);
        if (access?.readerSessionId && sessionId === access.readerSessionId) return true;
        if (access?.grantedSessionIds?.includes(sessionId)) return true;
    }
    return false;
}
