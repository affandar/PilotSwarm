// eval/validate-embedding-gate.mjs — deterministic validation of the
// embedding-gated crawl queue (readUncrawledFacts({ embeddedOnly: true })).
//
// Proves the contract the harvester relies on:
//   1. A fact with NO embedding is SKIPPED by the gated queue read…
//   2. …but is still visible to the UNgated read (so it isn't lost), and
//   3. once the in-DB embed loop fills its embedding in, it REAPPEARS in the
//      gated read on a later turn and can be crawled to drain the queue.
//
// Self-contained: own throwaway schema/graph, dropped on exit. Real HorizonDB +
// real embedder (the point is to validate the live in-DB pipeline).
//
//   node --env-file-if-exists=.env eval/validate-embedding-gate.mjs

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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
const HAS_EMBED = !!(process.env.HORIZON_EMBED_URL && process.env.HORIZON_EMBED_API_KEY);

if (!DB_URL || !HAS_EMBED) {
    const missing = [!DB_URL && "HORIZON_DATABASE_URL", !HAS_EMBED && "HORIZON_EMBED_*"].filter(Boolean).join(" + ");
    console.log(`SKIP validate-embedding-gate — missing ${missing}.`);
    process.exit(0);
}

const TRANSIENT = /ECONNRESET|ENOTCONN|EPIPE|ETIMEDOUT|Connection terminated/i;
process.on("uncaughtException", (err) => {
    if (err && (TRANSIENT.test(String(err.code)) || TRANSIENT.test(String(err.message)))) {
        console.log(`  (ignored transient ${err.code || err.message})`);
        return;
    }
    console.error("\nFATAL:", err?.stack || err?.message || err);
    process.exit(1);
});

const rnd = Math.random().toString(36).slice(2, 8);
const SCHEMA = `hz_gate_${rnd}`;
const GRAPH = `hzg_gate_${rnd}`;
const NS = "archive/gate-test";

let failures = 0;
function check(label, cond, detail = "") {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
    if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embeddedCount() {
    const c = new pg.Client({ connectionString: DB_URL });
    c.on("error", () => {});
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT count(*)::int total, count(embedding)::int embedded FROM "${SCHEMA}".facts`);
        return rows[0];
    } finally { await c.end().catch(() => {}); }
}

async function dropAll() {
    const c = new pg.Client({ connectionString: DB_URL });
    c.on("error", () => {});
    await c.connect();
    try {
        await c.query(`SET search_path = ag_catalog, "$user", public`);
        const inst = await c.query(
            `SELECT id FROM df.instances WHERE label = $1 AND status IN ('pending','running')`,
            [`hz-embed-cron:${SCHEMA}`]);
        for (const row of inst.rows) await c.query(`SELECT df.cancel($1,$2)`, [row.id, "gate test cleanup"]).catch(() => {});
        await c.query(`SELECT drop_graph('${GRAPH}', true)`).catch(() => {});
        await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    } finally { await c.end().catch(() => {}); }
}

async function main() {
    console.log(`validate-embedding-gate  schema=${SCHEMA}`);
    const { makeEvalStore } = await import("./_store.mjs");
    const embedding = {
        url: process.env.HORIZON_EMBED_URL,
        model: process.env.HORIZON_EMBED_MODEL ?? "text-embedding-3-small",
        dim: Number(process.env.HORIZON_EMBED_DIM ?? "1536"),
        apiKey: process.env.HORIZON_EMBED_API_KEY,
        apiKeyHeader: process.env.HORIZON_EMBED_API_KEY_HEADER ?? "api-key",
        inputField: "input",
    };
    const { store } = await makeEvalStore({
        connectionString: DB_URL, schema: SCHEMA, graphName: GRAPH,
        embedding, embeddingDim: embedding.dim,
    });

    try {
        // initialize() auto-starts the embed loop. Stop it FIRST so we control
        // timing, THEN seed — guaranteeing the seeded facts start un-embedded.
        await store.stopEmbedder("gate test: control timing");
        const N = 6;
        for (let i = 1; i <= N; i++) {
            await store.storeFact({
                key: `${NS}/msg-${i}`,
                value: { from: `Dev ${i}`, subject: `patch ${i}`, body: `proposal number ${i} about vacuum and logical replication` },
                shared: true, sessionId: null, tags: ["gate-test"], agentId: "gate-seed",
            });
        }
        const seeded = await embeddedCount();
        console.log(`\nseeded ${seeded.total} facts, embedder stopped (${seeded.embedded} embedded)`);

        // 1) gated read skips un-embedded facts
        const gatedBefore = await store.readUncrawledFacts({ namespace: NS, limit: 100, embeddedOnly: true });
        check("gated queue skips un-embedded facts", gatedBefore.count === 0, `count=${gatedBefore.count}`);

        // 2) ungated read still sees them (not lost)
        const ungated = await store.readUncrawledFacts({ namespace: NS, limit: 100, embeddedOnly: false });
        check("ungated queue still sees all facts", ungated.count === N, `count=${ungated.count}/${N}`);

        // 3) start the embed loop; un-embedded facts reappear in the gated read
        console.log(`\nstarting embed loop; polling until embeddings catch up…`);
        await store.startEmbedder({ intervalSeconds: 2, batch: 64 });
        let embedded = 0;
        for (let t = 0; t < 30; t++) {
            await sleep(2000);
            const s = await embeddedCount();
            embedded = s.embedded;
            if (embedded >= N) break;
        }
        check("embed loop embedded all facts", embedded === N, `embedded=${embedded}/${N}`);

        const gatedAfter = await store.readUncrawledFacts({ namespace: NS, limit: 100, embeddedOnly: true });
        check("facts reappear in gated queue once embedded (next turn)", gatedAfter.count === N, `count=${gatedAfter.count}/${N}`);

        // 4) crawling drains the queue
        const stamps = gatedAfter.facts.map((f) => ({ scopeKey: f.scopeKey }));
        const marked = await store.markFactsCrawled(stamps);
        const gatedDrained = await store.readUncrawledFacts({ namespace: NS, limit: 100, embeddedOnly: true });
        check("queue drains after crawl", gatedDrained.count === 0, `marked=${marked.marked}, remaining=${gatedDrained.count}`);

        console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    } finally {
        await store.close();
        await dropAll();
        console.log(`cleaned up ${SCHEMA} / ${GRAPH}`);
    }
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error("\nVALIDATION ERROR:", err?.stack || err?.message || err); process.exit(1); });
