// Integration harness — REAL SURFACE ONLY (06-provider-test-plan §0/§1).
//
// Every suite runs against the live HorizonDB named by HORIZON_DATABASE_URL
// and SKIPs when it is unset — but a full-validation pass is defined as zero
// skips. No stub endpoints, no marker facts, no simulated capabilities. The
// only deterministic seams are DATA: hand-seeded unit vectors written into
// the real embedding column (real pgvector executes every query).
//
// Env:
//   HORIZON_DATABASE_URL   — the HorizonDB (required by all suites)
//   HORIZON_EMBED_URL/_API_KEY/_MODEL/_DIM — the real embeddings deployment
//                            (embedder + semantic-pipeline suites)
//   PLAIN_DATABASE_URL     — a real vanilla Postgres (preconditions negatives)

import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizeDbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

/**
 * The plain-Postgres target for the preconditions NEGATIVES (06 §4): a real
 * vanilla Postgres that genuinely lacks the Horizon extensions. Resolution:
 * PLAIN_DATABASE_URL, else the PilotSwarm repo root .env's DATABASE_URL
 * (the main orchestration database — plain Postgres by definition), recast.
 */
function resolvePlainDbUrl() {
    if (process.env.PLAIN_DATABASE_URL) return process.env.PLAIN_DATABASE_URL;
    try {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
        const env = readFileSync(path.join(root, ".env"), "utf8");
        const m = env.match(/^DATABASE_URL=(.+)$/m);
        if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* no root .env — suite skips */ }
    return "";
}

export const DB_URL = normalizeDbUrl(process.env.HORIZON_DATABASE_URL || "");
export const HAS_DB = !!DB_URL;
export const PLAIN_DB_URL = normalizeDbUrl(resolvePlainDbUrl());
export const HAS_PLAIN_DB = !!PLAIN_DB_URL;

export const REAL_EMBED_DIM = Number(process.env.HORIZON_EMBED_DIM ?? "1536");
export const REAL_EMBED_MODEL = process.env.HORIZON_EMBED_MODEL ?? "text-embedding-3-small";
export const HAS_REAL_EMBED = !!(process.env.HORIZON_EMBED_URL && process.env.HORIZON_EMBED_API_KEY);

/** Embedding config pointed at the live endpoint, from HORIZON_EMBED_* env. */
export function realEmbedding(overrides = {}) {
    return {
        url: process.env.HORIZON_EMBED_URL,
        model: REAL_EMBED_MODEL,
        dim: REAL_EMBED_DIM,
        apiKey: process.env.HORIZON_EMBED_API_KEY,
        apiKeyHeader: process.env.HORIZON_EMBED_API_KEY_HEADER ?? "api-key",
        inputField: "input",
        ...overrides,
    };
}

/** Per-run names. Graph name MUST differ from the schema name (AGE's
 * create_graph creates a Postgres schema named after the graph). */
export function uniqueNames(tag = "t") {
    const r = Math.random().toString(36).slice(2, 8);
    return { schema: `hzt_${tag}_${r}`, graph: `hzg_${tag}_${r}` };
}

/** Build + initialize a store on a fresh per-run schema. Constructs the two
 *  SEPARATE providers (07 D2) — HorizonDBFactStore + HorizonDBGraphStore over
 *  one HorizonDB — and returns them individually plus a combined test facade so
 *  existing integration tests can drive facts + graph through one object. */
export async function makeStore({ tag = "t", embeddingDim = 4, embedding = undefined } = {}) {
    const { HorizonDBFactStore, HorizonDBGraphStore } = await import("../../dist/src/index.js");
    const names = uniqueNames(tag);
    const cfg = {
        connectionString: DB_URL,
        schema: names.schema,
        graphName: names.graph,
        embeddingDim,
        embedding,
    };
    const factStore = await HorizonDBFactStore.create(cfg);
    await factStore.initialize();
    const graphStore = await HorizonDBGraphStore.create(cfg);
    await graphStore.initialize();
    const store = combinedStore(factStore, graphStore);
    return { store, factStore, graphStore, ...names };
}

/** Test convenience: a thin facade over the two separate providers so existing
 *  tests can call both facts and graph methods on one `store`. Production wires
 *  factStore and graphStore independently (07 D2). close() ends both pools. */
function combinedStore(factStore, graphStore) {
    const FACT = [
        "storeFact", "readFacts", "deleteFact", "deleteSessionFactsForSession",
        "getSessionFactsStats", "getFactsStatsForSessions", "getSharedFactsStats",
        "searchFacts", "similarFacts", "readUncrawledFacts", "markFactsCrawled",
        "configureEmbedder", "startEmbedder", "stopEmbedder", "embedderStatus",
    ];
    const GRAPH = [
        "searchGraphNodes", "searchGraphEdges", "graphNeighbourhood",
        "upsertGraphNode", "upsertGraphEdge", "mergeGraphNodes",
        "deleteGraphNode", "deleteGraphEdge", "graphStats",
    ];
    const s = {};
    for (const m of FACT) if (typeof factStore[m] === "function") s[m] = (...a) => factStore[m](...a);
    for (const m of GRAPH) if (typeof graphStore[m] === "function") s[m] = (...a) => graphStore[m](...a);
    s.initialize = async () => { await factStore.initialize(); await graphStore.initialize(); };
    s.close = async () => { await factStore.close(); await graphStore.close(); };
    return s;
}

