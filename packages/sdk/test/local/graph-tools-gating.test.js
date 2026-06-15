/**
 * P4 (enhancedfactstore): graph + enhanced facts tool registration, gated by
 * capability × role. DB-less — exercises the tool factories directly with fake
 * stores, asserting which tools each (capability, role) combination yields.
 */

import { describe, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createFactTools, createGraphTools } from "../../src/index.ts";

// Minimal fakes — the factories only read `.capabilities` and call methods on
// demand; registration itself does no I/O.
function fakeEnhancedStore(caps = { search: true, embedder: true }) {
    return {
        capabilities: caps,
        searchFacts: async () => ({ count: 0, mode: "hybrid", facts: [] }),
        similarFacts: async () => ({ count: 0, mode: "semantic", facts: [] }),
        configureEmbedder: async () => ({ running: false }),
        startEmbedder: async () => ({ running: true }),
        stopEmbedder: async () => ({ running: false }),
        embedderStatus: async () => ({ running: false }),
        // base FactStore surface (unused here)
        storeFact: async () => ({}), readFacts: async () => ({ count: 0, facts: [] }),
        deleteFact: async () => ({}), deleteSessionFactsForSession: async () => 0,
        getSessionFactsStats: async () => [], getFactsStatsForSessions: async () => [],
        getSharedFactsStats: async () => [], readUncrawledFacts: async () => ({ count: 0, facts: [] }),
        markFactsCrawled: async () => ({ marked: 0, skipped: 0 }), initialize: async () => {}, close: async () => {},
    };
}
function fakeBaseStore() {
    return {
        storeFact: async () => ({}), readFacts: async () => ({ count: 0, facts: [] }),
        deleteFact: async () => ({}), deleteSessionFactsForSession: async () => 0,
        getSessionFactsStats: async () => [], getFactsStatsForSessions: async () => [],
        getSharedFactsStats: async () => [], readUncrawledFacts: async () => ({ count: 0, facts: [] }),
        markFactsCrawled: async () => ({ marked: 0, skipped: 0 }), initialize: async () => {}, close: async () => {},
    };
}
function fakeGraphStore() {
    return {
        initialize: async () => {}, close: async () => {},
        searchGraphNodes: async () => [], searchGraphEdges: async () => [],
        graphNeighbourhood: async () => ({ nodes: [], edges: [] }),
        upsertGraphNode: async () => ({}), upsertGraphEdge: async () => ({}),
        mergeGraphNodes: async () => {}, deleteGraphNode: async () => true, deleteGraphEdge: async () => true,
    };
}

const names = (tools) => new Set(tools.map((t) => t.name));

describe("P4: enhanced facts tool gating (createFactTools)", () => {
    it("base store → only store_fact/read_facts/delete_fact (no search tools)", () => {
        const n = names(createFactTools({ factStore: fakeBaseStore() }));
        assert(n.has("store_fact") && n.has("read_facts") && n.has("delete_fact"), "base KV tools present");
        assert(!n.has("facts_search") && !n.has("facts_similar") && !n.has("search_skills"), "no search tools on base store");
    });

    it("enhanced store (caps.search) → adds facts_search/facts_similar/search_skills", () => {
        const enh = fakeEnhancedStore();
        const n = names(createFactTools({ factStore: enh, enhancedFactStore: enh }));
        assert(n.has("facts_search") && n.has("facts_similar"), "search tools present");
        assert(n.has("search_skills"), "search_skills present for a normal agent");
    });

    it("enhanced store but caps.search=false → no search tools", () => {
        const enh = fakeEnhancedStore({ search: false, embedder: true });
        const n = names(createFactTools({ factStore: enh, enhancedFactStore: enh }));
        assert(!n.has("facts_search") && !n.has("search_skills"), "search tools gated off when caps.search=false");
    });

    it("facts-manager → gets facts_search but NOT search_skills (owns the namespace)", () => {
        const enh = fakeEnhancedStore();
        const n = names(createFactTools({ factStore: enh, enhancedFactStore: enh, agentIdentity: "facts-manager" }));
        assert(n.has("facts_search"), "facts-manager gets facts_search");
        assert(!n.has("search_skills"), "facts-manager does NOT get search_skills");
    });
});

describe("P4: graph tool gating (createGraphTools)", () => {
    const base = () => ({ graphStore: fakeGraphStore(), factStore: fakeBaseStore() });

    it("reader (no harvester role) → read tools only, no write/crawl/stats", () => {
        const n = names(createGraphTools({ ...base(), agentIdentity: "default" }));
        assert(n.has("graph_search_nodes") && n.has("graph_search_edges") && n.has("graph_neighbourhood"), "graph read tools present");
        assert(!n.has("graph_upsert_node") && !n.has("graph_delete_node"), "no write/delete for a reader");
        assert(!n.has("facts_read_uncrawled") && !n.has("facts_mark_crawled"), "no crawl queue for a reader");
        assert(!n.has("graph_stats"), "no graph_stats for an ordinary reader");
    });

    it("harvester role → read + crawl-queue + write/delete", () => {
        const n = names(createGraphTools({ ...base(), agentIdentity: "app-harvester", isHarvester: true }));
        assert(n.has("graph_search_nodes"), "reads present");
        assert(n.has("facts_read_uncrawled") && n.has("facts_mark_crawled"), "crawl queue present for harvester");
        assert(n.has("graph_upsert_node") && n.has("graph_upsert_edge") && n.has("graph_merge_nodes")
            && n.has("graph_delete_node") && n.has("graph_delete_edge"), "graph write/delete present for harvester");
    });

    it("facts-manager → harvester tools (dormant) + graph_stats", () => {
        const n = names(createGraphTools({ ...base(), agentIdentity: "facts-manager" }));
        assert(n.has("facts_read_uncrawled") && n.has("graph_upsert_node"), "facts-manager holds harvester tools");
        assert(n.has("graph_stats"), "facts-manager gets graph_stats");
    });

    it("agent-tuner → reads + graph_stats, NEVER write/crawl/delete", () => {
        const n = names(createGraphTools({ ...base(), agentIdentity: "agent-tuner", isHarvester: true }));
        assert(n.has("graph_search_nodes") && n.has("graph_neighbourhood"), "tuner gets graph reads");
        assert(n.has("graph_stats"), "tuner gets graph_stats");
        assert(!n.has("graph_upsert_node") && !n.has("graph_delete_node") && !n.has("graph_merge_nodes"), "tuner gets NO graph writes");
        assert(!n.has("facts_read_uncrawled") && !n.has("facts_mark_crawled"), "tuner gets NO crawl queue (even with isHarvester)");
    });
});
