// §3.1 upsertGraphNode (GE1–GE5).

import test from "node:test";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph } from "./_db.mjs";

test("graph nodes (GE1–GE5)", { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { store, schema, graph } = await makeStore({ tag: "gnode" });
    t.after(async () => { await store.close(); await dropSchemaAndGraph(schema, graph); });
    const agentId = "tester";

    await t.test("GE1 new node: created true, canonical node_key", async () => {
        const ref = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId });
        assert.equal(ref.created, true);
        assert.equal(ref.nodeKey, "person:tom-lane");
        assert.deepEqual(ref.aliases, ["Tom Lane"]);
    });

    await t.test("GE2 upsert same name: created false, merged", async () => {
        const ref = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId });
        assert.equal(ref.created, false);
        assert.equal(ref.nodeKey, "person:tom-lane");
    });

    await t.test("GE3 new aliases union in", async () => {
        const ref = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", aliases: ["tgl"], agentId });
        assert.ok(ref.aliases.includes("tgl"));
        assert.ok(ref.aliases.includes("Tom Lane"));
        const again = await store.upsertGraphNode({ kind: "person", name: "Tom Lane", aliases: ["tgl"], agentId });
        assert.equal(again.aliases.filter((a) => a === "tgl").length, 1, "alias union is idempotent");
    });

    await t.test("GE4 evidence unions onto the node (EVIDENCED_BY anchors)", async () => {
        await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId, evidence: ["shared:arch/m1"] });
        await store.upsertGraphNode({ kind: "person", name: "Tom Lane", agentId, evidence: ["shared:arch/m1", "shared:arch/m2"] });
        const hits = await store.searchGraphNodes({ kind: "person", nameLike: "tom lane" }, { unrestricted: true });
        assert.equal(hits.length, 1);
        assert.deepEqual([...hits[0].evidence].sort(), ["shared:arch/m1", "shared:arch/m2"], "evidence unioned, deduped");
    });

    await t.test("GE5 (neg) empty name/kind rejected with clear error", async () => {
        await assert.rejects(() => store.upsertGraphNode({ kind: "", name: "x", agentId }), /kind and name/);
        await assert.rejects(() => store.upsertGraphNode({ kind: "person", name: "  ", agentId }), /kind and name/);
        await assert.rejects(() => store.upsertGraphNode({ kind: "person", name: "x" }), /agentId/);
    });
});
