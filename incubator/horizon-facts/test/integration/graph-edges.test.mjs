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

    it("(neg) validation: self-edge, bad confidence, missing predicate", async () => {
        await assert.rejects(() => store.upsertGraphEdge({ fromKey: a.nodeKey, toKey: a.nodeKey, predicate: "is", agentId }), /self-referential/);
        await assert.rejects(() => store.upsertGraphEdge({ fromKey: a.nodeKey, toKey: b.nodeKey, predicate: "is", confidence: 1.5, agentId }), /confidence/);
        await assert.rejects(() => store.upsertGraphEdge({ fromKey: a.nodeKey, toKey: b.nodeKey, predicate: "  ", agentId }), /predicate/);
    });
});
