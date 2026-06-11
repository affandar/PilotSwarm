// eval/graph-quality.mjs — does the harvested knowledge GRAPH actually improve
// answer quality vs a strong model answering from its own knowledge + the web?
//
// Two arms, same questions, blinded LLM judge against a corpus-derived reference:
//
//   BASELINE  — model answers from parametric PG knowledge + the built-in
//               web_fetch tool (it can pull postgresql.org docs and the public
//               pgsql-hackers archive). NO graph access.
//   GRAPH     — model answers using ONLY the facts/graph retrieval tools
//               (facts_search / facts_similar / facts_read / graph_search_nodes
//               / graph_search_edges / graph_neighbourhood) over the harvested
//               archive. NO web, NO parametric free-styling.
//
// Ground truth: the questions are generated FROM the corpus emails, each with a
// reference answer grounded in the source email, so "correct" is well-defined.
//
// MODES:
//   node eval/graph-quality.mjs gen   — sample corpus → questions JSON (corpus only)
//   node eval/graph-quality.mjs run   — run both arms + judge → report (needs graph)
//
// Gates (SKIP, exit 0): GITHUB_TOKEN always; HORIZON_DATABASE_URL for `run`.
// Env: EVAL_MODEL (arms, default claude-haiku-4.5), JUDGE_MODEL (default EVAL_MODEL),
//   GEN_MODEL (default EVAL_MODEL), HARVEST_SCHEMA/HARVEST_GRAPH (default hz_eval/hzg_eval),
//   HARVEST_CORPUS (default pgsql-hackers-recent.json), QGEN (gen count, default 14),
//   QLIMIT (run subset), QUESTIONS_FILE (default eval/graph-quality-questions.json).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODE = (process.argv[2] || "run").toLowerCase();

// ── env / gates ──────────────────────────────────────────────────────────────

function normalizeDbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}
const DB_URL = normalizeDbUrl(process.env.HORIZON_DATABASE_URL || "");

function resolveGhToken() {
    const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN;
    if (fromEnv) return fromEnv;
    try {
        const env = readFileSync(path.resolve(__dirname, "..", ".env"), "utf8");
        const m = env.match(/^GITHUB_TOKEN=(.+)$/m);
        if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* none */ }
    try { const t = execSync("gh auth token", { encoding: "utf8" }).trim(); if (t) return t; } catch { /* none */ }
    return "";
}
const GH_TOKEN = resolveGhToken();
const MODEL = process.env.EVAL_MODEL || "claude-haiku-4.5";
const JUDGE_MODEL = process.env.JUDGE_MODEL || MODEL;
const GEN_MODEL = process.env.GEN_MODEL || MODEL;
const SCHEMA = process.env.HARVEST_SCHEMA || "hz_eval";
const GRAPH = process.env.HARVEST_GRAPH || "hzg_eval";
const CORPUS_FILE = process.env.HARVEST_CORPUS || "pgsql-hackers-recent.json";
const NS = "archive/pgsql-hackers";
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, "graph-quality-questions.json");
const QGEN = Number(process.env.QGEN || 14);
const QLIMIT = process.env.QLIMIT ? Number(process.env.QLIMIT) : Infinity;
const IDLE_MS = Number(process.env.EVAL_ARM_IDLE_MS || 90_000);

if (!GH_TOKEN) { console.log("SKIP graph-quality — missing GITHUB_TOKEN."); process.exit(0); }
if (MODE === "run" && !DB_URL) { console.log("SKIP graph-quality run — missing HORIZON_DATABASE_URL."); process.exit(0); }

const truncate = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const corpusPath = path.isAbsolute(CORPUS_FILE) ? CORPUS_FILE : path.join(__dirname, "corpus", CORPUS_FILE);

/** Extract the first balanced JSON object from a model response. */
function parseJsonObject(text) {
    const s = String(text ?? "");
    const start = s.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
}

// ── single-shot agent turn ────────────────────────────────────────────────────

/** Send one prompt, let the model loop through tools until idle, return the final
 * assistant text + per-arm telemetry (wall time, tool-call count, tool names). */
