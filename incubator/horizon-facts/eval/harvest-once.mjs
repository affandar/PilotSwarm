// eval/harvest-once.mjs — ONE-OFF persistent harvest for manual inspection.
//
// Unlike eval/scenarios.mjs (which drops its ephemeral schema in a finally),
// this script seeds the FULL real pgsql-hackers corpus, runs the SC1b harvester
// agent until the crawl queue drains, and then LEAVES the schema + AGE graph in
// place so you can browse them with the VS Code PostgreSQL / graph extension.
//
//   node --env-file-if-exists=.env eval/harvest-once.mjs
//
// Gates (SKIP, exit 0, when missing): HORIZON_DATABASE_URL + GITHUB_TOKEN.
// Optional: HORIZON_EMBED_* (real embeddings), EVAL_MODEL (default
// claude-haiku-4.5), EVAL_LIMIT (cap corpus for a cheap run), HARVEST_SCHEMA /
// HARVEST_GRAPH (override the generated names).
//
// The script prints the schema and graph names at the end — keep them; a
// companion cleanup is intentionally NOT performed here.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── env / gates ──────────────────────────────────────────────────────────────

function normalizeDbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

const DB_URL = normalizeDbUrl(process.env.HORIZON_DATABASE_URL || "");

/** GitHub token: env → repo root .env → gh CLI keyring. */
function resolveGhToken() {
    const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN;
    if (fromEnv) return fromEnv;
    try {
        const root = path.resolve(__dirname, "../../..");
        const env = readFileSync(path.join(root, ".env"), "utf8");
        const m = env.match(/^GITHUB_TOKEN=(.+)$/m);
        if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* no root .env */ }
    try {
        const t = execSync("gh auth token", { encoding: "utf8" }).trim();
        if (t) return t;
    } catch { /* no gh */ }
    return "";
}

const GH_TOKEN = resolveGhToken();
const MODEL = process.env.EVAL_MODEL || "claude-haiku-4.5";
const ROUND_TIMEOUT_MS = Number(process.env.EVAL_ROUND_TIMEOUT_MS || 120_000);
const HARD_TIMEOUT_MS = Number(process.env.EVAL_HARD_TIMEOUT_MS || 1_800_000);
const VERBOSE = process.env.EVAL_VERBOSE !== "0";
const MAX_ROUNDS = Number(process.env.EVAL_MAX_ROUNDS || 24);
const EVAL_LIMIT = process.env.EVAL_LIMIT ? Number(process.env.EVAL_LIMIT) : Infinity;
const HAS_EMBED = !!(process.env.HORIZON_EMBED_URL && process.env.HORIZON_EMBED_API_KEY);

if (!DB_URL || !GH_TOKEN) {
    const missing = [!DB_URL && "HORIZON_DATABASE_URL", !GH_TOKEN && "GITHUB_TOKEN"].filter(Boolean).join(" + ");
    console.log(`SKIP harvest-once — missing ${missing}.`);
    process.exit(0);
}

// HorizonDB (preview) intermittently resets idle pooled TLS connections. The
// store's pool already logs pool-level errors as non-fatal, but an idle reset
// surfacing on a checked-out Client emits an unhandled 'error' that would crash
// this long-running driver. Swallow ONLY transient socket errors here: any
// in-flight query rejection still surfaces to the agent as a tool error and is
// retried, and the durable crawl queue makes the harvest loop resumable.
const TRANSIENT_NET = /ECONNRESET|ENOTCONN|EPIPE|ETIMEDOUT|Connection terminated/i;
process.on("uncaughtException", (err) => {
    if (err && (TRANSIENT_NET.test(String(err.code)) || TRANSIENT_NET.test(String(err.message)))) {
        console.log(`  (ignored transient connection error ${err.code || err.message} — continuing)`);
        return;
    }
    console.error("\nHARVEST FATAL:", err?.stack || err?.message || err);
    process.exit(1);
});

// Persistent, inspectable names (override via env). A timestamp keeps repeat
// runs from colliding; both names are printed at the end for later cleanup.
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const SCHEMA = process.env.HARVEST_SCHEMA || `hz_harvest_${stamp}`;
const GRAPH = process.env.HARVEST_GRAPH || `hzg_harvest_${stamp}`;
// Corpus file (relative to eval/corpus, or an absolute path). Defaults to the
// pinned single-thread real corpus; point at pgsql-hackers-recent.json for the
// last-3-months multi-thread dataset.
const CORPUS_FILE = process.env.HARVEST_CORPUS || "pgsql-hackers-real.json";

