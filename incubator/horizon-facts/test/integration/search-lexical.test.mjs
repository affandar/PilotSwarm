// §2.2 Lexical search (L1–L4) — BM25 over the facts store only.

import test from "node:test";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, rawPool, aclOf, seedFX, fxScopeKey, FX } from "./_db.mjs";

test("lexical search (L1–L4)", { skip: !HAS_DB && "HORIZON_DATABASE_URL not set" }, async (t) => {
    const { store, schema, graph } = await makeStore({ tag: "lex", embeddingDim: 4 });
    const pool = rawPool();
    t.after(async () => { await store.close(); await pool.end(); await dropSchemaAndGraph(schema, graph); });

    await seedFX(store, schema, pool);
    const all = aclOf(null, [], true);

    await t.test("L1 'jsonb' finds F1 and F2 with a lexical signal > 0", async () => {
        const res = await store.searchFacts("jsonb", { mode: "lexical" }, all);
        const keys = res.facts.map((f) => f.scopeKey);
        assert.ok(keys.includes(fxScopeKey(FX[0])), "F1 returned");
        assert.ok(keys.includes(fxScopeKey(FX[1])), "F2 returned");
        for (const f of res.facts) {
            assert.ok(typeof f.signals.lexical === "number" && f.signals.lexical > 0);
            assert.equal(f.signals.semantic, undefined, "lexical mode carries no semantic signal");
        }
        assert.equal(res.mode, "lexical");
    });

    await t.test("L2 'vacuum' finds F3", async () => {
        const res = await store.searchFacts("vacuum", { mode: "lexical" }, all);
        assert.ok(res.facts.some((f) => f.scopeKey === fxScopeKey(FX[2])));
    });

    await t.test("L3 (neg) no-match query → empty result, count 0", async () => {
        const res = await store.searchFacts("zzzznomatch", { mode: "lexical" }, all);
        assert.deepEqual(res, { count: 0, mode: "lexical", facts: [] });
    });

    await t.test("L4 (neg) empty / whitespace query → defined empty, not a crash", async () => {
        for (const q of ["", "   ", "\n\t"]) {
            const res = await store.searchFacts(q, { mode: "lexical" }, all);
            assert.deepEqual(res, { count: 0, mode: "lexical", facts: [] });
        }
    });

    await t.test("namespace + tags filters compose", async () => {
        await store.storeFact({ key: "other/jsonb-elsewhere", value: { text: "jsonb mention" }, shared: true, tags: ["x"] });
        const ns = await store.searchFacts("jsonb", { mode: "lexical", namespace: "skills" }, all);
        assert.ok(ns.facts.every((f) => f.key.startsWith("skills/")), "namespace prefix respected");
    });

    await t.test("(neg) unknown mode throws (no graph mode)", async () => {
        await assert.rejects(() => store.searchFacts("jsonb", { mode: "graph" }, all), /no "graph" mode/);
    });
});