async function answerOnce(sdk, { systemMessage, tools, availableTools, prompt, label }) {
    const session = await sdk.createSession({
        model: MODEL,
        systemMessage: { mode: "replace", content: systemMessage },
        tools: tools ?? [],
        availableTools,
        onPermissionRequest: () => ({ kind: "approve-for-session", approval: { kind: "custom-tool" } }),
    });
    let text = "";
    let toolCalls = 0;
    const toolNames = new Set();
    let lastActivity = Date.now();
    session.on("assistant.message", (e) => { lastActivity = Date.now(); if (e?.data?.content) text = e.data.content; });
    session.on((event) => {
        const t = event?.type ?? "";
        if (t === "tool.execution_start") {
            lastActivity = Date.now();
            toolCalls++;
            const n = event?.data?.toolName || event?.data?.name;
            if (n) toolNames.add(n);
        }
    });
    const done = new Promise((resolve, reject) => {
        session.on("session.idle", () => resolve());
        session.on("session.error", (e) => reject(new Error(e?.data?.message || "session error")));
    });
    const watchdog = new Promise((_, reject) => {
        const iv = setInterval(() => {
            if (Date.now() - lastActivity > IDLE_MS) { clearInterval(iv); reject(new Error(`${label}: idle > ${IDLE_MS}ms`)); }
        }, 3000);
        done.finally(() => clearInterval(iv));
    });
    const t0 = performance.now();
    session.send({ prompt });
    try { await Promise.race([done, watchdog]); }
    catch (err) { return { text: text || `(no answer — ${err.message})`, toolCalls, toolNames: [...toolNames], wallMs: performance.now() - t0, error: err.message }; }
    return { text, toolCalls, toolNames: [...toolNames], wallMs: performance.now() - t0 };
}

// ── GEN: corpus → questions ────────────────────────────────────────────────────

const GEN_SYSTEM = [
    "You write evaluation questions for a PostgreSQL pgsql-hackers mailing-list knowledge base.",
    "Given ONE archived email, produce ONE specific, factual question whose answer is stated IN that email,",
    "plus the grounded reference answer. The question MUST require knowledge of THIS archive's specifics",
    "(who proposed/reviewed/objected to what, a concrete patch detail, a specific concern, a specific",
    "design decision) — NOT generic PostgreSQL trivia answerable without the archive.",
    "Prefer questions about people, patches, threads, relationships, and stated opinions/concerns.",
    "Respond with ONLY a JSON object:",
    '{ "question": "...", "reference": "...", "requires_archive": true|false, "topic": "short tag" }',
    "Set requires_archive=false if a strong model could answer it from general PG knowledge alone (it will be dropped).",
].join("\n");

async function runGen(sdk) {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
    const messages = corpus.messages;
    // Sample evenly across the corpus for thread/topic diversity.
    const stride = Math.max(1, Math.floor(messages.length / (QGEN * 2)));
    const sampled = [];
    for (let i = 0; i < messages.length && sampled.length < QGEN * 2; i += stride) sampled.push(messages[i]);
    console.log(`gen: sampling ${sampled.length} of ${messages.length} messages (stride ${stride}), target ${QGEN} questions`);

    const out = [];
    for (const m of sampled) {
        if (out.length >= QGEN) break;
        const emailText = `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\nMessage-ID: ${m.id}\n\n${truncate(m.body, 3500)}`;
        const r = await answerOnce(sdk, {
            systemMessage: GEN_SYSTEM,
            tools: [], availableTools: [],
            prompt: `Email:\n\n${emailText}\n\nWrite the question + reference JSON now.`,
            label: "gen",
        });
        const obj = parseJsonObject(r.text);
        if (!obj?.question || !obj?.reference) { console.log(`  · skip ${truncate(m.subject, 50)} (no JSON)`); continue; }
        if (obj.requires_archive === false) { console.log(`  · drop (generic) ${truncate(obj.question, 60)}`); continue; }
        out.push({
            id: out.length + 1, question: obj.question.trim(), reference: obj.reference.trim(),
            topic: obj.topic || "", sourceId: m.id, sourceSubject: m.subject,
        });
        console.log(`  ✓ Q${out.length}: ${truncate(obj.question, 80)}`);
    }
    writeFileSync(QUESTIONS_FILE, JSON.stringify({ generated: new Date().toISOString(), model: GEN_MODEL, corpus: CORPUS_FILE, questions: out }, null, 2));
    console.log(`\nwrote ${out.length} questions → ${path.relative(process.cwd(), QUESTIONS_FILE)}`);
}

// ── RUN: baseline vs graph + judge ─────────────────────────────────────────────

const BASELINE_SYSTEM = [
    "You are a PostgreSQL internals expert answering a question about the pgsql-hackers mailing list.",
    "Answer from your own knowledge of PostgreSQL and its development. You MAY use the web_fetch tool to",
    "retrieve public pages — e.g. postgresql.org docs, or the public pgsql-hackers archive at",
    "https://www.postgresql.org/message-id/<message-id> and https://www.postgresql.org/list/pgsql-hackers/ .",
    "Give a SPECIFIC, factual answer naming people/patches/threads where relevant. If you cannot determine",
    "the answer, say so honestly rather than guessing.",
].join("\n");

