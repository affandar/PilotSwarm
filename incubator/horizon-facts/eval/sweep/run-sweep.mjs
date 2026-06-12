#!/usr/bin/env node
/**
 * run-sweep.mjs — repeatable cross-model sweep driver for the horizon-facts
 * closed-QA eval (graph-grounded vs parametric+web).
 *
 * The sweep fills a 3x3x3 tensor over { harvester model, query model, judge
 * model } while only paying for the expensive work once per axis:
 *
 *   • 1 question set        (gen, fixed GEN_MODEL)              — corpus ground truth
 *   • N harvests            (one graph per HARVESTER model)     — the costly build
 *   • H×Q answer cells      (both arms, per harvester×query)    — transcripts
 *   • H×Q×J judge cells     (score each transcript per judge)   — cheap, DB-free
 *   • 1 LLM report          (reads the whole tensor)            — generate-report.mjs
 *
 * The baseline arm never touches the graph, but to keep each (harvester,query)
 * transcript self-contained we run both arms per answer cell. Judging is split
 * out so the same answers are graded by every judge model — which is exactly how
 * we measure judge bias.
 *
 * RESUMABLE: every step writes a file; re-running skips cells whose output
 * already exists (use --force to redo). Each cell is independently runnable, so
 * subagents can own one cell each.
 *
 * COMMANDS:
 *   node run-sweep.mjs status                      — what's done / pending
 *   node run-sweep.mjs gen                         — build the shared question set
 *   node run-sweep.mjs harvest <H>                 — harvest one model → hz_sw_<H>
 *   node run-sweep.mjs answer  <H> <Q>             — both arms for harvester H, query Q
 *   node run-sweep.mjs judge   <H> <Q> <J>         — judge that transcript with J
 *   node run-sweep.mjs report                      — generate REPORT.md (LLM)
 *   node run-sweep.mjs all                         — everything, sequential + resumable
 *
 * Flags: --force (redo existing), --corpus <file>, --qlimit <n>, --config <path>.
 *
 * Gates: HORIZON_DATABASE_URL + a GitHub token (see graph-quality.mjs). Embeddings
 * (HORIZON_EMBED_*) are STRONGLY recommended so every harvest builds a rich,
 * embedded graph (semantic search + similarity refinement) — the driver warns if
 * they are absent.
 */

import { readFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.resolve(__dirname, "..");          // incubator/horizon-facts/eval
const ROOT = path.resolve(EVAL_DIR, "..");               // incubator/horizon-facts

// Load .env into the driver's own process so warnIfNoEmbed/status reflect the
// same config the child evals see (children also load it via --env-file-if-exists).
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* no .env — gates will SKIP */ }

const args = process.argv.slice(2);
const cmd = (args[0] || "status").toLowerCase();
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : undefined; };
const FORCE = !!flag("force");

const CONFIG_PATH = flag("config") || path.join(__dirname, "sweep.config.json");
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const CORPUS = flag("corpus") || cfg.corpus;
const QLIMIT = flag("qlimit") ? Number(flag("qlimit")) : cfg.questionCount;
const EMBED_DIM = cfg.embedDim || 1536;

const QUESTIONS_FILE = path.join(__dirname, "questions.json");
const TRANSCRIPTS_DIR = path.join(__dirname, "transcripts");
const SCORES_DIR = path.join(__dirname, "scores");
const LOGS_DIR = path.join(__dirname, "logs");

const modelOf = (label) => {
    const m = cfg.models[label];
    if (!m) { console.error(`Unknown model label '${label}'. Known: ${Object.keys(cfg.models).join(", ")}`); process.exit(2); }
    return m;
};
const schemaFor = (h) => `hz_sw_${h}`;
const graphFor = (h) => `hzg_sw_${h}`;
const transcriptPath = (h, q) => path.join(TRANSCRIPTS_DIR, `${h}__${q}.json`);
const scorePath = (h, q, j) => path.join(SCORES_DIR, `${h}__${q}__${j}.json`);

for (const d of [TRANSCRIPTS_DIR, SCORES_DIR, LOGS_DIR]) mkdirSync(d, { recursive: true });

