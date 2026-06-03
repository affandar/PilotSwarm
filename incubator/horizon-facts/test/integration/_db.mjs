// Integration test harness for HorizonFactStore against a real HorizonDB.
//
// All integration suites SKIP automatically unless HORIZON_DATABASE_URL is set,
// so `npm test` stays DB-less and green. To run them:
//   HORIZON_DATABASE_URL=postgres://user:pw@host/db npm run test:integration
//
// A local HTTP embedding stub stands in for the embeddings endpoint. It speaks
// the OpenAI/AOAI response shape that both the Node EmbeddingClient and the
// in-DB sql/006 pipeline expect. Embeddings are deterministic bag-of-keyword
// vectors so semantic ordering is assertable.

import http from "node:http";
import pg from "pg";

export const DB_URL = process.env.HORIZON_DATABASE_URL || "";
export const HAS_DB = !!DB_URL;
export const EMBED_DIM = 8;
export const EMBED_MODEL = "stub-embed-8";

const VOCAB = ["jsonb", "subscript", "patch", "vacuum", "planner", "index", "lock", "replication"];

/** Deterministic keyword-bag embedding so similar texts get close vectors. */
export function fakeEmbed(text, dim = EMBED_DIM) {
    const t = String(text).toLowerCase();
    const v = new Array(dim).fill(0);
    for (let i = 0; i < VOCAB.length && i < dim; i++) {
        // count occurrences of the keyword
        let from = 0, n = 0, idx;
        while ((idx = t.indexOf(VOCAB[i], from)) !== -1) { n++; from = idx + 1; }
        v[i] = n;
    }
    // tiny base so all-zero texts still normalize
    for (let i = 0; i < dim; i++) v[i] += 0.001;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
}

/** Start the local embedding stub. Returns { url, close, count() }. */
export async function startEmbeddingStub() {
    let count = 0;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            count++;
            let input;
            try { input = JSON.parse(body).input; } catch { input = ""; }
            const inputs = Array.isArray(input) ? input : [input];
            const data = inputs.map((t) => ({ embedding: fakeEmbed(t) }));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    return {
        url: `http://127.0.0.1:${port}/embeddings`,
        close: () => new Promise((r) => server.close(r)),
        count: () => count,
    };
}

export function uniqueNames() {
    const r = Math.random().toString(36).slice(2, 8);
    return { schema: `hf_test_${r}`, graph: `hf_test_${r}` };
}

/** Embedding config pointed at the stub (no auth). */
export function stubEmbedding(stubUrl) {
    return { url: stubUrl, model: EMBED_MODEL, dim: EMBED_DIM, inputField: "input" };
}

/** Drop a test schema + AGE graph. Safe to call in teardown. */
export async function dropSchemaAndGraph(connectionString, schema, graph) {
    const pool = new pg.Pool({ connectionString, max: 1 });
    try {
        try {
            await pool.query(`LOAD 'age'`);
            await pool.query(`SET search_path = ag_catalog, "$user", public`);
            await pool.query(`SELECT drop_graph($1, true)`, [graph]);
        } catch { /* graph may not exist */ }
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
        await pool.end();
    }
}

/** Convenience: a raw pool for direct psql-style assertions. */
export function rawPool() {
    return new pg.Pool({ connectionString: DB_URL, max: 1 });
}