const GRAPH_SYSTEM = [
    "You answer questions about a PostgreSQL pgsql-hackers mailing-list archive that has been harvested into",
    "a knowledge graph (people, patches, code_files, threads, concepts joined by free-text relationships)",
    "plus a searchable facts store (one fact per email).",
    "Use ONLY the provided retrieval tools — do NOT rely on prior knowledge:",
    "  • facts_search { query, mode, namespace } — find emails (mode: lexical|semantic|hybrid).",
    `    Always pass namespace: "${NS}".`,
    "  • facts_similar { scopeKey, k } — semantically nearest emails to one you already have.",
    "  • facts_read { scopeKeys } — read full email bodies (resolve graph evidence back to text).",
    "  • graph_search_nodes { kind, nameLike, seeds, depth } — resolve/expand entities.",
    "  • graph_search_edges { fromKey, toKey, predicate } — relationships.",
    "  • graph_neighbourhood { nodeKey, depth } — everything connected to a node.",
    "Retrieve grounded context first, then answer SPECIFICALLY, naming the people/patches/threads you found.",
    "If the tools return nothing relevant, say so honestly rather than inventing an answer.",
].join("\n");

const JUDGE_SYSTEM = [
    "You are a strict grader. You are given a QUESTION about the pgsql-hackers archive, a REFERENCE answer",
    "derived from the source emails (treat it as ground truth), and two candidate answers A and B.",
    "Grade each candidate on FACTUAL CORRECTNESS vs the reference and SPECIFICITY (names, concrete details).",
    "An answer that is vague, hedges, or says 'I don't know' scores low. An answer that invents plausible-",
    "sounding but unverifiable specifics that conflict with the reference scores low (penalize hallucination).",
    "Respond with ONLY JSON:",
    '{ "a_score": 1-5, "b_score": 1-5, "winner": "A"|"B"|"tie", "reason": "one sentence" }',
].join("\n");

async function judge(sdk, q, ansA, ansB) {
    const prompt = [
        `QUESTION:\n${q.question}`, ``,
        `REFERENCE (ground truth):\n${q.reference}`, ``,
        `ANSWER A:\n${truncate(ansA, 1800)}`, ``,
        `ANSWER B:\n${truncate(ansB, 1800)}`, ``,
        `Grade now as JSON.`,
    ].join("\n");
    const r = await answerOnce(sdk, { systemMessage: JUDGE_SYSTEM, tools: [], availableTools: [], prompt, label: "judge" });
    const obj = parseJsonObject(r.text) || {};
    return {
        aScore: Number(obj.a_score) || 0, bScore: Number(obj.b_score) || 0,
        winner: ["A", "B", "tie"].includes(obj.winner) ? obj.winner : "tie",
        reason: String(obj.reason || "").trim(),
    };
}

async function runEval(sdk) {
    if (!existsSync(QUESTIONS_FILE)) {
        console.log(`No questions file at ${QUESTIONS_FILE}. Run \`node eval/graph-quality.mjs gen\` first.`);
        process.exit(1);
    }
    const { questions } = JSON.parse(readFileSync(QUESTIONS_FILE, "utf8"));
    const subset = questions.slice(0, Math.min(questions.length, QLIMIT));
    console.log(`graph-quality RUN — ${subset.length} questions  arms model=${MODEL}  judge=${JUDGE_MODEL}`);
    console.log(`  graph: schema=${SCHEMA} graph=${GRAPH}\n`);

    const { HorizonFactStore } = await import("../dist/src/index.js");
    const store = await HorizonFactStore.create({ connectionString: DB_URL, schema: SCHEMA, graphName: GRAPH, embeddingDim: 1536 });
    // No initialize() — we read an already-harvested store. Confirm it exists.
    const { buildSdkTools } = await import("./tools.mjs");
    const { tools: graphTools, toolNames: graphToolNames } = await buildSdkTools(store, { role: "reader" });
    // Real web tools for the baseline (the SDK's built-ins are broken here).
    const { buildWebTools } = await import("./web-tools.mjs");
    const { tools: webTools, toolNames: webToolNames } = buildWebTools();

    const rows = [];
    try {
        for (const q of subset) {
            console.log(`Q${q.id}: ${truncate(q.question, 90)}`);
            // Run both arms (sequential — keeps DB/LLM load clean and comparable).
            const baseline = await answerOnce(sdk, {
                systemMessage: BASELINE_SYSTEM, tools: webTools, availableTools: webToolNames,
                prompt: q.question, label: "baseline",
            });
            const graph = await answerOnce(sdk, {
                systemMessage: GRAPH_SYSTEM, tools: graphTools, availableTools: graphToolNames,
                prompt: q.question, label: "graph",
            });
            // Blind + randomize A/B to remove position bias.
            const graphIsA = Math.random() < 0.5;
            const ansA = graphIsA ? graph.text : baseline.text;
            const ansB = graphIsA ? baseline.text : graph.text;
            const j = await judge(sdk, q, ansA, ansB);
            const graphScore = graphIsA ? j.aScore : j.bScore;
            const baseScore = graphIsA ? j.bScore : j.aScore;
            const winner = j.winner === "tie" ? "tie" : ((j.winner === "A") === graphIsA ? "graph" : "baseline");
            rows.push({ q, baseline, graph, graphScore, baseScore, winner, reason: j.reason });
            console.log(`   graph ${graphScore}/5 (${graph.toolCalls} tools, ${(graph.wallMs / 1000).toFixed(1)}s)  ` +
                `baseline ${baseScore}/5 (${baseline.toolCalls} tools${baseline.toolNames.includes("web_fetch") ? "+web" : ""}, ${(baseline.wallMs / 1000).toFixed(1)}s)  → ${winner}`);
        }
    } finally {
        await store.close?.();
    }
    report(rows);
}

