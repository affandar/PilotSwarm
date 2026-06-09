// eval/tools.mjs — the LLM-facing harvester toolset (Copilot SDK defineTool).
//
// These are the tools from docs/proposals/enhancedfactstore/05-tools-spec.md,
// wired to the EnhancedFactsAdapter. Descriptions are intentionally rich: the
// eval measures whether a model can harvest correctly GIVEN this tool surface,
// so the guidance the model needs lives in the descriptions, not in the test.

import { defineTool } from "@github/copilot-sdk";

/**
 * @param {import("./store-adapter.mjs").EnhancedFactsAdapter} adapter
 * @returns {import("@github/copilot-sdk").Tool<any>[]}
 */
export function createHarvesterTools(adapter) {
    const facts_read_uncrawled = defineTool("facts_read_uncrawled", {
        description:
            "Return facts that have NOT yet been incorporated into the knowledge graph (the crawl backlog). " +
            "This is your work queue. Process each returned fact, then call facts_mark_crawled for it. " +
            "When this returns count:0 the corpus is fully harvested and you are done.",
        parameters: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Max facts to pull this batch (default 20)." },
            },
        },
        handler: async (args) => adapter.readUncrawled({ limit: args?.limit }),
    });

    const facts_mark_crawled = defineTool("facts_mark_crawled", {
        description:
            "Stamp facts as incorporated into the graph so they leave the crawl queue. " +
            "Call this AFTER you have upserted the nodes and edges derived from a fact. " +
            "Pass the exact scopeKey values from facts_read_uncrawled.",
        parameters: {
            type: "object",
            properties: {
                scopeKeys: { type: "array", items: { type: "string" }, description: "Fact scope_keys you just processed." },
            },
            required: ["scopeKeys"],
        },
        handler: async (args) => adapter.markCrawled({ scopeKeys: args?.scopeKeys ?? [] }),
    });

    const facts_search = defineTool("facts_search", {
        description:
            "Search the FACTS store and return ranked facts. This searches facts only — " +
            "it does NOT traverse the graph (use graph_search_nodes for that). " +
            "IMPORTANT: how 'query' is interpreted depends on 'mode'. " +
            "In lexical mode (the default here) 'query' is a BM25 keyword search — pass salient TERMS " +
            "(e.g. 'jsonb subscript vacuum'), NOT a natural-language sentence; extra stop-words dilute the match. " +
            "In semantic mode 'query' is natural language matched by meaning. In hybrid mode pass a short, " +
            "keyword-rich phrase used both ways.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Keywords/terms for lexical (BM25); natural language for semantic; a keyword-rich phrase for hybrid." },
                mode: { type: "string", enum: ["lexical", "semantic", "hybrid"], description: "Default lexical in this eval — so 'query' should be keywords, not a sentence." },
                limit: { type: "number", description: "Max results (default 10)." },
            },
            required: ["query"],
        },
        handler: async (args) => adapter.searchFacts({ query: args?.query, mode: args?.mode, limit: args?.limit }),
    });

    const graph_search_nodes = defineTool("graph_search_nodes", {
        description:
            "Find existing graph nodes by kind and/or nameLike (matches name OR any alias). " +
            "ALWAYS call this to RESOLVE an entity BEFORE creating it with graph_upsert_node — " +
            "this is how a new surface form like 'tgl' attaches to the existing 'Tom Lane' node " +
            "instead of creating a duplicate person. Returns matching nodes with their nodeKey.",
        parameters: {
            type: "object",
            properties: {
                kind: { type: "string", description: "Node kind filter, e.g. person, patch, code_file, thread." },
                nameLike: { type: "string", description: "Lexical match on node name or any alias." },
                seeds: { type: "array", items: { type: "string" }, description: "Optional node keys to expand from." },
                depth: { type: "number", description: "Hops to expand from seeds (1..5)." },
                limit: { type: "number", description: "Max nodes (default 20)." },
            },
        },
        handler: async (args) => adapter.searchGraphNodes(args ?? {}),
    });

    const graph_upsert_node = defineTool("graph_upsert_node", {
        description:
            "Create a graph node, or merge into an existing one (idempotent — aliases and evidence union in). " +
            "kind and name are free text. ALWAYS pass evidence: the scopeKey of the fact you are reading. " +
            "Use graph_search_nodes FIRST to avoid duplicates. Returns nodeKey (use it for edges) and created:false " +
            "when it merged into an existing node.",
        parameters: {
            type: "object",
            properties: {
                kind: { type: "string", description: "Free text: person, patch, code_file, thread, ..." },
                name: { type: "string", description: "Canonical surface form." },
                aliases: { type: "array", items: { type: "string" }, description: "Other observed surface forms." },
                evidence: { type: "array", items: { type: "string" }, description: "Fact scope_keys justifying this node." },
            },
            required: ["kind", "name"],
        },
        handler: async (args) => adapter.upsertGraphNode(args ?? {}),
    });

    const graph_upsert_edge = defineTool("graph_upsert_edge", {
        description:
            "Assert a free-text relationship between two nodes, or reinforce an existing one. " +
            "Re-stating the same (fromKey, predicate, toKey) does NOT duplicate — it strengthens the edge. " +
            "predicate is a free-text verb phrase, e.g. 'comments on', 'reviews', 'revives argument from'. " +
            "Pass the RESOLVED nodeKey values (from graph_upsert_node), not raw names. " +
            "evidence is REQUIRED: the scopeKey of the source fact.",
        parameters: {
            type: "object",
            properties: {
                fromKey: { type: "string", description: "Source node key." },
                toKey: { type: "string", description: "Target node key." },
                predicate: { type: "string", description: "Free-text verb phrase." },
                confidence: { type: "number", description: "0..1 for this observation (default 1.0)." },
                evidence: { type: "array", items: { type: "string" }, description: "Fact scope_keys justifying this edge (>=1)." },
            },
            required: ["fromKey", "toKey", "predicate", "evidence"],
        },
        handler: async (args) => adapter.upsertGraphEdge(args ?? {}),
    });

    const graph_search_edges = defineTool("graph_search_edges", {
        description:
            "Find edges by anchor (fromKey/toKey) or exact predicate. Use to inspect existing relationships " +
            "around a node before asserting new ones.",
        parameters: {
            type: "object",
            properties: {
                fromKey: { type: "string" },
                toKey: { type: "string" },
                predicate: { type: "string", description: "EXACT predicate text." },
                minConfidence: { type: "number" },
                limit: { type: "number" },
            },
        },
        handler: async (args) => adapter.searchGraphEdges(args ?? {}),
    });

    return [
        facts_read_uncrawled,
        facts_mark_crawled,
        facts_search,
        graph_search_nodes,
        graph_upsert_node,
        graph_upsert_edge,
        graph_search_edges,
    ];
}

