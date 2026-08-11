#!/usr/bin/env node

/**
 * Git repo worker — a headless pilotswarm worker collocated with a git-cache mirror.
 *
 * Identical polling/execution behaviour to examples/worker.js, but designed to
 * run 1:1 on the same nodes as the git-cache mirror DaemonSet (see
 * SqlOrchestrationPlatform/docs/AKS-GIT-HYDRATION.md, sections 5 & 6). The pod
 * is co-scheduled with the mirror daemon from node boot, but an initContainer
 * gate (`wait-for-mirror`) blocks THIS process from starting until the daemon
 * has finished the initial `git clone --mirror` on this node and written the
 * readiness sentinel. Because the worker polls PostgreSQL for jobs, "process
 * not started" == "cannot accept a job", so a still-warming node never runs work.
 *
 * Steady-state enlistment sync (MVP):
 *   - The daemon maintains a node-local BARE mirror (RO to us) and periodically
 *     `git fetch`es it (gc off -> append-only). It never touches our enlistment.
 *   - At startup this worker clones ONE reused working enlistment FROM that
 *     mirror (`git clone --no-hardlinks`, so objects are copied and the
 *     enlistment is self-contained) and chdir's into it.
 *   - When a session is ACQUIRED onto this worker (a COLD turn — turn 0 or a
 *     cross-worker resume), the SDK calls our `beforeRunTurn` hook, which
 *     fetches from the mirror and hard-resets the enlistment to the target ref
 *     (reconcileEnlistment). The SDK scopes this to hydration/acquisition: on
 *     warm turns of a pinned repo-affinity session the hook is NOT called, so a
 *     long session's own mid-session working-tree edits survive across turns
 *     (a per-turn `reset --hard` would wipe them). Because
 *     PILOTSWARM_WORKER_CONCURRENCY=1, the single job slot is the mutex: while a
 *     reconcile runs the worker claims no other job — a brief "unavailable"
 *     window — and the tree is guaranteed idle. Once a job is running, the
 *     daemon's fetch/prune on the mirror can never affect it (append-only +
 *     copied objects). Freshness bound = last fetch at acquisition.
 *
 * Env vars: everything examples/worker.js accepts, plus:
 *   GIT_CACHE_MIRROR   — absolute path to the node-local bare mirror for this
 *                        repo (e.g. /mnt/git-cache/<repo>.git). Enables the
 *                        enlistment lifecycle + reconcile hook.
 *   GIT_CACHE_ROOT     — hostPath root of the mirror store (default /mnt/git-cache)
 *   GIT_CACHE_REPO     — DNS-safe repo name this node's pool serves
 *   GIT_ENLISTMENT_DIR — writable working enlistment path
 *                        (default /mnt/enlistment/<repo>)
 *   GIT_ENLISTMENT_REF — ref to reset onto each job (default: mirror's
 *                        origin/HEAD, falling back to main/master)
 *   GIT_ENLISTMENT_CLEAN — "1" to `git clean -fdx` each reconcile (default off:
 *                        keep warm build caches across jobs)
 *
 * REQUIRED: run with PILOTSWARM_WORKER_CONCURRENCY=1 (one PilotSwarm job per
 * pod at a time) — this is what makes reconcile-before-job race-free.
 *
 * Usage:
 *   node examples/git-repo-worker.js
 *   # In the DaemonSet: command ["node", "examples/git-repo-worker.js"]
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PilotSwarmWorker, horizonConfigFromEnv } from "pilotswarm-sdk";

// Sentinel value written to KV by the bicep-deploy `seed-secrets` step for
// optional secrets the user didn't provide (CSI Secret Store requires
// non-empty values). Strip it so downstream code treats the secret as unset.
// Keep in sync with deploy/scripts/lib/seed-secrets.mjs.
const SEED_SECRETS_UNSET_SENTINEL = "__PS_UNSET__";
for (const k of Object.keys(process.env)) {
    if (process.env[k] === SEED_SECRETS_UNSET_SENTINEL) {
        delete process.env[k];
    }
}

const logLevel = process.env.LOG_LEVEL || "info";
const podName = process.env.POD_NAME || os.hostname();

// --- git-cache collocation -------------------------------------------------
// The initContainer already guaranteed the mirror is present before we start;
// this is a defensive re-check + observability. If GIT_CACHE_MIRROR is set but
// missing, fail fast rather than silently fall back to slow network clones.
const gitCacheRoot = process.env.GIT_CACHE_ROOT || "/mnt/git-cache";
const gitCacheRepo = process.env.GIT_CACHE_REPO || undefined;
const gitCacheMirror = process.env.GIT_CACHE_MIRROR
    || (gitCacheRepo ? `${gitCacheRoot}/${gitCacheRepo}.git` : undefined);

// beforeRunTurn reconcile hook — wired into the worker config below only when a
// mirror is configured. Plain (non-git-cache) deployments leave it undefined.
let beforeRunTurn;

if (gitCacheMirror) {
    if (!fs.existsSync(gitCacheMirror)) {
        console.error(`[git-repo-worker] FATAL git-cache mirror not found at ${gitCacheMirror} — the initContainer gate should have prevented start.`);
        process.exit(1);
    }

    // ── Enlistment model (git-hydration MVP) ─────────────────────────────
    // The node-local bare mirror (RO) is maintained by the git-cache daemon,
    // which periodically `git fetch`es it (gc off -> append-only). This worker
    // keeps ONE reused working enlistment on a writable volume and, BEFORE
    // every job, fetches from the mirror and hard-resets to the target ref
    // (reconcileEnlistment, invoked via the SDK `beforeRunTurn` hook). With
    // PILOTSWARM_WORKER_CONCURRENCY=1 the single job slot is the mutex: while a
    // reconcile runs no other job can be claimed, so the tree is always idle
    // during reconcile and the worker is briefly "unavailable" for jobs. The
    // in-process lock below self-serializes reconciles so bumping concurrency
    // later degrades to "jobs queue behind a reconcile" rather than a torn tree.
    const enlistmentDir = process.env.GIT_ENLISTMENT_DIR
        || path.join(process.env.GIT_ENLISTMENT_ROOT || "/mnt/enlistment", gitCacheRepo || "repo");
    const cleanEachJob = ["1", "true", "yes", "on"].includes(
        (process.env.GIT_ENLISTMENT_CLEAN || "").trim().toLowerCase(),
    );

    const runGit = (cwd, args) => execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();

    // Resolve the ref every job resets to. Explicit override wins; otherwise the
    // mirror's default branch (origin/HEAD), falling back to main/master.
    const resolveTargetRef = () => {
        if (process.env.GIT_ENLISTMENT_REF) return process.env.GIT_ENLISTMENT_REF;
        try {
            // e.g. "origin/main" -> the tracking ref we reset onto.
            return runGit(enlistmentDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
        } catch {
            for (const b of ["origin/main", "origin/master"]) {
                try { runGit(enlistmentDir, ["rev-parse", "--verify", b]); return b; } catch { /* try next */ }
            }
            throw new Error("could not resolve a default ref (set GIT_ENLISTMENT_REF)");
        }
    };

    // One-time at startup: clone the working enlistment FROM the local mirror.
    // --no-hardlinks copies objects into the enlistment's own store so it is
    // fully self-contained; the daemon's fetch/prune on the mirror can never
    // affect an in-flight job. chdir so the Copilot CLI roots discovery here.
    const ensureEnlistment = () => {
        if (!fs.existsSync(path.join(enlistmentDir, ".git"))) {
            fs.mkdirSync(path.dirname(enlistmentDir), { recursive: true });
            console.log(`[git-repo-worker] cloning enlistment from mirror ${gitCacheMirror} -> ${enlistmentDir} (one-time)`);
            const t0 = Date.now();
            execFileSync("git", ["clone", "--no-hardlinks", gitCacheMirror, enlistmentDir], {
                stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            });
            // Match the mirror's maintenance posture: never repack/prune under
            // an active job. Objects stay append-only for the pod's lifetime.
            runGit(enlistmentDir, ["config", "gc.auto", "0"]);
            console.log(`[git-repo-worker] enlistment ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } else {
            console.log(`[git-repo-worker] reusing existing enlistment at ${enlistmentDir}`);
        }
        process.chdir(enlistmentDir);
        console.log(`[git-repo-worker] cwd -> ${enlistmentDir} (CLI discovery root)`);
    };

    // Self-serializing lock (promise chain). Guarantees one reconcile at a time
    // regardless of worker concurrency; with concurrency=1 it is uncontended.
    let lockTail = Promise.resolve();
    const withEnlistmentLock = (fn) => {
        const run = lockTail.then(fn, fn);
        lockTail = run.then(() => {}, () => {});
        return run;
    };

    const reconcileEnlistment = (trace) => withEnlistmentLock(() => {
        const ref = resolveTargetRef();
        const log = (m) => { console.log(m); if (trace) trace(m); };
        log(`[git-repo-worker] reconciling ${enlistmentDir} -> ${ref} (worker UNAVAILABLE)`);
        const t0 = Date.now();
        // Local fetch from the mirror (no network); copies new objects into the
        // enlistment's own store. --prune drops deleted refs (never objects).
        runGit(enlistmentDir, ["fetch", "--prune", "--no-write-fetch-head", "origin"]);
        const sha = runGit(enlistmentDir, ["rev-parse", ref]);
        runGit(enlistmentDir, ["checkout", "--force", "--detach", sha]);
        runGit(enlistmentDir, ["reset", "--hard", sha]);
        if (cleanEachJob) runGit(enlistmentDir, ["clean", "-fdx"]);
        log(`[git-repo-worker] reconciled to ${sha.slice(0, 12)} in ${Date.now() - t0}ms (READY)`);
    });

    // Prepare the enlistment now so the first job starts on a synced tree.
    ensureEnlistment();
    reconcileEnlistment();

    // The SDK invokes this at the top of every runTurn, before the session
    // touches the working directory — the brief "unavailable" reconcile window.
    beforeRunTurn = async ({ trace }) => { await reconcileEnlistment(trace); };

    console.log(`[git-repo-worker] git-cache mirror: ${gitCacheMirror}`);
    console.log(`[git-repo-worker] enlistment: ${enlistmentDir} (reconcile-before-job; clean=${cleanEachJob})`);
}

// Plugin directories: env override or auto-detect bundled/default Docker plugin dirs.
const pluginDirs = process.env.PLUGIN_DIRS
    ? process.env.PLUGIN_DIRS.split(",").map(d => d.trim()).filter(Boolean)
    : [];
if (pluginDirs.length === 0 && fs.existsSync("/app/packages/cli/plugins/plugin.json")) {
    pluginDirs.push("/app/packages/cli/plugins");
}
if (pluginDirs.length === 0 && fs.existsSync("/app/plugin/plugin.json")) {
    pluginDirs.push("/app/plugin");
}

console.log(`[git-repo-worker] Pod: ${podName}`);
console.log(`[git-repo-worker] Store: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);
if (pluginDirs.length > 0) console.log(`[git-repo-worker] Plugin dirs: ${pluginDirs.join(", ")}`);
if (process.env.SESSION_STATE_DIR) console.log(`[git-repo-worker] Session state dir: ${process.env.SESSION_STATE_DIR}`);

// System message: falls back to default.agent.md from plugin if not set here.
const SYSTEM_MESSAGE = undefined;

const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    logLevel,
    traceWriter: (message) => console.log(message),
    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
    sessionStateDir: process.env.SESSION_STATE_DIR || undefined,
    modelProvidersPath: process.env.PS_MODEL_PROVIDERS_PATH || process.env.MODEL_PROVIDERS_PATH || undefined,
    workerNodeId: podName,
    systemMessage: SYSTEM_MESSAGE,
    pluginDirs,
    // Pre-turn reconcile (git-hydration MVP): sync the local enlistment from
    // the node-local mirror before each job. Undefined unless a mirror is set.
    beforeRunTurn,
    useManagedIdentity: ["1", "true", "yes", "on"].includes(
        (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
    ),
    cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
    aadDbUser: process.env.PILOTSWARM_DB_AAD_USER || undefined,
    blobAccountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL || undefined,
    ...horizonConfigFromEnv(),
    ...(["0", "false", "off", "no"].includes((process.env.PILOTSWARM_AGENT_PACKAGES || "").trim().toLowerCase())
        ? {}
        : {
            agentPackages: {
                cacheDir: process.env.PILOTSWARM_AGENT_PACKAGES_DIR || undefined,
                refreshIntervalMs: (() => {
                    const n = Number.parseInt(process.env.PILOTSWARM_AGENT_PACKAGES_REFRESH_MS || "", 10);
                    return Number.isFinite(n) ? n : undefined;
                })(),
            },
        }),
});

await worker.start();
console.log(`[git-repo-worker] Started ✓ Polling for orchestrations...`);
if (worker.loadedAgents.length > 0) {
    console.log(`[git-repo-worker] Agents: ${worker.loadedAgents.map(a => a.name).join(", ")}`);
}

// Graceful drain (lifecycle protocol §3.8): stop fetching, let in-flight turns
// finish and commit within the drain budget, then exit. The pod's
// terminationGracePeriodSeconds must exceed the drain budget.
async function shutdown(signal) {
    console.log(`[git-repo-worker] ${signal} received, draining...`);
    await worker.gracefulShutdown();
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Block forever — worker polls in background.
await new Promise(() => {});