function truncate(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }

// ── agent runner (Copilot SDK) — mirrors eval/scenarios.mjs ───────────────────

function withActivityWatchdog(promise, { idleMs, hardMs, lastActivity, label }) {
    let interval, hardTimer;
    const watchdog = new Promise((_, reject) => {
        interval = setInterval(() => {
            const quiet = Date.now() - lastActivity();
            if (quiet > idleMs) reject(new Error(`${label}: no agent activity for ${Math.round(quiet / 1000)}s`));
        }, 5_000);
        hardTimer = setTimeout(() => reject(new Error(`${label}: hard wall-clock cap ${hardMs}ms exceeded`)), hardMs);
    });
    const clear = () => { clearInterval(interval); clearTimeout(hardTimer); };
    return Promise.race([promise.finally(clear), watchdog]);
}

async function runAgent({ sdk, systemMessage, tools, toolNames, firstPrompt, continuePrompt, isDone, label }) {
    const session = await sdk.createSession({
        model: MODEL,
        systemMessage: { mode: "replace", content: systemMessage },
        tools,
        availableTools: toolNames,
        onPermissionRequest: () => ({ kind: "approve-for-session", approval: { kind: "custom-tool" } }),
    });

    let assistantText = "";
    let toolCalls = 0;
    let lastActivity = Date.now();
    session.on("assistant.message", (e) => {
        lastActivity = Date.now();
        if (e?.data?.content) assistantText = e.data.content;
        if (VERBOSE && e?.data?.content?.trim()) console.log(`  [${label}] » ${truncate(e.data.content.trim(), 140)}`);
    });
    session.on((event) => {
        lastActivity = Date.now();
        const t = event?.type ?? "";
        if (t === "tool.execution_start") {
            toolCalls++;
            const name = event?.data?.toolName || event?.data?.name;
            if (VERBOSE) console.log(`  [${label}] tool ${name ?? "?"} (#${toolCalls})`);
            else if (toolCalls % 25 === 0) console.log(`  · [${label}] ${toolCalls} tool calls…`);
        }
    });

    const idle = () => new Promise((resolve, reject) => {
        session.on("session.idle", () => resolve());
        session.on("session.error", (e) => reject(new Error(e?.data?.message || "session error")));
    });

    let consecutiveStalls = 0;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const wait = idle();
        session.send({ prompt: round === 1 ? firstPrompt : continuePrompt });
        try {
            await withActivityWatchdog(wait, {
                idleMs: ROUND_TIMEOUT_MS,
                hardMs: HARD_TIMEOUT_MS,
                lastActivity: () => lastActivity,
                label: `${label} round ${round}`,
            });
            consecutiveStalls = 0;
        } catch (err) {
            consecutiveStalls++;
            console.log(`  [${label}] round ${round} stalled (${err.message}) — re-prompting (${consecutiveStalls}/3)`);
            if (consecutiveStalls >= 3) throw new Error(`${label}: 3 consecutive stalled rounds — giving up`);
        }
        if (await isDone()) {
            console.log(`  [${label}] done after round ${round} (${toolCalls} tool calls)`);
            return assistantText;
        }
        if (consecutiveStalls === 0) console.log(`  [${label}] round ${round} ended, not done — continuing`);
    }
    console.log(`  [${label}] WARNING: round budget exhausted (${MAX_ROUNDS})`);
    return assistantText;
}

// ── store / corpus helpers — mirrors eval/scenarios.mjs ───────────────────────

const NS = `archive/pgsql-hackers`;
const msgKey = (id) => `${NS}/msg-${id}`;

async function seedMessages(store, messages) {
    for (const m of messages) {
        await store.storeFact({
            key: msgKey(m.id),
            value: { from: m.from, subject: m.subject, date: m.date, body: m.body },
            shared: true, sessionId: null, tags: ["pgsql-hackers", "archive"], agentId: "harvest-once-seed",
        });
    }
}

// The queue check runs between agent rounds; a transient pool drop here would
// otherwise crash the driver mid-harvest. Retry a few times before giving up.
const queueCount = async (store) => {
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            return (await store.readUncrawledFacts({ namespace: NS, limit: 500 })).count;
        } catch (err) {
            lastErr = err;
            if (!TRANSIENT_NET.test(String(err?.code)) && !TRANSIENT_NET.test(String(err?.message))) throw err;
            console.log(`  (queue check transient error ${err.code || err.message}, retry ${attempt}/5)`);
            await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
    }
    throw lastErr;
};

