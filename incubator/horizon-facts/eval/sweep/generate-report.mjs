#!/usr/bin/env node
/**
 * generate-report.mjs — read the whole sweep score tensor and have an LLM write
 * REPORT.md. The aggregates are computed DETERMINISTICALLY here (so the numbers
 * are real, not model-invented); the LLM only writes the narrative grounded in
 * that JSON summary + a few sampled transcript excerpts.
 *
 * Bias controls baked into the summary (the whole point of the cross-model sweep):
 *   • full 3x3x3 tensor (graph mean, baseline mean, wins) per harvester×query×judge
 *   • marginals by harvester / query / judge
 *   • JUDGE LENIENCY: mean graph score each judge awards (is one judge generous?)
 *   • SAME-FAMILY bias: does a judge favor answers from its own model family?
 *   • INTER-JUDGE agreement: spread of the 3 judges on the same answers
 *   • VERBOSITY: correlation of score with answer length (does length buy score?)
 *   • ABSTENTION: baseline answers that punt ("cannot find"), which drive wins
 *
 * Env: SWEEP_DIR (default this dir's parent layout), REPORT_MODEL, SWEEP_CONFIG.
 * Gate: GITHUB_TOKEN (SKIP exit 0 if missing — still writes the numeric summary).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_DIR = process.env.SWEEP_DIR || __dirname;
const SCORES_DIR = path.join(SWEEP_DIR, "scores");
const TRANSCRIPTS_DIR = path.join(SWEEP_DIR, "transcripts");
const REPORT_FILE = path.join(SWEEP_DIR, "REPORT.md");
const SUMMARY_FILE = path.join(SWEEP_DIR, "summary.json");
const CONFIG_PATH = process.env.SWEEP_CONFIG || path.join(SWEEP_DIR, "sweep.config.json");
const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
const REPORT_MODEL = process.env.REPORT_MODEL || cfg.reportModel || "claude-opus-4.8";
// The report model writes a 6-section analysis over the full tensor; slow models
// (opus) need well beyond the old 180s. Configurable, generous default.
const REPORT_TIMEOUT_MS = Number(process.env.EVAL_REPORT_TIMEOUT_MS) || 600000;

function resolveGhToken() {
    const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN;
    if (fromEnv) return fromEnv;
    try { const m = readFileSync(path.resolve(__dirname, "..", "..", ".env"), "utf8").match(/^GITHUB_TOKEN=(.+)$/m); if (m) return m[1].trim().replace(/^["']|["']$/g, ""); } catch { /* */ }
    try { const t = execSync("gh auth token", { encoding: "utf8" }).trim(); if (t) return t; } catch { /* */ }
    return "";
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const round = (x, n = 2) => +Number(x).toFixed(n);
const stdev = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
function pearson(xs, ys) {
    const n = xs.length; if (n < 2) return 0;
    const mx = mean(xs), my = mean(ys);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
    return (dx && dy) ? round(num / Math.sqrt(dx * dy), 3) : 0;
}
/** model family from a label/model string, for same-family bias analysis. */
const familyOf = (label, model) => {
    const s = `${label} ${model}`.toLowerCase();
    if (s.includes("opus")) return "claude";
    if (s.includes("sonnet")) return "claude";
    if (s.includes("haiku")) return "claude";
    if (s.includes("gpt")) return "gpt";
    return "other";
};

// ── load all score cells ───────────────────────────────────────────────────────

if (!existsSync(SCORES_DIR)) { console.error(`No scores dir at ${SCORES_DIR}`); process.exit(1); }
const scoreFiles = readdirSync(SCORES_DIR).filter((f) => f.endsWith(".json"));
if (scoreFiles.length === 0) { console.error("No score files yet — run judging first."); process.exit(1); }

const cells = scoreFiles.map((f) => JSON.parse(readFileSync(path.join(SCORES_DIR, f), "utf8")));
const modelMap = cfg.models || {};

// flat per-row records tagged with harvester/query/judge for slicing
const recs = [];
for (const c of cells) {
    for (const r of c.rows) {
        recs.push({
            harvester: c.harvester, query: c.query, judge: c.judge,
            judgeModel: c.judgeModel, id: r.id, topic: r.topic,
            graphScore: r.graphScore, baseScore: r.baseScore, winner: r.winner,
            graphLen: r.graphLen, baseLen: r.baseLen, graphTools: r.graphTools, baseWeb: r.baseWeb,
        });
    }
}

