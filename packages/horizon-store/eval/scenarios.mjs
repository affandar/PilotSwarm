// eval/scenarios.mjs — the 06-provider-test-plan §10 scenario tier.
//
// Copilot-SDK agents (no PilotSwarm) drive the REAL provider surface
// (src/agent-tools.ts) against live HorizonDB. LLM output is non-deterministic,
// so assertions are STRUCTURAL invariants; SC2 gets byte-identical determinism
// from recorded replay of SC1's real tool calls.
//
//   node --env-file-if-exists=.env eval/scenarios.mjs            # all scenarios
//   node --env-file-if-exists=.env eval/scenarios.mjs sc1a       # synthetic only
//   node --env-file-if-exists=.env eval/scenarios.mjs real       # SC1b/SC5/SC2/SC3/SC4 chain
//
// Gates (SKIPs, exit 0, when missing): HORIZON_DATABASE_URL + GITHUB_TOKEN.
// Optional: HORIZON_EMBED_* (real embeddings → SC4 runs hybrid; else lexical),
//           EVAL_MODEL (default gpt-4o-mini), EVAL_LIMIT (real-corpus message
//           cap for cheap dev runs; invariants re-derive from the seeded
//           subset, so a capped run stays honest), EVAL_ROUND_TIMEOUT_MS,
//           EVAL_MAX_ROUNDS.
//
// Scenarios (06 §10):
//   SC1a  cold harvest, synthetic 3-message corpus — exact hand-authored invariants
//   SC1b  cold harvest, real 60-message corpus     — metadata-derived invariants
//   SC5   scoped publication (private draft harvested alongside SC1b)
//   SC2   replay immunity (re-queue + replay SC1b's recorded mutating calls)
//   SC3   edit → re-queue → incremental harvest
//   SC4   reader Q&A via the fact-pivot

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
/** Activity watchdog: a round fails only after this much agent SILENCE. */
const ROUND_TIMEOUT_MS = Number(process.env.EVAL_ROUND_TIMEOUT_MS || 120_000);
/** Hard wall-clock cap per round (long productive turns are fine below it). */
const HARD_TIMEOUT_MS = Number(process.env.EVAL_HARD_TIMEOUT_MS || 1_800_000);
const VERBOSE = process.env.EVAL_VERBOSE !== "0";
const MAX_ROUNDS = Number(process.env.EVAL_MAX_ROUNDS || 24); // 60 msgs / 5-per-batch + slack
const EVAL_LIMIT = process.env.EVAL_LIMIT ? Number(process.env.EVAL_LIMIT) : Infinity;
const HAS_EMBED = !!(process.env.HORIZON_EMBED_URL && process.env.HORIZON_EMBED_API_KEY);

if (!DB_URL || !GH_TOKEN) {
    const missing = [!DB_URL && "HORIZON_DATABASE_URL", !GH_TOKEN && "GITHUB_TOKEN"].filter(Boolean).join(" + ");
    console.log(`SKIP scenarios — missing ${missing}.`);
    process.exit(0);
}

// ── scorecard ────────────────────────────────────────────────────────────────

