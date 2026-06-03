// Integration — AGE graph construction + Cypher (the open-graph crawler).
//
// Live mirror of poc/05-crawler.mjs against a real AGE store: entity dedup by
// alias, relationship reinforcement (noisy-OR), the mandatory-evidence guard,
// anchor-and-explore (neighbourhood), exact-predicate query, and provenance.
//
// Run: HORIZON_DATABASE_URL=... npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { HorizonFactStore } from "../../dist/src/index.js";
import { HAS_DB, DB_URL, uniqueNames, dropSchemaAndGraph } from "./_db.mjs";

const opts = { skip: !HAS_DB ? "HORIZON_DATABASE_URL not set" : false };

let store, names;
const AGENT = "harvester-1";

before(async () => {
    if (!HAS_DB) return;
    names = uniqueNames();
    // Graph-only: no embedding endpoint needed for the open graph.
    store = await HorizonFactStore.create({ connectionString: DB_URL, schema: names.schema, graphName: names.graph });
    await store.initialize();
});

after(async () => {
    if (!HAS_DB) return;
    await store?.close();
    await dropSchemaAndGraph(DB_URL, names.schema, names.graph);
});

test("graph construction: entities + relationships are created", opts, async () => {
    const tom = await store.upsertEntity({ kind: "person", name: "Tom Lane", aliases: ["tgl"], agentId: AGENT });
    const patch = await store.upsertEntity({ kind: "patch", name: "v3 fix jsonb subscript", agentId: AGENT });
    const file = await store.upsertEntity({ kind: "code_file", name: "src/backend/utils/adt/jsonbsubs.c", agentId: AGENT });
    assert.ok(tom.created && patch.created && file.created, "all newly created");

    const r1 = await store.assertRelationship({
        fromKey: tom.entityKey, toKey: patch.entityKey, predicate: "comments on",
        confidence: 0.95, evidence: ["shared:archive/msg/1001"], agentId: AGENT });
    assert.equal(r1.reinforced, false, "first assert creates");
    assert.equal(r1.observations, 1);

    await store.assertRelationship({
        fromKey: patch.entityKey, toKey: file.entityKey, predicate: "touches",
        confidence: 0.9, evidence: ["shared:archive/msg/1001"], agentId: AGENT });

    console.log(`  created 3 entities + 2 relationships in graph ${names.graph}`);
});

test("alias resolution: 'tgl' reuses Tom Lane, not a new node", opts, async () => {
    const hits = await store.searchEntities({ kind: "person", nameLike: "tgl" });
    assert.equal(hits.length, 1, "exactly one person matches alias tgl");
    assert.equal(hits[0].name, "Tom Lane");
    assert.ok(hits[0].aliases.includes("tgl"));
});

test("reinforcement: 'comment on' merges into 'comments on' (noisy-OR)", opts, async () => {
    const tomKey = "person:tom-lane";
    const patchKey = "patch:v3-fix-jsonb-subscript";

    const r2 = await store.assertRelationship({
        fromKey: tomKey, toKey: patchKey, predicate: "comment on",
        confidence: 0.8, evidence: ["shared:archive/msg/1002"], agentId: AGENT });
    assert.equal(r2.reinforced, true, "reinforced existing edge");
    assert.equal(r2.observations, 2);
    assert.ok(Math.abs(r2.confidence - 0.99) < 1e-6, `confidence 0.95⊕0.80=0.99, got ${r2.confidence}`);

    const rels = await store.searchRelationships({ predicateKey: "comment", fromKey: tomKey });
    assert.equal(rels.length, 1, "single edge, not duplicated");
    assert.equal(rels[0].observations, 2);
    assert.deepEqual([...rels[0].evidence].sort(),
        ["shared:archive/msg/1001", "shared:archive/msg/1002"], "evidence accumulated from both");
    console.log(`  edge reinforced → confidence ${rels[0].confidence}, obs ${rels[0].observations}`);
});

test("evidence guard: empty-evidence assertion is rejected", opts, async () => {
    await assert.rejects(
        store.assertRelationship({
            fromKey: "person:tom-lane", toKey: "topic:postgres", predicate: "secretly controls",
            confidence: 0.9, evidence: [], agentId: AGENT }),
        /evidence/i,
        "assertion without evidence must be rejected");
});

test("anchor-and-explore: neighbourhood discovers predicates", opts, async () => {
    const sub = await store.neighbourhood("person:tom-lane", 2);
    assert.ok(sub.nodes.length >= 2, "reaches patch (and file at depth 2)");
    const preds = new Set(sub.edges.map((e) => e.predicate));
    assert.ok(preds.has("comments on"), "discovers the 'comments on' predicate");
    console.log(`  neighbourhood: ${sub.nodes.length} nodes, predicates ${[...preds].join(", ")}`);
});

test("exact-predicate query: touches → the touched file", opts, async () => {
    const rels = await store.searchRelationships({ predicateKey: "touche", minConfidence: 0.8 });
    assert.ok(rels.length >= 1, "finds the 'touches' edge");
    assert.equal(rels[0].toKey, "code_file:src-backend-utils-adt-jsonbsubs-c");
});

test("provenance: evidence links resolve", opts, async () => {
    await store.linkEvidence("person:tom-lane", ["shared:archive/msg/1001"]);
    // No throw == linked. (Reading EVIDENCED_BY back is covered by neighbourhood
    // shape; this asserts the write path is valid Cypher.)
    assert.ok(true);
});
