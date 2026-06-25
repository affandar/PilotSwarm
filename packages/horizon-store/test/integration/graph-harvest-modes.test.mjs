// Graph fill modes: graph store is an add-on and nothing fills it automatically.
// Apps can populate it either by direct provider API calls or by giving an agent
// the graph/crawl tools. Both modes consume the same generic facts crawl queue.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createGraphTools } from "pilotswarm-sdk";
import { HAS_DB, makeStore, dropSchemaAndGraph } from "./_db.mjs";

const byName = (tools, name) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} exists`);
    return tool;
};

describe.skipIf(!HAS_DB)("graph add-on fill modes", () => {
    let store, factStore, graphStore, schema, graph;

    beforeAll(async () => {
        ({ store, factStore, graphStore, schema, graph } = await makeStore({ tag: "gfill" }));
    });
    afterAll(async () => {
        await store?.close();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("fills the graph out of band with provider APIs", async () => {
        await factStore.storeFact({
            key: "corpus/fill/code",
            value: { text: "Checkout API is owned by Fulfillment" },
            shared: true,
            agentId: "fixture",
        });

        const queue = await factStore.readUncrawledFacts({ namespace: "corpus/fill", limit: 10 });
        const fact = queue.facts.find((f) => f.key === "corpus/fill/code");
        assert.ok(fact, "direct fill sees the pending fact");

        const service = await graphStore.upsertGraphNode({
            kind: "service",
            name: "Checkout API",
            namespace: "corpus/fill",
            evidence: [fact.scopeKey],
            agentId: "code-harvest",
        });
        const team = await graphStore.upsertGraphNode({
            kind: "team",
            name: "Fulfillment",
            namespace: "corpus/fill",
            evidence: [fact.scopeKey],
            agentId: "code-harvest",
        });
        await graphStore.upsertGraphEdge({
            fromKey: service.nodeKey,
            toKey: team.nodeKey,
            predicate: "OWNED_BY",
            namespace: "corpus/fill",
            evidence: [fact.scopeKey],
            agentId: "code-harvest",
        });
        assert.deepEqual(await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: fact.scopeKey, etag: fact.etag }] }), { affected: 1, skipped: 0 });

        const edges = await graphStore.searchGraphEdges({ fromKey: service.nodeKey, namespace: "corpus/fill" }, { unrestricted: true });
        assert.ok(edges.some((edge) => edge.toKey === team.nodeKey && edge.evidence.includes(fact.scopeKey)),
            "direct provider fill wrote graph edge with fact evidence");
        const after = await factStore.readUncrawledFacts({ namespace: "corpus/fill", limit: 10 });
        assert.ok(!after.facts.some((f) => f.scopeKey === fact.scopeKey), "direct fill drained its crawl receipt");
    });

    it("fills the graph in band through harvester tools", async () => {
        await factStore.storeFact({
            key: "corpus/fill/tool",
            value: { text: "Inventory service depends on Checkout API" },
            shared: true,
            agentId: "fixture",
        });

        const tools = createGraphTools({
            factStore,
            graphStore,
            agentIdentity: "source-harvester",
            isHarvester: true,
            agentId: "tool-harvest",
            resolveAccess: async () => ({ unrestricted: true }),
        });

        const readQueue = byName(tools, "facts_read_uncrawled");
        const markQueue = byName(tools, "facts_set_crawled");
        const upsertNode = byName(tools, "graph_upsert_node");
        const upsertEdge = byName(tools, "graph_upsert_edge");
        const searchEdges = byName(tools, "graph_search_edges");

        const queue = await readQueue.handler({ namespace: "corpus/fill", limit: 10 }, { sessionId: "harvester-session" });
        const fact = queue.facts.find((f) => f.key === "corpus/fill/tool");
        assert.ok(fact, "tool fill sees the pending fact");

        const inventory = await upsertNode.handler({
            kind: "service",
            name: "Inventory service",
            namespace: "corpus/fill",
            evidence: [fact.scopeKey],
        }, { sessionId: "harvester-session" });
        const checkout = await upsertNode.handler({
            kind: "service",
            name: "Checkout API",
            namespace: "corpus/fill",
            evidence: [fact.scopeKey],
        }, { sessionId: "harvester-session" });
        await upsertEdge.handler({
            fromKey: inventory.nodeKey,
            toKey: checkout.nodeKey,
            predicate: "DEPENDS_ON",
            namespace: "corpus/fill",
            evidence: [fact.scopeKey],
        }, { sessionId: "harvester-session" });
        assert.deepEqual(await markQueue.handler({ scopeKeys: [{ scopeKey: fact.scopeKey, etag: fact.etag }] }, { sessionId: "harvester-session" }),
            { affected: 1, skipped: 0 });

        const edges = await searchEdges.handler({ fromKey: inventory.nodeKey, namespace: "corpus/fill" }, { sessionId: "harvester-session" });
        assert.ok(edges.some((edge) => edge.toKey === checkout.nodeKey && edge.evidence.includes(fact.scopeKey)),
            "tool fill wrote graph edge with fact evidence");
        const after = await readQueue.handler({ namespace: "corpus/fill", limit: 10 }, { sessionId: "harvester-session" });
        assert.ok(!after.facts.some((f) => f.scopeKey === fact.scopeKey), "tool fill drained its crawl receipt");
    });

    it("does not expose crawl queue tools to ordinary graph users", () => {
        const tools = createGraphTools({
            factStore,
            graphStore,
            agentIdentity: "ordinary-agent",
            resolveAccess: async () => ({ unrestricted: true }),
        });
        const names = new Set(tools.map((tool) => tool.name));
        assert.ok(names.has("graph_upsert_node"), "ordinary non-tuner agents can write graph facts they know");
        assert.ok(!names.has("facts_read_uncrawled"), "ordinary agents do not get privileged crawl queue read");
        assert.ok(!names.has("facts_set_crawled"), "ordinary agents do not get privileged crawl queue write");
    });
});