const harvesters = [...new Set(cells.map((c) => c.harvester))].sort();
const queries = [...new Set(cells.map((c) => c.query))].sort();
const judges = [...new Set(cells.map((c) => c.judge))].sort();

// ── tensor + marginals ──────────────────────────────────────────────────────────

const cellAgg = (pred) => {
    const sub = recs.filter(pred);
    if (!sub.length) return null;
    const wins = { graph: 0, baseline: 0, tie: 0 };
    for (const r of sub) wins[r.winner]++;
    return {
        n: sub.length,
        graphMean: round(mean(sub.map((r) => r.graphScore))),
        baselineMean: round(mean(sub.map((r) => r.baseScore))),
        delta: round(mean(sub.map((r) => r.graphScore - r.baseScore))),
        wins,
    };
};

const tensor = [];
for (const h of harvesters) for (const q of queries) for (const j of judges) {
    const agg = cellAgg((r) => r.harvester === h && r.query === q && r.judge === j);
    if (agg) tensor.push({ harvester: h, query: q, judge: j, ...agg });
}

const marginal = (key) => {
    const vals = [...new Set(recs.map((r) => r[key]))].sort();
    return vals.map((v) => ({ [key]: v, ...cellAgg((r) => r[key] === v) }));
};

// ── judge bias: leniency + same-family ──────────────────────────────────────────

const judgeBias = judges.map((j) => {
    const jr = recs.filter((r) => r.judge === j);
    const sameFam = jr.filter((r) => familyOf(r.judge, modelMap[r.judge]) === familyOf(r.query, modelMap[r.query]));
    const diffFam = jr.filter((r) => familyOf(r.judge, modelMap[r.judge]) !== familyOf(r.query, modelMap[r.query]));
    return {
        judge: j, judgeModel: modelMap[j] || j,
        graphMean: round(mean(jr.map((r) => r.graphScore))),
        baselineMean: round(mean(jr.map((r) => r.baseScore))),
        delta: round(mean(jr.map((r) => r.graphScore - r.baseScore))),
        sameFamilyQueryGraphMean: sameFam.length ? round(mean(sameFam.map((r) => r.graphScore))) : null,
        diffFamilyQueryGraphMean: diffFam.length ? round(mean(diffFam.map((r) => r.graphScore))) : null,
    };
});

// ── inter-judge agreement: spread across judges on the same (h,q,id) answer ──────

const byAnswer = new Map();
for (const r of recs) {
    const k = `${r.harvester}__${r.query}__${r.id}`;
    if (!byAnswer.has(k)) byAnswer.set(k, []);
    byAnswer.get(k).push(r);
}
const graphSpreads = [], baseSpreads = [];
let unanimousGraphWins = 0, splitDecisions = 0, totalAnswers = 0;
for (const [, group] of byAnswer) {
    if (group.length < 2) continue;
    totalAnswers++;
    graphSpreads.push(Math.max(...group.map((r) => r.graphScore)) - Math.min(...group.map((r) => r.graphScore)));
    baseSpreads.push(Math.max(...group.map((r) => r.baseScore)) - Math.min(...group.map((r) => r.baseScore)));
    const winners = new Set(group.map((r) => r.winner));
    if (winners.size === 1 && winners.has("graph")) unanimousGraphWins++;
    if (winners.size > 1) splitDecisions++;
}
const interJudge = {
    answersWithMultipleJudges: totalAnswers,
    meanGraphScoreSpread: round(mean(graphSpreads)),
    meanBaselineScoreSpread: round(mean(baseSpreads)),
    unanimousGraphWins, splitDecisions,
};

// ── verbosity: does answer length correlate with score? ──────────────────────────

const verbosity = {
    graphScoreVsLen: pearson(recs.map((r) => r.graphLen), recs.map((r) => r.graphScore)),
    baselineScoreVsLen: pearson(recs.map((r) => r.baseLen), recs.map((r) => r.baseScore)),
    avgGraphLen: Math.round(mean(recs.map((r) => r.graphLen))),
    avgBaselineLen: Math.round(mean(recs.map((r) => r.baseLen))),
};

