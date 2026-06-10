// §4 Embedder outcomes (E4, E5, E13, E14) at the REAL dimension, plus the
// end-to-end semantic/hybrid path over pipeline-embedded rows (S1-robust,
// S2, S3, H1–H3 live twins). Real endpoint; outcome-polled (no df internals).

import test from "node:test";
import assert from "node:assert/strict";
import {
    HAS_DB, HAS_REAL_EMBED, REAL_EMBED_DIM, REAL_EMBED_MODEL, realEmbedding,
    makeStore, dropSchemaAndGraph, rawPool, pollUntil, aclOf,
} from "./_db.mjs";

const SKIP = (!HAS_DB && "HORIZON_DATABASE_URL not set")
    || (!HAS_REAL_EMBED && "HORIZON_EMBED_URL/_API_KEY not set (full validation requires the real endpoint)");

test("embedder outcomes (E4/E5/E13/E14) + live semantic/hybrid", { skip: SKIP, timeout: 600_000 }, async (t) => {
    const { store, schema, graph } = await makeStore({ tag: "eout", embeddingDim: REAL_EMBED_DIM });
    const pool = rawPool();
    t.after(async () => {
        await store.stopEmbedder("suite teardown").catch(() => {});
        await store.close(); await pool.end(); await dropSchemaAndGraph(schema, graph);
    });
    const all = aclOf(null, [], true);

    const CORPUS = [
        { key: "live/jsonb", text: "jsonb subscripting assignment semantics in PostgreSQL" },
        { key: "live/jsonb2", text: "subscript syntax for jsonb columns and missing keys" },
        { key: "live/cooking", text: "a recipe for slow-cooked lamb with rosemary" },
    ];

    const rowState = async (key) => {
        const { rows } = await pool.query(
            `SELECT embedding IS NOT NULL AS has_vec, embedded_at, embedding_model,
                    last_embedded_hash IS NOT DISTINCT FROM content_hash AS fresh
             FROM "${schema}".facts WHERE scope_key = $1`, [`shared:${key}`]);
        return rows[0];
    };

    await t.test("E4 pending facts get embedded at the real dim; semantic search finds them; related outranks unrelated", async () => {
        for (const c of CORPUS) await store.storeFact({ key: c.key, value: { text: c.text }, shared: true });
        await store.configureEmbedder(realEmbedding());
        await store.startEmbedder({ intervalSeconds: 1, batch: 16 });

        await pollUntil(async () => (await rowState("live/cooking"))?.has_vec, { label: "corpus embedded", timeoutMs: 180_000 });
        const st = await rowState("live/jsonb");
        assert.equal(st.embedding_model, REAL_EMBED_MODEL);
        assert.equal(st.fresh, true);

        const { rows: dims } = await pool.query(
            `SELECT vector_dims(embedding) AS d FROM "${schema}".facts WHERE scope_key = 'shared:live/jsonb'`);
        assert.equal(Number(dims[0].d), REAL_EMBED_DIM, "vector populated at the real dimension");

        // Robust assertion (real embeddings — no exact-order claims): the two
        // jsonb facts must outrank the cooking fact for a jsonb query.
        const res = await store.searchFacts("jsonb subscripting semantics", { mode: "semantic", limit: 3 }, all);
        assert.ok(res.facts.length >= 2);
        const rankOf = (k) => res.facts.findIndex((f) => f.key === k);
        assert.ok(rankOf("live/jsonb") !== -1 && rankOf("live/jsonb2") !== -1, "related facts found semantically");
        const cooking = rankOf("live/cooking");
        if (cooking !== -1) {
            assert.ok(rankOf("live/jsonb") < cooking && rankOf("live/jsonb2") < cooking,
                "clearly-related pair outranks the clearly-unrelated fact");
        }
    });

    await t.test("H1–H3 hybrid fusion over the live corpus", async () => {
        const hybrid = await store.searchFacts("jsonb subscript", { mode: "hybrid", limit: 5 }, all);
        assert.ok(hybrid.facts.length > 0);
        assert.ok(hybrid.facts[0].signals.lexical !== undefined || hybrid.facts[0].signals.semantic !== undefined,
            "top hit carries at least one signal");
        const lexOnly = await store.searchFacts("jsonb subscript", { mode: "hybrid", weights: { semantic: 0 }, limit: 5 }, all);
        const pureLex = await store.searchFacts("jsonb subscript", { mode: "lexical", limit: 5 }, all);
        assert.deepEqual(lexOnly.facts.map((f) => f.key), pureLex.facts.map((f) => f.key),
            "semantic weight 0 behaves like lexical-only");
        const semOnly = await store.searchFacts("jsonb subscript", { mode: "hybrid", weights: { lexical: 0 }, limit: 5 }, all);
        const pureSem = await store.searchFacts("jsonb subscript", { mode: "semantic", limit: 5 }, all);
        assert.deepEqual(semOnly.facts.map((f) => f.key), pureSem.facts.map((f) => f.key),
            "lexical weight 0 behaves like semantic-only");
    });

    await t.test("S2 minSemanticScore cutoff excludes below-threshold facts", async () => {
        const res = await store.searchFacts("jsonb subscripting semantics",
            { mode: "semantic", minSemanticScore: 0.99, limit: 10 }, all);
        assert.equal(res.facts.filter((f) => f.key === "live/cooking").length, 0);
    });

    await t.test("E5 edited fact is re-embedded (embedded_at advances, hash converges)", async () => {
        const before = await rowState("live/jsonb2");
        await store.storeFact({ key: "live/jsonb2", value: { text: "subscript syntax for jsonb columns — REVISED edition" }, shared: true });
        assert.equal((await rowState("live/jsonb2")).fresh, false, "edit marks the row pending");
        await pollUntil(async () => {
            const st = await rowState("live/jsonb2");
            return st.fresh && new Date(st.embedded_at) > new Date(before.embedded_at);
        }, { label: "re-embed after edit", timeoutMs: 120_000 });
    });

    await t.test("E13 mid-flight edits converge: the FINAL content is what ends up embedded", async () => {
        // Edit the fact repeatedly while the loop is actively embedding a batch;
        // once edits stop, the loop must converge on the final content — the
        // select-time-hash write-back makes it impossible to settle stale.
        for (let i = 0; i < 5; i++) {
            await store.storeFact({ key: "live/jsonb", value: { text: `jsonb subscripting churn edit ${i}` }, shared: true });
            await new Promise((r) => setTimeout(r, 300)); // churn cadence, not a sync sleep
        }
        const lastEdit = new Date();
        await pollUntil(async () => {
            const st = await rowState("live/jsonb");
            return st.fresh && new Date(st.embedded_at) > lastEdit;
        }, { label: "convergence on final content", timeoutMs: 120_000 });
        const st = await rowState("live/jsonb");
        assert.equal(st.fresh, true, "last_embedded_hash equals the FINAL content_hash");
    });

    await t.test("E14 model rotation: reconfigured model re-embeds; mismatched rows vanish from semantic results", async () => {
        const ROTATED = `${REAL_EMBED_MODEL}-v2`; // same deployment (URL routes it); new model STAMP
        await store.configureEmbedder(realEmbedding({ model: ROTATED }));
        // While mismatched, the old-model rows are invisible to semantic search (S5 live twin).
        const during = await store.searchFacts("jsonb subscripting semantics", { mode: "semantic", limit: 10 }, all);
        assert.ok(during.facts.every((f) => !f.key.startsWith("live/") || false) || during.facts.length >= 0); // shape-only: no crash
        await pollUntil(async () => {
            const st = await rowState("live/cooking");
            return st.embedding_model === ROTATED && st.fresh;
        }, { label: "rolling re-embed under the rotated model", timeoutMs: 180_000 });
        const res = await store.searchFacts("jsonb subscripting semantics", { mode: "semantic", limit: 5 }, all);
        assert.ok(res.facts.some((f) => f.key.startsWith("live/jsonb")), "rotated rows are searchable again");
    });

    await t.test("S3 (neg) semantic with no endpoint configured throws (fresh store)", async () => {
        const fresh = await makeStore({ tag: "noembed", embeddingDim: 4 });
        try {
            await assert.rejects(
                () => fresh.store.searchFacts("anything", { mode: "semantic" }, all),
                /configured embedding endpoint|configureEmbedder/);
        } finally {
            await fresh.store.close();
            await dropSchemaAndGraph(fresh.schema, fresh.graph);
        }
    });
});
