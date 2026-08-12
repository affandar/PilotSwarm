#!/usr/bin/env node
// -----------------------------------------------------------------------------
// trace-session-tree.mjs — cluster-operator forensics for a PilotSwarm session
// tree.
//
// Given ANY session id in a tree (root or descendant), this reconstructs the
// whole spawn tree and prints a single time-ordered timeline of the important
// events across every session in it — WITH the worker pod that emitted each one
// (SessionEvent.workerNodeId, which the worker sets to its POD_NAME) and, when
// kubectl is available, the AKS node each pod runs on. It also surfaces
// "pod movement" (a session whose events span >1 pod = it was dehydrated and
// rehydrated on another worker — an eviction / node drain / pod restart /
// failover), which is usually what an operator is actually chasing.
//
// DATA SOURCE. Everything comes from the same Postgres store the workers use
// (duroxide + CMS), read through the SDK's PgSessionCatalogProvider — the same
// entry point the scripts/_debug_*.js tools use. Pod -> node comes from kubectl.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   node scripts/trace-session-tree.mjs <session-id> [options]
//
//   Options:
//     --all                 show every event type (default: curated important set)
//     --types a,b,c         show only these event types (comma-separated)
//     --limit N             max events fetched per session (default 2000)
//     --since ISO           only events at/after this ISO timestamp
//     --namespace NS        k8s namespace for pod->node lookup (default: pilotswarm)
//     --no-kubectl          skip pod->node correlation (use when run INSIDE a pod)
//     --json                emit the assembled trace as JSON instead of text
//     --database-url URL    override $DATABASE_URL
//     --managed-identity    force AAD/Entra token auth (DefaultAzureCredential)
//     --no-managed-identity force password/connection-string auth
//     --aad-user USER       Postgres AAD role for MI mode (default: $PILOTSWARM_DB_AAD_USER)
//     -h, --help
//
// AUTH. This store uses passwordless Microsoft Entra (managed identity) auth on
// AKS. The tracer auto-enables MI when $PILOTSWARM_USE_MANAGED_IDENTITY is set OR
// the URL has no password, minting the Postgres token via DefaultAzureCredential
// (--aad-user / $PILOTSWARM_DB_AAD_USER is the PG role). The credential that works
// everywhere is the workers' own workload identity, so the most reliable path is
// to run this INSIDE a worker pod (see below) where that identity + the AAD user
// + a reachable DB all already exist.
//
// ── GETTING DATABASE_URL (operator) ──────────────────────────────────────────
//   The workers already have it. Pull it from any Ready worker pod:
//
//     $env:DATABASE_URL = (kubectl -n pilotswarm exec `
//        (kubectl -n pilotswarm get pod -l app.kubernetes.io/component=git-repo-worker `
//         -o jsonpath='{.items[0].metadata.name}') `
//        -c git-repo-worker -- printenv DATABASE_URL)
//
//   If the Postgres server is only reachable from inside the cluster, run this
//   script IN a worker pod (DATABASE_URL + the SDK are already there) and pass
//   --no-kubectl, then do the pod->node mapping from your box:
//
//     kubectl -n pilotswarm cp scripts/trace-session-tree.mjs <pod>:/tmp/t.mjs -c git-repo-worker
//     kubectl -n pilotswarm exec <pod> -c git-repo-worker -- \
//        sh -c 'cd /app && node /tmp/t.mjs <id> --no-kubectl'
//
//   (The Admin/PilotSwarm/trace-session.ps1 wrapper automates all of the above.)
// -----------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Resolve dist/cms.js relative to THIS file so the script runs from any CWD
// (repo checkout `scripts/` OR a copy dropped at /tmp inside a pod with the repo
// at /app — in the latter case set PS_SDK_DIST or run with cwd=/app).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmsCandidates = [
    process.env.PS_CMS_DIST,
    path.resolve(__dirname, "../packages/sdk/dist/cms.js"),
    path.resolve(process.cwd(), "packages/sdk/dist/cms.js"),
    "/app/packages/sdk/dist/cms.js",
].filter(Boolean);

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const o = { positionals: [], all: false, types: null, limit: 2000, since: null,
        namespace: "pilotswarm", kubectl: true, json: false, databaseUrl: null,
        mi: null, aadUser: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "-h": case "--help": o.help = true; break;
            case "--all": o.all = true; break;
            case "--no-kubectl": o.kubectl = false; break;
            case "--json": o.json = true; break;
            case "--types": o.types = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean); break;
            case "--limit": o.limit = parseInt(argv[++i], 10) || o.limit; break;
            case "--since": o.since = argv[++i]; break;
            case "--namespace": case "-n": o.namespace = argv[++i]; break;
            case "--database-url": o.databaseUrl = argv[++i]; break;
            case "--managed-identity": o.mi = true; break;
            case "--no-managed-identity": o.mi = false; break;
            case "--aad-user": o.aadUser = argv[++i]; break;
            default:
                if (a.startsWith("-")) { console.error(`unknown option: ${a}`); process.exit(2); }
                o.positionals.push(a);
        }
    }
    return o;
}

