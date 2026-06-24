// §2.8 Lineage (LN1–LN3) — base readFacts({scope:"descendants"}); ranking via
// searchFacts. There is NO dedicated lineageFacts method (02 §7).

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, aclOf } from "./_db.mjs";

describe.skipIf(!HAS_DB)("lineage via base readFacts (LN1–LN3)", () => {
    let store, schema, graph;

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "lin" }));
        await store.storeFact({ key: "notes/child1", value: { text: "jsonb child one" }, sessionId: "CHILD-1" });
        await store.storeFact({ key: "notes/child2", value: { text: "vacuum child two" }, sessionId: "CHILD-2" });
        await store.storeFact({ key: "notes/stranger", value: { text: "outside the tree" }, sessionId: "STRANGER" });
        await store.storeFact({ key: "skills/shared-ln", value: { text: "shared" }, shared: true });
    });
    afterAll(async () => {
        await store?.close();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("LN1 descendants scope returns spawn-tree facts only", async () => {
        const { facts } = await store.readFacts(
            { scope: "descendants" }, aclOf("PARENT", ["CHILD-1", "CHILD-2"]));
        const keys = facts.map((f) => f.scopeKey).sort();
        assert.deepEqual(keys, ["session:CHILD-1:notes/child1", "session:CHILD-2:notes/child2"]);
    });

    it("LN2 lineage ranked via searchFacts with the same grants", async () => {
        const res = await store.searchFacts("jsonb",
            { mode: "lexical", scope: "descendants" }, aclOf("PARENT", ["CHILD-1", "CHILD-2"]));
        assert.equal(res.facts.length, 1);
        assert.equal(res.facts[0].scopeKey, "session:CHILD-1:notes/child1");
    });

    it("LN3 (neg) unknown session → empty", async () => {
        const { count } = await store.readFacts({ scope: "descendants" }, aclOf("NOBODY", []));
        assert.equal(count, 0);
    });
});
