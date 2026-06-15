// eval/graph-explore.mjs — REALISTIC exploration eval.
//
// Real agents don't ask pinpoint trivia; they EXPLORE. The pattern (per how an
// LLM actually consumes this KB):
//
//   start from an AREA ("logical replication conflict logging", "REPACK") or a
//   CODE FILE ("pg_stat_statements.c")  →  find the relevant facts  →  THEN walk
//   the GRAPH for adjacents (other patches by the same author, reviewers,
//   related concepts, open concerns) and synthesize a brief.
//
// This eval scores that open-ended synthesis, not a single fact. Two arms, same
// open-ended tasks, blinded judge against a corpus-derived DOSSIER (the set of
// people / patches / concerns / decisions a complete brief should cover):
//
//   BASELINE  — parametric PG knowledge + built-in web_fetch/web_search. No graph.
//   GRAPH     — the realistic flow: facts_search → graph_search_nodes(seeds=scopeKeys)
//               → graph_neighbourhood/edges (adjacents) → facts_read(evidence) → brief.
//
// Ground truth: tasks are generated FROM whole corpus THREADS (an area = a
// thread; a file task = the thread(s) touching that file), so the dossier covers
// everything actually discussed. Coverage is therefore well-defined.
//
// MODES:
//   node eval/graph-explore.mjs gen   — corpus threads → exploration tasks + dossiers (corpus only)
//   node eval/graph-explore.mjs run   — both arms + coverage judge → report (needs graph)
//
// Gates (SKIP, exit 0): GITHUB_TOKEN always; HORIZON_DATABASE_URL for `run`.
// Env: EVAL_MODEL (arms, default claude-haiku-4.5), JUDGE_MODEL, GEN_MODEL,
//   HARVEST_SCHEMA/HARVEST_GRAPH (default hz_eval/hzg_eval), HARVEST_CORPUS,
//   EXPLORE_AREAS (default 10), EXPLORE_FILES (default 3), QLIMIT (run subset),
//   TASKS_FILE (default eval/graph-explore-tasks.json), EXPLORE_EMBED_DIM (default 1536).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
const TASKS_FILE = process.env.TASKS_FILE || path.join(__dirname, "graph-explore-tasks.json");
const N_AREAS = Number(process.env.EXPLORE_AREAS || 10);
const N_FILES = Number(process.env.EXPLORE_FILES || 3);
const QLIMIT = process.env.QLIMIT ? Number(process.env.QLIMIT) : Infinity;
const EMBED_DIM = Number(process.env.EXPLORE_EMBED_DIM || 1536);
const IDLE_MS = Number(process.env.EVAL_ARM_IDLE_MS || 120_000);

if (!GH_TOKEN) { console.log("SKIP graph-explore — missing GITHUB_TOKEN."); process.exit(0); }
if (MODE === "run" && !DB_URL) { console.log("SKIP graph-explore run — missing HORIZON_DATABASE_URL."); process.exit(0); }

const truncate = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const normSubj = (s) => String(s).replace(/^\s*(re|fwd|aw):\s*/i, "").replace(/^\s*(re|fwd|aw):\s*/i, "").trim();
const corpusPath = path.isAbsolute(CORPUS_FILE) ? CORPUS_FILE : path.join(__dirname, "corpus", CORPUS_FILE);

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