const HELP = `trace-session-tree.mjs — trace a PilotSwarm session tree with per-event pod/node attribution

  node scripts/trace-session-tree.mjs <session-id> [--all] [--types a,b] [--limit N]
       [--since ISO] [--namespace NS] [--no-kubectl] [--json] [--database-url URL]
       [--managed-identity | --no-managed-identity] [--aad-user USER]

  <session-id>  any session in the tree (root or descendant); the whole tree is traced.

Entra/managed-identity auth is auto-detected (passwordless URL or
$PILOTSWARM_USE_MANAGED_IDENTITY); run inside a worker pod for a credential that
always works. See the header of this file for how to obtain DATABASE_URL.`;

// Curated "important" event types for an operator: lifecycle, placement/fan-out,
// waits, model/tool activity, and failures. Chatty types (reasoning, canvas_data,
// prompt_layers, *_suppressed) are excluded unless --all. Anything whose type
// matches FAILURE_RX is ALWAYS shown, even in curated mode, so problems are never
// filtered away.
const IMPORTANT = new Set([
    "session.turn_started", "session.turn_stopped",
    "session.agent_spawned",
    "session.wait_started", "session.wait_completed", "session.input_required_started",
    "session.hydrated", "session.dehydrated", "session.affinity_released",
    "session.model_changed",
    "session.command_received", "session.command_completed",
    "session.cron_started", "session.cron_fired", "session.cron_at_fired",
    "session.artifact_presented",
    "tool.execution_start", "tool.execution_complete",
    "assistant.usage",
    "user.message", "assistant.message", "system.message",
]);
const FAILURE_RX = /error|fail|refus|mismatch|regress|drop|cancel|stopped|lossy|empty|unpublish/i;

// ── helpers ──────────────────────────────────────────────────────────────────
const short = (id, n = 8) => (id ? String(id).slice(0, n) : "-");
// Display label for a worker/cache pod: drop the common DaemonSet-name prefix so
// the distinguishing <repo>-<hash> is visible (full names are kept for kubectl
// lookups and aggregation keys — this is display-only).
const podLabel = (p, n = 24) => {
    if (!p || p === "-") return p ?? "-";
    return short(String(p).replace(/^git-repo-worker-/, "").replace(/^git-cache-/, ""), n);
};
const asObj = (d) => (d && typeof d === "object" ? d : {});

function fmtElapsed(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mmm = String(Math.floor(ms % 1000)).padStart(3, "0");
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}
const iso = (d) => new Date(d).toISOString();
const hms = (d) => new Date(d).toISOString().slice(11, 23); // HH:MM:SS.mmm (UTC)

