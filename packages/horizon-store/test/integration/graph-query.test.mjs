// §3.3 Graph queries (GQ1–GQ16) — resolve, seed pivot, evidence ACL filter,
// neighbourhood. Also covers §2.5 (RF1–RF5: graph retrieval via seeds).

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, rawPool, aclOf, seedFX, seedGX, fxScopeKey, FX } from "./_db.mjs";

describe.skipIf(!HAS_DB)("graph queries (GQ1–GQ16, RF1–RF5)", () => {
    let store, schema, graph, pool, n;
    const F1 = fxScopeKey(FX[0]);
    const all = { unrestricted: true };

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "gq", embeddingDim: 4 }));
        pool = rawPool();
        await seedFX(store, schema, pool);
        n = await seedGX(store);
    });
    afterAll(async () => {
        await store?.close();
        await pool?.end();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("GQ1 by kind", async () => {
        const hits = await store.searchGraphNodes({ kind: "skill" }, all);
        assert.deepEqual(hits.map((h) => h.nodeKey).sort(), ["skill:jsonb-subscript", "skill:vacuum"]);
    });

    it("GQ2 nameLike matches via alias (lexical, no embeddings)", async () => {
        await store.upsertGraphNode({ kind: "person", name: "moody", aliases: ["mad-eye"], agentId: "fixture" });
        const hits = await store.searchGraphNodes({ nameLike: "mad-eye" }, all);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].nodeKey, "person:moody");
    });

    it("GQ3 fact-scopeKey seeds pivot via EVIDENCED_BY", async () => {
        const hits = await store.searchGraphNodes({ seeds: [F1], depth: 1 }, all);
        const keys = hits.map((h) => h.nodeKey);
        assert.ok(keys.includes("skill:jsonb-subscript"), "F1 evidences jsonb-subscript");
    });

    it("GQ4 node-key seeds expand directly", async () => {
        const hits = await store.searchGraphNodes({ seeds: [n.vacuum.nodeKey], depth: 1 }, all);
        const keys = hits.map((h) => h.nodeKey).sort();
        assert.ok(keys.includes("skill:vacuum"), "seed itself returned");
        assert.ok(keys.includes("skill:jsonb-subscript"), "1-hop neighbour (supersedes)");
        assert.ok(keys.includes("component:planner"), "1-hop neighbour (tunes)");
    });

    it("GQ5 hits carry EVIDENCED_BY scopeKeys for the readFacts round-trip", async () => {
        const hits = await store.searchGraphNodes({ seeds: [F1], depth: 1 }, all);
        const sub = hits.find((h) => h.nodeKey === "skill:jsonb-subscript");
        assert.deepEqual(sub.evidence, [F1]);
        const { facts } = await store.readFacts({ scopeKeys: sub.evidence }, all);
        assert.equal(facts.length, 1);
        assert.equal(facts[0].scopeKey, F1);
    });

    it("RF3 fact-pivot returns facts pure facts-search would miss", async () => {
        // Lexical search for "jsonb" never finds F3 (vacuum). The graph path
        // (F1 → jsonb-subscript —supersedes→ vacuum, evidenced by F3) does.
        const direct = await store.searchFacts("jsonb", { mode: "lexical" }, aclOf(null, [], true));
        assert.ok(!direct.facts.some((f) => f.scopeKey === fxScopeKey(FX[2])), "precondition: lexical misses F3");
        const nodes = await store.searchGraphNodes({ seeds: [F1], depth: 2 }, all);
        const connected = [...new Set(nodes.flatMap((h) => h.evidence))];
        const { facts } = await store.readFacts({ scopeKeys: connected }, all);
        assert.ok(facts.some((f) => f.scopeKey === fxScopeKey(FX[2])), "graph expansion reaches F3");
    });

    it("GQ8/RF4 depth bounds traversal", async () => {
        // jsonb-subscript -1-> vacuum -2-> planner -3-> moody
        const d1 = await store.searchGraphNodes({ seeds: [n.jsonbSub.nodeKey], depth: 1 }, all);
        const d3 = await store.searchGraphNodes({ seeds: [n.jsonbSub.nodeKey], depth: 3 }, all);
        const k1 = d1.map((h) => h.nodeKey);
        const k3 = d3.map((h) => h.nodeKey);
        assert.ok(k1.includes("skill:vacuum") && !k1.includes("person:moody"), "depth 1 stops at vacuum");
        assert.ok(k3.includes("person:moody"), "depth 3 reaches moody");
    });

    it("GQ6 searchGraphEdges exact predicateKey only", async () => {
        const hits = await store.searchGraphEdges({ predicate: "supersedes" }, all);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].fromKey, "skill:jsonb-subscript");
        const none = await store.searchGraphEdges({ predicate: "supersede-ish" }, all);
        assert.equal(none.length, 0, "no fuzzy match");
    });

    it("GQ7 anchor-and-explore by fromKey", async () => {
        const hits = await store.searchGraphEdges({ fromKey: n.vacuum.nodeKey }, all);
        assert.deepEqual(hits.map((h) => h.predicate), ["tunes"]);
    });

    it("GQ8 graphNeighbourhood depth 1: direct neighbours + connecting edges", async () => {
        const sub = await store.graphNeighbourhood(n.vacuum.nodeKey, 1, all);
        const keys = sub.nodes.map((x) => x.nodeKey).sort();
        assert.deepEqual(keys, ["component:planner", "skill:jsonb-subscript"]);
        assert.ok(sub.edges.some((e) => e.predicate === "supersedes"));
        assert.ok(sub.edges.some((e) => e.predicate === "tunes"));
    });

    it("GQ8b graphNeighbourhood can be filtered by namespace subtree", async () => {
        const root = await store.upsertGraphNode({ kind: "service", name: "namespace neighbourhood root", namespace: "corpus/acme/services", agentId: "fixture" });
        const acmeLeaf = await store.upsertGraphNode({ kind: "service", name: "namespace neighbourhood acme leaf", namespace: "corpus/acme/services/leaf", agentId: "fixture" });
        const globexLeaf = await store.upsertGraphNode({ kind: "service", name: "namespace neighbourhood globex leaf", namespace: "corpus/globex/services", agentId: "fixture" });
        await store.upsertGraphEdge({ fromKey: root.nodeKey, toKey: acmeLeaf.nodeKey, predicate: "links", namespace: "corpus/acme/services", agentId: "fixture" });
        await store.upsertGraphEdge({ fromKey: root.nodeKey, toKey: globexLeaf.nodeKey, predicate: "links", namespace: "corpus/globex/services", agentId: "fixture" });

        const sub = await store.graphNeighbourhood(root.nodeKey, 1, all, { namespace: "corpus/acme" });
        const keys = sub.nodes.map((x) => x.nodeKey).sort();
        assert.deepEqual(keys, [acmeLeaf.nodeKey], "only namespace-matching neighbour returned");
        assert.equal(sub.nodes[0].namespace, "corpus/acme/services/leaf", "node namespace is surfaced");
        assert.ok(sub.edges.some((e) => e.toKey === acmeLeaf.nodeKey && e.namespace === "corpus/acme/services"), "matching edge namespace is surfaced");
        assert.ok(!sub.edges.some((e) => e.toKey === globexLeaf.nodeKey), "non-matching neighbour/edge excluded");
    });

    it("GQ9 neighbourhood depth clamped to 1..5", async () => {
        const a = await store.graphNeighbourhood(n.vacuum.nodeKey, 99, all);
        const b = await store.graphNeighbourhood(n.vacuum.nodeKey, 5, all);
        assert.deepEqual(a.nodes.map((x) => x.nodeKey).sort(), b.nodes.map((x) => x.nodeKey).sort());
        const c = await store.graphNeighbourhood(n.vacuum.nodeKey, 0, all);
        assert.deepEqual(c.nodes.map((x) => x.nodeKey).sort(),
            (await store.graphNeighbourhood(n.vacuum.nodeKey, 1, all)).nodes.map((x) => x.nodeKey).sort());
    });

    it("GQ10/11/12 (neg) empties: unknown predicate / node / seeds", async () => {
        assert.deepEqual(await store.searchGraphEdges({ predicateKey: "never_predicate" }, all), []);
        assert.deepEqual(await store.graphNeighbourhood("skill:never-was", 2, all), { nodes: [], edges: [] });
        assert.deepEqual(await store.searchGraphNodes({ seeds: ["shared:never/was"] }, all), []);
    });

    it("GQ13 evidence arrays ACL-filtered per caller; traversal unaffected", async () => {
        // Mixed-evidence node: shared + S1-private + S2-private.
        const sharedK = fxScopeKey(FX[0]);
        const s1K = fxScopeKey(FX[4]);
        const s2K = fxScopeKey(FX[5]);
        await store.upsertGraphNode({ kind: "topic", name: "mixed", agentId: "fixture", evidence: [sharedK, s1K, s2K] });

        const asS1 = await store.searchGraphNodes({ kind: "topic", nameLike: "mixed" }, aclOf("S1"));
        assert.deepEqual([...asS1[0].evidence].sort(), [s1K, sharedK].sort(), "S1 sees shared + own only");

        const asAll = await store.searchGraphNodes({ kind: "topic", nameLike: "mixed" }, all);
        assert.deepEqual([...asAll[0].evidence].sort(), [s1K, s2K, sharedK].sort(), "unrestricted sees all");
    });

    it("GQ14 connectivity THROUGH inaccessible evidence still works (topology shared)", async () => {
        // S2-private fact evidences the hub; an S2 caller seeding with its own
        // fact reaches nodes connected via that hub.
        const hub = await store.upsertGraphNode({ kind: "topic", name: "hub", agentId: "fixture", evidence: [fxScopeKey(FX[5])] }); // S2-only evidence
        const leaf = await store.upsertGraphNode({ kind: "topic", name: "leaf", agentId: "fixture" });
        await store.upsertGraphEdge({ fromKey: hub.nodeKey, toKey: leaf.nodeKey, predicate: "links to", agentId: "fixture" });

        const asS2 = await store.searchGraphNodes({ seeds: [fxScopeKey(FX[5])], depth: 1 }, aclOf("S2"));
        assert.ok(asS2.some((h) => h.nodeKey === "topic:leaf"), "S2 pivots via its own fact and reaches the leaf");
        const hubHit = asS2.find((h) => h.nodeKey === "topic:hub");
        assert.deepEqual(hubHit.evidence, [fxScopeKey(FX[5])], "S2 sees its own evidence key");
    });

    it("GQ15 inaccessible fact seed ≡ unknown seed (deep-equal, no probe oracle)", async () => {
        const s2Seed = await store.searchGraphNodes({ seeds: [fxScopeKey(FX[5])], depth: 1 }, aclOf("S1"));
        const unknown = await store.searchGraphNodes({ seeds: ["session:S1:never/was"], depth: 1 }, aclOf("S1"));
        assert.deepEqual(s2Seed, unknown, "seeding another session's fact must behave exactly like an unknown key");
        assert.deepEqual(s2Seed, []);
    });

    it("GQ16 edge evidence is ACL-filtered too", async () => {
        const x = await store.upsertGraphNode({ kind: "topic", name: "edge-ev-a", agentId: "fixture" });
        const y = await store.upsertGraphNode({ kind: "topic", name: "edge-ev-b", agentId: "fixture" });
        await store.upsertGraphEdge({
            fromKey: x.nodeKey, toKey: y.nodeKey, predicate: "cites",
            evidence: [fxScopeKey(FX[0]), fxScopeKey(FX[5])], agentId: "fixture",
        });
        const [asS1] = await store.searchGraphEdges({ fromKey: x.nodeKey }, aclOf("S1"));
        assert.deepEqual(asS1.evidence, [fxScopeKey(FX[0])], "S2-private key filtered from edge evidence");
        const [asAll] = await store.searchGraphEdges({ fromKey: x.nodeKey }, all);
        assert.equal(asAll.evidence.length, 2);
    });
});