function warnIfNoEmbed() {
    if (!(process.env.HORIZON_EMBED_URL && process.env.HORIZON_EMBED_API_KEY)) {
        console.warn("⚠️  HORIZON_EMBED_* not set — harvests will build lexical-only (dim-4) graphs.");
        console.warn("    For parity with the embedded reference graph, configure embeddings before harvesting.");
    }
}

/** Run a node script with extra env, writing all output to a per-cell log file
 * (so background-orchestrated cells leave a durable, inspectable trace). Returns
 * the child exit code. */
function runNode(scriptRel, scriptArgs, extraEnv, logName) {
    const script = path.join(EVAL_DIR, scriptRel);
    const env = { ...process.env, ...extraEnv };
    const logPath = path.join(LOGS_DIR, logName);
    console.log(`▶ node ${scriptRel} ${scriptArgs.join(" ")}  (log: ${path.relative(ROOT, logPath)})`);
    const fd = openSync(logPath, "w");
    try {
        const res = spawnSync("node", ["--env-file-if-exists=" + path.join(ROOT, ".env"), script, ...scriptArgs], {
            cwd: ROOT, env, stdio: ["ignore", fd, fd], encoding: "utf8",
        });
        return res.status ?? 1;
    } finally {
        closeSync(fd);
    }
}

function ensureGenerated() {
    if (existsSync(QUESTIONS_FILE) && !FORCE) return;
    const code = runNode("graph-quality.mjs", ["gen"], {
        GEN_MODEL: cfg.genModel, EVAL_MODEL: cfg.genModel,
        HARVEST_CORPUS: CORPUS, QGEN: String(QLIMIT), QUESTIONS_FILE,
    }, "gen.log");
    if (code !== 0) { console.error("gen failed"); process.exit(code); }
}

function doHarvest(h) {
    const schema = schemaFor(h), graph = graphFor(h);
    warnIfNoEmbed();
    const code = runNode("harvest-once.mjs", [], {
        EVAL_MODEL: modelOf(h), HARVEST_SCHEMA: schema, HARVEST_GRAPH: graph,
        HARVEST_CORPUS: CORPUS, EVAL_VERBOSE: "0",
        // Headroom: 119 facts / 5-per-batch ≈ 24 batches with zero margin at the
        // default MAX_ROUNDS=24. Models that pull smaller batches (or re-pull)
        // need more rounds to drain the queue, so give generous headroom.
        EVAL_MAX_ROUNDS: process.env.EVAL_MAX_ROUNDS || "60",
    }, `harvest_${h}.log`);
    if (code === 0) console.log(`✓ harvested ${h} → ${schema}/${graph}`);
    else console.error(`✗ harvest ${h} failed (exit ${code}) — durable queue means re-running resumes`);
    return code;
}

/** Harvest every configured model SEQUENTIALLY (one at a time). Running them in
 * parallel saturates the local socket/DNS stack against the shared preview
 * cluster (EADDRNOTAVAIL / ENOTFOUND). Continue past a single failure — the
 * durable crawl queue makes each independently resumable — and report a summary. */
function doHarvestAll() {
    const results = [];
    for (const h of cfg.harvesters) {
        console.log(`\n── harvest ${h} (${modelOf(h)}) ──`);
        results.push({ h, code: doHarvest(h) });
    }
    console.log(`\n── harvest-all summary ──`);
    for (const r of results) console.log(`  ${r.code === 0 ? "✓" : "✗"} ${r.h}${r.code === 0 ? "" : ` (exit ${r.code})`}`);
    const failed = results.filter((r) => r.code !== 0);
    if (failed.length) { console.error(`\n${failed.length} harvest(s) failed — re-run 'harvest-all' to resume the incomplete ones.`); process.exit(1); }
    console.log("\n✓ all harvests drained their queues");
}

function doAnswer(h, q) {
    const out = transcriptPath(h, q);
    if (existsSync(out) && !FORCE) { console.log(`• skip answer ${h}×${q} (exists)`); return; }
    const code = runNode("graph-quality.mjs", ["answer"], {
        QUERY_MODEL: modelOf(q), HARVESTER_LABEL: h, QUERY_LABEL: q,
        HARVEST_SCHEMA: schemaFor(h), HARVEST_GRAPH: graphFor(h),
        HARVEST_CORPUS: CORPUS, QUESTIONS_FILE, QLIMIT: String(QLIMIT),
        TRANSCRIPTS_FILE: out, QUALITY_EMBED_DIM: String(EMBED_DIM),
    }, `answer_${h}__${q}.log`);
    if (code !== 0) { console.error(`answer ${h}×${q} failed`); process.exit(code); }
}

