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

// Normalize the connection string for managed Postgres (Azure HorizonDB) whose
// cert chain isn't in Node's default trust store. `uselibpqcompat=true` makes
// `sslmode=require` mean "encrypt, don't verify CA" (libpq semantics) instead of
// pg's default verify-full, which rejects the chain with "self-signed certificate".
function normalizeDbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

export const DB_URL = normalizeDbUrl(process.env.HORIZON_DATABASE_URL || "");
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
    // schema and graph must be distinct: AGE's create_graph() creates a Postgres
    // schema named after the graph, which would collide with the facts schema if
    // they shared a name ("schema ... already exists").
    return { schema: `hf_test_${r}`, graph: `hf_graph_${r}` };
}

/** Embedding config pointed at the stub (no auth). */
export function stubEmbedding(stubUrl) {
    return { url: stubUrl, model: EMBED_MODEL, dim: EMBED_DIM, inputField: "input" };
}

// ── Real embedding endpoint (live Azure AI Foundry / AOAI) ───────────────────
// Set HORIZON_EMBED_URL + HORIZON_EMBED_API_KEY in .env to exercise the in-DB
// df.http() pipeline against the actual model. Without these, in-DB tests that
// need a DB-reachable endpoint skip honestly.
export const REAL_EMBED_DIM = Number(process.env.HORIZON_EMBED_DIM ?? "1536");
export const REAL_EMBED_MODEL = process.env.HORIZON_EMBED_MODEL ?? "text-embedding-3-small";
export const HAS_REAL_EMBED = !!(process.env.HORIZON_EMBED_URL && process.env.HORIZON_EMBED_API_KEY);

/** Embedding config pointed at the live endpoint, from HORIZON_EMBED_* env. */
export function realEmbedding() {
    return {
        url: process.env.HORIZON_EMBED_URL,
        model: REAL_EMBED_MODEL,
        dim: REAL_EMBED_DIM,
        apiKey: process.env.HORIZON_EMBED_API_KEY,
        apiKeyHeader: process.env.HORIZON_EMBED_API_KEY_HEADER ?? "api-key",
        inputField: "input",
    };
}

/** Drop a test schema + AGE graph. Safe to call in teardown. */
export async function dropSchemaAndGraph(connectionString, schema, graph) {
    const pool = new pg.Pool({ connectionString, max: 1 });
    try {
        try {
            // `LOAD 'age'` is blocked on managed PG where age is preloaded via
            // shared_preload_libraries; tolerate that and still drop the graph.
            try {
                await pool.query(`LOAD 'age'`);
            } catch (err) {
                if (!/access to library "age" is not allowed/i.test(String(err?.message ?? ""))) throw err;
            }
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
