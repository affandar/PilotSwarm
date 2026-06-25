// pilotswarm-horizon-store — LLM-facing agent tools (05-tools-spec).
//
// Tool names and contracts follow docs/proposals/enhancedfactstore/05-tools-spec.md
// exactly: `facts_*` over the facts store, `graph_*` over the open graph. Two
// role bundles over the same corpus:
//
//   READER    — facts_search / facts_similar / facts_read + the graph READ tools.
//   HARVESTER — everything the reader gets, plus the PRIVILEGED crawl-queue
//               tools (facts_read_uncrawled / facts_set_crawled) and the graph
//               WRITE tools. Crawling sees ALL facts across scopes by design
//               (01 §6.6); only grant this bundle to the trusted harvester role.
//
// Descriptors are host-agnostic (name + JSON-schema + handler), mapping onto
// PilotSwarm's defineTool() shape.

import type {
    AccessContext, GraphStore, SearchOpts,
} from "./types.js";
import type { HorizonDBFactStore } from "./horizon-store.js";

export interface AgentTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (args: any) => Promise<unknown>;
}

export type Role = "reader" | "harvester";

export interface FactsToolsOptions {
    /** Which bundle to build. Default "reader". */
    role?: Role;
    /**
     * Access context resolver for the READER-scoped tools. Default:
     * unrestricted (single-tenant). Override for multi-tenant sessions.
     * The crawl-queue tools never use it — they are privileged by contract.
     */
    resolveAccess?: (args: any) => AccessContext;
    /** Agent identity recorded on graph writes. Default "harvester". */
    agentId?: string;
    /**
     * When true, the privileged `facts_read_uncrawled` queue tool only returns
     * facts that already have an embedding; un-embedded facts are skipped this
     * turn and reappear once the in-DB embed loop catches up. This is a HARVEST
     * POLICY set by the host (not an LLM-controlled argument): enable it when
     * embeddings are configured so the harvester can similarity-refine the
     * graph from each fact's stored vector.
     */
    embeddedOnly?: boolean;
}

