// §2.7 ACL scoping (A1–A5). A5 proves the ACL predicate lives INSIDE the
// search proc, before rank/LIMIT — not a post-filter over a bounded pool.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, rawPool, aclOf, seedFX, fxScopeKey, FX } from "./_db.mjs";

describe.skipIf(!HAS_DB)("ACL scoping (A1–A5)", () => {
    let store, schema, graph, pool;
    const F5 = fxScopeKey(FX[4]); // session:S1
    const F6 = fxScopeKey(FX[5]); // session:S2

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "acl", embeddingDim: 4 }));
        pool = rawPool();
        await seedFX(store, schema, pool);
    });
    afterAll(async () => {
        await store?.close();
        await pool?.end();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    const searchKeys = async (access) =>
        (await store.searchFacts("jsonb subscript", { mode: "lexical", limit: 50 }, access))
            .facts.map((f) => f.scopeKey);

    it("A1 S1 reader sees shared + S1, never S2's F6", async () => {
        const keys = await searchKeys(aclOf("S1"));
        assert.ok(keys.includes(F5));
        assert.ok(!keys.includes(F6));
        assert.ok(keys.includes(fxScopeKey(FX[0])), "shared visible");
    });

    it("A2 grantedSessionIds extends visibility", async () => {
        const keys = await searchKeys(aclOf("S1", ["S2"]));
        assert.ok(keys.includes(F6), "granted S2 fact now visible");
    });

    it("A3 unrestricted sees all", async () => {
        const keys = await searchKeys(aclOf(null, [], true));
        assert.ok(keys.includes(F5) && keys.includes(F6));
    });

    it("A4 (neg) no reader context → session facts excluded", async () => {
        const keys = await searchKeys({});
        assert.ok(!keys.includes(F5) && !keys.includes(F6));
        assert.ok(keys.includes(fxScopeKey(FX[0])), "shared still visible");
    });

    it("A5 ACL precedes ranking: accessible match survives a pool of dominating inaccessible rows", async () => {
        // Engineer >candidatePool inaccessible facts that all outrank the
        // caller's single accessible match for the term "starve".
        const POOL = 10;
        for (let i = 0; i < POOL + 15; i++) {
            await store.storeFact({
                key: `noise/starve-${i}`,
                value: { text: "starve starve starve starve starve starve" }, // heavy term frequency → outranks
                sessionId: "S-OTHER",
            });
        }
        await store.storeFact({
            key: "mine/starve-needle",
            value: { text: "a single starve mention" },                      // weak match, but MINE
            sessionId: "S-CALLER",
        });
        const res = await store.searchFacts(
            "starve", { mode: "lexical", candidatePool: POOL, limit: POOL }, aclOf("S-CALLER"));
        const keys = res.facts.map((f) => f.scopeKey);
        assert.ok(keys.includes("session:S-CALLER:mine/starve-needle"),
            "accessible match must be returned even though >pool inaccessible rows outrank it (ACL in WHERE, not post-filter)");
        assert.ok(!keys.some((k) => k.startsWith("session:S-OTHER:")), "no leakage of inaccessible rows");
    });

    it("readFacts scope=descendants returns spawn-tree facts only", async () => {
        const { facts } = await store.readFacts({ scope: "descendants" }, aclOf("PARENT", ["S1", "S2"]));
        const keys = facts.map((f) => f.scopeKey).sort();
        assert.deepEqual(keys.filter((k) => k.startsWith("session:S1") || k.startsWith("session:S2")), keys,
            "descendants scope yields only granted-session facts");
        assert.ok(keys.includes(F5) && keys.includes(F6));
    });
});