// ── abstention: short/low baseline answers ───────────────────────────────────────
const baselineAbstain = recs.filter((r) => r.baseScore <= 2);
const abstention = {
    baselineLowScoreRate: round(baselineAbstain.length / (recs.length || 1), 3),
    baselineUsedWebRate: round(recs.filter((r) => r.baseWeb).length / (recs.length || 1), 3),
};

const headline = cellAgg(() => true);

// Actual questions/cell comes from the DATA (rows ÷ cells), not the config — the
// committed questionCount can drift from what was actually run (e.g. --qlimit 8).
const questionsPerCell = cells.length ? Math.round(recs.length / cells.length) : 0;
// Baseline arm regime (web-access caps + idle watchdog), read from the same
// harness env/defaults graph-quality.mjs uses, so the report can disclose it.
const baselineRegime = {
    webSearchCap: Number(process.env.EVAL_WEB_SEARCH_BUDGET || 2),
    webFetchCap: Number(process.env.EVAL_WEB_FETCH_BUDGET || 8),
    armIdleTimeoutMs: Number(process.env.EVAL_ARM_IDLE_MS || 90000),
};

const summary = {
    generated: new Date().toISOString(),
    config: { harvesters, queries, judges, models: modelMap, corpus: cfg.corpus, questions: questionsPerCell, configuredQuestionCount: cfg.questionCount, baselineRegime },
    coverage: { scoreCells: cells.length, expected: harvesters.length * queries.length * judges.length, rows: recs.length },
    headline,
    marginals: { byHarvester: marginal("harvester"), byQuery: marginal("query"), byJudge: marginal("judge") },
    judgeBias, interJudge, verbosity, abstention,
    tensor,
};

writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
console.log(`wrote numeric summary → ${path.relative(process.cwd(), SUMMARY_FILE)}`);
console.log(`  headline: graph ${headline.graphMean} vs baseline ${headline.baselineMean} (Δ${headline.delta}); wins g${headline.wins.graph}/b${headline.wins.baseline}/t${headline.wins.tie}`);
console.log(`  coverage: ${cells.length}/${summary.coverage.expected} judge cells, ${recs.length} graded rows`);

// ── sample transcript excerpts (a couple of contested + clear cells) ─────────────

function sampleTranscripts() {
    if (!existsSync(TRANSCRIPTS_DIR)) return [];
    const files = readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith(".json")).slice(0, 2);
    const out = [];
    for (const f of files) {
        const t = JSON.parse(readFileSync(path.join(TRANSCRIPTS_DIR, f), "utf8"));
        for (const r of t.rows.slice(0, 2)) {
            out.push({
                cell: `${t.harvester}×${t.query}`, question: r.question,
                reference: String(r.reference).slice(0, 300),
                graph: String(r.graph.text).slice(0, 400),
                baseline: String(r.baseline.text).slice(0, 400),
            });
        }
    }
    return out;
}

// ── LLM narrative ────────────────────────────────────────────────────────────────

const GH_TOKEN = resolveGhToken();
if (!GH_TOKEN) {
    console.log("SKIP LLM narrative — no GITHUB_TOKEN. summary.json written; REPORT.md not generated.");
    process.exit(0);
}