export function createFactsTools(
    factStore: HorizonDBFactStore,
    graphStore: GraphStore | undefined,
    opts: FactsToolsOptions = {},
): AgentTool[] {
    const role = opts.role ?? "reader";
    const access = opts.resolveAccess ?? (() => ({ unrestricted: true }));
    const agentId = opts.agentId ?? "harvester";
    const embeddedOnly = opts.embeddedOnly ?? false;
    const tools: AgentTool[] = [];

    // ── §1 retrieval (reader + harvester) ────────────────────────────────────

    tools.push({
        name: "facts_search",
        description:
            "Search facts by a query over the FACTS STORE ONLY. The query shape depends on mode: " +
            "lexical = BM25 — pass KEYWORDS/terms, not a sentence; semantic = natural language (embedded); " +
            "hybrid = a short keyword-rich phrase, used both ways. There is NO graph mode — use graph_search_nodes. " +
            "Returned scopeKey values are the natural seeds for graph_search_nodes.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Keywords for lexical, natural language for semantic, keyword-rich phrase for hybrid." },
                mode: { type: "string", enum: ["lexical", "semantic", "hybrid"], description: "Default hybrid." },
                namespace: { type: "string", description: "Key-prefix filter, e.g. 'archive/pgsql-hackers'." },
                tags: { type: "array", items: { type: "string" }, description: "Restrict to facts carrying all these tags." },
                limit: { type: "number", description: "Max results (default 20)." },
            },
            required: ["query"],
        },
        handler: (a) => {
            const o: SearchOpts = { mode: a.mode, namespace: a.namespace, tags: a.tags, limit: a.limit };
            return factStore.searchFacts(a.query, o, access(a));
        },
    });

    tools.push({
        name: "facts_similar",
        description:
            "Given a fact you already have, return the semantically nearest other facts " +
            "(vector kNN over the fact's stored embedding — no query text, no re-embedding). Anchor excluded.",
        parameters: {
            type: "object",
            properties: {
                scopeKey: { type: "string", description: "The anchor fact's scope_key." },
                k: { type: "number", description: "Top-k neighbours (default 8)." },
                minScore: { type: "number", description: "Drop neighbours below this cosine score (0..1)." },
            },
            required: ["scopeKey"],
        },
        handler: (a) => factStore.similarFacts(a.scopeKey, { k: a.k, minScore: a.minScore }, access(a)),
    });

    tools.push({
        name: "facts_read",
        description:
            "Read facts directly by key/scopeKeys/tags/scope — no ranking. Use scopeKeys to resolve the " +
            "evidence arrays returned by graph tools back into facts. scope: 'descendants' reads the spawn-tree (lineage).",
        parameters: {
            type: "object",
            properties: {
                keyPattern: { type: "string", description: "Key prefix/pattern filter." },
                scopeKeys: { type: "array", items: { type: "string" }, description: "Explicit fact scope_keys (e.g. graph evidence). Inaccessible/unknown keys are silently omitted." },
                tags: { type: "array", items: { type: "string" } },
                scope: { type: "string", enum: ["accessible", "shared", "session", "descendants"], description: "Default accessible." },
                limit: { type: "number" },
            },
        },
        handler: (a) => factStore.readFacts(
            { keyPattern: a.keyPattern, scopeKeys: a.scopeKeys, tags: a.tags, scope: a.scope, limit: a.limit },
            access(a)),
    });

    // ── §3 graph read (reader + harvester) — only when a graph is configured ──

    if (graphStore) {
    tools.push({
        name: "graph_search_nodes",
        description:
            "Find / expand graph nodes. RESOLVE step (does this entity exist? — use kind + nameLike before every " +
            "create) and PIVOT step (seeds = fact scope_keys from facts_search pivot via EVIDENCED_BY; node keys " +
            "expand directly; depth bounds the hops). Each hit carries its EVIDENCED_BY fact scope_keys — feed " +
            "evidence straight into facts_read.",
        parameters: {
            type: "object",
            properties: {
                kind: { type: "string", description: "Free-text node kind filter ('person', 'patch', …)." },
                nameLike: { type: "string", description: "Lexical match on node name or any alias. The resolve key." },
                seeds: { type: "array", items: { type: "string" }, description: "Fact scope_keys OR node keys to anchor from." },
                depth: { type: "number", description: "Hops to expand from seeds (1..5)." },
                limit: { type: "number" },
            },
        },
        handler: (a) => graphStore!.searchGraphNodes(
            { kind: a.kind, nameLike: a.nameLike, seeds: a.seeds, depth: a.depth, limit: a.limit },
            access(a)),
    });

    tools.push({
        name: "graph_search_edges",
        description:
            "Find edges, two ways only: anchor-and-explore (set fromKey and/or toKey) or exact-predicate " +
            "(predicate/predicateKey, exact equality — no fuzzy match).",
        parameters: {
            type: "object",
            properties: {
                predicate: { type: "string", description: "EXACT predicate text." },
                predicateKey: { type: "string", description: "EXACT normalized key (preferred, surface-stable)." },
                fromKey: { type: "string" },
                toKey: { type: "string" },
                minConfidence: { type: "number" },
                limit: { type: "number" },
            },
        },
        handler: (a) => graphStore!.searchGraphEdges(a, access(a)),
    });

    tools.push({
        name: "graph_neighbourhood",
        description: "Bounded subgraph around a node — 'show me everything connected to X'.",
        parameters: {
            type: "object",
            properties: {
                nodeKey: { type: "string" },
                depth: { type: "number", description: "Hops (clamped 1..5)." },
            },
            required: ["nodeKey", "depth"],
        },
        handler: (a) => graphStore!.graphNeighbourhood(a.nodeKey, a.depth, access(a)),
    });
    }

    if (role !== "harvester") return tools;

    // Crawl-queue + graph-write are harvester tools that only make sense with a
    // graph to harvest into (07 §1.5) — gate them on graphStore presence.
    if (graphStore) {

    // ── §2 crawl queue (HARVESTER ONLY — privileged, all scopes) ─────────────

    tools.push({
        name: "facts_read_uncrawled",
        description:
            "PRIVILEGED work queue: facts not yet incorporated into the graph (new or edited since last crawl), " +
            "across ALL scopes. Keep each fact's scopeKey and etag — both are the receipt facts_set_crawled needs.",
        parameters: {
            type: "object",
            properties: {
                keyPrefix: { type: "string", description: "Restrict the queue to a literal key prefix (a crawler may reuse its graph namespace as this prefix)." },
                namespace: { type: "string", description: "Deprecated alias for keyPrefix (accepted one release for existing prompts)." },
                limit: { type: "number", description: "Max facts this batch (default 20, capped at 500)." },
            },
        },
        handler: (a) => factStore.readUncrawledFacts({ keyPrefix: a.keyPrefix ?? a.namespace, limit: a.limit, embeddedOnly }),
    });

    tools.push({
        name: "facts_set_crawled",
        description:
            "Set the crawled flag on a selection of facts. Provide EXACTLY one of: " +
            "`scopeKeys` — after processing rows from facts_read_uncrawled, pass each row's { scopeKey, etag } " +
            "(include etag to make the entry conditional/race-safe, or omit it entirely — not null — to force/stomp); or " +
            "`keyPrefix` — flip a whole literal key prefix at once (coarse, no per-row etag). " +
            "Set `crawled:false` to put facts BACK on the radar for recrawl (e.g. after changing extraction logic). " +
            "A skipped entry means the fact changed since your read (etag mismatch) or was already in that state; " +
            "a scopeKey that no longer exists is neither marked nor skipped.",
        parameters: {
            type: "object",
            properties: {
                scopeKeys: {
                    type: "array",
                    description: "Explicit batch (max 500) of { scopeKey, etag? } receipts from facts_read_uncrawled.",
                    minItems: 1,
                    maxItems: 500,
                    items: {
                        type: "object",
                        properties: {
                            scopeKey: { type: "string" },
                            etag: { type: "number" },
                        },
                        required: ["scopeKey"],
                    },
                },
                keyPrefix: { type: "string", description: "Literal key prefix to flip in one shot (coarse; no per-row etag)." },
                crawled: { type: "boolean", description: "Default true. false clears the flag to trigger a recrawl." },
            },
        },
        handler: (a) => factStore.setFactsCrawled({ scopeKeys: a.scopeKeys, keyPrefix: a.keyPrefix, crawled: a.crawled }),
    });

    tools.push({
        name: "graph_remove_evidence",
        description:
            "Reconcile a soft-deleted fact with the graph: remove this fact scopeKey from node EVIDENCED_BY anchors " +
            "and edge evidence arrays, deleting graph nodes/edges that become evidence-less. Call this for " +
            "facts_read_uncrawled rows where deletedAt/deleted_at is set, then mark the fact crawled with its scopeKey and etag.",
        parameters: {
            type: "object",
            properties: {
                scopeKey: { type: "string", description: "Deleted fact scopeKey from facts_read_uncrawled." },
                namespace: { type: "string", description: "Optional graph namespace guard." },
            },
            required: ["scopeKey"],
        },
        handler: (a) => graphStore.removeGraphEvidence(a.scopeKey, { namespace: a.namespace }),
    });

    // ── §4 graph write (HARVESTER ONLY) ──────────────────────────────────────

    tools.push({
        name: "graph_upsert_node",
        description:
            "Create a node, or merge into an existing one (idempotent; aliases and evidence union in). " +
            "RESOLVE BEFORE YOU CREATE: graph_search_nodes by nameLike first. Evidence is optional in the " +
            "contract, but pass the source fact's scope_key — it is the provenance, and what makes " +
            "reinforcement dedup work. The graph is SHARED: anything you incorporate is visible to every reader.",
        parameters: {
            type: "object",
            properties: {
                kind: { type: "string", description: "Free text: person, patch, code_file, thread…" },
                name: { type: "string", description: "Canonical surface form." },
                aliases: { type: "array", items: { type: "string" }, description: "Other observed surface forms." },
                evidence: { type: "array", items: { type: "string" }, description: "Fact scope_keys justifying this node. Pass the source fact." },
            },
            required: ["kind", "name"],
        },
        handler: (a) => graphStore!.upsertGraphNode({ ...a, agentId }),
    });

    tools.push({
        name: "graph_upsert_edge",
        description:
            "Assert a free-text relationship, or reinforce an existing one. Re-stating the same " +
            "(fromKey, predicate, toKey) does not duplicate — it bumps observations and combines confidence " +
            "(noisy-OR) ONLY when you bring new evidence; same-evidence replays are harmless no-ops. " +
            "Pass RESOLVED nodeKeys, not raw names. One verb per relationship.",
        parameters: {
            type: "object",
            properties: {
                fromKey: { type: "string", description: "Source node key (from graph_upsert_node / graph_search_nodes)." },
                toKey: { type: "string", description: "Target node key." },
                predicate: { type: "string", description: "Free-text verb, e.g. 'revives argument from'." },
                confidence: { type: "number", description: "0..1 for THIS observation (default 1.0)." },
                evidence: { type: "array", items: { type: "string" }, description: "Fact scope_keys justifying the edge. Pass the source fact." },
            },
            required: ["fromKey", "toKey", "predicate"],
        },
        handler: (a) => graphStore!.upsertGraphEdge({ ...a, agentId }),
    });

    tools.push({
        name: "graph_merge_nodes",
        description:
            "Entity resolution: fold a duplicate node into the survivor (union aliases, repoint edges, delete " +
            "the duplicate). Use when you discover two nodes are the same entity after the fact.",
        parameters: {
            type: "object",
            properties: {
                fromKey: { type: "string", description: "Duplicate to remove." },
                intoKey: { type: "string", description: "Survivor to keep." },
                reason: { type: "string", description: "Why they're the same (audit)." },
            },
            required: ["fromKey", "intoKey", "reason"],
        },
        handler: async (a) => { await graphStore!.mergeGraphNodes(a.fromKey, a.intoKey, a.reason); return { merged: true }; },
    });

    tools.push({
        name: "graph_delete_node",
        description: "Remove a node and all its edges (DETACH DELETE). No cascade to facts.",
        parameters: {
            type: "object",
            properties: { nodeKey: { type: "string" } },
            required: ["nodeKey"],
        },
        handler: async (a) => ({ deleted: await graphStore!.deleteGraphNode(a.nodeKey) }),
    });

    tools.push({
        name: "graph_delete_edge",
        description: "Remove one exact edge triple. Returns whether something matched.",
        parameters: {
            type: "object",
            properties: {
                fromKey: { type: "string" },
                toKey: { type: "string" },
                predicateKey: { type: "string" },
            },
            required: ["fromKey", "toKey", "predicateKey"],
        },
        handler: async (a) => ({ deleted: await graphStore!.deleteGraphEdge(a.fromKey, a.toKey, a.predicateKey) }),
    });
    }

    return tools;
}
