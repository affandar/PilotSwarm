// §2.4 similarFacts (SF1–SF5) — semantic kNN of a known fact, seeded dim-4
// vectors (deterministic DATA in the real embedding column; exact cosine order
// computed from the seeded vectors, never hard-coded).

import test from "node:test";
import assert from "node:assert/strict";
import {
    HAS_DB, makeStore, dropSchemaAndGraph, rawPool, aclOf,
    FX, fxScopeKey, seedFX, cosine,
} from "./_db.mjs";

test("similarFacts (SF1–SF5)", { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { store, schema, graph } = await makeStore({ tag: "sf", embeddingDim: 4 });
    const pool = rawPool();
    t.after(async () => { await store.close(); await pool.end(); await dropSchemaAndGraph(schema, graph); });

    await seedFX(store, schema, pool);
    const F1 = fxScopeKey(FX[0]);

    await t.test("SF1 nearest neighbour order matches the seeded cosine math; anchor excluded", async () => {
        // Expected order computed FROM the vectors (unrestricted sees all).
        const anchor = FX[0];
        const expected = FX.filter((f) => f.id !== "F1")
            .map((f) => ({ sk: fxScopeKey(f), sim: cosine(anchor.vec, f.vec) }))
            .sort((a, b) => b.sim - a.sim)
            .map((x) => x.sk);
        const res = await store.similarFacts(F1, { k: 5 }, aclOf(null, [], true));
        assert.equal(res.mode, "semantic");
        assert.ok(!res.facts.some((f) => f.scopeKey === F1), "anchor excluded");
        assert.deepEqual(res.facts.map((f) => f.scopeKey), expected);
        // NB: by the actual math, F6 [0.95,0.05] (cos 0.9986) and F5 [0.9,0.1]
        // (0.9938) are MORE parallel to F1 than F2 [0.97,0.24] (0.9707) — the
        // expected order is computed, never assumed (04 §1.1's illustrative
        // "F2 first" row gets this wrong).
        assert.equal(res.facts[0].scopeKey, fxScopeKey(FX[5]), "F6 is the closest to F1 by cosine");
        const orthogonalRank = res.facts.findIndex((f) => f.scopeKey === fxScopeKey(FX[2]));
        assert.ok(orthogonalRank >= 3, "orthogonal F3 ranks below all near-parallel vectors");
        for (const f of res.facts) assert.ok(typeof f.signals.semantic === "number");
    });

    await t.test("SF2 k bound", async () => {
        const res = await store.similarFacts(F1, { k: 2 }, aclOf(null, [], true));
        assert.ok(res.facts.length <= 2);
    });

    await t.test("SF3 minScore filters by cosine", async () => {
        // Threshold chosen from the seeded math: keep only F2 (and ACL-visible
        // near-parallels), exclude orthogonals F3/F4.
        const res = await store.similarFacts(F1, { k: 10, minScore: 0.5 }, aclOf(null, [], true));
        const keys = res.facts.map((f) => f.scopeKey);
        assert.ok(keys.includes(fxScopeKey(FX[1])));
        assert.ok(!keys.includes(fxScopeKey(FX[2])), "orthogonal F3 excluded");
        assert.ok(!keys.includes(fxScopeKey(FX[3])), "orthogonal F4 excluded");
    });

    await t.test("SF4 (neg) unknown scope_key → empty", async () => {
        const res = await store.similarFacts("shared:never/was", { k: 5 }, aclOf(null, [], true));
        assert.deepEqual(res, { count: 0, mode: "semantic", facts: [] });
    });

    await t.test("SF5 (neg/acl) existing-but-inaccessible anchor ≡ unknown (deep-equal, no oracle)", async () => {
        const anchorPrivate = fxScopeKey(FX[5]); // session:S2:notes/b — S1 cannot read it
        const asS1 = await store.similarFacts(anchorPrivate, { k: 5 }, aclOf("S1"));
        const unknown = await store.similarFacts("shared:never/was", { k: 5 }, aclOf("S1"));
        assert.deepEqual(asS1, unknown, "inaccessible anchor must be byte-identical to unknown");
        assert.equal(asS1.count, 0);
    });

    await t.test("results are ACL-scoped: S1 reader never sees S2's F6", async () => {
        const res = await store.similarFacts(F1, { k: 10 }, aclOf("S1"));
        const keys = res.facts.map((f) => f.scopeKey);
        assert.ok(keys.includes(fxScopeKey(FX[4])), "own session fact visible");
        assert.ok(!keys.includes(fxScopeKey(FX[5])), "other session's fact filtered");
    });

    await t.test("(S4 twin) anchor with NULL embedding → empty, not a crash", async () => {
        await store.storeFact({ key: "skills/no-vec", value: { text: "unembedded" }, shared: true });
        const res = await store.similarFacts("shared:skills/no-vec", { k: 5 }, aclOf(null, [], true));
        assert.equal(res.count, 0);
    });
});