const checks = [];
function check(scenario, name, ok, detail = "") {
    checks.push({ scenario, name, ok: !!ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  [${scenario}] ${name}${detail ? `  — ${truncate(detail, 140)}` : ""}`);
}
function truncate(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }

// ── agent runner (Copilot SDK) ───────────────────────────────────────────────

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

/**
 * Wait for `promise`, failing only when there has been NO agent activity
 * (tool calls / messages, reported via `lastActivity()`) for `idleMs` — a
 * long PRODUCTIVE turn never times out, a hung one does. `hardMs` caps total
 * wall-clock as the safety net.
 */
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

/**
 * Run an agent session, re-prompting until `isDone()` or budgets exhaust.
 * Returns the final assistant text.
 */
async function runAgent({ sdk, systemMessage, tools, toolNames, firstPrompt, continuePrompt, isDone, label }) {
    const session = await sdk.createSession({
        model: MODEL,
        // REPLACE the CLI's coding-agent foundation prompt entirely — without
        // this the model behaves like a workspace coding agent (view/bash over
        // the repo) instead of a harvester over the registered tools.
        systemMessage: { mode: "replace", content: systemMessage },
        // Tools must be passed at creation (registerTools is @internal) and the
        // allowlist restricts the session to ONLY them — built-ins disappear.
        tools,
        availableTools: toolNames,
        onPermissionRequest: (req) => {
            const res = approveAny(req);
            if (VERBOSE) console.log(`  [${label}] permission ${req?.kind ?? "?"} ${req?.toolName ?? ""} → ${res.kind}`);
            return res;
        },
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
        if (VERBOSE && (t.startsWith("permission") || t.includes("error"))) {
            console.log(`  [${label}] [${t}] ${truncate(JSON.stringify(event?.data ?? {}), 200)}`);
        }
    });

    const idle = () => new Promise((resolve, reject) => {
        const onIdle = () => resolve();
        const onErr = (e) => reject(new Error(e?.data?.message || "session error"));
        session.on("session.idle", onIdle);
        session.on("session.error", onErr);
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
            // The crawl queue is durable and the loop resumable — a stalled
            // turn (model/API hiccup) is retried by re-prompting, not fatal.
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

// ── store / corpus helpers ───────────────────────────────────────────────────

const runId = `r${Date.now().toString(36)}`;
const UNRESTRICTED = { unrestricted: true };

async function makeEvalStore(tag) {
    const { makeEvalStore: makeStores } = await import("./_store.mjs");
    const schema = `hzev_${tag}_${runId}`;
    const graphName = `hzevg_${tag}_${runId}`;
    const embedding = HAS_EMBED ? {
        url: process.env.HORIZON_EMBED_URL,
        model: process.env.HORIZON_EMBED_MODEL ?? "text-embedding-3-small",
        dim: Number(process.env.HORIZON_EMBED_DIM ?? "1536"),
        apiKey: process.env.HORIZON_EMBED_API_KEY,
        apiKeyHeader: process.env.HORIZON_EMBED_API_KEY_HEADER ?? "api-key",
        inputField: "input",
    } : undefined;
    const { store } = await makeStores({
        connectionString: DB_URL, schema, graphName,
        embedding, embeddingDim: embedding?.dim ?? 4,
    });
    return { store, schema, graphName };
}

async function dropEvalStore({ schema, graphName }) {
    try {
        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString: DB_URL });
        await client.connect();
        try {
            try {
                await client.query(`LOAD 'age'`);
            } catch (err) {
                if (!/access to library "age" is not allowed/i.test(String(err?.message ?? ""))) throw err;
            }
            await client.query(`SET search_path = ag_catalog, "$user", public`);
            await client.query(`SELECT drop_graph($1, true)`, [graphName]).catch(() => {});
            await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally { await client.end(); }
    } catch (err) {
        console.log(`  (cleanup) ${schema}: ${err.message}`);
    }
}

const NS = `archive/pgsql-hackers`;
const msgKey = (id) => `${NS}/msg-${id}`;

async function seedMessages(store, messages, { sessionId = null } = {}) {
    for (const m of messages) {
        await store.storeFact({
            key: msgKey(m.id),
            value: { from: m.from, subject: m.subject, date: m.date, body: m.body },
            shared: !sessionId, sessionId, tags: ["pgsql-hackers", "archive"], agentId: "eval-seed",
        });
    }
}

const queueCount = async (store) =>
    (await store.readUncrawledFacts({ namespace: NS, limit: 500 })).count;

// ── graph inspection helpers ─────────────────────────────────────────────────

let normalizeName;
async function loadModel() {
    ({ normalizeName } = await import("../dist/src/index.js"));
}

const personNodes = async (store) => store.searchGraphNodes({ kind: "person", limit: 500 }, UNRESTRICTED);
const allEdges = async (store) => store.searchGraphEdges({ limit: 500 }, UNRESTRICTED);

function nodesMatching(nodes, authorName) {
    const want = normalizeName(authorName);
    return nodes.filter((n) =>
        [n.name, ...(n.aliases ?? [])].some((s) => {
            const got = normalizeName(s);
            return got === want || got.includes(want) || want.includes(got);
        }));
}

/** Stable, sorted snapshot of the whole graph for byte-identical comparison. */
async function graphSnapshot(store) {
    const nodes = (await store.searchGraphNodes({ limit: 500 }, UNRESTRICTED))
        .map((n) => ({ ...n, aliases: [...n.aliases].sort(), evidence: [...n.evidence].sort() }))
        .sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
    const edges = (await allEdges(store))
        .map((e) => ({ ...e, evidence: [...e.evidence].sort() }))
        .sort((a, b) => `${a.fromKey}|${a.predicateKey}|${a.toKey}`.localeCompare(`${b.fromKey}|${b.predicateKey}|${b.toKey}`));
    return JSON.stringify({ nodes, edges });
}

// ── SC1a — synthetic corpus, exact invariants ────────────────────────────────

async function scenarioSC1a(sdk) {
    console.log("\n━━ SC1a — cold harvest, synthetic corpus (exact invariants) ━━");
    const env = await makeEvalStore("a");
    const { store } = env;
    try {
        const corpus = JSON.parse(readFileSync(path.join(__dirname, "corpus", "pgsql-hackers.json"), "utf8"));
        await seedMessages(store, corpus.messages);
        console.log(`  seeded ${corpus.messages.length} synthetic messages`);

        const { buildSdkTools, HARVESTER_SYSTEM_PROMPT } = await import("./tools.mjs");
        const record = [];
        const { tools, toolNames } = await buildSdkTools(store, { role: "harvester", record });

        await runAgent({
            sdk, tools, toolNames, systemMessage: HARVESTER_SYSTEM_PROMPT, label: "sc1a-harvest",
            firstPrompt: "Harvest the entire archive into the knowledge graph now. Work the crawl queue until facts_read_uncrawled returns count:0.",
            continuePrompt: "The crawl queue is not empty yet. Continue harvesting until facts_read_uncrawled returns count:0.",
            isDone: async () => (await queueCount(store)) === 0,
        });

        const persons = await personNodes(store);
        const edges = await allEdges(store);

        const tomNodes = nodesMatching(persons, "Tom Lane");
        const tom = tomNodes[0];
        check("SC1a", "one Tom Lane person node (no duplicate)", tomNodes.length === 1,
            tomNodes.map((n) => n.nodeKey).join(",") || "none");
        check("SC1a", "'tgl' is an alias on the Tom Lane node", !!tom &&
            [tom.name, ...tom.aliases].some((s) => normalizeName(s) === "tgl"),
            tom ? JSON.stringify(tom.aliases) : "no node");
        check("SC1a", "Andres Freund is a distinct person node",
            nodesMatching(persons, "Andres Freund").length === 1);

        const tomConnected = tom ? (await store.graphNeighbourhood(tom.nodeKey, 2, UNRESTRICTED)).nodes.length > 0 : false;
        check("SC1a", "Tom Lane reaches a non-person node within 2 hops", tomConnected);

        const reinforced = edges.filter((e) => e.observations >= 2 && new Set(e.evidence).size >= 2);
        check("SC1a", "reinforced edge: observations>=2 from 2 distinct messages", reinforced.length >= 1,
            reinforced.map((e) => `${e.predicateKey}:obs=${e.observations},ev=${e.evidence.length}`).join(" ") || "none");

        check("SC1a", "every edge carries >=1 evidence scopeKey",
            edges.length > 0 && edges.every((e) => e.evidence.length >= 1), `${edges.length} edges`);

        check("SC1a", "queue drained", (await queueCount(store)) === 0);
        const markCalls = record.filter((r) => r.name === "facts_mark_crawled" && r.result);
        const skippedTotal = markCalls.reduce((s, r) => s + (r.result.skipped ?? 0), 0);
        check("SC1a", "receipts: skipped == 0 across all mark calls", markCalls.length > 0 && skippedTotal === 0,
            `${markCalls.length} calls, skipped=${skippedTotal}`);
    } finally {
        await store.close();
        await dropEvalStore(env);
    }
}

// ── Phase B — real corpus chain: SC1b → SC5 → SC2 → SC3 → SC4 ───────────────

async function scenarioReal(sdk) {
    console.log("\n━━ Phase B — real corpus chain (SC1b → SC5 → SC2 → SC3 → SC4) ━━");
    const env = await makeEvalStore("b");
    const { store, schema } = env;
    try {
        const corpus = JSON.parse(readFileSync(path.join(__dirname, "corpus", "pgsql-hackers-real.json"), "utf8"));
        const messages = corpus.messages.slice(0, Math.min(corpus.messages.length, EVAL_LIMIT));
        await seedMessages(store, messages);

        // Effective metadata derived from the SEEDED subset (06 §10: invariants
        // are computed, never hand-coded — a capped dev run stays honest).
        const byAuthor = new Map();
        for (const m of messages) {
            const name = String(m.from).replace(/<.*$/, "").trim();
            byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
        }
        const multiAuthors = [...byAuthor.entries()].filter(([, n]) => n >= 2).map(([n]) => n);
        const earliestAuthor = String(messages[0].from).replace(/<.*$/, "").trim();
        const corpusScopeKeys = new Set(messages.map((m) => `shared:${msgKey(m.id)}`));

        // SC5 setup: one session-private draft in the same namespace.
        const DRAFT_KEY = `${NS}/draft-reply-tgl`;
        const DRAFT_SK = `session:S1:${DRAFT_KEY}`;
        await store.storeFact({
            key: DRAFT_KEY, sessionId: "S1",
            value: {
                from: "S1 Drafter <drafter@example.com>",
                subject: "Draft reply re: typsubparse naming",
                body: "Draft (unsent): I agree with Tom Lane's naming objection about typsubparse. " +
                      "Our internal project VELVETHAMMER will adopt the renamed API once it lands.",
            },
            tags: ["draft"], agentId: "eval-seed",
        });
        console.log(`  seeded ${messages.length} real messages (+1 private draft); multi-authors: ${multiAuthors.join(", ")}`);

        const { buildSdkTools, HARVESTER_SYSTEM_PROMPT, READER_SYSTEM_PROMPT, MUTATING_TOOLS } = await import("./tools.mjs");
        const record = [];
        const { tools, handlers, toolNames } = await buildSdkTools(store, { role: "harvester", record });

        // ── SC1b: cold harvest at scale ──────────────────────────────────────
        await runAgent({
            sdk, tools, toolNames, systemMessage: HARVESTER_SYSTEM_PROMPT, label: "sc1b-harvest",
            firstPrompt: `Harvest the archive (${messages.length + 1} facts) into the knowledge graph. Pull ONE batch of 5 with facts_read_uncrawled, incorporate each email thoroughly (entities + relationships + evidence), mark them crawled, then end your turn.`,
            continuePrompt: "Good. Pull the NEXT batch of 5 with facts_read_uncrawled and incorporate each email thoroughly (sender + relationships + evidence, resolve-before-create), mark them crawled, then end your turn. If the queue is empty, summarize.",
            isDone: async () => (await queueCount(store)) === 0,
        });

        const persons = await personNodes(store);
        const edges = await allEdges(store);

        for (const author of multiAuthors) {
            const matches = nodesMatching(persons, author);
            check("SC1b", `exactly one person node for multi-message author '${author}'`, matches.length === 1,
                matches.map((n) => n.nodeKey).join(",") || "none");
            if (matches.length === 1) {
                const hood = await store.graphNeighbourhood(matches[0].nodeKey, 2, UNRESTRICTED);
                check("SC1b", `'${author}' reaches a non-person node within 2 hops`,
                    hood.nodes.some((n) => n.kind !== "person"), `${hood.nodes.length} neighbours`);
            }
        }

        const reinforced = edges.filter((e) => e.observations >= 2 &&
            new Set(e.evidence.filter((k) => corpusScopeKeys.has(k))).size >= 2);
        check("SC1b", "at least one edge reinforced from >=2 distinct corpus messages", reinforced.length >= 1,
            reinforced.slice(0, 3).map((e) => `${e.fromKey}-${e.predicateKey}:obs=${e.observations}`).join(" ") || "none");

        check("SC1b", "every edge carries >=1 evidence scopeKey",
            edges.length > 0 && edges.every((e) => e.evidence.length >= 1), `${edges.length} edges`);
        check("SC1b", "queue drained at scale", (await queueCount(store)) === 0);
        const markCalls = record.filter((r) => r.name === "facts_mark_crawled" && r.result);
        const skippedTotal = markCalls.reduce((s, r) => s + (r.result.skipped ?? 0), 0);
        // A skipped stamp mid-run is the receipt guard WORKING (bad/stale hash
        // rejected); the invariant is that nothing is lost: every seeded fact
        // ends marked (markedTotal covers the corpus) and the queue drained.
        const markedTotal = markCalls.reduce((s, r) => s + (r.result.marked ?? 0), 0);
        check("SC1b", "receipts honest: every fact marked; skips (if any) were retried",
            markedTotal >= messages.length + 1,
            `marked=${markedTotal} skipped=${skippedTotal} across ${markCalls.length} calls`);

        // ── SC5: scoped publication ──────────────────────────────────────────
        const allNodes = await store.searchGraphNodes({ limit: 500 }, UNRESTRICTED);
        const draftEvidenced = allNodes.filter((n) => n.evidence.includes(DRAFT_SK));
        check("SC5", "private draft was harvested into the shared graph (publication happened)",
            draftEvidenced.length >= 1, draftEvidenced.map((n) => n.nodeKey).join(",") || "draft contributed no nodes");

        if (draftEvidenced.length >= 1) {
            const probe = draftEvidenced[0];
            const asS2 = await store.searchGraphNodes({ nameLike: probe.name }, { readerSessionId: "S2" });
            const s2Hit = asS2.find((n) => n.nodeKey === probe.nodeKey);
            check("SC5", "S2 sees the node CONTENT but not the private evidence pointer",
                !!s2Hit && !s2Hit.evidence.includes(DRAFT_SK),
                s2Hit ? `evidence=${JSON.stringify(s2Hit.evidence)}` : "node not visible");
            const asS1 = await store.searchGraphNodes({ nameLike: probe.name }, { readerSessionId: "S1" });
            const s1Hit = asS1.find((n) => n.nodeKey === probe.nodeKey);
            check("SC5", "S1 (owner) sees its own evidence pointer",
                !!s1Hit && s1Hit.evidence.includes(DRAFT_SK));
        }
        const s2Seed = await store.searchGraphNodes({ seeds: [DRAFT_SK], depth: 1 }, { readerSessionId: "S2" });
        const unknownSeed = await store.searchGraphNodes({ seeds: ["session:S2:never/was"], depth: 1 }, { readerSessionId: "S2" });
        check("SC5", "inaccessible draft seed behaves exactly like an unknown seed",
            JSON.stringify(s2Seed) === JSON.stringify(unknownSeed) && s2Seed.length === 0);

        // ── SC2: replay immunity (recorded replay of SC1b) ───────────────────
        console.log("  [sc2] snapshot → re-queue → replay recorded mutating calls → compare");
        const before = await graphSnapshot(store);
        const { default: pg } = await import("pg");
        const raw = new pg.Pool({ connectionString: DB_URL, max: 1 });
        try {
            await raw.query(`UPDATE "${schema}".facts SET last_crawled_at = NULL`);
        } finally { await raw.end(); }

        const mutating = record.filter((r) => MUTATING_TOOLS.has(r.name) && !r.error);
        let replayMarked = 0, replaySkipped = 0;
        for (const call of mutating) {
            const res = await handlers.get(call.name)(call.args);
            if (call.name === "facts_mark_crawled" && res) {
                replayMarked += res.marked ?? 0;
                replaySkipped += res.skipped ?? 0;
            }
        }
        const after = await graphSnapshot(store);
        check("SC2", `graph byte-identical after replaying ${mutating.length} recorded mutating calls`, after === before,
            after === before ? "" : `drift: ${diffSnapshots(before, after)}`);
        // Replay determinism includes the receipts: content is unchanged, so
        // every recorded stamp resolves EXACTLY as it did originally — the
        // same marks succeed and the same (e.g. typo'd-hash) stamps skip.
        check("SC2", "replayed receipts resolve identically to the original run; queue re-drains",
            replayMarked === markedTotal && replaySkipped === skippedTotal && (await queueCount(store)) === 0,
            `marked=${replayMarked}/${markedTotal} skipped=${replaySkipped}/${skippedTotal}`);

        // ── SC3: edit → re-queue → incremental harvest ───────────────────────
        const editTarget = messages.find((m) => nodesMatching(persons, String(m.from).replace(/<.*$/, "").trim()).length === 1) ?? messages[1];
        const stampsBefore = await crawlStamps(schema);
        await store.storeFact({
            key: msgKey(editTarget.id), shared: true, tags: ["pgsql-hackers", "archive"], agentId: "eval-seed",
            value: {
                from: editTarget.from, subject: editTarget.subject, date: editTarget.date,
                body: editTarget.body + "\n\nCORRECTION (appended later): I now withdraw my earlier wording complaint about this patch.",
            },
        });
        const queued = await store.readUncrawledFacts({ namespace: NS, limit: 50 });
        check("SC3", "only the edited fact re-entered the queue", queued.count === 1 &&
            queued.facts[0]?.scopeKey === `shared:${msgKey(editTarget.id)}`,
            queued.facts.map((f) => f.scopeKey).join(",") || "empty");

        await runAgent({
            sdk, tools, toolNames, systemMessage: HARVESTER_SYSTEM_PROMPT, label: "sc3-incremental",
            firstPrompt: "One archived email was edited and re-entered the crawl queue. Process it (resolve-before-create as usual) until facts_read_uncrawled returns count:0.",
            continuePrompt: "Continue until facts_read_uncrawled returns count:0.",
            isDone: async () => (await queueCount(store)) === 0,
        });
        check("SC3", "incremental harvest drained the queue", (await queueCount(store)) === 0);
        const stampsAfter = await crawlStamps(schema);
        const touched = [...stampsBefore.entries()].filter(([k, v]) =>
            k !== `shared:${msgKey(editTarget.id)}` && stampsAfter.get(k)?.getTime() !== v?.getTime());
        check("SC3", "all other facts' crawl stamps untouched", touched.length === 0,
            touched.slice(0, 3).map(([k]) => k).join(",") || "");
        const edgesAfterSc3 = await allEdges(store);
        const dupTriples = findDuplicateTriples(edgesAfterSc3);
        check("SC3", "no duplicate (from,predicate,to) triples after re-harvest", dupTriples.length === 0,
            dupTriples.slice(0, 3).join(" ") || "");

        // ── SC4: reader Q&A via the fact-pivot ───────────────────────────────
        const readerRecord = [];
        const { tools: readerTools, toolNames: readerToolNames } = await buildSdkTools(store, { role: "reader", record: readerRecord });
        const searchMode = HAS_EMBED ? "hybrid" : "lexical";
        const answer = await runAgent({
            sdk, tools: readerTools, toolNames: readerToolNames, systemMessage: READER_SYSTEM_PROMPT, label: "sc4-reader",
            firstPrompt:
                `Question: Who authored the generic type subscripting patch discussed in this archive, and who pushed back on its design? ` +
                `Use facts_search (mode: "${searchMode}"), pivot into the graph with the result scopeKeys, and ground your answer in evidence.`,
            continuePrompt: "Finish answering the question with your EVIDENCE list.",
            isDone: async () => true, // single exchange; reader has no queue
        });

        const answerNorm = normalizeName(answer);
        check("SC4", `answer names the patch author ('${earliestAuthor}')`,
            answerNorm.includes(normalizeName(earliestAuthor)), truncate(answer, 120));
        const others = multiAuthors.filter((a) => a !== earliestAuthor);
        check("SC4", "answer names at least one other multi-message participant",
            others.some((a) => answerNorm.includes(normalizeName(a))), `candidates: ${others.join(", ")}`);
        const citedKeys = [...answer.matchAll(/(?:shared|session):[^\s,)\]]+/g)].map((m) => m[0]);
        const readKeys = readerRecord.filter((r) => r.name === "facts_read" && Array.isArray(r.args?.scopeKeys))
            .flatMap((r) => r.args.scopeKeys);
        const evidenceCited = [...new Set([...citedKeys, ...readKeys])];
        check("SC4", "all cited evidence keys are corpus scopeKeys",
            evidenceCited.length > 0 && evidenceCited.every((k) => corpusScopeKeys.has(k) || k === DRAFT_SK),
            `${evidenceCited.length} keys cited`);
    } finally {
        await store.close();
        await dropEvalStore(env);
    }

    async function crawlStamps(schema) {
        const { default: pg } = await import("pg");
        const raw = new pg.Pool({ connectionString: DB_URL, max: 1 });
        try {
            const { rows } = await raw.query(`SELECT scope_key, last_crawled_at FROM "${schema}".facts`);
            return new Map(rows.map((r) => [r.scope_key, r.last_crawled_at]));
        } finally { await raw.end(); }
    }
}

/** First few concrete differences between two graph snapshots (debug aid). */
function diffSnapshots(beforeJson, afterJson) {
    const b = JSON.parse(beforeJson), a = JSON.parse(afterJson);
    const index = (xs, key) => new Map(xs.map((x) => [key(x), JSON.stringify(x)]));
    const diffs = [];
    for (const [label, bs, as, key] of [
        ["node", b.nodes, a.nodes, (n) => n.nodeKey],
        ["edge", b.edges, a.edges, (e) => `${e.fromKey}|${e.predicateKey}|${e.toKey}`],
    ]) {
        const bi = index(bs, key), ai = index(as, key);
        for (const [k, v] of ai) {
            if (!bi.has(k)) diffs.push(`+${label} ${k}`);
            else if (bi.get(k) !== v) diffs.push(`Δ${label} ${k}: ${bi.get(k)} → ${v}`);
        }
        for (const k of bi.keys()) if (!ai.has(k)) diffs.push(`-${label} ${k}`);
    }
    return diffs.slice(0, 3).join(" ; ") || "(whitespace/order only)";
}

function findDuplicateTriples(edges) {
    const seen = new Map();
    const dups = [];
    for (const e of edges) {
        const k = `${e.fromKey}|${e.predicateKey}|${e.toKey}`;
        if (seen.has(k)) dups.push(k);
        seen.set(k, true);
    }
    return dups;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const what = (process.argv[2] || "all").toLowerCase();
    console.log(`scenarios run=${runId} model=${MODEL} embed=${HAS_EMBED ? "real" : "none (lexical only)"} target=${what}`);

    await loadModel();
    const { CopilotClient } = await import("@github/copilot-sdk");
    const sdk = new CopilotClient({ gitHubToken: GH_TOKEN });
    await sdk.start();
    try {
        if (what === "all" || what === "sc1a") await scenarioSC1a(sdk);
        if (what === "all" || what === "real" || what === "sc1b") await scenarioReal(sdk);
    } finally {
        try { await sdk.stop(); } catch { /* ignore */ }
    }

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${"━".repeat(70)}`);
    console.log(`scenarios: ${checks.length - failed.length}/${checks.length} invariants passed`);
    for (const f of failed) console.log(`  FAILED [${f.scenario}] ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    console.log(failed.length === 0 ? "SCENARIOS PASSED" : "SCENARIOS FAILED");
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("\nSCENARIO ERROR:", err?.stack || err?.message || err);
    process.exit(1);
});