function doJudge(h, q, j) {
    const tIn = transcriptPath(h, q);
    if (!existsSync(tIn)) { console.error(`no transcript for ${h}×${q} — run answer first`); process.exit(2); }
    const out = scorePath(h, q, j);
    if (existsSync(out) && !FORCE) { console.log(`• skip judge ${h}×${q}×${j} (exists)`); return; }
    const code = runNode("graph-quality.mjs", ["judge"], {
        JUDGE_MODEL: modelOf(j), JUDGE_LABEL: j,
        TRANSCRIPTS_FILE: tIn, SCORES_FILE: out,
    }, `judge_${h}__${q}__${j}.log`);
    if (code !== 0) { console.error(`judge ${h}×${q}×${j} failed`); process.exit(code); }
}

function doReport() {
    const code = runNode("sweep/generate-report.mjs", [], {
        SWEEP_DIR: __dirname, REPORT_MODEL: cfg.reportModel, SWEEP_CONFIG: CONFIG_PATH,
    }, "report.log");
    if (code !== 0) { console.error("report failed"); process.exit(code); }
}

function status() {
    console.log(`SWEEP STATUS  (config: ${path.relative(ROOT, CONFIG_PATH)})`);
    console.log(`  corpus=${CORPUS}  questions=${QLIMIT}  embedDim=${EMBED_DIM}`);
    console.log(`  models: ${cfg.harvesters.map((h) => `${h}=${modelOf(h)}`).join("  ")}`);
    console.log(`  questions.json: ${existsSync(QUESTIONS_FILE) ? "✓" : "—"}`);
    let harv = 0, ans = 0, jud = 0;
    console.log("  harvests:");
    for (const h of cfg.harvesters) { console.log(`    ${h}: schema ${schemaFor(h)} (run 'harvest ${h}')`); }
    console.log("  answer cells (transcripts):");
    for (const h of cfg.harvesters) for (const q of cfg.queries) {
        const ok = existsSync(transcriptPath(h, q)); ans += ok ? 1 : 0;
        console.log(`    ${h}×${q}: ${ok ? "✓" : "—"}`);
    }
    console.log("  judge cells (scores):");
    for (const h of cfg.harvesters) for (const q of cfg.queries) for (const j of cfg.judges) {
        const ok = existsSync(scorePath(h, q, j)); jud += ok ? 1 : 0;
    }
    console.log(`    ${jud}/${cfg.harvesters.length * cfg.queries.length * cfg.judges.length} done`);
    console.log(`  REPORT.md: ${existsSync(path.join(__dirname, "REPORT.md")) ? "✓" : "—"}`);
    console.log(`\n  (answers ${ans}/${cfg.harvesters.length * cfg.queries.length})`);
}

function runAll() {
    ensureGenerated();
    doHarvestAll();
    for (const h of cfg.harvesters) for (const q of cfg.queries) doAnswer(h, q);
    for (const h of cfg.harvesters) for (const q of cfg.queries) for (const j of cfg.judges) doJudge(h, q, j);
    doReport();
    console.log("\n✓ sweep complete");
}

switch (cmd) {
    case "status": status(); break;
    case "gen": ensureGenerated(); break;
    case "harvest": if (!positional[0]) { console.error("usage: harvest <H>"); process.exit(2); } process.exit(doHarvest(positional[0])); break;
    case "harvest-all": doHarvestAll(); break;
    case "answer": if (positional.length < 2) { console.error("usage: answer <H> <Q>"); process.exit(2); } ensureGenerated(); doAnswer(positional[0], positional[1]); break;
    case "judge": if (positional.length < 3) { console.error("usage: judge <H> <Q> <J>"); process.exit(2); } doJudge(positional[0], positional[1], positional[2]); break;
    case "report": doReport(); break;
    case "all": runAll(); break;
    default: console.error(`Unknown command '${cmd}'. See header for usage.`); process.exit(2);
}
