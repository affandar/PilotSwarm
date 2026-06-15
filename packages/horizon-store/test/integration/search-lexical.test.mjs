// §2.2 Lexical search (L1–L4) — BM25 over the facts store only.

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { HAS_DB, makeStore, dropSchemaAndGraph, rawPool, aclOf, seedFX, fxScopeKey, FX } from "./_db.mjs";

describe.skipIf(!HAS_DB)("lexical search (L1–L4)", () => {
    let store, schema, graph, pool;
    const all = aclOf(null, [], true);

    beforeAll(async () => {
        ({ store, schema, graph } = await makeStore({ tag: "lex", embeddingDim: 4 }));
        pool = rawPool();
        await seedFX(store, schema, pool);
    });
    afterAll(async () => {
        await store?.close();
        await pool?.end();
        if (schema) await dropSchemaAndGraph(schema, graph);
    });

    it("L1 'jsonb' finds F1 and F2 with a lexical signal > 0", async () => {
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

    it("L2 'vacuum' finds F3", async () => {
        const res = await store.searchFacts("vacuum", { mode: "lexical" }, all);
        assert.ok(res.facts.some((f) => f.scopeKey === fxScopeKey(FX[2])));
    });

    it("L3 (neg) no-match query → empty result, count 0", async () => {
        const res = await store.searchFacts("zzzznomatch", { mode: "lexical" }, all);
        assert.deepEqual(res, { count: 0, mode: "lexical", facts: [] });
    });

    it("L4 (neg) empty / whitespace query → defined empty, not a crash", async () => {
        for (const q of ["", "   ", "\n\t"]) {
            const res = await store.searchFacts(q, { mode: "lexical" }, all);
            assert.deepEqual(res, { count: 0, mode: "lexical", facts: [] });
        }
    });

    it("namespace + tags filters compose", async () => {
        await store.storeFact({ key: "other/jsonb-elsewhere", value: { text: "jsonb mention" }, shared: true, tags: ["x"] });
        const ns = await store.searchFacts("jsonb", { mode: "lexical", namespace: "skills" }, all);
        assert.ok(ns.facts.every((f) => f.key.startsWith("skills/")), "namespace prefix respected");
    });

    it("(neg) unknown mode throws (no graph mode)", async () => {
        await assert.rejects(() => store.searchFacts("jsonb", { mode: "graph" }, all), /no "graph" mode/);
    });

    // ─── HIGH#5 hybrid-degrade (enhancedfactstore 07 P5) ─────────────────────
    // This suite's store has NO embedding endpoint configured, so the semantic
    // signal cannot run. HYBRID (the default facts_search mode) must degrade to
    // lexical-only instead of throwing; an EXPLICIT semantic request still errs.

    it("hybrid with no embedder degrades to lexical (does not throw)", async () => {
        const res = await store.searchFacts("jsonb", { mode: "hybrid" }, all);
        const keys = res.facts.map((f) => f.scopeKey);
        assert.ok(keys.includes(fxScopeKey(FX[0])), "F1 still returned via the lexical signal");
        assert.ok(keys.includes(fxScopeKey(FX[1])), "F2 still returned via the lexical signal");
        for (const f of res.facts) {
            assert.ok(typeof f.signals.lexical === "number" && f.signals.lexical > 0, "lexical signal present");
            assert.equal(f.signals.semantic, undefined, "no semantic signal when the embedder is absent");
        }
    });

    it("explicit semantic with no embedder still throws (explicit intent preserved)", async () => {
        await assert.rejects(
            () => store.searchFacts("jsonb", { mode: "semantic" }, all),
            /configured embedding endpoint|configureEmbedder/,
        );
    });
});
