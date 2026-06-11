// eval/bench-graph.mjs — DETERMINISTIC graph-write microbenchmark.
//
// The agent-driven harvest is too noisy to measure a per-op latency change
// (every run does a different number of calls with different concurrency, and
// unrelated ops like facts_similar swing 5x between runs from DB contention).
// This benchmark removes the LLM entirely: it drives a fixed, scripted set of
// graph upserts directly against HorizonFactStore and reports clean p50/p95.
//
// It also measures the two primitives that explain WHERE the time goes on a
// remote cluster:
//   - RTT          : one round trip (SELECT 1)
//   - age-prep     : LOAD 'age' + SET search_path  (what the OLD code ran on
//                    EVERY withAge checkout; the WeakSet change now runs it once
//                    per physical connection, so this is the per-op saving)
//
//   node --env-file-if-exists=.env eval/bench-graph.mjs
//
// Gate (SKIP, exit 0): HORIZON_DATABASE_URL. Creates an ephemeral schema/graph
// and DROPS both in a finally. Knobs: BENCH_NODES (default 80), BENCH_EDGES
// (default 80), BENCH_CONCURRENCY (default 8), BENCH_SAMPLES (default 20).

import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeDbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

const DB_URL = normalizeDbUrl(process.env.HORIZON_DATABASE_URL || "");
if (!DB_URL) { console.log("SKIP bench-graph — missing HORIZON_DATABASE_URL."); process.exit(0); }

const N_NODES = Number(process.env.BENCH_NODES || 80);
const N_EDGES = Number(process.env.BENCH_EDGES || 80);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || 8);
const SAMPLES = Number(process.env.BENCH_SAMPLES || 20);
const POOL_MAX = Number(process.env.BENCH_POOL_MAX || 3);   // store default is 3

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const SCHEMA = `hzb_${stamp}`;
const GRAPH = `hzbg_${stamp}`;
const AGENT = "bench-graph";

const pct = (xs, p) => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const median = (xs) => pct(xs, 50);
const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0));

/** Run `tasks` (array of () => Promise) with a fixed concurrency, timing each. */
async function timedPool(tasks, concurrency) {
    const durations = [];
    let errors = 0;
    let i = 0;
    const worker = async () => {
        while (i < tasks.length) {
            const task = tasks[i++];
            const t0 = performance.now();
            try { await task(); } catch { errors++; }
            durations.push(performance.now() - t0);
        }
    };
    const t0 = performance.now();
    await Promise.all(Array.from({ length: concurrency }, worker));
    const wall = performance.now() - t0;
    return { durations, errors, wall };
}

