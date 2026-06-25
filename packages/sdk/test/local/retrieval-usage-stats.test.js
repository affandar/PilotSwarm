/**
 * Retrieval Usage Stats — count-only CMS aggregation and inspect tools.
 *
 * Verifies migration 0021 stored procs and the inspect/management surfaces
 * without driving an LLM. Events are seeded directly into CMS so the test is
 * deterministic and fast.
 *
 * Run: npx vitest run test/local/retrieval-usage-stats.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createFactTools, createGraphTools, createInspectTools } from "../../src/index.ts";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import {
    assert,
    assertEqual,
    assertGreaterOrEqual,
    assertNotNull,
} from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => {
    await preflightChecks();
});

function findTool(tools, name) {
    const tool = tools.find((t) => t.name === name);
    assertNotNull(tool, `${name} tool registered`);
    return tool;
}

async function seedSession(catalog, sessionId, opts = {}) {
    await catalog.createSession(sessionId, opts);
    await catalog.updateSession(sessionId, { state: "running" });
}

function retrievalEvents() {
    return [
        {
            eventType: "facts.searched",
            data: {
                operation: "facts_search",
                queryPreview: "index scan tuning",
                mode: "hybrid",
                namespace: "corpus/pgsql",
                limit: 20,
                resultCount: 3,
                durationMs: 12,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "facts.similar",
            data: {
                operation: "facts_similar",
                scopeKey: "shared:corpus/pgsql/doc-1",
                namespace: "corpus/pgsql",
                k: 8,
                resultCount: 2,
                durationMs: 8,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "skills.searched",
            data: {
                operation: "search_skills",
                queryPreview: "horizondb age",
                namespace: "skills",
                resultCount: 4,
                durationMs: 5,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "graph.searched",
            data: {
                operation: "graph_search_nodes",
                kind: "person",
                nameLikePreview: "tom lane",
                namespace: "corpus/pgsql",
                resultCount: 5,
                durationMs: 20,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "graph.searched",
            data: {
                operation: "graph_search_edges",
                predicateKey: "depend_on",
                fromKey: "patch:foo",
                toKey: "file:bar",
                namespace: "corpus/pgsql",
                resultCount: 1,
                durationMs: 9,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "graph.searched",
            data: {
                operation: "graph_neighbourhood",
                nodeKey: "person:tom-lane",
                namespace: "corpus/pgsql",
                resultCount: 9,
                nodeCount: 6,
                edgeCount: 3,
                durationMs: 25,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "graph.node_searched",
            data: {
                operation: "graph_search_nodes",
                nodeKey: "person:tom-lane",
                namespace: "corpus/pgsql",
                durationMs: 20,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "graph.node_searched",
            data: {
                operation: "graph_search_nodes",
                nodeKey: "person:tom-lane",
                namespace: "corpus/pgsql",
                durationMs: 18,
                callerAgentId: "alpha",
            },
        },
        {
            eventType: "graph.node_loaded",
            data: {
                operation: "graph_neighbourhood",
                nodeKey: "person:tom-lane",
                namespace: "corpus/pgsql",
                durationMs: 25,
                callerAgentId: "alpha",
            },
        },
    ];
}

function createEnhancedFactStoreStub() {
    const facts = [
        {
            scopeKey: "shared:corpus/pgsql/doc-1",
            key: "corpus/pgsql/doc-1",
            value: { title: "doc" },
            agentId: "harvester",
            sessionId: null,
            shared: true,
            tags: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            etag: 1,
            score: 0.9,
        },
        {
            scopeKey: "shared:skills/horizondb-idiosyncrasies",
            key: "skills/horizondb-idiosyncrasies",
            value: { name: "horizondb-idiosyncrasies", description: "HorizonDB quirks" },
            agentId: "facts-manager",
            sessionId: null,
            shared: true,
            tags: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            etag: 2,
            score: 0.8,
        },
    ];
    return {
        capabilities: { search: true, embedder: false },
        async initialize() {},
        async storeFact(input) { return { key: input.key, shared: input.shared === true, stored: true }; },
        async readFacts() { return { count: 0, facts: [] }; },
        async deleteFact(input) { return { key: input.key, shared: input.shared === true, deleted: true }; },
        async deleteSessionFactsForSession() { return 0; },
        async getSessionFactsStats() { return []; },
        async getFactsStatsForSessions() { return []; },
        async getSharedFactsStats() { return []; },
        async readUncrawledFacts() { return { count: 0, facts: [] }; },
        async setFactsCrawled() { return { affected: 0, skipped: 0 }; },
        async purgeExpiredFacts() { return 0; },
        async getFactsTombstoneStats() { return { pendingTotal: 0, unreconciled: 0, ttlBlocked: 0, oldestUnreconciledAgeSeconds: null, reconciledUnswept: 0 }; },
        async forcePurgeFacts() { return 0; },
        async searchFacts(query, opts) {
            const rows = opts?.namespace === "skills" ? facts.slice(1) : facts.slice(0, 1);
            return { count: rows.length, facts: rows };
        },
        async similarFacts() {
            const rows = facts.slice(0, 1);
            return { count: rows.length, facts: rows };
        },
        async close() {},
    };
}

function createGraphStoreStub() {
    return {
        async initialize() {},
        async close() {},
        async searchGraphNodes() {
            return [{ nodeKey: "person:tom-lane", kind: "person", name: "Tom Lane", aliases: [], evidence: [], score: 1 }];
        },
        async searchGraphEdges() {
            return [{ fromKey: "patch:foo", toKey: "file:bar", predicate: "depends on", predicateKey: "depend_on", confidence: 1, observations: 1, evidence: [] }];
        },
        async graphNeighbourhood() {
            return {
                nodes: [{ nodeKey: "person:tom-lane", kind: "person", name: "Tom Lane" }],
                edges: [{ fromKey: "person:tom-lane", toKey: "project:postgresql", predicate: "maintains", confidence: 1 }],
            };
        },
        async upsertGraphNode() { return { nodeKey: "person:tom-lane", kind: "person", name: "Tom Lane", aliases: [], created: false }; },
        async upsertGraphEdge() { return { fromKey: "a", toKey: "b", predicate: "depends on", predicateKey: "depend_on", confidence: 1, observations: 1, reinforced: false }; },
        async mergeGraphNodes() {},
        async deleteGraphNode() { return false; },
        async deleteGraphEdge() { return false; },
        async removeGraphEvidence(scopeKey) { return { scopeKey, nodeEvidenceRemoved: 0, edgeEvidenceRemoved: 0, nodesDeleted: 0, edgesDeleted: 0 }; },
        normalizePredicateKey(predicate) { return predicate === "DEPENDS_ON" ? "depend_on" : String(predicate || "").toLowerCase(); },
    };
}

function eventRecorder(events) {
    return async (sessionId, eventType, data) => {
        events.push({ sessionId, eventType, data });
    };
}

describe("Retrieval Usage Stats", () => {
    it("emits count-only events from enhanced fact retrieval tools", async () => {
        const events = [];
        const factStore = createEnhancedFactStoreStub();
        const tools = createFactTools({
            factStore,
            enhancedFactStore: factStore,
            agentIdentity: "alpha",
            recordEvent: eventRecorder(events),
        });
        const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;

        await findTool(tools, "facts_search").handler({ query: "x".repeat(120), namespace: "corpus/pgsql", limit: 5 }, { sessionId });
        await findTool(tools, "facts_similar").handler({ scopeKey: "shared:corpus/pgsql/doc-1", namespace: "corpus/pgsql", k: 3 }, { sessionId });
        await findTool(tools, "search_skills").handler({ query: "horizondb", limit: 4 }, { sessionId });

        const types = events.map((event) => event.eventType).sort();
        assertEqual(types.join(","), "facts.searched,facts.similar,skills.searched", "fact retrieval event types emitted");
        const factsSearch = events.find((event) => event.eventType === "facts.searched");
        assertEqual(factsSearch.data.operation, "facts_search");
        assertEqual(factsSearch.data.namespace, "corpus/pgsql");
        assertEqual(factsSearch.data.resultCount, 1);
        assertEqual(factsSearch.data.queryPreview.length, 80, "queryPreview clipped");
        assert(!("facts" in factsSearch.data), "facts_search event does not persist returned facts");

        const skillSearch = events.find((event) => event.eventType === "skills.searched");
        assertEqual(skillSearch.data.namespace, "skills");
        assert(!("skills" in skillSearch.data), "search_skills event does not persist returned skills");
    }, TIMEOUT);

    it("emits count-only events from graph retrieval tools", async () => {
        const events = [];
        const graphStore = createGraphStoreStub();
        const factStore = createEnhancedFactStoreStub();
        const tools = createGraphTools({
            graphStore,
            factStore,
            agentIdentity: "alpha",
            agentId: "alpha",
            resolveAccess: async (sessionId) => ({ readerSessionId: sessionId, grantedSessionIds: [] }),
            recordEvent: eventRecorder(events),
        });
        const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;

        await findTool(tools, "graph_search_nodes").handler({ seeds: ["person:tom-lane", "shared:corpus/pgsql/doc-1"], namespace: "default", limit: 5 }, { sessionId });
        await findTool(tools, "graph_search_edges").handler({ predicate: "DEPENDS_ON", fromKey: "patch:foo", toKey: "file:bar", namespace: "corpus/pgsql" }, { sessionId });
        await findTool(tools, "graph_neighbourhood").handler({ nodeKey: "person:tom-lane", depth: 1, namespace: "corpus/pgsql" }, { sessionId });

        const graphSearches = events.filter((event) => event.eventType === "graph.searched");
        const nodeSearched = events.filter((event) => event.eventType === "graph.node_searched");
        const nodeLoaded = events.filter((event) => event.eventType === "graph.node_loaded");
        assertEqual(graphSearches.length, 3, "three graph.searched events emitted");
        assertEqual(nodeSearched.length, 1, "only exact node-key seed emits graph.node_searched");
        assertEqual(nodeSearched[0].data.nodeKey, "person:tom-lane");
        assertEqual(nodeLoaded.length, 1, "neighbourhood anchor emits graph.node_loaded");
        assertEqual(nodeLoaded[0].data.nodeKey, "person:tom-lane");

        const edgeSearch = graphSearches.find((event) => event.data.operation === "graph_search_edges");
        assertEqual(edgeSearch.data.predicateKey, "depend_on", "provider predicate normalizer used");
        assert(!("predicate" in edgeSearch.data), "raw predicate text is not persisted");
        assert(!("nodes" in graphSearches[0].data), "graph events do not persist returned nodes");
        assert(!("edges" in edgeSearch.data), "graph events do not persist returned edges");
    }, TIMEOUT);

    it("aggregates per-session retrieval, graph node, and edge-search usage", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });
            await catalog.recordEvents(sid, retrievalEvents());

            const usage = await catalog.getSessionRetrievalUsage(sid);
            console.log("  usage rows:", usage.map((r) => `${r.surface}/${r.operation}/${r.namespace}=${r.calls}`).join(", "));

            const factsSearch = usage.find((r) => r.operation === "facts_search");
            assertNotNull(factsSearch, "facts_search row");
            assertEqual(factsSearch.surface, "facts");
            assertEqual(factsSearch.namespace, "corpus/pgsql");
            assertEqual(factsSearch.calls, 1);
            assertEqual(factsSearch.totalResults, 3);
            assertEqual(factsSearch.totalDurationMs, 12);

            const graphNeighbourhood = usage.find((r) => r.operation === "graph_neighbourhood");
            assertNotNull(graphNeighbourhood, "graph_neighbourhood row");
            assertEqual(graphNeighbourhood.totalResults, 9);

            const nodeUsage = await catalog.getSessionGraphNodeUsage(sid, { nodeKeyLike: "tom", limit: 10 });
            console.log("  node rows:", nodeUsage.map((r) => `${r.kind}/${r.nodeKey}=${r.count}`).join(", "));
            const searched = nodeUsage.find((r) => r.kind === "searched");
            const loaded = nodeUsage.find((r) => r.kind === "loaded");
            assertEqual(searched.count, 2, "node searched twice");
            assertEqual(loaded.count, 1, "node loaded once");

            const loadedOnly = await catalog.getSessionGraphNodeUsage(sid, { kind: "loaded" });
            assertEqual(loadedOnly.length, 1, "kind filter keeps only loaded rows");
            assertEqual(loadedOnly[0].kind, "loaded");

            const edges = await catalog.getSessionGraphEdgeSearchUsage(sid);
            assertEqual(edges.length, 1, "one edge-search request shape");
            assertEqual(edges[0].predicateKey, "depend_on");
            assertEqual(edges[0].fromKey, "patch:foo");
            assertEqual(edges[0].totalResults, 1);

            const future = new Date(Date.now() + 3600_000);
            const empty = await catalog.getSessionRetrievalUsage(sid, { since: future });
            assertEqual(empty.length, 0, "future since cutoff filters retrieval rows");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("rolls up retrieval usage across a session tree and fleet", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const parent = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const child = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const beta = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, parent, { agentId: "coordinator" });
            await seedSession(catalog, child, { agentId: "alpha", parentSessionId: parent });
            await seedSession(catalog, beta, { agentId: "beta" });

            await catalog.recordEvents(parent, [retrievalEvents()[0]]);
            await catalog.recordEvents(child, [retrievalEvents()[3], retrievalEvents()[6]]);
            await catalog.recordEvents(beta, [retrievalEvents()[0], retrievalEvents()[0]]);

            const tree = await catalog.getSessionTreeRetrievalUsage(parent);
            console.log("  tree totalCalls:", tree.totalCalls, "rolledUp:", tree.rolledUp.map((r) => `${r.operation}=${r.calls}`).join(", "));
            assertEqual(tree.rootSessionId, parent);
            assertEqual(tree.perSession.length, 2, "parent + child retrieval buckets");
            assertEqual(tree.totalCalls, 2, "parent facts_search + child graph_search_nodes");

            const rolledFacts = tree.rolledUp.find((r) => r.operation === "facts_search");
            const rolledGraph = tree.rolledUp.find((r) => r.operation === "graph_search_nodes");
            assertEqual(rolledFacts.calls, 1);
            assertEqual(rolledGraph.calls, 1);

            const fleet = await catalog.getFleetRetrievalUsage();
            const betaFacts = fleet.rows.find((r) => r.agentId === "beta" && r.operation === "facts_search");
            assertNotNull(betaFacts, "beta facts fleet row");
            assertGreaterOrEqual(betaFacts.calls, 2, "beta facts searches counted");
            assertEqual(betaFacts.sessionCount, 1, "beta facts row came from one session");

            const fleetNodes = await catalog.getFleetGraphNodeUsage({ nodeKeyLike: "tom", kind: "searched" });
            const alphaNode = fleetNodes.rows.find((r) => r.agentId === "alpha" && r.nodeKey === "person:tom-lane");
            assertNotNull(alphaNode, "fleet node usage row");
            assertGreaterOrEqual(alphaNode.count, 1);
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("exposes inspect tools with lineage gating", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const parent = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const child = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const unrelated = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, parent, { agentId: "coordinator" });
            await seedSession(catalog, child, { agentId: "alpha", parentSessionId: parent });
            await seedSession(catalog, unrelated, { agentId: "beta" });
            await catalog.recordEvents(child, retrievalEvents());

            const ordinaryTools = createInspectTools({ catalog, agentIdentity: "coordinator" });
            const readUsage = findTool(ordinaryTools, "read_session_retrieval_usage");
            const allowed = await readUsage.handler({ session_id: child }, { sessionId: parent });
            assertEqual(allowed.sessionId, child, "parent can inspect child retrieval usage");
            assertGreaterOrEqual(allowed.totalCalls, 1, "child usage returned");

            const denied = await readUsage.handler({ session_id: child }, { sessionId: unrelated });
            assertNotNull(denied.error, "unrelated ordinary session denied");
            assert(/not your session or a descendant/i.test(denied.error), `denial message: ${denied.error}`);

            const readNode = findTool(ordinaryTools, "read_session_graph_node_usage");
            const nodeResult = await readNode.handler({ session_id: child, node_key_like: "tom", kind: "searched" }, { sessionId: parent });
            assertEqual(nodeResult.sessionId, child);
            assertGreaterOrEqual(nodeResult.rows.length, 1, "node usage visible to parent");

            const tunerTools = createInspectTools({ catalog, agentIdentity: "agent-tuner" });
            const fleetUsage = await findTool(tunerTools, "read_fleet_retrieval_usage").handler({});
            assert(Array.isArray(fleetUsage.rows), "tuner fleet retrieval rows returned");

            const graphSearches = await findTool(tunerTools, "read_session_graph_searches").handler({ session_id: child, limit: 50 });
            assertGreaterOrEqual(graphSearches.count, 1, "raw graph search timeline returned");
            const first = graphSearches.searches[0];
            assert("operation" in first, "raw timeline uses operation field");
            assert("queryPreview" in first, "raw timeline uses preview field");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