/** Drop a test schema + AGE graph. Safe to call in teardown. */
export async function dropSchemaAndGraph(schema, graph) {
    const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
    try {
        try {
            try {
                await pool.query(`LOAD 'age'`);
            } catch (err) {
                if (!/access to library "age" is not allowed/i.test(String(err?.message ?? ""))) throw err;
            }
            await pool.query(`SET search_path = ag_catalog, "$user", public`);
            await pool.query("SELECT pg_advisory_lock($1)", [graphBootstrapLockKey()]);
            try { await pool.query(`SELECT drop_graph($1, true)`, [graph]); }
            finally { await pool.query("SELECT pg_advisory_unlock($1)", [graphBootstrapLockKey()]).catch(() => {}); }
        } catch { /* graph may not exist */ }
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
        await pool.end();
    }
}

function graphBootstrapLockKey() {
    let hash = 0x48_5a_46;
    for (const ch of "horizon-graph-bootstrap") hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    return hash;
}

/** Raw pool for direct catalog/table assertions (test code is exempt from the
 * provider's no-inline-SQL rule — that rule binds src/, not tests). */
export function rawPool(url = DB_URL) {
    return new pg.Pool({ connectionString: url, max: 2 });
}

/** Poll an async predicate until truthy or deadline (charter: no fixed sleeps). */
export async function pollUntil(fn, { timeoutMs = 60_000, everyMs = 500, label = "condition" } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`pollUntil timed out after ${timeoutMs}ms waiting for ${label}`);
        await new Promise((r) => setTimeout(r, everyMs));
    }
}

/** Access-context builder. */
export function aclOf(readerSessionId, grantedSessionIds = [], unrestricted = false) {
    return { readerSessionId, grantedSessionIds, unrestricted };
}

// ── FX corpus (04 §1.1): deterministic dim-4 unit vectors seeded into the
//    REAL embedding column. Expected ranks are computed from these vectors.

export const FX_MODEL = "seeded-4";

export const FX = [
    { id: "F1", key: "skills/jsonb",           shared: true,  vec: [1, 0, 0, 0],        value: { name: "jsonb",            text: "jsonb fundamentals and subscripting" } },
    { id: "F2", key: "skills/jsonb-subscript", shared: true,  vec: [0.97, 0.24, 0, 0],  value: { name: "jsonb subscript",  text: "jsonb subscript assignment semantics patch" } },
    { id: "F3", key: "skills/vacuum",          shared: true,  vec: [0, 1, 0, 0],        value: { name: "vacuum",           text: "vacuum tuning for the planner" } },
    { id: "F4", key: "skills/replication",     shared: true,  vec: [0, 0, 1, 0],        value: { name: "replication",      text: "logical replication slots" } },
    { id: "F5", key: "notes/a", session: "S1", shared: false, vec: [0.9, 0.1, 0, 0],    value: { name: "private note a",   text: "jsonb subscript investigation notes" } },
    { id: "F6", key: "notes/b", session: "S2", shared: false, vec: [0.95, 0.05, 0, 0],  value: { name: "private note b",   text: "jsonb subscript draft reply" } },
];

export function fxScopeKey(f) {
    return f.shared ? `shared:${f.key}` : `session:${f.session}:${f.key}`;
}

export function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Seed the FX corpus through the provider API, then write the hand-authored
 * vectors directly into the real embedding column (deterministic DATA). */
export async function seedFX(store, schema, pool) {
    for (const f of FX) {
        await store.storeFact({
            key: f.key, value: f.value, shared: f.shared,
            sessionId: f.session ?? null, agentId: "fixture",
        });
    }
    for (const f of FX) {
        await pool.query(
            `UPDATE "${schema}".facts
               SET embedding = $1::vector,
                   embedding_model = $2
             WHERE scope_key = $3`,
            [`[${f.vec.join(",")}]`, FX_MODEL, fxScopeKey(f)],
        );
    }
}

// ── GX graph fixture (04 §1.3), built through the provider's own write API. ──

export async function seedGX(store) {
    const agentId = "fixture";
    const n = {};
    n.jsonbSub = await store.upsertGraphNode({ kind: "skill", name: "jsonb-subscript", agentId, evidence: [fxScopeKey(FX[0])] });
    n.vacuum   = await store.upsertGraphNode({ kind: "skill", name: "vacuum", agentId, evidence: [fxScopeKey(FX[2])] });
    n.planner  = await store.upsertGraphNode({ kind: "component", name: "planner", agentId });
    n.moody    = await store.upsertGraphNode({ kind: "person", name: "moody", agentId });
    n.alastor  = await store.upsertGraphNode({ kind: "person", name: "alastor-moody", agentId });
    await store.upsertGraphEdge({ fromKey: n.jsonbSub.nodeKey, toKey: n.vacuum.nodeKey, predicate: "supersedes", agentId, evidence: [fxScopeKey(FX[0])] });
    await store.upsertGraphEdge({ fromKey: n.vacuum.nodeKey, toKey: n.planner.nodeKey, predicate: "tunes", agentId, evidence: [fxScopeKey(FX[2])] });
    await store.upsertGraphEdge({ fromKey: n.planner.nodeKey, toKey: n.moody.nodeKey, predicate: "owned_by", agentId });
    return n;
}
