// §3.4 mergeGraphNodes (GM1–GM4) — entity resolution, hardened repoint.

import test from "node:test";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph } from "./_db.mjs";

test("graph merge (GM1–GM4)", { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { store, schema, graph } = await makeStore({ tag: "gmerge" });
    t.after(async () => { await store.close(); await dropSchemaAndGraph(schema, graph); });
    const agentId = "tester";
    const all = { unrestricted: true };

    const moody = await store.upsertGraphNode({ kind: "person", name: "moody", agentId });
    const alastor = await store.upsertGraphNode({ kind: "person", name: "alastor-moody", aliases: ["Mad-Eye"], agentId });
    const planner = await store.upsertGraphNode({ kind: "component", name: "planner", agentId });
    const vacuum = await store.upsertGraphNode({ kind: "skill", name: "vacuum", agentId });
    // duplicate's edges: in + out, one of which collides with a survivor edge
    await store.upsertGraphEdge({ fromKey: planner.nodeKey, toKey: alastor.nodeKey, predicate: "owned_by", evidence: ["shared:e/1"], agentId });
    await store.upsertGraphEdge({ fromKey: alastor.nodeKey, toKey: vacuum.nodeKey, predicate: "maintains", evidence: ["shared:e/2"], agentId });
    await store.upsertGraphEdge({ fromKey: planner.nodeKey, toKey: moody.nodeKey, predicate: "owned_by", evidence: ["shared:e/3"], agentId }); // survivor already has owned_by

    await t.test("GM1–GM3 merge: aliases unioned, edges repointed (deduped), duplicate gone", async () => {
        await store.mergeGraphNodes(alastor.nodeKey, moody.nodeKey, "same person");

        const [hit] = await store.searchGraphNodes({ kind: "person", nameLike: "moody" }, all);
        assert.equal(hit.nodeKey, "person:moody", "only the survivor remains");
        assert.ok(hit.aliases.includes("Mad-Eye"), "aliases unioned onto survivor");
        assert.ok(hit.aliases.some((a) => a === "alastor-moody"), "duplicate's name becomes an alias");

        const gone = await store.searchGraphNodes({ nameLike: "alastor-moody", kind: "person" }, all);
        assert.ok(!gone.some((h) => h.nodeKey === "person:alastor-moody"), "duplicate removed");

        // owned_by collided with an existing survivor edge → COMBINED, not duplicated.
        const owned = await store.searchGraphEdges({ fromKey: planner.nodeKey, predicate: "owned_by" }, all);
        assert.equal(owned.length, 1, "no duplicate triple after merge");
        assert.equal(owned[0].toKey, "person:moody");
        assert.equal(owned[0].observations, 2, "observations combined");
        assert.deepEqual([...owned[0].evidence].sort(), ["shared:e/1", "shared:e/3"], "evidence unioned");

        // maintains had no collision → plain repoint.
        const maintains = await store.searchGraphEdges({ predicateKey: "maintain" }, all);
        assert.equal(maintains.length, 1);
        assert.equal(maintains[0].fromKey, "person:moody", "outgoing edge repointed to survivor");
    });

    await t.test("GM4 (neg) merge into missing target throws", async () => {
        const x = await store.upsertGraphNode({ kind: "person", name: "temp", agentId });
        await assert.rejects(() => store.mergeGraphNodes(x.nodeKey, "person:never-was", "r"), /target not found/);
    });

    await t.test("merge with missing SOURCE is a silent no-op", async () => {
        await store.mergeGraphNodes("person:never-was", moody.nodeKey, "r");
    });
});