async function main() {
    console.log(`bench-graph  schema=${SCHEMA} graph=${GRAPH}`);
    console.log(`  nodes=${N_NODES} edges=${N_EDGES} concurrency=${CONCURRENCY} poolMax=${POOL_MAX} samples=${SAMPLES}\n`);

    const { HorizonFactStore } = await import("../dist/src/index.js");
    const store = await HorizonFactStore.create({
        connectionString: DB_URL, schema: SCHEMA, graphName: GRAPH, embeddingDim: 4, poolMax: POOL_MAX,
    });
    await store.initialize();

    // A separate raw pool for the primitive measurements (RTT, age-prep), so we
    // measure the cluster, not the store's pool state.
    const raw = new pg.Pool({ connectionString: DB_URL, max: 2 });
    raw.on("error", () => {});

    try {
        // ── primitive 1: RTT (one round trip) ────────────────────────────────
        const rtt = [];
        for (let k = 0; k < SAMPLES; k++) {
            const c = await raw.connect();
            const t0 = performance.now();
            await c.query("SELECT 1");
            rtt.push(performance.now() - t0);
            c.release();
        }

        // ── primitive 2: age-prep (LOAD age + SET search_path) ────────────────
        // This is exactly what the OLD code ran on EVERY withAge checkout. The
        // WeakSet change runs it once per physical connection instead, so this
        // value is the per-graph-op latency the optimization removes.
        const prep = [];
        for (let k = 0; k < SAMPLES; k++) {
            const c = await raw.connect();
            const t0 = performance.now();
            try { await c.query("LOAD 'age'"); } catch { /* preloaded — still a round trip */ }
            await c.query(`SET search_path = ag_catalog, "$user", public`);
            prep.push(performance.now() - t0);
            c.release();
        }

        // ── upsertGraphNode (the harvest's #1 cost) ───────────────────────────
        const nodeTasks = Array.from({ length: N_NODES }, (_, k) => () =>
            store.upsertGraphNode({ kind: "benchnode", name: `node-${k}`, agentId: AGENT }));
        const nodes = await timedPool(nodeTasks, CONCURRENCY);

        // ── upsertGraphEdge (endpoints pre-created above, so 0 not-found) ─────
        const edgeTasks = Array.from({ length: N_EDGES }, (_, k) => () =>
            store.upsertGraphEdge({
                fromKey: `benchnode:node-${k % N_NODES}`,
                toKey: `benchnode:node-${(k + 1) % N_NODES}`,
                predicate: "benchlink", agentId: AGENT, confidence: 0.9,
            }));
        const edges = await timedPool(edgeTasks, CONCURRENCY);

        // ── report ────────────────────────────────────────────────────────────
        const rttMed = median(rtt), prepMed = median(prep);
        console.log("PRIMITIVES (ms)");
        console.log("─".repeat(78));
        console.log(`  RTT (SELECT 1)              p50 ${rttMed}   p95 ${pct(rtt, 95)}`);
        console.log(`  age-prep (LOAD+SET)         p50 ${prepMed}   p95 ${pct(prep, 95)}   ← removed per-op by WeakSet`);
        console.log("");

        const row = (name, r) =>
            `  ${name.padEnd(20)} calls ${String(r.durations.length).padStart(4)}  errs ${String(r.errors).padStart(3)}` +
            `  p50 ${String(median(r.durations)).padStart(5)}  p95 ${String(pct(r.durations, 95)).padStart(5)}` +
            `  total ${String(sum(r.durations)).padStart(7)}  wall ${String(Math.round(r.wall)).padStart(6)}`;
        console.log("GRAPH OPS (ms)  [concurrency=" + CONCURRENCY + "]");
        console.log("─".repeat(78));
        console.log(row("upsertGraphNode", nodes));
        console.log(row("upsertGraphEdge", edges));
        console.log("");

        // Decompose: how many round trips is each op, and what would the OLD
        // (per-checkout-prep) latency have been?
        const nodeMed = median(nodes.durations), edgeMed = median(edges.durations);
        console.log("ANALYSIS");
        console.log("─".repeat(78));
        console.log(`  est. round trips/op  ≈ p50 / RTT   node ${(nodeMed / rttMed).toFixed(1)}   edge ${(edgeMed / rttMed).toFixed(1)}`);
        console.log(`  WeakSet saving/op    ≈ age-prep p50 = ${prepMed} ms`);
        console.log(`  old node p50 (est)   ≈ ${nodeMed} + ${prepMed} = ${nodeMed + prepMed} ms  → new ${nodeMed} ms  (${Math.round(100 * prepMed / (nodeMed + prepMed))}% faster)`);
        console.log(`  old edge p50 (est)   ≈ ${edgeMed} + ${prepMed} = ${edgeMed + prepMed} ms  → new ${edgeMed} ms  (${Math.round(100 * prepMed / (edgeMed + prepMed))}% faster)`);
        console.log("");
        console.log(`  errors: node ${nodes.errors}, edge ${edges.errors}  (expect 0 — label-race retries are silent)`);

        await store.close?.();
    } finally {
        await raw.end().catch(() => {});
        // Drop the ephemeral schema + graph.
        const c = new pg.Client({ connectionString: DB_URL });
        c.on("error", () => {});
        await c.connect();
        await c.query(`SET search_path = ag_catalog, "$user", public`);
        await c.query(`SELECT drop_graph($1, true)`, [GRAPH]).catch(() => {});
        await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
        await c.end();
        console.log(`\ncleaned up ${SCHEMA} + ${GRAPH}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