// ── single agent turn (loops through tools until idle) ─────────────────────────

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
    const toolSeq = [];
    let lastActivity = Date.now();
    session.on("assistant.message", (e) => { lastActivity = Date.now(); if (e?.data?.content) text = e.data.content; });
    session.on((event) => {
        const t = event?.type ?? "";
        if (t === "tool.execution_start") {
            lastActivity = Date.now();
            toolCalls++;
            const n = event?.data?.toolName || event?.data?.name;
            if (n) toolSeq.push(n);
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
    catch (err) { return { text: text || `(no answer — ${err.message})`, toolCalls, toolSeq, wallMs: performance.now() - t0, error: err.message }; }
    return { text, toolCalls, toolSeq, wallMs: performance.now() - t0 };
}

// ── GEN: corpus threads → exploration tasks + dossiers ─────────────────────────

const DOSSIER_SYSTEM = [
    "You build a reference DOSSIER for an evaluation of a PostgreSQL pgsql-hackers knowledge base.",
    "Given ALL emails of ONE mailing-list thread (an AREA of discussion), produce:",
    "  • area: a short area name a developer would recognize (e.g. 'REPACK CONCURRENTLY command').",
    "  • question: ONE open-ended brief request a developer ramping up on this area would ask —",
    "    e.g. 'I'm getting up to speed on <area>. Who is involved, what patches/proposals exist,",
    "    how do they relate, and what are the main open concerns or disagreements?'",
    "  • key_points: 6-12 SPECIFIC, checkable facts a COMPLETE brief must cover — each naming",
    "    concrete people, patches, decisions, concerns, error messages, or design choices FROM the",
    "    thread. No vague points.",
    "  • people / patches / files / concepts: the named entities actually present in the thread.",
    "Respond with ONLY JSON:",
    '{ "area": "...", "question": "...", "key_points": ["..."], "people": ["..."], "patches": ["..."], "files": ["..."], "concepts": ["..."] }',
].join("\n");

const FILE_DOSSIER_SYSTEM = [
    "You build a reference DOSSIER for an evaluation of a PostgreSQL pgsql-hackers knowledge base,",
    "centered on a specific CODE FILE. Given the emails that mention the file, produce:",
    "  • area: 'activity touching <file>'.",
    "  • question: an open-ended request like 'I'm about to work on <file>. What recent pgsql-hackers",
    "    activity touches it — which patches/threads/people, and what concerns or changes should I know?'",
    "  • key_points: 5-10 SPECIFIC checkable facts about how this file figures in the discussions.",
    "  • people / patches / files / concepts: named entities actually present.",
    "Respond with ONLY JSON (same shape as the area dossier).",
].join("\n");

function threadClusters(messages) {
    const by = new Map();
    for (const m of messages) {
        const k = normSubj(m.subject);
        const g = by.get(k) || { subject: k, msgs: [] };
        g.msgs.push(m);
        by.set(k, g);
    }
    return [...by.values()].sort((a, b) => b.msgs.length - a.msgs.length);
}

function threadText(msgs, perMsg = 1400, cap = 14000) {
    let out = "";
    for (const m of msgs) {
        const block = `--- Message-ID: ${m.id}\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${truncate(m.body, perMsg)}\n`;
        if (out.length + block.length > cap) break;
        out += block + "\n";
    }
    return out;
}

async function runGen(sdk) {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
    const messages = corpus.messages;
    const clusters = threadClusters(messages);
    const areas = clusters.filter((c) => c.msgs.length >= 2);
    console.log(`gen: ${clusters.length} threads, ${areas.length} multi-message; target ${N_AREAS} area + ${N_FILES} file tasks`);

    const tasks = [];

    // Area tasks — one per richest threads.
    for (const c of areas.slice(0, N_AREAS)) {
        const r = await answerOnce(sdk, {
            systemMessage: DOSSIER_SYSTEM, tools: [], availableTools: [],
            prompt: `Thread "${c.subject}" (${c.msgs.length} messages):\n\n${threadText(c.msgs)}\n\nBuild the dossier JSON now.`,
            label: "gen-area",
        });
        const obj = parseJsonObject(r.text);
        if (!obj?.question || !Array.isArray(obj.key_points) || obj.key_points.length < 3) { console.log(`  · skip area "${truncate(c.subject, 50)}" (thin dossier)`); continue; }
        tasks.push({
            id: tasks.length + 1, seedType: "area", seed: obj.area || c.subject,
            question: obj.question.trim(), key_points: obj.key_points,
            entities: { people: obj.people || [], patches: obj.patches || [], files: obj.files || [], concepts: obj.concepts || [] },
            threadSubject: c.subject, sourceIds: c.msgs.map((m) => m.id),
        });
        console.log(`  ✓ area Q${tasks.length}: ${truncate(obj.area || c.subject, 60)} (${obj.key_points.length} key points)`);
    }

    // File tasks — top mentioned code files; dossier from the threads that mention them.
    const fileCount = new Map();
    const re = /\b(?:src\/[\w/]+\/)?(\w+\.[ch])\b/g;
    for (const m of messages) { let x; while ((x = re.exec(m.body))) fileCount.set(x[1], (fileCount.get(x[1]) || 0) + 1); }
    const topFiles = [...fileCount.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 2).slice(0, N_FILES);
    for (const [file] of topFiles) {
        const hits = messages.filter((m) => new RegExp(`\\b${file.replace(/\./g, "\\.")}\\b`).test(m.body));
        if (hits.length === 0) continue;
        const r = await answerOnce(sdk, {
            systemMessage: FILE_DOSSIER_SYSTEM, tools: [], availableTools: [],
            prompt: `Code file: ${file}\n\nEmails mentioning it (${hits.length}):\n\n${threadText(hits)}\n\nBuild the file-centric dossier JSON now.`,
            label: "gen-file",
        });
        const obj = parseJsonObject(r.text);
        if (!obj?.question || !Array.isArray(obj.key_points) || obj.key_points.length < 3) { console.log(`  · skip file ${file} (thin dossier)`); continue; }
        tasks.push({
            id: tasks.length + 1, seedType: "code_file", seed: file,
            question: obj.question.trim(), key_points: obj.key_points,
            entities: { people: obj.people || [], patches: obj.patches || [], files: obj.files || [file], concepts: obj.concepts || [] },
            threadSubject: `file:${file}`, sourceIds: hits.map((m) => m.id),
        });
        console.log(`  ✓ file Q${tasks.length}: ${file} (${obj.key_points.length} key points)`);
    }

    writeFileSync(TASKS_FILE, JSON.stringify({ generated: new Date().toISOString(), model: GEN_MODEL, corpus: CORPUS_FILE, tasks }, null, 2));
    console.log(`\nwrote ${tasks.length} exploration tasks → ${path.relative(process.cwd(), TASKS_FILE)}`);
}

// ── RUN: baseline vs graph (multi-hop) + coverage judge ────────────────────────

const BASELINE_SYSTEM = [
    "You are briefing a developer who is ramping up on a PostgreSQL development area (or a code file).",
    "Answer from your own PostgreSQL knowledge. You MAY use web_fetch/web_search to retrieve public",
    "pages — postgresql.org docs and the public pgsql-hackers archive",
    "(https://www.postgresql.org/list/pgsql-hackers/ and message-id permalinks).",
    "Produce a thorough brief: who is involved, what patches/proposals exist, how they relate, and the",
    "main open concerns, disagreements, and decisions. Name specific people, patches, and threads.",
    "If you cannot determine specifics, say so honestly rather than inventing them.",
].join("\n");

const GRAPH_SYSTEM = [
    "You are briefing a developer on a PostgreSQL development AREA (or CODE FILE), using ONLY a harvested",
    "pgsql-hackers knowledge base — a facts store (one fact per email) plus a knowledge graph (people,",
    "patches, code_files, threads, concepts joined by free-text relationship edges). Do NOT use prior",
    "knowledge; retrieve everything.",
    "",
    "FOLLOW THIS EXPLORATION FLOW (this is how the KB is meant to be used):",
    "  1. ORIENT — facts_search({ query: <the area/file>, mode: 'hybrid', namespace: '" + NS + "' }).",
    "     Collect the most relevant emails and KEEP their scopeKeys.",
    "  2. PIVOT INTO THE GRAPH — graph_search_nodes({ seeds: <those scopeKeys>, depth: 2 }) to surface the",
    "     entities connected to those facts AND their adjacents (other patches, reviewers, concepts).",
    "     Also graph_search_nodes({ kind, nameLike }) to resolve a specific person/patch/file by name.",
    "  3. EXPAND FOR ADJACENTS — for the central entities, graph_neighbourhood({ nodeKey, depth: 2 }) and",
    "     graph_search_edges({ fromKey|toKey }) to discover relationships and adjacent entities you would",
    "     NOT find by search alone (e.g. another patch by the same author, who reviewed what, related concepts).",
    "  4. GROUND — facts_read({ scopeKeys: <evidence from the nodes/edges> }) to read the actual emails.",
    "  5. SYNTHESIZE — brief the developer: who is involved, what patches/proposals exist, how they relate",
    "     (use the graph edges!), and the open concerns/disagreements/decisions. Name specifics.",
    "If retrieval returns nothing relevant, say so honestly rather than inventing an answer.",
].join("\n");

const JUDGE_SYSTEM = [
    "You are a strict grader for OPEN-ENDED briefs about the pgsql-hackers archive. You are given the TASK,",
    "a reference DOSSIER (KEY POINTS = ground truth a complete brief must cover, plus the named ENTITIES),",
    "and two candidate briefs A and B. Grade each on three axes, 1-5:",
    "  • coverage   — how many KEY POINTS it captures (5 = nearly all, 1 = almost none).",
    "  • accuracy   — factual correctness vs the dossier; penalize invented/contradictory specifics.",
    "  • connections — does it surface RELATIONSHIPS / adjacent entities (who relates to whom, related",
    "                  patches/concepts), not just an isolated list? (5 = rich, well-connected synthesis).",
    "Vague briefs and 'I don't know' score low on coverage. Hallucinated specifics score low on accuracy.",
    "Respond with ONLY JSON:",
    '{ "a": {"coverage":1-5,"accuracy":1-5,"connections":1-5}, "b": {"coverage":1-5,"accuracy":1-5,"connections":1-5}, "winner":"A"|"B"|"tie", "reason":"one sentence" }',
].join("\n");

async function judge(sdk, task, ansA, ansB) {
    const dossier = [
        `KEY POINTS (ground truth):`,
        ...task.key_points.map((p, i) => `  ${i + 1}. ${p}`),
        ``,
        `ENTITIES: people=[${(task.entities.people || []).join(", ")}] patches=[${(task.entities.patches || []).join(", ")}] files=[${(task.entities.files || []).join(", ")}] concepts=[${(task.entities.concepts || []).join(", ")}]`,
    ].join("\n");
    const prompt = [
        `TASK:\n${task.question}`, ``,
        dossier, ``,
        `BRIEF A:\n${truncate(ansA, 2600)}`, ``,
        `BRIEF B:\n${truncate(ansB, 2600)}`, ``,
        `Grade now as JSON.`,
    ].join("\n");
    const r = await answerOnce(sdk, { systemMessage: JUDGE_SYSTEM, tools: [], availableTools: [], prompt, label: "judge" });
    const obj = parseJsonObject(r.text) || {};
    const norm = (x) => ({ coverage: Number(x?.coverage) || 0, accuracy: Number(x?.accuracy) || 0, connections: Number(x?.connections) || 0 });
    return {
        a: norm(obj.a), b: norm(obj.b),
        winner: ["A", "B", "tie"].includes(obj.winner) ? obj.winner : "tie",
        reason: String(obj.reason || "").trim(),
    };
}

const avg3 = (s) => (s.coverage + s.accuracy + s.connections) / 3;

async function runEval(sdk) {
    if (!existsSync(TASKS_FILE)) {
        console.log(`No tasks file at ${TASKS_FILE}. Run \`node eval/graph-explore.mjs gen\` first.`);
        process.exit(1);
    }
    const { tasks } = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
    const subset = tasks.slice(0, Math.min(tasks.length, QLIMIT));
    console.log(`graph-explore RUN — ${subset.length} tasks  arms=${MODEL}  judge=${JUDGE_MODEL}`);
    console.log(`  graph: schema=${SCHEMA} graph=${GRAPH}\n`);

    const { makeEvalStore } = await import("./_store.mjs");
    // Reads an already-harvested store (no initialize / migrations).
    const { store } = await makeEvalStore(
        { connectionString: DB_URL, schema: SCHEMA, graphName: GRAPH, embeddingDim: EMBED_DIM },
        { initialize: false });
    const { buildSdkTools } = await import("./tools.mjs");
    const { tools: graphTools, toolNames: graphToolNames } = await buildSdkTools(store, { role: "reader" });
    // Real web tools for the baseline (the SDK's built-ins are broken here).
    const { buildWebTools } = await import("./web-tools.mjs");
    const { tools: webTools, toolNames: webToolNames } = buildWebTools();

    const rows = [];
    try {
        for (const task of subset) {
            console.log(`Q${task.id} [${task.seedType}] ${truncate(task.seed, 70)}`);
            const baseline = await answerOnce(sdk, {
                systemMessage: BASELINE_SYSTEM, tools: webTools, availableTools: webToolNames,
                prompt: task.question, label: "baseline",
            });
            const graph = await answerOnce(sdk, {
                systemMessage: GRAPH_SYSTEM, tools: graphTools, availableTools: graphToolNames,
                prompt: task.question, label: "graph",
            });
            const graphIsA = Math.random() < 0.5;
            const j = await judge(sdk, task, graphIsA ? graph.text : baseline.text, graphIsA ? baseline.text : graph.text);
            const gS = graphIsA ? j.a : j.b;
            const bS = graphIsA ? j.b : j.a;
            const winner = j.winner === "tie" ? "tie" : ((j.winner === "A") === graphIsA ? "graph" : "baseline");
            // Did the graph arm actually traverse (search → graph)? Detect the pivot.
            const usedSearch = graph.toolSeq.some((t) => t.startsWith("facts_"));
            const usedGraph = graph.toolSeq.some((t) => t.startsWith("graph_"));
            rows.push({ task, baseline, graph, gS, bS, winner, reason: j.reason, traversed: usedSearch && usedGraph });
            console.log(`   graph cov${gS.coverage}/acc${gS.accuracy}/con${gS.connections} (${graph.toolCalls} tools${usedSearch && usedGraph ? ", search→graph" : ""})  ` +
                `baseline cov${bS.coverage}/acc${bS.accuracy}/con${bS.connections} (${baseline.toolCalls} tools${baseline.toolSeq.some((t) => t.startsWith("web")) ? "+web" : ""})  → ${winner}`);
        }
    } finally {
        await store.close?.();
    }
    report(rows);
}

function report(rows) {
    const n = rows.length || 1;
    const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
    const dims = ["coverage", "accuracy", "connections"];
    const gDim = Object.fromEntries(dims.map((d) => [d, sum((r) => r.gS[d]) / n]));
    const bDim = Object.fromEntries(dims.map((d) => [d, sum((r) => r.bS[d]) / n]));
    const gOverall = sum((r) => avg3(r.gS)) / n, bOverall = sum((r) => avg3(r.bS)) / n;
    const wins = { graph: 0, baseline: 0, tie: 0 };
    for (const r of rows) wins[r.winner]++;
    const webUsed = rows.filter((r) => r.baseline.toolSeq.some((t) => t.startsWith("web"))).length;
    const traversed = rows.filter((r) => r.traversed).length;
    const gToolAvg = sum((r) => r.graph.toolCalls) / n;
    const gWall = sum((r) => r.graph.wallMs) / n / 1000, bWall = sum((r) => r.baseline.wallMs) / n / 1000;

    console.log(`\n${"═".repeat(82)}`);
    console.log("GRAPH-EXPLORE EVAL — open-ended area/file briefs: graph traversal vs parametric+web");
    console.log("═".repeat(82));
    console.log(`tasks: ${rows.length}   arms: ${MODEL}   judge: ${JUDGE_MODEL}`);
    console.log("");
    console.log(`                 coverage   accuracy   connections   overall`);
    console.log(`  graph    ${gDim.coverage.toFixed(2).padStart(8)}   ${gDim.accuracy.toFixed(2).padStart(8)}   ${gDim.connections.toFixed(2).padStart(11)}   ${gOverall.toFixed(2).padStart(7)}`);
    console.log(`  baseline ${bDim.coverage.toFixed(2).padStart(8)}   ${bDim.accuracy.toFixed(2).padStart(8)}   ${bDim.connections.toFixed(2).padStart(11)}   ${bOverall.toFixed(2).padStart(7)}`);
    console.log(`  Δ(graph-base) ${(gDim.coverage - bDim.coverage >= 0 ? "+" : "") + (gDim.coverage - bDim.coverage).toFixed(2)}      ` +
        `${(gDim.accuracy - bDim.accuracy >= 0 ? "+" : "") + (gDim.accuracy - bDim.accuracy).toFixed(2)}        ` +
        `${(gDim.connections - bDim.connections >= 0 ? "+" : "") + (gDim.connections - bDim.connections).toFixed(2)}        ` +
        `${(gOverall - bOverall >= 0 ? "+" : "") + (gOverall - bOverall).toFixed(2)}`);
    console.log("");
    console.log(`head-to-head      graph wins ${wins.graph}   baseline wins ${wins.baseline}   ties ${wins.tie}`);
    console.log(`graph arm ran the search→graph pivot on ${traversed}/${rows.length} tasks`);
    console.log(`baseline used web on ${webUsed}/${rows.length} tasks`);
    console.log(`avg graph retrieval ${gToolAvg.toFixed(1)} tool calls   avg wall: graph ${gWall.toFixed(1)}s / baseline ${bWall.toFixed(1)}s`);

    console.log(`\n${"─".repeat(82)}`);
    console.log("PER-TASK");
    console.log("─".repeat(82));
    for (const r of rows) {
        const tag = r.winner === "graph" ? "GRAPH" : r.winner === "baseline" ? "BASE " : "tie  ";
        console.log(`Q${String(r.task.id).padStart(2)} [${tag}] [${r.task.seedType[0]}] g(${avg3(r.gS).toFixed(1)}) b(${avg3(r.bS).toFixed(1)})  ${truncate(r.task.seed, 60)}`);
        if (r.reason) console.log(`        ↳ ${truncate(r.reason, 120)}`);
    }

    console.log(`\n${"─".repeat(82)}`);
    console.log("SAMPLE BRIEFS (first 2 tasks)");
    console.log("─".repeat(82));
    for (const r of rows.slice(0, 2)) {
        console.log(`\nQ${r.task.id} [${r.task.seedType}] ${r.task.seed}`);
        console.log(`  TASK: ${truncate(r.task.question, 200)}`);
        console.log(`  KEY POINTS (${r.task.key_points.length}): ${truncate(r.task.key_points.join(" | "), 360)}`);
        console.log(`\n  GRAPH (cov${r.gS.coverage}/acc${r.gS.accuracy}/con${r.gS.connections}): ${truncate(r.graph.text, 420)}`);
        console.log(`\n  BASELINE (cov${r.bS.coverage}/acc${r.bS.accuracy}/con${r.bS.connections}): ${truncate(r.baseline.text, 420)}`);
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

main().catch((err) => { console.error("\nGRAPH-EXPLORE ERROR:", err?.stack || err?.message || err); process.exit(1); });