function report(rows) {
    const n = rows.length || 1;
    const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
    const gMean = (sum((r) => r.graphScore) / n), bMean = (sum((r) => r.baseScore) / n);
    const wins = { graph: 0, baseline: 0, tie: 0 };
    for (const r of rows) wins[r.winner]++;
    const webUsed = rows.filter((r) => r.baseline.toolNames.includes("web_fetch") || r.baseline.toolNames.includes("web_search")).length;
    const gToolAvg = sum((r) => r.graph.toolCalls) / n;
    const gWallAvg = sum((r) => r.graph.wallMs) / n / 1000;
    const bWallAvg = sum((r) => r.baseline.wallMs) / n / 1000;

    console.log(`\n${"═".repeat(78)}`);
    console.log("GRAPH-QUALITY EVAL — graph-grounded vs parametric+web");
    console.log("═".repeat(78));
    console.log(`questions: ${rows.length}   arms: ${MODEL}   judge: ${JUDGE_MODEL}`);
    console.log("");
    console.log(`mean score /5     graph ${gMean.toFixed(2)}     baseline ${bMean.toFixed(2)}     Δ ${(gMean - bMean >= 0 ? "+" : "")}${(gMean - bMean).toFixed(2)}`);
    console.log(`head-to-head      graph wins ${wins.graph}   baseline wins ${wins.baseline}   ties ${wins.tie}`);
    console.log(`baseline used web on ${webUsed}/${rows.length} questions`);
    console.log(`avg graph retrieval ${gToolAvg.toFixed(1)} tool calls   avg wall: graph ${gWallAvg.toFixed(1)}s / baseline ${bWallAvg.toFixed(1)}s`);
    console.log(`\n${"─".repeat(78)}`);
    console.log("PER-QUESTION");
    console.log("─".repeat(78));
    for (const r of rows) {
        const tag = r.winner === "graph" ? "GRAPH " : r.winner === "baseline" ? "BASE  " : "tie   ";
        console.log(`Q${String(r.q.id).padStart(2)} [${tag}] g${r.graphScore} b${r.baseScore}  ${truncate(r.q.question, 84)}`);
        if (r.reason) console.log(`        ↳ ${truncate(r.reason, 110)}`);
    }
    console.log(`\n${"─".repeat(78)}`);
    console.log("SAMPLE ANSWERS (first 3 questions)");
    console.log("─".repeat(78));
    for (const r of rows.slice(0, 3)) {
        console.log(`\nQ${r.q.id}: ${r.q.question}`);
        console.log(`  REFERENCE: ${truncate(r.q.reference, 240)}`);
        console.log(`  GRAPH    (${r.graphScore}/5): ${truncate(r.graph.text, 280)}`);
        console.log(`  BASELINE (${r.baseScore}/5): ${truncate(r.baseline.text, 280)}`);
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const { CopilotClient } = await import("@github/copilot-sdk");
    const sdk = new CopilotClient({ gitHubToken: GH_TOKEN });
    await sdk.start();
    try {
        if (MODE === "gen") await runGen(sdk);
        else if (MODE === "run") await runEval(sdk);
        else { console.log(`Unknown mode '${MODE}'. Use 'gen' or 'run'.`); process.exit(1); }
    } finally {
        try { await sdk.stop(); } catch { /* ignore */ }
    }
}

main().catch((err) => { console.error("\nGRAPH-QUALITY ERROR:", err?.stack || err?.message || err); process.exit(1); });
