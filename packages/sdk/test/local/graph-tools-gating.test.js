/**
 * P4 (enhancedfactstore): graph + enhanced facts tool registration, gated by
 * capability × role. DB-less — exercises the tool factories directly with fake
 * stores, asserting which tools each (capability, role) combination yields.
 */

import { describe, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createFactTools, createGraphTools } from "../../src/index.ts";
import { resolveHarvesterRole } from "../../src/session-proxy.ts";

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
const byName = (tools, n) => tools.find((t) => t.name === n);

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

    it("agent-tuner → factory yields facts_search + facts_similar + search_skills (read-only)", () => {
        const enh = fakeEnhancedStore();
        const n = names(createFactTools({ factStore: enh, enhancedFactStore: enh, agentIdentity: "agent-tuner" }));
        assert(n.has("facts_search") && n.has("facts_similar"), "tuner search tools present");
        assert(n.has("search_skills"), "tuner DOES get search_skills (MED#5 — it is a read)");
    });

    it("HIGH#3: facts_search blocks the reserved intake/* namespace for a task agent", async () => {
        const enh = fakeEnhancedStore();
        const tools = createFactTools({ factStore: enh, enhancedFactStore: enh, agentIdentity: "default" });
        const res = await byName(tools, "facts_search").handler({ query: "x", namespace: "intake" }, { sessionId: "s1" });
        assert(res && typeof res.error === "string" && /intake/.test(res.error), "intake namespace search is rejected for a task agent");
    });

    it("HIGH#3: facts_search strips reserved-prefix hits a task agent should not see", async () => {
        const enh = fakeEnhancedStore();
        // Store returns a mix of allowed + reserved-prefixed facts.
        enh.searchFacts = async () => ({
            count: 2, mode: "hybrid",
            facts: [{ key: "skills/azure", value: "{}", score: 0.9 }, { key: "intake/secret/s9", value: "{}", score: 0.8 }],
        });
        const tools = createFactTools({ factStore: enh, enhancedFactStore: enh, agentIdentity: "default" });
        const res = await byName(tools, "facts_search").handler({ query: "x" }, { sessionId: "s1" });
        const keys = res.facts.map((f) => f.key);
        assert(keys.includes("skills/azure"), "allowed skills fact kept");
        assert(!keys.some((k) => k.startsWith("intake/")), "reserved intake fact stripped from results");
    });

    it("facts_similar forwards namespace to the provider", async () => {
        const enh = fakeEnhancedStore();
        let seenOpts;
        enh.similarFacts = async (_scopeKey, opts) => {
            seenOpts = opts;
            return { count: 0, mode: "semantic", facts: [] };
        };
        const tools = createFactTools({ factStore: enh, enhancedFactStore: enh, agentIdentity: "default" });
        await byName(tools, "facts_similar").handler({ scopeKey: "shared:corpus/acme/dog", namespace: "corpus/acme", k: 7, minScore: 0.4 }, { sessionId: "s1" });
        assertEqual(seenOpts.namespace, "corpus/acme", "namespace forwarded");
        assertEqual(seenOpts.k, 7, "k forwarded");
        assertEqual(seenOpts.minScore, 0.4, "minScore forwarded");
    });

    it("HIGH#3: facts_similar blocks the reserved intake/* namespace for a task agent", async () => {
        const enh = fakeEnhancedStore();
        const tools = createFactTools({ factStore: enh, enhancedFactStore: enh, agentIdentity: "default" });
        const res = await byName(tools, "facts_similar").handler({ scopeKey: "shared:skills/x", namespace: "intake" }, { sessionId: "s1" });
        assert(res && typeof res.error === "string" && /intake/.test(res.error), "intake namespace similar search is rejected for a task agent");
    });
});