// One-line operator-relevant summary per event type. Best-effort/defensive:
// event.data shapes drift across orchestration versions, so guard everything.
function summarize(ev) {
    const d = asObj(ev.data);
    const clip = (s, n = 90) => (s == null ? "" : String(s).replace(/\s+/g, " ").slice(0, n));
    switch (ev.eventType) {
        case "session.turn_started":  return `turn#${d.turnIndex ?? d.iteration ?? "?"}${d.model ? ` model=${d.model}` : ""}`;
        case "session.turn_stopped":  return `${d.reason ?? d.status ?? ""}`.trim();
        case "session.agent_spawned": return `spawn ${d.agentId ?? d.slug ?? d.agent ?? "agent"} -> child ${short(d.childSessionId ?? d.sessionId)}${d.model ? ` (${d.model})` : ""}`;
        case "session.wait_started":   return `wait ${d.waitSeconds != null ? d.waitSeconds + "s " : ""}${clip(d.waitReason ?? d.reason, 70)}`;
        case "session.wait_completed": return `${clip(d.reason, 70)}`;
        case "session.input_required_started": return `awaiting input ${clip(d.reason, 60)}`;
        case "session.hydrated":       return `HYDRATED (loaded onto worker)${d.reason ? " " + clip(d.reason, 50) : ""}`;
        case "session.dehydrated":     return `DEHYDRATED (evicted from worker)${d.reason ? " " + clip(d.reason, 50) : ""}`;
        case "session.affinity_released": return `worker affinity released`;
        case "session.model_changed":  return `model ${d.from ?? "?"} -> ${d.to ?? d.model ?? "?"}`;
        case "session.model_mismatch": return `MODEL MISMATCH ${clip(JSON.stringify(d), 80)}`;
        case "session.command_received":  return `cmd ${clip(d.command ?? d.name, 60)}`;
        case "session.command_completed": return `cmd done ${clip(d.command ?? d.name, 50)}`;
        case "session.cron_fired": case "session.cron_at_fired": return `cron fired ${clip(d.name ?? d.schedule, 50)}`;
        case "session.cron_started": return `cron scheduled ${clip(d.name ?? d.schedule, 50)}`;
        case "session.error":        return `ERROR ${clip(d.error ?? d.message ?? JSON.stringify(d), 110)}`;
        case "session.lossy_handoff": return `LOSSY HANDOFF ${clip(d.reason ?? JSON.stringify(d), 90)}`;
        case "session.regenerate_requested": return `regen requested ${clip(d.reason, 60)}`;
        case "session.regenerate_failed":    return `REGEN FAILED ${clip(d.error ?? d.reason, 90)}`;
        case "session.regenerate_refused":   return `regen refused ${clip(d.reason, 70)}`;
        case "session.artifact_presented":   return `artifact ${clip(d.name ?? d.title ?? d.artifactId, 60)}`;
        case "tool.execution_start":  return `${d.toolName ?? d.tool ?? "tool"}(${clip(JSON.stringify(d.arguments ?? d.args ?? {}), 70)})`;
        case "tool.execution_complete": {
            const ok = d.isError === true || d.success === false ? "FAILED" : "ok";
            const name = d.toolName ?? d.tool ?? short(d.toolCallId, 12);
            const res = d.result?.content ?? d.error ?? "";
            return `${name} -> ${ok} ${clip(res, 60)}`;
        }
        case "assistant.usage": return `model=${d.model ?? "?"} in=${d.inputTokens ?? "?"} out=${d.outputTokens ?? "?"}${d.cost != null ? ` cost=${d.cost}` : ""}`;
        case "user.message":      return `USER: ${clip(d.content, 100)}`;
        case "assistant.message": return d.content ? `ASSISTANT: ${clip(d.content, 100)}` : "(tool call)";
        case "system.message":    return `SYSTEM: ${clip(d.content, 90)}`;
        default:                  return clip(JSON.stringify(d), 100);
    }
}

