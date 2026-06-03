// Integration — pg_durable HTTP embedding pipeline.
//
// Verifies the embedding write path end to end:
//   1. Node fallback (embedPending): the Node EmbeddingClient embeds pending
//      facts and writes vectors. Works against any reachable DB.
//   2. In-DB HTTP path (sql/006 / setupHttpEmbedding): probes the `http`
//      extension and, IF the embedding endpoint is reachable FROM the database,
//      runs embed_new_facts() and asserts vectors populate.
//
// Run: HORIZON_DATABASE_URL=... npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { HorizonFactStore } from "../../dist/src/index.js";
import {
    HAS_DB, DB_URL, EMBED_DIM, uniqueNames, startEmbeddingStub, stubEmbedding,
    dropSchemaAndGraph, rawPool,
} from "./_db.mjs";

const opts = { skip: !HAS_DB ? "HORIZON_DATABASE_URL not set" : false };

let store, stub, names;

before(async () => {
    if (!HAS_DB) return;
    stub = await startEmbeddingStub();
    names = uniqueNames();
    store = await HorizonFactStore.create({
        connectionString: DB_URL,
        schema: names.schema,
        graphName: names.graph,
        embedding: stubEmbedding(stub.url),
    });
    await store.initialize();
});

after(async () => {
    if (!HAS_DB) return;
    await store?.close();
    await stub?.close();
    await dropSchemaAndGraph(DB_URL, names.schema, names.graph);
});

test("Node fallback embedPending populates vectors", opts, async () => {
    await store.storeFact({ key: "skills/jsonb", shared: true,
        value: { name: "jsonb subscript", text: "jsonb subscript patch" } });
    await store.storeFact({ key: "skills/vacuum", shared: true,
        value: { name: "vacuum", text: "autovacuum planner" } });

    const n = await store.embedPending(10);
    assert.equal(n, 2, "embedded both pending facts");

    const pool = rawPool();
    try {
        const { rows } = await pool.query(
            `SELECT embedding IS NOT NULL AS has_emb, embedding_model
             FROM "${names.schema}".facts ORDER BY id`);
        assert.equal(rows.length, 2);
        assert.ok(rows.every((r) => r.has_emb), "all facts have embeddings");
        assert.ok(rows.every((r) => r.embedding_model), "embedding_model recorded");
        console.log(`  embedded ${rows.length} facts via Node fallback (dim ${EMBED_DIM})`);
    } finally {
        await pool.end();
    }

    // Idempotent: nothing pending now.
    const again = await store.embedPending(10);
    assert.equal(again, 0, "no re-embedding when content unchanged");
});

test("in-DB HTTP pipeline capability + embed_new_facts", opts, async () => {
    const cap = store.httpEmbeddingCapability();
    assert.ok(cap, "capability reported during initialize()");
    console.log(`  http extension available: ${cap.httpExtension}`);
    if (!cap.httpExtension) {
        console.log(`  NOTE: ${cap.note}`);
        return; // honest skip — cluster lacks pgsql-http
    }

    // The DB must be able to REACH the endpoint. The local stub binds to
    // 127.0.0.1 of the test host; a remote cluster can't reach it. Only run the
    // live in-DB call when an externally-reachable endpoint is provided.
    if (!process.env.HORIZON_EMBED_URL) {
        console.log("  http ext present but no DB-reachable HORIZON_EMBED_URL; " +
                    "skipping live in-DB call (set HORIZON_EMBED_URL to a reachable endpoint).");
        return;
    }

    const pool = rawPool();
    try {
        await pool.query(
            `UPDATE "${names.schema}".embedding_config SET url = $1, model = $2, dim = $3 WHERE id = 1`,
            [process.env.HORIZON_EMBED_URL, process.env.HORIZON_EMBED_MODEL ?? "text-embedding-3-small",
             Number(process.env.HORIZON_EMBED_DIM ?? EMBED_DIM)]);
    } finally {
        await pool.end();
    }

    await store.storeFact({ key: "skills/indb", shared: true,
        value: { name: "in-db embed", text: "embedded inside postgres over http" } });
    const n = await store.embedNewFactsInDb(10);
    assert.ok(n >= 1, "embed_new_facts embedded at least the new fact");
    console.log(`  embed_new_facts() embedded ${n} fact(s) via in-DB HTTP`);
});