// ── perf + error telemetry (HorizonDB validation) ────────────────────────────

/** Short-lived stats client — avoids holding an idle connection that HorizonDB
 * would later reset. Used for per-round + final fact/embedding/crawl counts. */
async function dbStats() {
    const c = new pg.Client({ connectionString: DB_URL });
    c.on("error", () => {});
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT count(*)::int total,
                    count(embedding)::int embedded,
                    count(*) FILTER (WHERE last_crawled_at IS NOT NULL)::int crawled
             FROM "${SCHEMA}".facts`);
        return rows[0];
    } finally { await c.end().catch(() => {}); }
}

const pctl = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** Classify a tool/DB error message into a coarse HorizonDB-relevant bucket. */
function classifyError(msg) {
    const s = String(msg || "");
    if (/ECONNRESET|ENOTCONN|EPIPE|ETIMEDOUT|Connection terminated|terminating connection|server closed/i.test(s)) return "transient-conn";
    if (/self-signed certificate|certificate chain|TLS|SSL/i.test(s)) return "tls";
    if (/access to library .*age.* is not allowed/i.test(s)) return "age-load (benign)";
    if (/a name constant is expected|syntax error|cannot cast type agtype/i.test(s)) return "age-cypher";
    if (/timeout|timed out/i.test(s)) return "timeout";
    if (/embedding|vector|dimension/i.test(s)) return "embedding";
    if (/evidence is required/i.test(s)) return "policy (evidence)";
    return "other";
}

/** Merge [start,end] intervals and return total covered wall-clock ms (so
 * overlapping/parallel tool calls are counted once, not summed). */
function intervalUnionMs(intervals) {
    if (!intervals.length) return 0;
    const s = intervals.map((i) => [i.s, i.e]).sort((a, b) => a[0] - b[0]);
    let total = 0, curS = s[0][0], curE = s[0][1];
    for (let i = 1; i < s.length; i++) {
        const [a, b] = s[i];
        if (a > curE) { total += curE - curS; curS = a; curE = b; }
        else if (b > curE) curE = b;
    }
    return total + (curE - curS);
}

/** Decompose the agent's wall time into LLM-generation time vs DB time.
 *
 * Each record entry has startedAt (epoch ms) + durationMs, so every DB tool
 * call is an interval. The union of those intervals is the wall-clock time when
 * ≥1 DB call was in flight (= "DB time"); the remainder of the agent's wall
 * time is when 0 DB calls were running (= model generation + SDK/network =
 * "LLM time"). Summed durations (work) can exceed DB wall time because the
 * agent fires tool calls in parallel — the work/wall ratio is the parallelism. */
function timingReport(record, agentWallMs, seedMs) {
    const timed = record.filter((e) => typeof e.durationMs === "number" && typeof e.startedAt === "number");
    const ivAll = timed.map((e) => ({ s: e.startedAt, e: e.startedAt + e.durationMs }));
    const isGraph = (n) => n.startsWith("graph_");
    const isFacts = (n) => n.startsWith("facts_");
    const work = (pred) => timed.filter((e) => pred(e.name)).reduce((a, e) => a + e.durationMs, 0);

    const dbWall = intervalUnionMs(ivAll);
    const dbWork = timed.reduce((a, e) => a + e.durationMs, 0);
    const graphWork = work(isGraph), factsWork = work(isFacts), otherWork = dbWork - graphWork - factsWork;
    const llmWall = Math.max(0, agentWallMs - dbWall);
    const pctOf = (x) => agentWallMs > 0 ? `${(100 * x / agentWallMs).toFixed(1)}%` : "—";
    const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

    console.log(`\n${"─".repeat(78)}`);
    console.log("WALL-CLOCK SPLIT — where the harvest spent its time");
    console.log("─".repeat(78));
    console.log(`  seeding (storeFact ×N, pre-agent)   ${fmt(seedMs).padStart(9)}`);
    console.log(`  agent loop wall                     ${fmt(agentWallMs).padStart(9)}   (100%)`);
    console.log(`    ├─ LLM generation (no DB in flight)${fmt(llmWall).padStart(9)}   ${pctOf(llmWall).padStart(6)}`);
    console.log(`    └─ DB time (≥1 tool in flight)     ${fmt(dbWall).padStart(9)}   ${pctOf(dbWall).padStart(6)}`);
    console.log("");
    console.log(`  DB work (Σ durations, counts parallel calls separately)  ${fmt(dbWork)}`);
    console.log(`    ├─ graph_*  ${fmt(graphWork).padStart(8)}   (${timed.filter((e) => isGraph(e.name)).length} calls)`);
    console.log(`    ├─ facts_*  ${fmt(factsWork).padStart(8)}   (${timed.filter((e) => isFacts(e.name)).length} calls)`);
    console.log(`    └─ other    ${fmt(otherWork).padStart(8)}`);
    console.log(`  DB parallelism (work / wall)        ${dbWall > 0 ? (dbWork / dbWall).toFixed(1) + "×" : "—"}`);
    console.log(`  → LLM is ${llmWall > dbWall ? "the" : "NOT the"} dominant cost: ` +
        `LLM ${pctOf(llmWall)} vs DB ${pctOf(dbWall)} of agent wall.`);
}

/** Print a per-tool latency table, an error breakdown, and the retry tally. */
function perfReport(record, retries) {
    const byName = new Map();
    for (const e of record) {
        const g = byName.get(e.name) ?? { name: e.name, n: 0, errs: 0, durs: [] };
        g.n++;
        if (e.error) g.errs++;
        if (typeof e.durationMs === "number") g.durs.push(e.durationMs);
        byName.set(e.name, g);
    }
    const rows = [...byName.values()]
        .map((g) => ({
            name: g.name, calls: g.n, errors: g.errs,
            total: g.durs.reduce((a, b) => a + b, 0),
            p50: pctl(g.durs, 50), p95: pctl(g.durs, 95), max: g.durs.length ? Math.max(...g.durs) : 0,
        }))
        .sort((a, b) => b.total - a.total);

    console.log(`\n${"─".repeat(78)}`);
    console.log("PER-TOOL PERFORMANCE (ms)  [similarity = facts_similar/_search_*, graph = graph_*]");
    console.log("─".repeat(78));
    console.log("tool".padEnd(22) + "calls".padStart(7) + "errs".padStart(6) +
        "p50".padStart(9) + "p95".padStart(9) + "max".padStart(9) + "total".padStart(10));
    for (const r of rows) {
        console.log(
            r.name.padEnd(22) + String(r.calls).padStart(7) + String(r.errors).padStart(6) +
            r.p50.toFixed(0).padStart(9) + r.p95.toFixed(0).padStart(9) + r.max.toFixed(0).padStart(9) +
            r.total.toFixed(0).padStart(10));
    }

    // Error breakdown
    const errs = record.filter((e) => e.error);
    console.log(`\n${"─".repeat(78)}`);
    console.log(`HORIZONDB / TOOL ERRORS — ${errs.length} of ${record.length} calls failed`);
    console.log("─".repeat(78));
    if (errs.length === 0) {
        console.log("  none");
    } else {
        const byClass = new Map();
        for (const e of errs) {
            const cls = classifyError(e.error);
            const g = byClass.get(cls) ?? { count: 0, sample: e.error, tools: new Set() };
            g.count++; g.tools.add(e.name);
            byClass.set(cls, g);
        }
        for (const [cls, g] of [...byClass.entries()].sort((a, b) => b[1].count - a[1].count)) {
            console.log(`  ${cls.padEnd(20)} ${String(g.count).padStart(4)}  tools=${[...g.tools].join(",")}`);
            console.log(`      e.g. ${truncate(g.sample, 130)}`);
        }
    }

    // Retry tally (store-level transient retries that papered over drops)
    console.log(`\n${"─".repeat(78)}`);
    console.log(`STORE-LEVEL TRANSIENT RETRIES — ${retries.length} (auto-recovered connection drops)`);
    console.log("─".repeat(78));
    if (retries.length === 0) {
        console.log("  none");
    } else {
        const byLabel = new Map();
        for (const r of retries) byLabel.set(r.label, (byLabel.get(r.label) ?? 0) + 1);
        for (const [label, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${label.padEnd(24)} ${n}`);
        }
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`harvest-once model=${MODEL} embed=${HAS_EMBED ? "real" : "none (lexical only)"}`);
    console.log(`  schema=${SCHEMA} graph=${GRAPH}`);

    const { HorizonFactStore } = await import("../dist/src/index.js");
    const embedding = HAS_EMBED ? {
        url: process.env.HORIZON_EMBED_URL,
        model: process.env.HORIZON_EMBED_MODEL ?? "text-embedding-3-small",
        dim: Number(process.env.HORIZON_EMBED_DIM ?? "1536"),
        apiKey: process.env.HORIZON_EMBED_API_KEY,
        apiKeyHeader: process.env.HORIZON_EMBED_API_KEY_HEADER ?? "api-key",
        inputField: "input",
    } : undefined;

    const store = await HorizonFactStore.create({
        connectionString: DB_URL, schema: SCHEMA, graphName: GRAPH,
        embedding, embeddingDim: embedding?.dim ?? 4,
    });
    await store.initialize();

    // Record store-level transient retries so the perf report can show how many
    // HorizonDB connection drops were silently papered over.
    const retries = [];
    const { setDbRetryHooks } = await import("../dist/src/index.js");
    setDbRetryHooks({ onRetry: (info) => retries.push(info) });

    const { CopilotClient } = await import("@github/copilot-sdk");
    const sdk = new CopilotClient({ gitHubToken: GH_TOKEN });
    await sdk.start();

    try {
        const corpusPath = path.isAbsolute(CORPUS_FILE) ? CORPUS_FILE : path.join(__dirname, "corpus", CORPUS_FILE);
        const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
        const messages = corpus.messages.slice(0, Math.min(corpus.messages.length, EVAL_LIMIT));
        const seedT0 = performance.now();
        await seedMessages(store, messages);
        const seedMs = performance.now() - seedT0;
        console.log(`  seeded ${messages.length} messages from ${path.basename(corpusPath)}`);
        if (HAS_EMBED) {
            const s0 = await dbStats();
            console.log(`  embed gate ON — at seed: ${s0.embedded}/${s0.total} embedded (loop will catch up in background)`);
        }

        const record = [];
        const { buildSdkTools, HARVESTER_SYSTEM_PROMPT } = await import("./tools.mjs");
        // embeddedOnly mirrors HAS_EMBED: when embeddings are configured the
        // harvester reads only embedded facts (so facts_similar works); when not,
        // the gate is off and the whole queue is harvestable lexically.
        const { tools, toolNames } = await buildSdkTools(store, { role: "harvester", embeddedOnly: HAS_EMBED, record });

        let lastRoundStats = null;
        const agentT0 = performance.now();
        await runAgent({
            sdk, tools, toolNames, systemMessage: HARVESTER_SYSTEM_PROMPT, label: "harvest",
            firstPrompt: `Harvest the archive (${messages.length} facts) into the knowledge graph. Pull ONE batch of 5 with facts_read_uncrawled, incorporate each email thoroughly (entities + relationships + evidence + similarity refinement), mark them crawled, then end your turn.`,
            continuePrompt: "Good. Pull the NEXT batch of 5 with facts_read_uncrawled and incorporate each email thoroughly (sender + relationships + evidence, resolve-before-create, similarity refinement), mark them crawled, then end your turn. If the queue is empty, summarize.",
            isDone: async () => {
                const s = await dbStats();
                if (!lastRoundStats || s.crawled !== lastRoundStats.crawled || s.embedded !== lastRoundStats.embedded) {
                    console.log(`  [stats] embedded ${s.embedded}/${s.total}, crawled ${s.crawled}/${s.total}`);
                    lastRoundStats = s;
                }
                return (await queueCount(store)) === 0;
            },
        });
        const agentWallMs = performance.now() - agentT0;

        const remaining = await queueCount(store);
        const sFinal = await dbStats();
        console.log(`\n${"━".repeat(70)}`);
        console.log(`harvest complete — crawl queue remaining: ${remaining}`);
        console.log(`  facts: ${sFinal.embedded}/${sFinal.total} embedded, ${sFinal.crawled}/${sFinal.total} crawled`);

        perfReport(record, retries);
        timingReport(record, agentWallMs, seedMs);

        console.log(`\nInspect with the VS Code PostgreSQL / graph extension:`);
        console.log(`  facts table : "${SCHEMA}".facts`);
        console.log(`  AGE graph   : ${GRAPH}  (ag_catalog.cypher('${GRAPH}', $$ MATCH (n) RETURN n $$))`);
        console.log(`\nWhen you are done inspecting, ask me to clean up:`);
        console.log(`  DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;  +  SELECT drop_graph('${GRAPH}', true);`);
    } finally {
        await store.close();
        try { await sdk.stop(); } catch { /* ignore */ }
    }
}

main().catch((err) => {
    console.error("\nHARVEST ERROR:", err?.stack || err?.message || err);
    process.exit(1);
});
