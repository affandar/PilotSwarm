// §3.2 upsertGraphEdge (GR1–GR8) — evidence optional; reinforcement counts
// only NOVEL evidence (GR7: replay immunity; GR8: evidence-less reinforces).
// Tests build on each other sequentially.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph } from "./_db.mjs";

describe.skipIf(!HAS_DB)("graph edges (GR1–GR8)", () => {
    let store, schema, graph, a, b, c;
    const agentId = "tester";

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "gedge" }));
        a = await store.upsertGraphNode({ kind: "patch", name: "generic subscripting", agentId });
        b = await store.upsertGraphNode({ kind: "person", name: "Dmitry Dolgov", agentId });
        c = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId });
    });
    afterAll(async () => {
        await store?.close();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("GR1 evidence-less edge is ACCEPTED (evidence optional)", async () => {
        const ref = await store.upsertGraphEdge({ fromKey: b.nodeKey, toKey: a.nodeKey, predicate: "authored", agentId });
        assert.equal(ref.reinforced, false);
        assert.equal(ref.observations, 1);
        assert.equal(ref.confidence, 1.0);
    });

    it("GR2 edge with evidence stores it", async () => {
        const ref = await store.upsertGraphEdge({
            fromKey: c.nodeKey, toKey: a.nodeKey, predicate: "defends design of",
            confidence: 0.8, evidence: ["shared:arch/m3"], agentId,
        });
        assert.equal(ref.observations, 1);
        const [hit] = await store.searchGraphEdges({ fromKey: c.nodeKey, predicateKey: ref.predicateKey }, { unrestricted: true });
        assert.deepEqual(hit.evidence, ["shared:arch/m3"]);
    });

    it("GR3 re-assert with NEW evidence reinforces: observations++, noisy-OR", async () => {
        const ref = await store.upsertGraphEdge({
            fromKey: c.nodeKey, toKey: a.nodeKey, predicate: "defends design of",
            confidence: 0.5, evidence: ["shared:arch/m4"], agentId,
        });
        assert.equal(ref.reinforced, true);
        assert.equal(ref.observations, 2);
        assert.ok(Math.abs(ref.confidence - (1 - (1 - 0.8) * (1 - 0.5))) < 1e-9, "noisy-OR(0.8, 0.5) = 0.9");
    });

    it("GR4 evidence unions across asserts", async () => {
        const [hit] = await store.searchGraphEdges({ fromKey: c.nodeKey, predicate: "defends design of" }, { unrestricted: true });
        assert.deepEqual([...hit.evidence].sort(), ["shared:arch/m3", "shared:arch/m4"]);
    });

    it("GR5 (neg) edge to a missing endpoint throws", async () => {
        await assert.rejects(
            () => store.upsertGraphEdge({ fromKey: c.nodeKey, toKey: "person:never-was", predicate: "knows", agentId }),
            /endpoint node not found/);
    });

    it("GR6 predicate_key normalization groups surface variants", async () => {
        const r1 = await store.upsertGraphEdge({ fromKey: b.nodeKey, toKey: c.nodeKey, predicate: "revives argument from", evidence: ["shared:arch/m5"], agentId });
        const r2 = await store.upsertGraphEdge({ fromKey: b.nodeKey, toKey: c.nodeKey, predicate: "revives the argument from", evidence: ["shared:arch/m6"], agentId });
        assert.equal(r1.predicateKey, r2.predicateKey, "stopword variants share a predicate_key");
        assert.equal(r2.observations, 2, "variant reinforced, not duplicated");
    });

    it("GR7 (dedup) re-assert with ONLY already-known evidence is a no-op", async () => {
        const before = await store.searchGraphEdges({ fromKey: c.nodeKey, predicate: "defends design of" }, { unrestricted: true });
        const ref = await store.upsertGraphEdge({
            fromKey: c.nodeKey, toKey: a.nodeKey, predicate: "defends design of",
            confidence: 0.99, evidence: ["shared:arch/m3", "shared:arch/m4"], agentId,
        });
        assert.equal(ref.reinforced, false, "known-evidence replay must not reinforce");
        const after = await store.searchGraphEdges({ fromKey: c.nodeKey, predicate: "defends design of" }, { unrestricted: true });
        assert.deepEqual(after, before, "edge byte-identical after replay (no observation/confidence/evidence drift)");
    });

    it("GR8 evidence-less re-assert still reinforces (dedup applies only to evidence-carrying asserts)", async () => {
        const before = await store.searchGraphEdges({ fromKey: b.nodeKey, predicateKey: "authored" }, { unrestricted: true });
        const ref = await store.upsertGraphEdge({ fromKey: b.nodeKey, toKey: a.nodeKey, predicate: "authored", confidence: 0.5, agentId });
        assert.equal(ref.reinforced, true);
        assert.equal(ref.observations, before[0].observations + 1);
    });

    it("GR9 namespace persists on edges and namespace search includes edge or endpoint subtree matches", async () => {
        const checkout = await store.upsertGraphNode({ kind: "service", name: "checkout namespace edge", namespace: "corpus/acme/services", agentId });
        const inventory = await store.upsertGraphNode({ kind: "service", name: "inventory namespace edge", namespace: "corpus/acme/services", agentId });
        const globex = await store.upsertGraphNode({ kind: "service", name: "globex namespace edge", namespace: "corpus/globex/services", agentId });

        const intra = await store.upsertGraphEdge({
            fromKey: checkout.nodeKey,
            toKey: inventory.nodeKey,
            predicate: "depends on",
            namespace: "corpus/acme/services",
            evidence: ["shared:corpus/acme/doc-edge"],
            agentId,
        });
        assert.equal(intra.namespace, "corpus/acme/services", "created edge ref carries namespace");
        const bridge = await store.upsertGraphEdge({
            fromKey: globex.nodeKey,
            toKey: checkout.nodeKey,
            predicate: "calls",
            namespace: "corpus/globex/services",
            agentId,
        });

        const acme = await store.searchGraphEdges({ namespace: "corpus/acme", limit: 20 }, { unrestricted: true });
        const acmeTriples = acme.map((e) => `${e.fromKey}->${e.toKey}:${e.predicateKey}`).sort();
        assert.ok(acmeTriples.includes(`${checkout.nodeKey}->${inventory.nodeKey}:${intra.predicateKey}`), "edge namespace under acme matches");
        assert.ok(acmeTriples.includes(`${globex.nodeKey}->${checkout.nodeKey}:${bridge.predicateKey}`), "bridge edge matches because one endpoint is in acme namespace");

        const exact = await store.searchGraphEdges({ namespace: "corpus/acme/services", predicateKey: intra.predicateKey }, { unrestricted: true });
        assert.equal(exact.find((e) => e.fromKey === checkout.nodeKey && e.toKey === inventory.nodeKey)?.namespace, "corpus/acme/services");

        const stats = await store.graphStats({ namespace: "corpus/acme" });
        assert.ok(stats.nodeCount >= 2, "namespaced stats count matching nodes");
        assert.ok(stats.edgeCount >= 2, "namespaced stats count edge/endpoint namespace matches");
    });

    it("GR10 namespace guard prevents deleting an edge outside the subtree", async () => {
        const from = await store.upsertGraphNode({ kind: "service", name: "guarded edge from", namespace: "corpus/acme/ops", agentId });
        const to = await store.upsertGraphNode({ kind: "service", name: "guarded edge to", namespace: "corpus/acme/ops", agentId });
        const ref = await store.upsertGraphEdge({ fromKey: from.nodeKey, toKey: to.nodeKey, predicate: "observes", namespace: "corpus/acme/ops", agentId });

        assert.equal(await store.deleteGraphEdge(from.nodeKey, to.nodeKey, ref.predicateKey, { namespace: "corpus/globex" }), false, "wrong namespace guard blocks delete");
        assert.equal((await store.searchGraphEdges({ fromKey: from.nodeKey, predicateKey: ref.predicateKey }, { unrestricted: true })).length, 1, "edge still exists");
        assert.equal(await store.deleteGraphEdge(from.nodeKey, to.nodeKey, ref.predicateKey, { namespace: "corpus/acme" }), true, "ancestor namespace guard permits delete");
        assert.equal((await store.searchGraphEdges({ fromKey: from.nodeKey, predicateKey: ref.predicateKey }, { unrestricted: true })).length, 0, "edge deleted");
    });

    it("(neg) validation: self-edge, bad confidence, missing predicate", async () => {
        await assert.rejects(() => store.upsertGraphEdge({ fromKey: a.nodeKey, toKey: a.nodeKey, predicate: "is", agentId }), /self-referential/);
        await assert.rejects(() => store.upsertGraphEdge({ fromKey: a.nodeKey, toKey: b.nodeKey, predicate: "is", confidence: 1.5, agentId }), /confidence/);
        await assert.rejects(() => store.upsertGraphEdge({ fromKey: a.nodeKey, toKey: b.nodeKey, predicate: "  ", agentId }), /predicate/);
    });
});