const REPORT_SYSTEM = [
    "You are a rigorous ML evaluation analyst. You are given the COMPLETE numeric results of a cross-model",
    "experiment as JSON (already computed — do not invent or recompute numbers; cite only what is present).",
    "The experiment tests whether answering PostgreSQL pgsql-hackers questions from a HARVESTED KNOWLEDGE",
    "GRAPH beats a strong baseline that uses parametric knowledge + live web search. It sweeps three axes:",
    "harvester model (built the graph), query model (answered), judge model (graded) — a 3x3x3 tensor.",
    "",
    "IMPORTANT METHODOLOGY (cite from config.questions and config.baselineRegime — do not invent these):",
    "the baseline arm ran under deliberately constrained web access (web_search and web_fetch caps) and a",
    "per-answer idle watchdog (armIdleTimeoutMs): if the baseline streams no output for that long the answer",
    "is recorded as FAILED. These caps and the watchdog are part of the experimental setup and MUST be",
    "disclosed up front. Treat baseline idle-timeouts as a genuine operational/reliability signal — the model",
    "failed to deliver an answer within the responsiveness bar — NOT as mere harness noise to hide or wave away.",
    "config.questions is the ACTUAL questions-per-cell that ran (it may differ from configuredQuestionCount).",
    "",
    "Write a clear, skeptical REPORT.md in Markdown. Required sections:",
    "  0. Setup & methodology (models, corpus, ACTUAL question count, baseline web caps, idle watchdog seconds).",
    "  1. Headline result (graph vs baseline overall, with the numbers).",
    "  2. Does the harvester model matter? (marginal by harvester)",
    "  3. Does the query model matter? (marginal by query)",
    "  4. JUDGE BIAS — the key skeptical question. Discuss judge leniency (do some judges score higher?),",
    "     same-family favoritism (does a judge favor its own model family's answers?), and inter-judge",
    "     agreement (score spread, unanimous vs split decisions). State plainly whether judge choice changes",
    "     the conclusion.",
    "  5. Confounds — verbosity (score-vs-length correlation) and baseline abstention/failure rate. Separate",
    "     two distinct effects: (a) the graph being better on substance where both actually answer, and (b) the",
    "     baseline FAILING to answer (idle-timeout under the watchdog, or punting under the web caps). Frame (b)",
    "     as a real reliability property of that query model under the responsiveness bar, while also noting it",
    "     inflates the raw margin. Recommend splitting results by answered-vs-failed.",
    "  6. Bottom line + honest caveats (corpus framing, single eval, ACTUAL question count, baseline web caps).",
    "Use compact tables. Be specific with numbers. If the graph wins everywhere, say so but scrutinize WHY",
    "and whether any bias inflates it. If results are mixed, surface that honestly.",
    "",
    "OUTPUT CONTRACT: Your reply must BE the complete REPORT.md document itself — start directly with the",
    "'# ' H1 title and contain the full Markdown body. Do NOT describe the report, do NOT summarize what you",
    "changed, do NOT write in the past tense about editing a file, and do NOT use any tools. Emit only the",
    "document.",
].join("\n");

const { CopilotClient } = await import("@github/copilot-sdk");
const sdk = new CopilotClient({ gitHubToken: GH_TOKEN });
await sdk.start();
try {
    const session = await sdk.createSession({
        model: REPORT_MODEL,
        systemMessage: { mode: "replace", content: REPORT_SYSTEM },
        // Text-only: disable ALL tools (incl. SDK built-ins create/edit/bash) so the
        // model emits the Markdown document directly instead of acting like an
        // editing agent. Same pattern as the judge sessions in graph-quality.mjs.
        tools: [], availableTools: [],
        onPermissionRequest: () => ({ kind: "approve-for-session", approval: { kind: "custom-tool" } }),
    });
    let text = "";
    session.on("assistant.message", (e) => { if (e?.data?.content) text = e.data.content; });
    const idle = new Promise((res, rej) => { session.on("session.idle", res); session.on("session.error", (e) => rej(new Error(e?.data?.message || "session error"))); });
    const to = new Promise((_, rej) => setTimeout(() => rej(new Error(`report timeout ${Math.round(REPORT_TIMEOUT_MS / 1000)}s`)), REPORT_TIMEOUT_MS));
    const prompt = [
        "NUMERIC RESULTS (authoritative):",
        "```json", JSON.stringify(summary, null, 2), "```",
        "",
        "SAMPLE TRANSCRIPT EXCERPTS (illustrative only — do not generalize from these):",
        "```json", JSON.stringify(sampleTranscripts(), null, 2), "```",
        "",
        "Write REPORT.md now. Output ONLY the Markdown document.",
    ].join("\n");
    session.send({ prompt });
    await Promise.race([idle, to]);
    const md = text.replace(/^```markdown\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const stamped = `<!-- generated ${new Date().toISOString()} by generate-report.mjs (report model: ${REPORT_MODEL}) -->\n\n${md}\n`;
    writeFileSync(REPORT_FILE, stamped);
    console.log(`\nwrote LLM report → ${path.relative(process.cwd(), REPORT_FILE)} (${md.length} chars)`);
} finally {
    try { await sdk.stop(); } catch { /* */ }
}