export const HARVESTER_SYSTEM_PROMPT = [
    "You are a knowledge-graph HARVESTER for the PostgreSQL pgsql-hackers mailing list archive.",
    "Your job: read each uncrawled fact (an archived email) and incorporate it into an open knowledge graph",
    "of people, patches, code files, and threads, joined by free-text relationships.",
    "",
    "Follow this loop until facts_read_uncrawled returns count:0:",
    "  1. Call facts_read_uncrawled to get a batch of unprocessed emails.",
    "  2. For EACH email, read its body and identify entities (people, patches, code_files, threads)",
    "     and the relationships between them.",
    "  3. RESOLVE before you create: for each entity call graph_search_nodes(kind, nameLike) FIRST.",
    "     If a node already exists, reuse its nodeKey. If a sender appears by a short handle (e.g. 'tgl')",
    "     that is the same person as a full name already in the graph, upsert the node with that handle",
    "     as an alias so it MERGES — never create a second person node for the same human.",
    "  4. Create/merge each entity with graph_upsert_node, passing the email's scopeKey as evidence.",
    "  5. Assert each relationship with graph_upsert_edge using a concise lowercase free-text predicate,",
    "     passing the resolved nodeKeys and the email's scopeKey as evidence.",
    "     Use the predicate 'comments on' when a person comments on a patch, and 'reviews' when a person",
    "     reviews a patch, so repeated observations reinforce the same edge.",
    "  6. Call facts_mark_crawled with the email's scopeKey.",
    "",
    "Always pass evidence (the source email scopeKey) on every node and edge. Keep predicates short.",
    "When the queue is empty, reply with a one-line summary of what you built.",
].join("\n");
