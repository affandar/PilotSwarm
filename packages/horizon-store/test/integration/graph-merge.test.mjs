// §3.4 mergeGraphNodes (GM1–GM4) — entity resolution, hardened repoint.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph } from "./_db.mjs";

describe.skipIf(!HAS_DB)("graph merge (GM1–GM4)", () => {
    let store, schema, graph, moody, alastor, planner, vacuum;
    const agentId = "tester";
    const all = { unrestricted: true };

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "gmerge" }));
        moody = await store.upsertGraphNode({ kind: "person", name: "moody", agentId });
        alastor = await store.upsertGraphNode({ kind: "person", name: "alastor-moody", aliases: ["Mad-Eye"], agentId });
        planner = await store.upsertGraphNode({ kind: "component", name: "planner", agentId });
        vacuum = await store.upsertGraphNode({ kind: "skill", name: "vacuum", agentId });
        // duplicate's edges: in + out, one of which collides with a survivor edge
        await store.upsertGraphEdge({ fromKey: planner.nodeKey, toKey: alastor.nodeKey, predicate: "owned_by", evidence: ["shared:e/1"], agentId });
        await store.upsertGraphEdge({ fromKey: alastor.nodeKey, toKey: vacuum.nodeKey, predicate: "maintains", evidence: ["shared:e/2"], agentId });
        await store.upsertGraphEdge({ fromKey: planner.nodeKey, toKey: moody.nodeKey, predicate: "owned_by", evidence: ["shared:e/3"], agentId }); // survivor already has owned_by
    });
    afterAll(async () => {
        await store?.close();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("GM0 namespace guard prevents merging nodes outside the subtree", async () => {
        const dup = await store.upsertGraphNode({ kind: "service", name: "namespace merge duplicate", namespace: "corpus/acme/services", agentId });
        const survivor = await store.upsertGraphNode({ kind: "service", name: "namespace merge survivor", namespace: "corpus/acme/services", agentId });
        await store.mergeGraphNodes(dup.nodeKey, survivor.nodeKey, "wrong guard", { namespace: "corpus/globex" });
        assert.equal((await store.searchGraphNodes({ seeds: [dup.nodeKey] }, all)).length, 1, "wrong namespace guard is a no-op");

        await store.mergeGraphNodes(dup.nodeKey, survivor.nodeKey, "same service", { namespace: "corpus/acme" });
        assert.equal((await store.searchGraphNodes({ seeds: [dup.nodeKey] }, all)).length, 0, "ancestor namespace guard permits merge");
        const [hit] = await store.searchGraphNodes({ seeds: [survivor.nodeKey] }, all);
        assert.equal(hit.namespace, "corpus/acme/services", "survivor namespace is preserved");
    });

    it("GM1–GM3 merge: aliases unioned, edges repointed (deduped), duplicate gone", async () => {
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

    it("GM4 (neg) merge into missing target throws", async () => {
        const x = await store.upsertGraphNode({ kind: "person", name: "temp", agentId });
        await assert.rejects(() => store.mergeGraphNodes(x.nodeKey, "person:never-was", "r"), /target not found/);
    });

    it("merge with missing SOURCE is a silent no-op", async () => {
        await store.mergeGraphNodes("person:never-was", moody.nodeKey, "r");
    });
});
