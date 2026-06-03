// @incubator/horizon-facts — optional agent tools.
//
// The enhanced store can OPTIONALLY inject additional tools into an agent's
// toolset. These wrap the additive retrieval + open-graph methods so an agent
// can search facts semantically and harvest the open graph. They are plain,
// host-agnostic descriptors (name + JSON-schema parameters + handler) that map
// directly onto PilotSwarm's defineTool() shape — spread them into
// worker.registerTools([...]) or a session's tools.
//
// Nothing here is required for the drop-in FactStore behavior; an app opts in.

import type {
    AccessContext, EnhancedFactStore, GraphCrawlerInterface, SearchOpts,
} from "./types.js";

export interface AgentTool {
    name: string;
    description: string;
    /** JSON Schema for the tool arguments. */
    parameters: Record<string, unknown>;
    handler: (args: any) => Promise<unknown>;
}

export interface FactsToolsOptions {
    /** Retrieval tools (search_facts, related_facts). Default true. */
    retrieval?: boolean;
    /** Open-graph read tools (entities, neighbourhood, relationships). Default true. */
    graphRead?: boolean;
    /** Open-graph write/harvest tools (upsert_entity, assert_relationship, link_evidence). Default false. */
    graphWrite?: boolean;
    /** Tool name prefix to avoid collisions with SDK built-ins. Default "facts_". */
    prefix?: string;
    /**
     * Access context resolver. Given the tool-call context, return the ACL
     * context for the query. Default: unrestricted (suitable for trusted
     * single-tenant harvesting agents). Override for multi-tenant sessions.
     */
    resolveAccess?: (ctx: any) => AccessContext;
}

type Store = EnhancedFactStore & GraphCrawlerInterface;

/**
 * Build the optional agent toolset for a HorizonFactStore. Returns an array of
 * AgentTool descriptors; the caller decides where to register them.
 */
export function createFactsTools(store: Store, opts: FactsToolsOptions = {}): AgentTool[] {
    const prefix = opts.prefix ?? "facts_";
    const access = opts.resolveAccess ?? (() => ({ unrestricted: true }));
    const retrieval = opts.retrieval ?? true;
    const graphRead = opts.graphRead ?? true;
    const graphWrite = opts.graphWrite ?? false;
    const tools: AgentTool[] = [];

    if (retrieval) {
        tools.push({
            name: `${prefix}search`,
            description: "Search facts across lexical, semantic, and graph signals. Returns ranked facts.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Natural-language search query." },
                    mode: { type: "string", enum: ["lexical", "semantic", "graph", "hybrid"], description: "Default hybrid." },
                    namespace: { type: "string", description: "Optional key-prefix namespace (e.g. skills)." },
                    limit: { type: "number", description: "Max results (default 20)." },
                },
                required: ["query"],
            },
            handler: async (a) => {
                const o: SearchOpts = { mode: a.mode, namespace: a.namespace, limit: a.limit };
                return store.searchFacts(a.query, o, access(a));
            },
        });
        tools.push({
            name: `${prefix}related`,
            description: "Find facts semantically related to a known fact (by scope_key).",
            parameters: {
                type: "object",
                properties: {
                    scopeKey: { type: "string", description: "scope_key of the anchor fact." },
                    k: { type: "number", description: "Top-k neighbours (default 8)." },
                },
                required: ["scopeKey"],
            },
            handler: (a) => store.relatedFacts(a.scopeKey, { k: a.k }, access(a)),
        });
    }

    if (graphRead) {
        tools.push({
            name: `${prefix}graph_search_entities`,
            description: "Find graph entities by kind and/or name (anchor discovery).",
            parameters: {
                type: "object",
                properties: {
                    kind: { type: "string" }, nameLike: { type: "string" }, limit: { type: "number" },
                },
            },
            handler: (a) => store.searchEntities({ kind: a.kind, nameLike: a.nameLike, limit: a.limit }),
        });
        tools.push({
            name: `${prefix}graph_neighbourhood`,
            description: "Explore the edges around an entity to discover which predicates exist (anchor-and-explore).",
            parameters: {
                type: "object",
                properties: { entityKey: { type: "string" }, depth: { type: "number", description: "1..5" } },
                required: ["entityKey"],
            },
            handler: (a) => store.neighbourhood(a.entityKey, a.depth ?? 1),
        });
        tools.push({
            name: `${prefix}graph_search_relationships`,
            description: "Query relationships by EXACT predicate (agent-owned ontology) and/or endpoints.",
            parameters: {
                type: "object",
                properties: {
                    predicate: { type: "string" }, predicateKey: { type: "string" },
                    fromKey: { type: "string" }, toKey: { type: "string" },
                    minConfidence: { type: "number" }, limit: { type: "number" },
                },
            },
            handler: (a) => store.searchRelationships(a),
        });
    }

    if (graphWrite) {
        tools.push({
            name: `${prefix}graph_upsert_entity`,
            description: "Create or reuse a graph entity (search-first dedup by canonical key).",
            parameters: {
                type: "object",
                properties: {
                    kind: { type: "string" }, name: { type: "string" },
                    aliases: { type: "array", items: { type: "string" } },
                    agentId: { type: "string" },
                },
                required: ["kind", "name", "agentId"],
            },
            handler: (a) => store.upsertEntity(a),
        });
        tools.push({
            name: `${prefix}graph_assert_relationship`,
            description: "Assert a free-text relationship with MANDATORY evidence (fact scope_keys). Reinforces if it exists.",
            parameters: {
                type: "object",
                properties: {
                    fromKey: { type: "string" }, toKey: { type: "string" },
                    predicate: { type: "string", description: "Free text, e.g. 'revives argument from'." },
                    confidence: { type: "number", description: "0..1 for this observation." },
                    evidence: { type: "array", items: { type: "string" }, description: "≥1 fact scope_key. Required." },
                    agentId: { type: "string" }, model: { type: "string" },
                },
                required: ["fromKey", "toKey", "predicate", "confidence", "evidence", "agentId"],
            },
            handler: (a) => store.assertRelationship(a),
        });
        tools.push({
            name: `${prefix}graph_link_evidence`,
            description: "Attach evidence facts (scope_keys) to an entity or edge.",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string", description: "entity_key (or edge key)." },
                    factScopeKeys: { type: "array", items: { type: "string" } },
                },
                required: ["key", "factScopeKeys"],
            },
            handler: (a) => store.linkEvidence(a.key, a.factScopeKeys),
        });
    }

    return tools;
}
