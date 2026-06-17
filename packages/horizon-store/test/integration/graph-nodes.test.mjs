// §3.1 upsertGraphNode (GE1–GE5). Tests build on each other sequentially.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph } from "./_db.mjs";

describe.skipIf(!HAS_DB)("graph nodes (GE1–GE5)", () => {
    let store, schema, graph;
    const agentId = "tester";

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "gnode" }));
    });
    afterAll(async () => {
        await store?.close();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("GE1 new node: created true, canonical node_key", async () => {
        const ref = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId });
        assert.equal(ref.created, true);
        assert.equal(ref.nodeKey, "person:tom-lane");
        assert.deepEqual(ref.aliases, ["Tom Lane"]);
    });

    it("GE2 upsert same name: created false, merged", async () => {
        const ref = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId });
        assert.equal(ref.created, false);
        assert.equal(ref.nodeKey, "person:tom-lane");
    });

    it("GE3 new aliases union in", async () => {
        const ref = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", aliases: ["tgl"], agentId });
        assert.ok(ref.aliases.includes("tgl"));
        assert.ok(ref.aliases.includes("Tom Lane"));
        const again = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", aliases: ["tgl"], agentId });
        assert.equal(again.aliases.filter((a) => a === "tgl").length, 1, "alias union is idempotent");
    });

    it("GE4 evidence unions onto the node (EVIDENCED_BY anchors)", async () => {
        await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId, evidence: ["shared:arch/m1"] });
        await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId, evidence: ["shared:arch/m1", "shared:arch/m2"] });
        const hits = await store.searchGraphNodes({ kind: "person", nameLike: "tom lane" }, { unrestricted: true });
        assert.equal(hits.length, 1);
        assert.deepEqual([...hits[0].evidence].sort(), ["shared:arch/m1", "shared:arch/m2"], "evidence unioned, deduped");
    });

    it("GE4b namespace persists, searches by exact/subtree prefix, and legacy nodes are excluded", async () => {
        const checkout = await store.upsertGraphNode({
            kind: "service",
            name: "Checkout API",
            namespace: "corpus/acme/services",
            agentId,
            evidence: ["shared:corpus/acme/doc1"],
        });
        const billing = await store.upsertGraphNode({
            kind: "service",
            name: "Billing API",
            namespace: "corpus/acme/billing",
            agentId,
        });
        await store.upsertGraphNode({ kind: "service", name: "Robotics API", namespace: "corpus/globex/services", agentId });
        assert.equal(checkout.namespace, "corpus/acme/services", "created ref carries namespace");

        const preserved = await store.upsertGraphNode({ kind: "service", name: "Checkout API", agentId });
        assert.equal(preserved.created, false, "idempotent upsert hits existing node");
        assert.equal(preserved.namespace, "corpus/acme/services", "idempotent upsert preserves existing namespace when omitted");

        const acme = await store.searchGraphNodes({ namespace: "corpus/acme", limit: 20 }, { unrestricted: true });
        const acmeKeys = acme.map((h) => h.nodeKey).sort();
        assert.deepEqual(acmeKeys, [billing.nodeKey, checkout.nodeKey].sort(), "namespace subtree includes both acme descendants only");
        assert.ok(acme.every((h) => h.namespace?.startsWith("corpus/acme/")), "hits expose namespace");

        const exact = await store.searchGraphNodes({ namespace: "corpus/acme/services", limit: 20 }, { unrestricted: true });
        assert.deepEqual(exact.map((h) => h.nodeKey), [checkout.nodeKey], "exact namespace also includes its subtree, here only checkout");

        const none = await store.searchGraphNodes({ namespace: "corpus/acme", kind: "person", limit: 20 }, { unrestricted: true });
        assert.equal(none.length, 0, "legacy un-namespaced Tom Lane is excluded by namespace filter");
    });

    it("GE5 (neg) empty name/kind rejected with clear error", async () => {
        await assert.rejects(() => store.upsertGraphNode({ kind: "", name: "x", agentId }), /kind and name/);
        await assert.rejects(() => store.upsertGraphNode({ kind: "person", name: "  ", agentId }), /kind and name/);
        await assert.rejects(() => store.upsertGraphNode({ kind: "person", name: "x" }), /agentId/);
    });

    it("GE5b namespace guard prevents deleting a node outside the subtree", async () => {
        const target = await store.upsertGraphNode({ kind: "service", name: "Guarded Delete API", namespace: "corpus/acme/ops", agentId });
        assert.equal(await store.deleteGraphNode(target.nodeKey, { namespace: "corpus/globex" }), false, "wrong namespace guard blocks delete");
        assert.equal((await store.searchGraphNodes({ seeds: [target.nodeKey] }, { unrestricted: true })).length, 1, "node still exists");
        assert.equal(await store.deleteGraphNode(target.nodeKey, { namespace: "corpus/acme" }), true, "ancestor namespace guard permits delete");
        assert.equal((await store.searchGraphNodes({ seeds: [target.nodeKey] }, { unrestricted: true })).length, 0, "node deleted");
    });

    it("GE6 single quotes / backslashes in name + alias round-trip (Cypher escaping)", async () => {
        // Regression: AGE's Cypher parser needs backslash-escaped quotes (\'),
        // not SQL-style doubling (''). A name like "Andres's VM" previously threw
        // `syntax error at or near "'s VM'"` and the node silently failed to persist.
        const tricky = "Andres's VM \\ \"quote\"";
        const ref = await store.upsertGraphNode({
            kind: "concept", name: tricky, aliases: ["O'Brien's box"], agentId, evidence: ["shared:arch/m1"],
        });
        assert.equal(ref.created, true, "apostrophe/backslash node persists (not dropped by a syntax error)");
        // It must be findable, and the exact name/alias must round-trip intact.
        const hits = await store.searchGraphNodes({ kind: "concept", nameLike: "andres" }, { unrestricted: true });
        assert.equal(hits.length, 1, "node with special chars is searchable");
        assert.equal(hits[0].name, tricky, "name round-trips byte-for-byte");
        assert.ok(hits[0].aliases.includes("O'Brien's box"), "apostrophe alias round-trips");
        // Re-upsert resolves to the SAME node (escaping is stable across calls).
        const again = await store.upsertGraphNode({ kind: "concept", name: tricky, agentId });
        assert.equal(again.created, false, "re-upsert of special-char name merges, not duplicates");
        assert.equal(again.nodeKey, ref.nodeKey);
    });
});