// pod (workerNodeId) -> node name, via kubectl. Cached; failures are non-fatal.
function resolveNodes(pods, namespace) {
    const map = new Map();
    for (const pod of pods) {
        if (!pod || pod === "-") continue;
        try {
            const out = execFileSync("kubectl",
                ["-n", namespace, "get", "pod", pod, "-o", "jsonpath={.spec.nodeName}"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
            map.set(pod, out || "(unknown)");
        } catch {
            map.set(pod, "(not found)"); // pod may be gone (restarted/rescheduled)
        }
    }
    return map;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || opts.positionals.length === 0) { console.log(HELP); process.exit(opts.help ? 0 : 2); }

    const seedId = opts.positionals[0];
    const dbUrl = opts.databaseUrl || process.env.DATABASE_URL;
    if (!dbUrl) { console.error("DATABASE_URL not set (see file header to pull it from a worker pod), or pass --database-url"); process.exit(2); }

    // dynamic import so --help works even without a built SDK
    let PgSessionCatalogProvider;
    let importErr;
    for (const cand of cmsCandidates) {
        // ESM dynamic import needs a file:// URL for absolute filesystem paths
        // (bare Windows drive paths like Q:\... are not valid import specifiers).
        const spec = /^[a-z]+:\/\//i.test(cand) ? cand : pathToFileURL(cand).href;
        try { ({ PgSessionCatalogProvider } = await import(spec)); break; }
        catch (e) { importErr = e; }
    }
    if (!PgSessionCatalogProvider) {
        console.error(`could not load SDK cms.js (build it: npm -w @pilotswarm/sdk run build). Tried:\n  ${cmsCandidates.join("\n  ")}\n${importErr?.message ?? ""}`);
        process.exit(2);
    }

    // Managed-identity (Entra) auth: auto-enable when the env flag is set or the
    // URL carries no password; --managed-identity / --no-managed-identity override.
    const envMi = ["1", "true", "yes", "on"].includes((process.env.PILOTSWARM_USE_MANAGED_IDENTITY ?? "").trim().toLowerCase());
    let emptyPw = false;
    try { emptyPw = new URL(dbUrl).password === ""; } catch { /* non-URL string */ }
    const useMi = opts.mi != null ? opts.mi : (envMi || emptyPw);
    const aadUser = opts.aadUser || process.env.PILOTSWARM_DB_AAD_USER || undefined;
    if (useMi) console.error(`[trace] managed-identity auth (aadUser=${aadUser ?? "<from URL>"})`);

    const cat = await PgSessionCatalogProvider.create(dbUrl, undefined, useMi ? { useManagedIdentity: true, aadUser } : {});
    await cat.initialize();
    try {
        // 1) resolve the whole tree from any node in it
        const seed = await cat.getSession(seedId);
        if (!seed) { console.error(`session not found: ${seedId}`); process.exit(1); }
        const rootId = seed.rootSessionId || seed.sessionId;

        const descIds = (await safe(() => cat.getDescendantSessionIds(rootId))) || [];
        const treeIds = Array.from(new Set([rootId, ...descIds]));

        const rows = new Map();
        for (const id of treeIds) {
            const r = await safe(() => cat.getSession(id));
            if (r) rows.set(id, r);
        }

        // 2) pull events per session, tag with sessionId, merge
        const sinceMs = opts.since ? Date.parse(opts.since) : null;
        const typeFilter = opts.types ? new Set(opts.types) : null;
        const wanted = (t) => opts.all || FAILURE_RX.test(t) || (typeFilter ? typeFilter.has(t) : IMPORTANT.has(t));

        let all = [];
        let totalRaw = 0;
        for (const id of treeIds) {
            const evs = (await safe(() => cat.getSessionEvents(id, undefined, opts.limit))) || [];
            totalRaw += evs.length;
            for (const e of evs) {
                if (sinceMs && new Date(e.createdAt).getTime() < sinceMs) continue;
                all.push(e);
            }
        }
        all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || (a.seq - b.seq));
        const shown = all.filter((e) => wanted(e.eventType));

        // 3) pod / node correlation
        const pods = Array.from(new Set(all.map((e) => e.workerNodeId).filter(Boolean)));
        const nodeOf = opts.kubectl ? resolveNodes(pods, opts.namespace) : new Map();

        // per-pod aggregate
        const podAgg = new Map();
        for (const e of all) {
            const p = e.workerNodeId || "(none)";
            const a = podAgg.get(p) || { count: 0, first: e.createdAt, last: e.createdAt, repos: new Set() };
            a.count++;
            if (new Date(e.createdAt) < new Date(a.first)) a.first = e.createdAt;
            if (new Date(e.createdAt) > new Date(a.last)) a.last = e.createdAt;
            const r = rows.get(e.sessionId);
            if (r?.agentId) a.repos.add(r.agentId);
            podAgg.set(p, a);
        }

        // per-session ordered pod sequence (movement / failover detection)
        const podSeqBySession = new Map();
        for (const e of all) {
            if (!e.workerNodeId) continue;
            const seq = podSeqBySession.get(e.sessionId) || [];
            const lastEntry = seq[seq.length - 1];
            if (!lastEntry || lastEntry.pod !== e.workerNodeId) seq.push({ pod: e.workerNodeId, at: e.createdAt });
            podSeqBySession.set(e.sessionId, seq);
        }

        if (opts.json) {
            console.log(JSON.stringify({
                rootId, seedId, sessionCount: treeIds.length,
                sessions: treeIds.map((id) => summRow(rows.get(id), id)),
                pods: pods.map((p) => ({ pod: p, node: nodeOf.get(p) || null, ...aggOut(podAgg.get(p)) })),
                movement: [...podSeqBySession].map(([sid, seq]) => ({ sessionId: sid, hops: seq })),
                events: shown.map((e) => ({ ts: iso(e.createdAt), sessionId: e.sessionId, seq: e.seq,
                    type: e.eventType, pod: e.workerNodeId || null, summary: summarize(e) })),
            }, null, 2));
            return;
        }

        // ── text report ─────────────────────────────────────────────────────
        const rootRow = rows.get(rootId);
        const t0 = all.length ? new Date(all[0].createdAt).getTime() : Date.now();
        console.log(`\n== SESSION TREE  ${short(rootId)}  ${rootRow?.title ? `"${rootRow.title}"` : ""}  (${treeIds.length} session${treeIds.length === 1 ? "" : "s"}) ==`);
        console.log(`   root=${rootId}`);
        if (seedId !== rootId) console.log(`   (seed ${short(seedId)} is a descendant; tracing whole tree)`);

        // tree, parent -> children
        const kids = new Map();
        for (const id of treeIds) {
            const p = rows.get(id)?.parentSessionId;
            if (p && rows.has(p)) { (kids.get(p) || kids.set(p, []).get(p)).push(id); }
        }
        const printNode = (id, depth) => {
            const r = rows.get(id);
            const seq = podSeqBySession.get(id) || [];
            const podStr = seq.length === 0 ? "-" : seq.length === 1 ? podLabel(seq[0].pod, 28)
                : seq.map((s) => podLabel(s.pod, 24)).join(" -> ") + "  << MOVED";
            const bullet = depth === 0 ? "●" : "○";
            console.log(`   ${"  ".repeat(depth)}${bullet} ${short(id)} [${r?.agentId ?? "user"}] state=${r?.state ?? "?"}${r?.lastError ? " ERR" : ""} pod=${podStr}${r?.title ? `  "${clip(r.title, 48)}"` : ""}`);
            for (const c of (kids.get(id) || [])) printNode(c, depth + 1);
        };
        console.log("");
        printNode(rootId, 0);

        console.log(`\n== TIMELINE  (${shown.length} of ${all.length} events${opts.all ? ", all types" : ", important"}${sinceMs ? `, since ${opts.since}` : ""}) ==`);
        console.log(`   ${"UTC time".padEnd(12)} ${"+elapsed".padEnd(10)} ${"session".padEnd(9)} ${"event".padEnd(26)} ${"pod".padEnd(24)} summary`);
        const lastPodBySession = new Map();
        for (const e of shown) {
            const elapsed = new Date(e.createdAt).getTime() - t0;
            const pod = e.workerNodeId || "-";
            // "*" marks the exact event where THIS session hopped to a different
            // pod (rehydration/failover) — not just an interleave with a sibling.
            const prev = lastPodBySession.get(e.sessionId);
            const moved = pod !== "-" && prev && prev !== pod ? " *" : "";
            if (pod !== "-") lastPodBySession.set(e.sessionId, pod);
            const line = `   ${hms(e.createdAt)} ${("+" + fmtElapsed(elapsed)).padEnd(10)} ${short(e.sessionId).padEnd(9)} ${e.eventType.padEnd(26)} ${podLabel(pod, 24).padEnd(24)}${moved} ${summarize(e)}`;
            console.log(line);
        }

        console.log(`\n== NODES & PODS INVOLVED ==`);
        console.log(`   ${"pod".padEnd(26)} ${"node".padEnd(34)} ${"events".padStart(6)}  ${"first".padEnd(12)} ${"last".padEnd(12)}`);
        for (const p of pods) {
            const a = podAgg.get(p);
            console.log(`   ${podLabel(p, 26).padEnd(26)} ${String(nodeOf.get(p) ?? (opts.kubectl ? "?" : "(skipped)")).padEnd(34)} ${String(a.count).padStart(6)}  ${hms(a.first).slice(0, 12)} ${hms(a.last).slice(0, 12)}`);
        }
        if (!opts.kubectl) console.log(`   (pod->node lookup skipped; run without --no-kubectl, or map manually: kubectl -n ${opts.namespace} get pod <pod> -o wide)`);

        // movement / failover callout
        const moved = [...podSeqBySession].filter(([, seq]) => seq.length > 1);
        console.log(`\n== POD MOVEMENT (rehydration / failover) ==`);
        if (moved.length === 0) {
            console.log(`   none — every session stayed on a single worker pod for its whole life.`);
        } else {
            for (const [sid, seq] of moved) {
                console.log(`   ${short(sid)} : ${seq.map((s) => `${podLabel(s.pod, 24)}@${hms(s.at)}`).join("  ->  ")}`);
            }
            console.log(`   (a session changing pods = it was dehydrated and rehydrated elsewhere: node drain, pod`);
            console.log(`    restart/eviction, or a rolling worker update. Correlate the timestamps with kubectl`);
            console.log(`    get events / node status around those times.)`);
        }
        console.log("");
    } finally {
        await safe(() => cat.close());
    }
}

function clip(s, n) { return s == null ? "" : String(s).replace(/\s+/g, " ").slice(0, n); }
function summRow(r, id) {
    return r ? { sessionId: id, parentSessionId: r.parentSessionId ?? null, agentId: r.agentId ?? null,
        state: r.state, title: r.title ?? null, lastError: r.lastError ?? null,
        createdAt: r.createdAt ? iso(r.createdAt) : null } : { sessionId: id, missing: true };
}
function aggOut(a) { return a ? { events: a.count, first: iso(a.first), last: iso(a.last) } : { events: 0 }; }
async function safe(fn) { try { return await fn(); } catch (e) { if (process.env.TRACE_DEBUG) console.error("[trace] ", e?.message ?? e); return undefined; } }

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
