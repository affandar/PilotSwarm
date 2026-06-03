// Integration — full EnhancedFactStore provider.
//
// Proves the adapter is a DROP-IN FactStore (storeFact/readFacts/deleteFact/
// stats with the same semantics) AND adds working enhanced retrieval
// (lexical / semantic / hybrid + relatedFacts) plus the optional agent tools.
//
// Run: HORIZON_DATABASE_URL=... npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { HorizonFactStore, createFactsTools } from "../../dist/src/index.js";
import {
    HAS_DB, DB_URL, uniqueNames, startEmbeddingStub, stubEmbedding, dropSchemaAndGraph,
} from "./_db.mjs";

const opts = { skip: !HAS_DB ? "HORIZON_DATABASE_URL not set" : false };

let store, stub, names;
const SID = "sess-A";

before(async () => {
    if (!HAS_DB) return;
    stub = await startEmbeddingStub();
    names = uniqueNames();
    store = await HorizonFactStore.create({
        connectionString: DB_URL, schema: names.schema, graphName: names.graph,
        embedding: stubEmbedding(stub.url),
    });
    await store.initialize();
});

after(async () => {
    if (!HAS_DB) return;
    await store?.close();
    await stub?.close();
    await dropSchemaAndGraph(DB_URL, names.schema, names.graph);
});

// ─── drop-in base API parity ────────────────────────────────────────────────

test("base API: store / read / delete (shared + session)", opts, async () => {
    await store.storeFact({ key: "config/region", shared: true, value: { text: "westus3" } });
    await store.storeFact({ key: "notes/today", sessionId: SID, value: { text: "session-scoped note" } });

    const shared = await store.readFacts({ scope: "shared" });
    assert.ok(shared.facts.some((f) => f.key === "config/region"), "shared fact readable");
    assert.ok(!shared.facts.some((f) => f.key === "notes/today"), "session fact not in shared scope");

    const sess = await store.readFacts({ scope: "session", sessionId: SID }, { readerSessionId: SID });
    assert.ok(sess.facts.some((f) => f.key === "notes/today"), "session fact readable by owner");

    const accessible = await store.readFacts({ scope: "accessible" }, { readerSessionId: SID });
    assert.ok(accessible.facts.some((f) => f.key === "config/region"), "accessible includes shared");
    assert.ok(accessible.facts.some((f) => f.key === "notes/today"), "accessible includes own session");

    const del = await store.deleteFact({ key: "config/region", shared: true });
    assert.equal(del.deleted, true);
    const afterDel = await store.readFacts({ scope: "shared" });
    assert.ok(!afterDel.facts.some((f) => f.key === "config/region"), "deleted fact gone");
});

test("base API: stats bucket by namespace", opts, async () => {
    await store.storeFact({ key: "skills/x", shared: true, value: { text: "a skill" } });
    await store.storeFact({ key: "asks/y", shared: true, value: { text: "an ask" } });
    const stats = await store.getSharedFactsStats();
    const ns = new Set(stats.map((s) => s.namespace));
    assert.ok(ns.has("skills") && ns.has("asks"), "namespaces bucketed");
    assert.ok(stats.every((s) => s.factCount >= 1 && s.totalValueBytes > 0));
});

test("base API: deleteSessionFactsForSession", opts, async () => {
    await store.storeFact({ key: "tmp/a", sessionId: "sess-Z", value: { text: "z1" } });
    await store.storeFact({ key: "tmp/b", sessionId: "sess-Z", value: { text: "z2" } });
    const n = await store.deleteSessionFactsForSession("sess-Z");
    assert.equal(n, 2, "removed both session facts");
});

// ─── enhanced retrieval ─────────────────────────────────────────────────────

test("searchFacts: lexical finds by keyword", opts, async () => {
    await store.storeFact({ key: "skills/jsonb-subscript", shared: true,
        value: { name: "jsonb subscript", description: "how jsonb subscripting works", text: "jsonb subscript patch" } });
    await store.storeFact({ key: "skills/vacuum-tuning", shared: true,
        value: { name: "vacuum tuning", description: "autovacuum and planner", text: "vacuum planner index" } });

    const res = await store.searchFacts("jsonb subscript", { mode: "lexical" }, { unrestricted: true });
    assert.ok(res.facts.length >= 1);
    assert.equal(res.facts[0].key, "skills/jsonb-subscript", "best lexical hit is the jsonb fact");
    assert.ok(res.facts[0].signals.lexical > 0, "lexical signal present");
});

test("searchFacts: semantic ranks by embedding similarity", opts, async () => {
    await store.embedPending(50); // embed everything stored so far

    const res = await store.searchFacts("jsonb subscript", { mode: "semantic" }, { unrestricted: true });
    assert.ok(res.facts.length >= 1, "semantic returns hits");
    assert.equal(res.facts[0].key, "skills/jsonb-subscript", "jsonb fact is closest");
    assert.ok(res.facts[0].signals.semantic > 0, "semantic signal present");
});

test("searchFacts: hybrid fuses lexical + semantic", opts, async () => {
    await store.embedPending(50);
    const res = await store.searchFacts("jsonb subscript", { mode: "hybrid" }, { unrestricted: true });
    assert.ok(res.facts.length >= 1);
    assert.equal(res.mode, "hybrid");
    assert.equal(res.facts[0].key, "skills/jsonb-subscript");
    // top hit should carry at least one signal
    const s = res.facts[0].signals;
    assert.ok((s.lexical ?? 0) > 0 || (s.semantic ?? 0) > 0);
});

test("relatedFacts: nearest neighbours of an anchor", opts, async () => {
    await store.embedPending(50);
    const res = await store.relatedFacts("shared:skills/jsonb-subscript", { k: 5, minScore: 0 }, { unrestricted: true });
    assert.ok(res.facts.length >= 1, "returns neighbours");
    assert.ok(!res.facts.some((f) => f.key === "skills/jsonb-subscript"), "anchor excluded from its own neighbours");
});

// ─── optional agent tools ───────────────────────────────────────────────────

test("createFactsTools: retrieval + graph tools are wired", opts, async () => {
    const tools = createFactsTools(store, { graphWrite: true });
    const names_ = tools.map((t) => t.name);
    assert.ok(names_.includes("facts_search"), "search tool present");
    assert.ok(names_.includes("facts_related"), "related tool present");
    assert.ok(names_.includes("facts_graph_assert_relationship"), "graph write tool present (opt-in)");

    // The search tool handler actually queries the store.
    const searchTool = tools.find((t) => t.name === "facts_search");
    const out = await searchTool.handler({ query: "jsonb subscript", mode: "lexical" });
    assert.ok(out.facts.length >= 1, "search tool returns facts");

    // Graph write tool enforces the evidence guard.
    const assertTool = tools.find((t) => t.name === "facts_graph_assert_relationship");
    await store.upsertEntity({ kind: "topic", name: "alpha", agentId: "t" });
    await store.upsertEntity({ kind: "topic", name: "beta", agentId: "t" });
    await assert.rejects(
        assertTool.handler({ fromKey: "topic:alpha", toKey: "topic:beta", predicate: "relates to",
            confidence: 0.5, evidence: [], agentId: "t" }),
        /evidence/i, "tool rejects evidence-free assertion");
});

test("default tools exclude graph-write unless opted in", opts, async () => {
    const tools = createFactsTools(store);
    const names_ = tools.map((t) => t.name);
    assert.ok(!names_.includes("facts_graph_assert_relationship"), "write tools off by default");
    assert.ok(names_.includes("facts_graph_search_entities"), "graph read on by default");
});
