// §3.5 Graph deletes (GD1–GD5) — exact-triple delete, DETACH DELETE, no cascade.

import test from "node:test";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph } from "./_db.mjs";

test("graph deletes (GD1–GD5)", { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { store, schema, graph } = await makeStore({ tag: "gdel" });
    t.after(async () => { await store.close(); await dropSchemaAndGraph(schema, graph); });
    const agentId = "tester";
    const all = { unrestricted: true };

    await t.test("GD1 deleteGraphEdge exact triple", async () => {
        const a = await store.upsertGraphNode({ kind: "t", name: "a", agentId });
        const b = await store.upsertGraphNode({ kind: "t", name: "b", agentId });
        const e = await store.upsertGraphEdge({ fromKey: a.nodeKey, toKey: b.nodeKey, predicate: "links", agentId });
        assert.equal(await store.deleteGraphEdge(a.nodeKey, b.nodeKey, e.predicateKey), true);
        assert.deepEqual(await store.searchGraphEdges({ fromKey: a.nodeKey }, all), []);
    });

    await t.test("GD2 deleteGraphNode removes node + all incident edges (DETACH)", async () => {
        const c = await store.upsertGraphNode({ kind: "t", name: "c", agentId });
        const d = await store.upsertGraphNode({ kind: "t", name: "d", agentId });
        await store.upsertGraphEdge({ fromKey: c.nodeKey, toKey: d.nodeKey, predicate: "links", agentId });
        await store.upsertGraphEdge({ fromKey: d.nodeKey, toKey: c.nodeKey, predicate: "links back", agentId });
        assert.equal(await store.deleteGraphNode(c.nodeKey), true);
        assert.deepEqual(await store.searchGraphNodes({ kind: "t", nameLike: "c" }, all), []);
        assert.deepEqual(await store.searchGraphEdges({ fromKey: d.nodeKey }, all), [], "incident edges gone");
    });

    await t.test("GD3/GD4 (neg) unknown triple / node → false", async () => {
        assert.equal(await store.deleteGraphEdge("t:x", "t:y", "never"), false);
        assert.equal(await store.deleteGraphNode("t:never-was"), false);
    });

    await t.test("GD5 NO cascade: deleteFact leaves graph provenance in place", async () => {
        await store.storeFact({ key: "arch/gd5", value: { text: "evidence fact" }, shared: true });
        const node = await store.upsertGraphNode({ kind: "t", name: "evidenced", agentId, evidence: ["shared:arch/gd5"] });
        await store.deleteFact({ key: "arch/gd5", shared: true });
        const [hit] = await store.searchGraphNodes({ kind: "t", nameLike: "evidenced" }, all);
        assert.ok(hit, "node survives fact deletion");
        assert.deepEqual(hit.evidence, ["shared:arch/gd5"],
            "provenance still references the deleted fact (cleanup is a future gcGraph pass)");
        assert.equal(node.nodeKey, hit.nodeKey);
    });
});
