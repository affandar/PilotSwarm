// eval/harvester-eval.mjs — end-to-end harvester eval.
//
// Builds a harvester agent with the STANDARD GitHub Copilot SDK (no PilotSwarm),
// gives it the enhanced-facts toolset (eval/tools.mjs → eval/store-adapter.mjs),
// seeds a synthetic pgsql-hackers corpus into HorizonDB, lets the agent harvest
// the open graph, then asserts the graph was built correctly.
//
// Doubly gated — SKIPS (exit 0) unless BOTH are set:
//   HORIZON_DATABASE_URL   postgres://… (an Azure HorizonDB with AGE + facts)
//   GITHUB_TOKEN           (or GH_TOKEN / COPILOT_GITHUB_TOKEN) for the Copilot SDK
//
// Run:
//   cd incubator/horizon-facts
//   npm run build                       # produces dist/ that the adapter imports
//   HORIZON_DATABASE_URL=... GITHUB_TOKEN=... npm run eval:harvester
//
// Optional: EVAL_MODEL (default gpt-4o-mini), EVAL_PROVIDER, EVAL_TIMEOUT_MS.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// NOTE: ./store-adapter.mjs and ./tools.mjs are imported DYNAMICALLY inside
// main(), after the credential gate. tools.mjs statically imports
// "@github/copilot-sdk", so importing it eagerly would crash the SKIP path on
// machines that haven't run `npm install`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── credential gate ──────────────────────────────────────────────────────────
function normalizeDbUrl(raw) {
    if (!raw) return "";
    if (!/[?&]sslmode=/.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

const DB_URL = normalizeDbUrl(process.env.HORIZON_DATABASE_URL || "");
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN || "";
const MODEL = process.env.EVAL_MODEL || "gpt-4o-mini";
const PROVIDER = process.env.EVAL_PROVIDER || "";
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS || 240_000);

if (!DB_URL || !GH_TOKEN) {
    const missing = [!DB_URL && "HORIZON_DATABASE_URL", !GH_TOKEN && "GITHUB_TOKEN"].filter(Boolean).join(" + ");
    console.log(`SKIP harvester-eval — missing ${missing}. Set both to run the end-to-end eval.`);
    process.exit(0);
}

// ── invariant scorecard ──────────────────────────────────────────────────────
const checks = [];
function check(name, ok, detail = "") {
    checks.push({ name, ok: !!ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
    const corpus = JSON.parse(readFileSync(path.join(__dirname, "corpus", "pgsql-hackers.json"), "utf8"));

    const { EnhancedFactsAdapter } = await import("./store-adapter.mjs");
    const { createHarvesterTools, HARVESTER_SYSTEM_PROMPT } = await import("./tools.mjs");

    // Unique-per-run namespace + graph so repeated runs never pollute assertions.
    // NB: graph names map to Postgres schemas; avoid the reserved `pg_` prefix.
    const runId = `r${Date.now().toString(36)}`;
    const namespace = `archive/pgsql-hackers/${runId}`;
    const graphName = `hzeval_${runId}`;
    const schema = process.env.EVAL_SCHEMA || "horizon_facts_eval";

    console.log(`\nharvester-eval  run=${runId}  model=${MODEL}  graph=${graphName}`);

    const { HorizonFactStore } = await import("../dist/src/index.js");
    const store = await HorizonFactStore.create({ connectionString: DB_URL, schema, graphName });
    await store.initialize();

    const adapter = new EnhancedFactsAdapter(store, { runId, namespace });
    await adapter.seedCorpus(corpus.messages);
    console.log(`  seeded ${corpus.messages.length} archived messages into ${namespace}`);

    // ── run the harvester agent on the standard Copilot SDK ──────────────────
    const { CopilotClient } = await import("@github/copilot-sdk");

    // Instrument: log every tool-driven adapter call (name, brief args, result/err).
    const brief = (v) => { try { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 160) + "…" : s; } catch { return String(v); } };
    const loggedAdapter = new Proxy(adapter, {
        get(target, prop, recv) {
            const orig = Reflect.get(target, prop, recv);
            if (typeof orig !== "function" || typeof prop !== "string") return orig;
            return async (...args) => {
                const t0 = Date.now();
                try {
                    const out = await orig.apply(target, args);
                    const n = Array.isArray(out) ? out.length : (out && typeof out === "object" && "count" in out ? out.count : undefined);
                    console.log(`  · ${prop}(${brief(args[0] ?? "")})${n !== undefined ? ` -> ${n}` : ""} [${Date.now() - t0}ms]`);
                    return out;
                } catch (err) {
                    console.log(`  ✖ ${prop}(${brief(args[0] ?? "")}) ERROR: ${err.message}`);
                    throw err;
                }
            };
        },
    });
    const tools = createHarvesterTools(loggedAdapter);

    const sdk = new CopilotClient({ gitHubToken: GH_TOKEN });
    let assistantText = "";
    try {
        await sdk.start();
        const sessionOpts = {
            model: MODEL,
            systemMessage: HARVESTER_SYSTEM_PROMPT,
            onPermissionRequest: approveAny,
        };
        if (PROVIDER) sessionOpts.provider = PROVIDER;

        const session = await sdk.createSession(sessionOpts);
        session.registerTools(tools);

        // Progress + diagnostics: surface assistant text, tool calls, turn ends.
        let turns = 0;
        let toolCalls = 0;
        session.on("assistant.message", (e) => {
            assistantText = (e?.data?.content || assistantText);
            const txt = (e?.data?.content || "").trim();
            if (txt) console.log(`  » assistant: ${truncate(txt, 160)}`);
        });
        // Catch-all logger so we SEE every event type the SDK emits.
        const seenTypes = new Map();
        session.on((event) => {
            const t = event?.type ?? event?.eventType ?? "unknown";
            seenTypes.set(t, (seenTypes.get(t) ?? 0) + 1);
            if (t === "assistant.turn_end") turns++;
            if (t === "tool.execution_start") {
                toolCalls++;
                const name = event?.data?.toolName || event?.data?.name;
                console.log(`  [tool.start] ${name ?? "?"}`);
            }
            if (t === "tool.execution_complete") {
                const name = event?.data?.toolName || event?.data?.name;
                console.log(`  [tool.done]  ${name ?? "?"}`);
            }
            if (t.startsWith("permission") || t.includes("error")) {
                console.log(`  [${t}] ${truncate(JSON.stringify(event?.data ?? {}), 200)}`);
            }
        });

        await withTimeout(new Promise((resolve, reject) => {
            session.on("session.idle", () => resolve());
            session.on("session.error", (e) => reject(new Error(e?.data?.message || "session error")));
            session.send({
                prompt: "Harvest the entire pgsql-hackers archive into the knowledge graph now. " +
                    "Work the crawl queue until facts_read_uncrawled returns count:0.",
            });
        }), TIMEOUT_MS, "agent harvest");

        console.log(`\n  event types seen: ${[...seenTypes.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);
        console.log(`  agent finished after ~${turns} turns, ${toolCalls} tool calls: ${truncate(assistantText, 200)}`);
    } finally {
        try { await sdk.stop(); } catch { /* ignore */ }
    }

    // ── assert the graph was built correctly ─────────────────────────────────
    console.log("\nInvariants:");
    const entities = await store.searchEntities({ limit: 500 });
    const edges = await store.searchRelationships({ limit: 500 });

    const lc = (s) => String(s || "").toLowerCase();
    const isTomLane = (e) =>
        [e.name, ...(e.aliases || [])].some((s) => lc(s).includes("tom lane") || lc(s) === "tgl" || lc(s).includes("lane"));
    const isAndres = (e) =>
        [e.name, ...(e.aliases || [])].some((s) => lc(s).includes("andres") || lc(s).includes("freund"));

    const tomNodes = entities.filter(isTomLane);
    const tom = tomNodes[0];
    check("Tom Lane resolves to exactly one node (no duplicate person)", tomNodes.length === 1,
        `found ${tomNodes.length}: ${tomNodes.map((e) => e.entityKey).join(", ") || "none"}`);
    check("'tgl' merged as an alias of Tom Lane (alias dedup)",
        !!tom && [tom.name, ...(tom.aliases || [])].some((s) => lc(s) === "tgl"),
        tom ? `aliases=${JSON.stringify(tom.aliases)}` : "no Tom Lane node");

    const andresNodes = entities.filter(isAndres);
    check("Andres Freund is a separate person node", andresNodes.length === 1,
        `found ${andresNodes.length}`);

    const tomEdges = tom ? edges.filter((r) => r.fromKey === tom.entityKey) : [];
    check("Tom Lane is connected to at least one patch/file/thread", tomEdges.length >= 1,
        `${tomEdges.length} outgoing edges`);

    const reinforced = edges.filter((r) => Number(r.observations) >= 2);
    check("At least one edge was reinforced across two messages (observations>=2)", reinforced.length >= 1,
        reinforced.map((r) => `${r.predicateKey}=${r.observations}`).join(", ") || "none");

    const allHaveEvidence = edges.length > 0 && edges.every((r) => Array.isArray(r.evidence) && r.evidence.length >= 1);
    check("Every edge carries >=1 evidence scope_key", allHaveEvidence,
        `${edges.length} edges`);

    const reinforcedEvidence = reinforced.some((r) => (r.evidence || []).length >= 2);
    check("The reinforced edge accumulated evidence from both messages", reinforcedEvidence,
        reinforced.map((r) => `${r.predicateKey}:${(r.evidence || []).length}`).join(", ") || "none");

    const remaining = await adapter.readUncrawled({ limit: 100 });
    check("No facts remain uncrawled after the run", remaining.count === 0,
        `${remaining.count} left`);

    // ── report + cleanup ─────────────────────────────────────────────────────
    console.log("\nGraph summary:");
    console.log(`  entities (${entities.length}): ${entities.map((e) => e.entityKey).join(", ")}`);
    for (const r of edges) {
        console.log(`  ${r.fromKey} -[${r.predicate} | key=${r.predicateKey} conf=${Number(r.confidence).toFixed(2)} obs=${r.observations}]-> ${r.toKey}  ev=${(r.evidence || []).length}`);
    }

    await store.close();
    await bestEffortDropGraph(DB_URL, graphName);

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${failed.length === 0 ? "EVAL PASSED" : `EVAL FAILED (${failed.length}/${checks.length} invariants)`}`);
    process.exit(failed.length === 0 ? 0 : 1);
}

function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }

// Auto-approve every permission request, mirroring the repo's
// approvePermissionForSession: custom tools need an `approve-for-session` with a
// matching `custom-tool` approval, NOT a bare `approve-once` (which the SDK drops
// for custom tools, silently starving the model of tool results).
function approveAny(request) {
    const kind = request?.kind;
    if (kind === "custom-tool") {
        const toolName = typeof request?.toolName === "string" ? request.toolName : null;
        if (toolName) return { kind: "approve-for-session", approval: { kind: "custom-tool", toolName } };
    }
    if (kind === "read") return { kind: "approve-for-session", approval: { kind: "read" } };
    if (kind === "write") return { kind: "approve-for-session", approval: { kind: "write" } };
    return { kind: "approve-once" };
}

function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
    return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

/** Best-effort: drop the per-run AGE graph so runs don't accumulate. */
async function bestEffortDropGraph(connectionString, graphName) {
    try {
        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString });
        await client.connect();
        try {
            await client.query(`LOAD 'age'`);
            await client.query(`SET search_path = ag_catalog, "$user", public`);
            await client.query(`SELECT drop_graph($1, true)`, [graphName]);
        } finally { await client.end(); }
    } catch (err) {
        console.log(`  (cleanup) could not drop graph ${graphName}: ${err.message}`);
    }
}

main().catch((err) => {
    console.error("\nEVAL ERROR:", err?.stack || err?.message || err);
    process.exit(1);
});