describe("P4: graph tool gating (createGraphTools)", () => {
    const base = () => ({ graphStore: fakeGraphStore(), factStore: fakeBaseStore() });

    it("reader (no harvester role) → reads + graph write/delete, but no crawl/stats", () => {
        const n = names(createGraphTools({ ...base(), agentIdentity: "default" }));
        assert(n.has("graph_search_nodes") && n.has("graph_search_edges") && n.has("graph_neighbourhood"), "graph read tools present");
        assert(n.has("graph_upsert_node") && n.has("graph_upsert_edge") && n.has("graph_merge_nodes")
            && n.has("graph_delete_node") && n.has("graph_delete_edge"), "graph write/delete now available to every non-tuner session");
        assert(!n.has("facts_read_uncrawled") && !n.has("facts_mark_crawled"), "crawl queue stays harvester/facts-manager only");
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

    it("namespace is forwarded through every graph read/write/delete/stat tool", async () => {
        const ns = "corpus/acme/services";
        const seen = {};
        const gs = {
            ...fakeGraphStore(),
            searchGraphNodes: async (q) => { seen.searchNodes = q; return []; },
            searchGraphEdges: async (q) => { seen.searchEdges = q; return []; },
            graphNeighbourhood: async (_nodeKey, _depth, _access, opts) => { seen.neighbourhood = opts; return { nodes: [], edges: [] }; },
            upsertGraphNode: async (input) => { seen.upsertNode = input; return {}; },
            upsertGraphEdge: async (input) => { seen.upsertEdge = input; return {}; },
            mergeGraphNodes: async (_fromKey, _intoKey, _reason, opts) => { seen.mergeNodes = opts; },
            deleteGraphNode: async (_nodeKey, opts) => { seen.deleteNode = opts; return true; },
            deleteGraphEdge: async (_fromKey, _toKey, _predicateKey, opts) => { seen.deleteEdge = opts; return true; },
            graphStats: async (opts) => { seen.graphStats = opts; return { nodeCount: 1, edgeCount: 2 }; },
        };
        const factStore = {
            ...fakeBaseStore(),
            readUncrawledFacts: async (opts = {}) => { seen.uncrawled = opts; return { count: 0, facts: [] }; },
        };
        const tools = createGraphTools({ graphStore: gs, factStore, agentIdentity: "facts-manager" });

        await byName(tools, "graph_search_nodes").handler({ namespace: ns, nameLike: "checkout" }, { sessionId: "s1" });
        await byName(tools, "graph_search_edges").handler({ namespace: ns, predicateKey: "depends_on" }, { sessionId: "s1" });
        await byName(tools, "graph_neighbourhood").handler({ namespace: ns, nodeKey: "service:checkout", depth: 2 }, { sessionId: "s1" });
        await byName(tools, "graph_stats").handler({ namespace: ns }, { sessionId: "s1" });
        await byName(tools, "facts_read_uncrawled").handler({ namespace: ns, limit: 10 }, { sessionId: "s1" });
        await byName(tools, "graph_upsert_node").handler({ namespace: ns, kind: "service", name: "checkout" }, { sessionId: "s1" });
        await byName(tools, "graph_upsert_edge").handler({ namespace: ns, fromKey: "service:checkout", toKey: "service:inventory", predicate: "depends on" }, { sessionId: "s1" });
        await byName(tools, "graph_merge_nodes").handler({ namespace: ns, fromKey: "service:checkout-old", intoKey: "service:checkout", reason: "same" }, { sessionId: "s1" });
        await byName(tools, "graph_delete_node").handler({ namespace: ns, nodeKey: "service:checkout-old" }, { sessionId: "s1" });
        await byName(tools, "graph_delete_edge").handler({ namespace: ns, fromKey: "service:checkout", toKey: "service:inventory", predicateKey: "depends_on" }, { sessionId: "s1" });

        assertEqual(seen.searchNodes.namespace, ns, "graph_search_nodes forwards namespace");
        assertEqual(seen.searchEdges.namespace, ns, "graph_search_edges forwards namespace");
        assertEqual(seen.neighbourhood.namespace, ns, "graph_neighbourhood forwards namespace");
        assertEqual(seen.graphStats.namespace, ns, "graph_stats forwards namespace to provider aggregate");
        assertEqual(seen.uncrawled.namespace, ns, "graph_stats/facts_read_uncrawled forward namespace to crawl queue");
        assertEqual(seen.upsertNode.namespace, ns, "graph_upsert_node forwards namespace");
        assertEqual(seen.upsertEdge.namespace, ns, "graph_upsert_edge forwards namespace");
        assertEqual(seen.mergeNodes.namespace, ns, "graph_merge_nodes forwards namespace guard");
        assertEqual(seen.deleteNode.namespace, ns, "graph_delete_node forwards namespace guard");
        assertEqual(seen.deleteEdge.namespace, ns, "graph_delete_edge forwards namespace guard");
    });

    it("BLOCKER#1: with no resolveAccess, a reader's graph search FAILS CLOSED (own session only, never unrestricted)", async () => {
        let seenAccess;
        const gs = fakeGraphStore();
        gs.searchGraphNodes = async (_q, access) => { seenAccess = access; return []; };
        const tools = createGraphTools({ graphStore: gs, factStore: fakeBaseStore(), agentIdentity: "default" });
        await byName(tools, "graph_search_nodes").handler({ nameLike: "x" }, { sessionId: "s1" });
        assert(seenAccess && seenAccess.unrestricted !== true, "reader access is NOT unrestricted");
        assertEqual(seenAccess.readerSessionId, "s1", "reader access scoped to caller session");
    });

    it("BLOCKER#1: agent-tuner graph search resolves UNRESTRICTED (privileged investigator)", async () => {
        let seenAccess;
        const gs = fakeGraphStore();
        gs.searchGraphNodes = async (_q, access) => { seenAccess = access; return []; };
        const tools = createGraphTools({ graphStore: gs, factStore: fakeBaseStore(), agentIdentity: "agent-tuner" });
        await byName(tools, "graph_search_nodes").handler({ nameLike: "x" }, { sessionId: "tuner1" });
        assertEqual(seenAccess.unrestricted, true, "tuner graph reads are unrestricted");
    });

    it("HIGH#4: graph_stats does NOT fan out — uses provider graphStats() when present", async () => {
        const gs = fakeGraphStore();
        let neighbourhoodCalls = 0;
        gs.graphNeighbourhood = async () => { neighbourhoodCalls++; return { nodes: [], edges: [] }; };
        gs.graphStats = async () => ({ nodeCount: 42, edgeCount: 99, uncrawledFacts: 7 });
        const tools = createGraphTools({ graphStore: gs, factStore: fakeBaseStore(), agentIdentity: "facts-manager" });
        const res = await byName(tools, "graph_stats").handler({}, {});
        assertEqual(res.nodeCount, 42, "node count from provider aggregate");
        assertEqual(res.edgeCount, 99, "edge count from provider aggregate");
        assertEqual(neighbourhoodCalls, 0, "no per-node neighbourhood fan-out");
    });

    it("HIGH#4: graph_stats fallback (no graphStats()) uses a bounded sample, still no fan-out", async () => {
        const gs = fakeGraphStore();
        let neighbourhoodCalls = 0;
        gs.graphNeighbourhood = async () => { neighbourhoodCalls++; return { nodes: [], edges: [] }; };
        gs.searchGraphNodes = async () => [{ nodeKey: "n1" }, { nodeKey: "n2" }];
        const tools = createGraphTools({ graphStore: gs, factStore: fakeBaseStore(), agentIdentity: "facts-manager" });
        const res = await byName(tools, "graph_stats").handler({}, {});
        assertEqual(neighbourhoodCalls, 0, "fallback must not fan out neighbourhood queries");
        assert(typeof res.uncrawledFacts === "number", "fallback still reports crawl backlog");
    });

    it("HIGH#1: graph_stats reports the REAL crawl backlog (not capped at 0/1)", async () => {
        // Regression: graph_stats used readUncrawledFacts({ limit: 1 }) whose
        // `count` is the returned-row count — so the backlog was always 0 or 1.
        const gs = fakeGraphStore();
        gs.graphStats = async () => ({ nodeCount: 5, edgeCount: 3 }); // provider omits uncrawledFacts
        const BACKLOG = 137;
        const factStore = {
            ...fakeBaseStore(),
            readUncrawledFacts: async ({ limit } = {}) => {
                const n = Math.min(limit ?? 20, BACKLOG);
                return { count: n, facts: Array.from({ length: n }, (_, i) => ({ key: `intake/x/${i}`, scopeKey: `shared:intake/x/${i}` })) };
            },
        };
        const tools = createGraphTools({ graphStore: gs, factStore, agentIdentity: "facts-manager" });
        const res = await byName(tools, "graph_stats").handler({}, {});
        assertEqual(res.uncrawledFacts, BACKLOG, "reports the real backlog when below the probe cap");
        assert(!res.uncrawledFactsCapped, "not flagged capped when backlog < probe");
    });

    it("HIGH#1: graph_stats flags a backlog deeper than the bounded probe", async () => {
        const gs = fakeGraphStore();
        gs.graphStats = async () => ({ nodeCount: 5, edgeCount: 3 });
        const factStore = {
            ...fakeBaseStore(),
            // Queue deeper than any probe → always returns the full requested limit.
            readUncrawledFacts: async ({ limit } = {}) => {
                const n = limit ?? 20;
                return { count: n, facts: Array.from({ length: n }, (_, i) => ({ key: `intake/x/${i}`, scopeKey: `shared:intake/x/${i}` })) };
            },
        };
        const tools = createGraphTools({ graphStore: gs, factStore, agentIdentity: "facts-manager" });
        const res = await byName(tools, "graph_stats").handler({}, {});
        assert(res.uncrawledFacts >= 500, "reports at least the probe depth");
        assertEqual(res.uncrawledFactsCapped, true, "flags that the real backlog exceeds the probe");
    });
});

// ─── BLOCKER#2: harvester role derives from the agent definition ─────────────
// The harvester role is a property of the AGENT, resolved from static worker
// config every turn — never inherited from a parent, never trusted from a stale
// serialized config. resolveHarvesterRole is the single authoritative derive.
describe("BLOCKER#2: resolveHarvesterRole (agent-definition-derived)", () => {
    const userAgents = [
        { name: "crawler", id: "crawler", title: "Knowledge Crawler", harvester: true },
        { name: "researcher", id: "researcher", title: "Researcher", harvester: false },
        { name: "writer", id: "writer", title: "Writer" }, // no harvester field
    ];
    const systemAgents = [
        { name: "facts-manager", id: "facts-manager", title: "Facts Manager" },
        { name: "harvest-sys", id: "harvest-sys", title: "System Harvester", harvester: true },
    ];

    it("a top-level harvester agent resolves true (by id)", () => {
        assertEqual(resolveHarvesterRole("crawler", undefined, userAgents, systemAgents), true);
    });

    it("a non-harvester agent resolves false", () => {
        assertEqual(resolveHarvesterRole("researcher", undefined, userAgents, systemAgents), false);
    });

    it("an agent with no harvester field resolves false (fail-closed)", () => {
        assertEqual(resolveHarvesterRole("writer", undefined, userAgents, systemAgents), false);
    });

    it("SECURITY: title is NOT an authorization key — a title match does not grant the role", () => {
        // 'Knowledge Crawler' is the crawler's TITLE (display metadata). Identity
        // is always the canonical id/name, never the title; matching on title
        // would be a privilege vector. So a title string must resolve false.
        assertEqual(resolveHarvesterRole("Knowledge Crawler", undefined, userAgents, systemAgents), false);
        // ...but the canonical name/id still grants.
        assertEqual(resolveHarvesterRole(undefined, "crawler", userAgents, systemAgents), true);
    });

    it("SECURITY: fail closed on a normalized-id collision (no false-positive escalation)", () => {
        // Two agents whose ids normalize to the SAME target, one harvester and
        // one not. An ambiguous match must NOT escalate to the privileged role.
        const colliding = [
            { name: "data-crawler", id: "data-crawler", harvester: true },
            { name: "datacrawler", id: "datacrawler", harvester: false }, // normalizes identically
        ];
        assertEqual(resolveHarvesterRole("datacrawler", undefined, colliding, undefined), false);
        // All-harvester collisions are unambiguous → grant.
        const allHarvest = [
            { name: "data-crawler", id: "data-crawler", harvester: true },
            { name: "datacrawler", id: "datacrawler", harvester: true },
        ];
        assertEqual(resolveHarvesterRole("datacrawler", undefined, allHarvest, undefined), true);
    });

    it("a system agent can carry the role too", () => {
        assertEqual(resolveHarvesterRole("harvest-sys", undefined, userAgents, systemAgents), true);
    });

    it("NO inheritance: an unknown identity resolves false even when a harvester exists in the list", () => {
        // Simulates a child whose own identity is not a harvester agent — the
        // presence of a harvester agent elsewhere in worker config must not leak.
        assertEqual(resolveHarvesterRole("some-child-id", undefined, userAgents, systemAgents), false);
    });

    it("empty / missing identity resolves false", () => {
        assertEqual(resolveHarvesterRole(undefined, undefined, userAgents, systemAgents), false);
        assertEqual(resolveHarvesterRole("", "", userAgents, systemAgents), false);
    });

    it("no agent lists → false (a deployment with no loaded agents has no harvesters)", () => {
        assertEqual(resolveHarvesterRole("crawler", undefined, undefined, undefined), false);
    });
});

