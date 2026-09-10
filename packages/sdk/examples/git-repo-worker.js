#!/usr/bin/env node

/**
 * Git repo worker — a headless pilotswarm worker collocated with a git-cache mirror.
 *
 * Identical polling/execution behaviour to examples/worker.js, but designed to
 * run 1:1 on the same nodes as the git-cache mirror DaemonSet (see
 * docs/architecture/aks-git-hydration.md, sections 5 & 6). The pod
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
import { PilotSwarmWorker, horizonConfigFromEnv, installPluginSpecs, fetchKeyVaultSecret, loadRepoMcpConfig, loadDefaultMcpConfig, hydrateGitWorkspace, dehydrateGitWorkspace, resolveTargetRef as resolveTargetRefCore, GitStore, Runner } from "pilotswarm-sdk";

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

// --- Readiness sentinel ----------------------------------------------------
// The k8s readinessProbe (daemonset.yaml) checks this file. We write it ONLY
// after worker.start() resolves — i.e. the enlistment has been cloned/synced
// AND the worker is actually polling PostgreSQL for jobs — and we remove it the
// moment we begin draining. This makes "Ready" mean "can accept a job" instead
// of merely "the node-local mirror exists": a still-warming worker (the one-time
// ~minutes cold enlistment clone) now honestly reports NotReady, and a rolling
// update won't tear down the next node's worker until this one can truly serve.
// The path lives on the pod-scoped copilot-home volume (emptyDir), so it is
// always absent at a fresh/cold start regardless of the enlistment's volume type.
const readyFile = process.env.WORKER_READY_FILE || "/home/node/.copilot/worker.ready";
const markReady = () => {
    try {
        fs.mkdirSync(path.dirname(readyFile), { recursive: true });
        fs.writeFileSync(readyFile, `${podName} ${new Date().toISOString()}\n`);
        console.log(`[git-repo-worker] readiness sentinel written -> ${readyFile} (READY: accepting jobs)`);
    } catch (err) {
        console.warn(`[git-repo-worker] could not write readiness sentinel ${readyFile}: ${err?.message ?? err}`);
    }
};
const clearReady = () => {
    try { fs.rmSync(readyFile, { force: true }); } catch { /* best effort */ }
};
// Defensive: begin NotReady even if the sentinel path is ever backed by a
// persistent volume — a stale file must never survive into a fresh process.
clearReady();

// --- git-cache collocation -------------------------------------------------
// The initContainer already guaranteed the mirror is present before we start;
// this is a defensive re-check + observability. If GIT_CACHE_MIRROR is set but
// missing, fail fast rather than silently fall back to slow network clones.
const gitCacheRoot = process.env.GIT_CACHE_ROOT || "/mnt/git-cache";
const gitCacheRepo = process.env.GIT_CACHE_REPO || undefined;
const gitCacheMirror = process.env.GIT_CACHE_MIRROR
    || (gitCacheRepo ? `${gitCacheRoot}/${gitCacheRepo}.git` : undefined);

// Devbox / local self-fetch worktree mode (Shape C). Reachable ONLY when there
// is NO node-local mirror AND the operator explicitly opts in — so it can never
// activate on AKS, where every DaemonSet sets GIT_CACHE_MIRROR to a literal.
const devboxSelfFetch = !gitCacheMirror
    && ["1", "true", "yes", "on"].includes((process.env.GIT_ENLISTMENT_SELF_FETCH || "").trim().toLowerCase())
    && !!(process.env.GIT_SHARED_STORE || process.env.REPO_URL);

// beforeRunTurn reconcile hook — wired into the worker config below only when a
// mirror is configured. Plain (non-git-cache) deployments leave it undefined.
let beforeRunTurn;
// afterRunTurn dehydrate hook — the post-turn half of the §8.5 durable
// git-workspace protocol. Assigned alongside beforeRunTurn when a mirror is set.
let afterRunTurn;

// Repo-stored MCP servers loaded from the enlistment's own .vscode/mcp.json.
// A repo-pinned worker grants these to every session it runs (see below).
let repoMcpServers = {};

// Fleet-default MCP servers (DEFAULT_MCP_JSON deploy token): a deploy-time,
// fleet-level set of REMOTE servers -- canonically the Azure DevOps MCP --
// injected into every session INDEPENDENT of the target repo's .vscode/mcp.json.
// Loaded unconditionally (not tied to git-cache): each is marked optional so a
// session whose caller has no token for its audience silently runs without it.
// The concrete URL/org live only in the ADO-side deploy value, never here.
let defaultMcpServers = {};
try {
    defaultMcpServers = loadDefaultMcpConfig(process.env.DEFAULT_MCP_JSON, {
        trace: (m) => console.log(m),
    });
    const defaultNames = Object.keys(defaultMcpServers);
    if (defaultNames.length > 0) {
        console.log(`[git-repo-worker] fleet-default MCP servers (every-session, optional): ${defaultNames.join(", ")}`);
    }
} catch (err) {
    console.warn(`[git-repo-worker] default MCP load error (continuing): ${err?.message ?? err}`);
}

// Merge fleet-default servers under repo-declared servers: the repo's own
// declaration of a same-named server WINS (repo spread last), which lets a repo
// pin e.g. `ado` with a narrower toolset. Overrides are logged so the swap is
// visible in `kubectl logs`.
function mergeMcpServers(defaults, repo) {
    const merged = { ...defaults, ...repo };
    for (const name of Object.keys(repo ?? {})) {
        if (defaults && name in defaults) {
            console.log(`[git-repo-worker] repo MCP server "${name}" overrides fleet default of the same name`);
        }
    }
    return merged;
}

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

    // Resolve the ref a job resets to (per-session config.gitRef > worker-wide
    // GIT_ENLISTMENT_REF > the mirror's origin/HEAD default). The logic lives in
    // the SDK's resolveTargetRef so it is unit-tested (test/unit/git-store.test.mjs);
    // this binding injects the enlistment dir + git runner.
    const resolveTargetRef = (sessionGitRef) =>
        resolveTargetRefCore(sessionGitRef, { dir: enlistmentDir, runGit, envRef: process.env.GIT_ENLISTMENT_REF });

    // Clone the working enlistment FROM the local mirror. --no-hardlinks copies
    // objects into the enlistment's own store so it is fully self-contained; the
    // daemon's fetch/prune on the mirror can never affect an in-flight job.
    const cloneEnlistment = () => {
        fs.mkdirSync(path.dirname(enlistmentDir), { recursive: true });
        console.log(`[git-repo-worker] cloning enlistment from mirror ${gitCacheMirror} -> ${enlistmentDir} (one-time)`);
        const t0 = Date.now();
        execFileSync("git", ["clone", "--no-hardlinks", gitCacheMirror, enlistmentDir], {
            stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        // Match the mirror's maintenance posture: never repack/prune under an
        // active job. Objects stay append-only for the pod's lifetime.
        runGit(enlistmentDir, ["config", "gc.auto", "0"]);
        console.log(`[git-repo-worker] enlistment ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    };

    // Is an existing enlistment a COMPLETE, usable clone? On a node-local
    // (hostPath) enlistment that survives pod restarts, a pod killed mid-clone
    // leaves a `.git` behind but an incomplete object store / unborn HEAD —
    // reusing it would crash the first reconcile. Cheap gate: HEAD must peel to
    // a commit object present locally, and origin must be wired to the mirror.
    // (Deeper corruption — e.g. missing blobs — is caught by the reconcile
    // fallback in prepareEnlistment below.)
    const enlistmentIsHealthy = () => {
        if (!fs.existsSync(path.join(enlistmentDir, ".git"))) return false;
        try {
            runGit(enlistmentDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
            return runGit(enlistmentDir, ["config", "--get", "remote.origin.url"]).length > 0;
        } catch {
            return false;
        }
    };

    // One-time at startup: ensure a usable enlistment exists, then chdir into it
    // so the Copilot CLI roots discovery here. Reuses a healthy node-local
    // enlistment (the hostPath fast path — no re-clone on pod restart / node
    // reboot); re-clones a torn/partial one.
    const ensureEnlistment = () => {
        if (enlistmentIsHealthy()) {
            // Drop any stale git lock left by a process killed mid-operation; the
            // reconcile that follows (checkout --force + reset --hard) heals the
            // working tree itself.
            for (const lock of ["index.lock", "HEAD.lock", "shallow.lock"]) {
                try { fs.rmSync(path.join(enlistmentDir, ".git", lock), { force: true }); } catch { /* ignore */ }
            }
            console.log(`[git-repo-worker] reusing existing enlistment at ${enlistmentDir} (validated)`);
        } else {
            if (fs.existsSync(enlistmentDir)) {
                console.warn(`[git-repo-worker] enlistment at ${enlistmentDir} is incomplete/corrupt — re-cloning`);
                fs.rmSync(enlistmentDir, { recursive: true, force: true });
            }
            cloneEnlistment();
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

    const reconcileEnlistment = (trace, sessionGitRef) => withEnlistmentLock(() => {
        const ref = resolveTargetRef(sessionGitRef);
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

    // Prepare the enlistment now so the first job starts on a synced tree. If
    // the reconcile fails on a reused enlistment (torn state the cheap health
    // check missed — e.g. missing blobs after a mid-clone kill), discard it and
    // re-clone once. This restores the "always start clean" safety that the old
    // emptyDir gave for free, now that the enlistment survives on hostPath.
    ensureEnlistment();
    try {
        await reconcileEnlistment();
    } catch (err) {
        console.warn(`[git-repo-worker] initial reconcile failed (${err?.message ?? err}) — discarding enlistment and re-cloning`);
        process.chdir(path.dirname(enlistmentDir));
        fs.rmSync(enlistmentDir, { recursive: true, force: true });
        cloneEnlistment();
        process.chdir(enlistmentDir);
        await reconcileEnlistment();
    }

    // Repo-stored MCP servers (delegated MCP access — repo-stored half): a
    // repo-pinned worker exposes the servers the repo declares for its own
    // developers in .vscode/mcp.json to every session it runs, so a customer
    // talking to this repo's agent can reach the repo's MCP servers without
    // attaching them per request. Loaded once
    // here, after the enlistment is synced; passed as direct worker mcpServers
    // config below (every-session base grant). Remote (http/sse) servers only
    // by default — repo stdio servers are authored for a developer box and
    // won't run on this Linux worker. Disable via REPO_MCP_ENABLED=0.
    if (!["0", "false", "off", "no"].includes((process.env.REPO_MCP_ENABLED || "").trim().toLowerCase())) {
        try {
            repoMcpServers = loadRepoMcpConfig(enlistmentDir, {
                remoteOnly: !["0", "false", "off", "no"].includes(
                    (process.env.REPO_MCP_REMOTE_ONLY || "").trim().toLowerCase(),
                ),
                allow: (process.env.REPO_MCP_ALLOW || "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                // Feeds we credential in NuGet.Config at boot (writeNuGetAuthConfig).
                // A `dnx`-launched repo stdio server that
                // pins its feed with `--source <URL>` bypasses those creds and
                // 401s; strip a matching override so dnx uses the credentialed
                // config source instead. Windows-only (matches NuGet auth wiring).
                credentialedNuGetFeeds: process.platform === "win32"
                    ? (process.env.ADO_NUGET_FEED_URLS || "")
                        .split(/[;,]/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : [],
                trace: (m) => console.log(m),
            });
            const names = Object.keys(repoMcpServers);
            if (names.length > 0) {
                console.log(`[git-repo-worker] repo MCP servers (every-session): ${names.join(", ")}`);
            } else {
                console.log(`[git-repo-worker] no repo MCP servers loaded from ${enlistmentDir}/.vscode/mcp.json`);
            }
        } catch (err) {
            console.warn(`[git-repo-worker] repo MCP load error (continuing): ${err?.message ?? err}`);
        }
    }

    // The SDK invokes beforeRunTurn at the top of every runTurn (before the
    // session touches the working directory) and afterRunTurn at the end of
    // every turn. When the SDK supplies durable git-workspace IO
    // (ctx.gitStateIO + ctx.gitBlobs — the CMS-backed pointer row + blob store),
    // we run the full §8.5 dehydrate/hydrate protocol so a user's uncommitted
    // work (unpushed local commits, tracked edits, untracked files) survives a
    // hard cross-pod session move. When that IO is absent (legacy / non-CMS
    // deployments) we fall back to the moving-ref reconcile: sync the enlistment
    // to the target ref and discard the working tree.
    beforeRunTurn = async ({ trace, gitStateIO, gitBlobs, config }) => {
        const sessionGitRef = config?.gitRef;
        if (gitStateIO && gitBlobs) {
            await withEnlistmentLock(async () => {
                const log = (m) => { console.log(m); if (trace) trace(m); };
                const res = await hydrateGitWorkspace({
                    enlistmentDir,
                    blobs: gitBlobs,
                    state: gitStateIO,
                    targetRef: resolveTargetRef(sessionGitRef),
                    trace,
                });
                log(`[git-repo-worker] hydrated (${res.mode}) base=${res.baseSha.slice(0, 12)} head=${res.headSha.slice(0, 12)} epoch=${res.epoch} ref=${resolveTargetRef(sessionGitRef)}`);
            });
            return;
        }
        await reconcileEnlistment(trace, sessionGitRef);
    };

    // Post-turn dehydrate: capture unpushed commits (bundle) + tracked/untracked
    // working-tree changes (patch) into durable blobs and advance the pointer
    // row (the commit point, written last). Runs on every turn under the
    // enlistment lock. No-op without durable IO (legacy fallback).
    afterRunTurn = async ({ trace, gitStateIO, gitBlobs }) => {
        if (!gitStateIO || !gitBlobs) return;
        await withEnlistmentLock(async () => {
            const log = (m) => { console.log(m); if (trace) trace(m); };
            const res = await dehydrateGitWorkspace({
                enlistmentDir,
                blobs: gitBlobs,
                state: gitStateIO,
                trace,
            });
            log(`[git-repo-worker] dehydrated epoch=${res.epoch} head=${res.headSha.slice(0, 12)} base=${res.baseSha.slice(0, 12)}`);
        });
    };

    console.log(`[git-repo-worker] git-cache mirror: ${gitCacheMirror}`);
    console.log(`[git-repo-worker] enlistment: ${enlistmentDir} (reconcile-before-job; clean=${cleanEachJob})`);
} else if (devboxSelfFetch) {
    // ── Devbox / local self-fetch worktree mode (Shape C) ────────────────
    // No node-local mirror. The worker hangs a single detached git WORKTREE off
    // an EXISTING local enlistment's shared object store (GIT_SHARED_STORE, e.g.
    // C:\src\service-repo) — so there is no multi-GB re-clone, only a one-time
    // working-tree checkout. A background Phase-A fetch keeps that shared store
    // warm (additive; never disturbs a running worktree — see src/git-store.ts
    // + its unit test), so a new job claim is a local checkout only. Auth to ADO
    // is the developer's az token (no PAT). Unreachable on AKS by construction:
    // requires GIT_CACHE_MIRROR unset AND the GIT_ENLISTMENT_SELF_FETCH opt-in.
    const sharedStore = process.env.GIT_SHARED_STORE;
    if (!sharedStore) {
        console.error("[git-repo-worker] FATAL devbox self-fetch requires GIT_SHARED_STORE (path to an existing local enlistment).");
        process.exit(1);
    }
    if (!fs.existsSync(sharedStore)) {
        console.error(`[git-repo-worker] FATAL GIT_SHARED_STORE not found: ${sharedStore}`);
        process.exit(1);
    }
    const cleanEachJob = ["1", "true", "yes", "on"].includes(
        (process.env.GIT_ENLISTMENT_CLEAN || "").trim().toLowerCase());

    // Network git commands get a fresh ADO bearer token injected via env (NOT
    // argv — so the token never appears in a process listing); local commands
    // don't. The az token is minted as the developer (popup-free); no PAT.
    const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Azure DevOps AAD app id
    // On Windows the Azure CLI ships as `az.cmd`; Node's execFile can't spawn a
    // .cmd without a shell (and won't PATHEXT-resolve a bare `az`), so run az
    // through the shell there. Args are all fixed literals (no injection).
    const AZ_WIN = process.platform === "win32";
    const mintAdoToken = () => execFileSync(AZ_WIN ? "az.cmd" : "az",
        ["account", "get-access-token", "--resource", ADO_RESOURCE, "--query", "accessToken", "-o", "tsv"],
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: AZ_WIN }).trim();
    const NETWORK_GIT = new Set(["fetch", "clone", "ls-remote", "push", "pull"]);
    const runGit = (cwd, args) => {
        const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
        if (NETWORK_GIT.has(args[0])) {
            const token = mintAdoToken();
            env.GIT_CONFIG_COUNT = "1";
            env.GIT_CONFIG_KEY_0 = "http.extraheader";
            env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: bearer ${token}`;
        }
        return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env }).trim();
    };

    const worktreeName = process.env.GIT_WORKTREE_NAME || gitCacheRepo || podName;
    const enlistmentDir = process.env.GIT_WORKTREE_DIR
        || path.join(process.env.GIT_WORKTREE_ROOT || path.join(path.dirname(sharedStore), "ps-worktrees"), worktreeName);
    const originUrl = process.env.REPO_URL || runGit(sharedStore, ["remote", "get-url", "origin"]);

    const store = new GitStore({ dir: sharedStore, runGit, trace: (m) => console.log(m) });
    const runner = new Runner({ dir: enlistmentDir, runGit });
    store.applyConfig(); // gc.auto=0 (protects worktrees) + benign checkout accelerators

    console.log(`[git-repo-worker] devbox self-fetch: shared store ${sharedStore}`);
    console.log(`[git-repo-worker] devbox origin: ${originUrl.replace(/\/\/[^/@]*@/, "//")}`);

    // Self-serializing lock — serializes reconcile, hydrate/dehydrate, AND the
    // background fetch tick so no two writers race on packed-refs.
    let lockTail = Promise.resolve();
    const withEnlistmentLock = (fn) => {
        const run = lockTail.then(fn, fn);
        lockTail = run.then(() => {}, () => {});
        return run;
    };

    const resolveTargetRef = (sessionGitRef) =>
        resolveTargetRefCore(sessionGitRef, { dir: sharedStore, runGit, envRef: process.env.GIT_ENLISTMENT_REF });
    const localSha = (rev) => { try { return store.revParse(rev); } catch { return undefined; } };

    const worktreeHealthy = () => {
        if (!fs.existsSync(enlistmentDir)) return false;
        try { runGit(enlistmentDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]); return true; }
        catch { return false; }
    };

    const ensureWorktree = (initialSha) => {
        store.pruneWorktrees(); // drop registrations for any dir removed out from under git
        if (worktreeHealthy()) {
            for (const lock of ["index.lock", "HEAD.lock"]) {
                try { fs.rmSync(path.join(enlistmentDir, ".git", lock), { force: true }); } catch { /* ignore */ }
            }
            console.log(`[git-repo-worker] reusing existing worktree at ${enlistmentDir}`);
            return;
        }
        if (fs.existsSync(enlistmentDir)) {
            store.removeWorktree(enlistmentDir);
            fs.rmSync(enlistmentDir, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(enlistmentDir), { recursive: true });
        console.log(`[git-repo-worker] materializing worktree ${enlistmentDir} @ ${initialSha.slice(0, 12)} (one-time; large monorepo checkout may take minutes)`);
        const t0 = Date.now();
        store.addWorktree(enlistmentDir, initialSha);
        console.log(`[git-repo-worker] worktree ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    };

    const reconcile = (trace, sessionGitRef) => withEnlistmentLock(() => {
        const ref = resolveTargetRef(sessionGitRef);
        const log = (m) => { console.log(m); if (trace) trace(m); };
        log(`[git-repo-worker] devbox reconciling ${enlistmentDir} -> ${ref} (worker UNAVAILABLE)`);
        const t0 = Date.now();
        // Phase A: no-op when the tip is already local (warm store from the tick);
        // narrow fetch only on a miss (e.g. a session pinned to a not-yet-local SHA).
        const sha = store.ensureObjects({ ref, sha: localSha(ref) });
        runner.checkout(sha, { clean: cleanEachJob }); // Phase B: local checkout
        store.keep(`wt/${worktreeName}`, sha);          // keepalive: shield the active base from prune
        log(`[git-repo-worker] devbox reconciled to ${sha.slice(0, 12)} in ${Date.now() - t0}ms (READY)`);
    });

    beforeRunTurn = async ({ trace, gitStateIO, gitBlobs, config }) => {
        const sessionGitRef = config?.gitRef;
        if (gitStateIO && gitBlobs) {
            await withEnlistmentLock(async () => {
                const res = await hydrateGitWorkspace({
                    enlistmentDir, blobs: gitBlobs, state: gitStateIO,
                    targetRef: resolveTargetRef(sessionGitRef),
                    detachedCheckout: true,
                    trace,
                });
                store.keep(`wt/${worktreeName}`, res.baseSha);
                const log = (m) => { console.log(m); if (trace) trace(m); };
                log(`[git-repo-worker] devbox hydrated (${res.mode}) base=${res.baseSha.slice(0, 12)} head=${res.headSha.slice(0, 12)} epoch=${res.epoch}`);
            });
            return;
        }
        await reconcile(trace, sessionGitRef);
    };

    afterRunTurn = async ({ trace, gitStateIO, gitBlobs }) => {
        if (!gitStateIO || !gitBlobs) return;
        await withEnlistmentLock(async () => {
            const res = await dehydrateGitWorkspace({ enlistmentDir, blobs: gitBlobs, state: gitStateIO, trace });
            const log = (m) => { console.log(m); if (trace) trace(m); };
            log(`[git-repo-worker] devbox dehydrated epoch=${res.epoch} head=${res.headSha.slice(0, 12)} base=${res.baseSha.slice(0, 12)}`);
        });
    };

    // Startup: ensure objects for the initial ref, materialize/reuse the worktree,
    // chdir in, sync. Runs BEFORE worker.start() so readiness is honest.
    const initialRef = resolveTargetRef();
    const initialSha = store.ensureObjects({ ref: initialRef, sha: localSha(initialRef) });
    ensureWorktree(initialSha);
    process.chdir(enlistmentDir);
    console.log(`[git-repo-worker] cwd -> ${enlistmentDir} (CLI discovery root)`);
    await reconcile();

    // Background Phase-A freshener: keep the shared store warm so claims are
    // checkout-only. Additive + lock-serialized; disable with GIT_FETCH_INTERVAL_MS=0.
    const fetchIntervalMs = parseInt(process.env.GIT_FETCH_INTERVAL_MS || "90000", 10);
    if (Number.isFinite(fetchIntervalMs) && fetchIntervalMs > 0) {
        const scheduleTick = () => {
            const delay = Math.round(fetchIntervalMs * (0.85 + Math.random() * 0.3)); // jitter
            const t = setTimeout(() => {
                withEnlistmentLock(() => { store.tick(); })
                    .then(() => console.log("[git-repo-worker] devbox fetch tick ok"))
                    .catch((e) => console.warn(`[git-repo-worker] devbox fetch tick failed (continuing): ${e?.message ?? e}`))
                    .finally(scheduleTick);
            }, delay);
            t.unref?.();
        };
        scheduleTick();
        console.log(`[git-repo-worker] devbox background fetch every ~${Math.round(fetchIntervalMs / 1000)}s`);
    }

    // Repo-stored MCP servers from the worktree's .vscode/mcp.json (same as mirror mode).
    if (!["0", "false", "off", "no"].includes((process.env.REPO_MCP_ENABLED || "").trim().toLowerCase())) {
        try {
            repoMcpServers = loadRepoMcpConfig(enlistmentDir, {
                remoteOnly: !["0", "false", "off", "no"].includes((process.env.REPO_MCP_REMOTE_ONLY || "").trim().toLowerCase()),
                allow: (process.env.REPO_MCP_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean),
                credentialedNuGetFeeds: process.platform === "win32"
                    ? (process.env.ADO_NUGET_FEED_URLS || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean)
                    : [],
                trace: (m) => console.log(m),
            });
            const names = Object.keys(repoMcpServers);
            console.log(names.length > 0
                ? `[git-repo-worker] repo MCP servers (every-session): ${names.join(", ")}`
                : `[git-repo-worker] no repo MCP servers loaded from ${enlistmentDir}/.vscode/mcp.json`);
        } catch (err) {
            console.warn(`[git-repo-worker] repo MCP load error (continuing): ${err?.message ?? err}`);
        }
    }

    console.log(`[git-repo-worker] devbox worktree: ${enlistmentDir} (shared store ${sharedStore}; reconcile-before-job; clean=${cleanEachJob})`);
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

// PluginSpec: deployment-configured external plugin sources (';'-delimited).
// Each entry (e.g. "ado-git:<org>/<project>/<repo>:plugins/<name>") is
// downloaded to local pod storage and appended to pluginDirs, so the GHCP
// SDK loads its agents/skills like any other plugin dir. Per-entry failures are
// quarantined and never block worker startup. Accepts PLUGIN_SPEC or PluginSpec.
// ADO PAT (Code:Read + Packaging:Read) — resolved ONCE at boot from a direct
// ADO_PAT env, else from Key Vault via the worker's managed identity (no PAT in
// a k8s Secret). Reused by BOTH PluginSpec ADO git clones and the NuGet feed
// auth below.
async function resolveAdoPat() {
    let pat = process.env.ADO_PAT?.trim() || undefined;
    if (!pat) {
        const kvUri = process.env.ADO_PAT_KEYVAULT_SECRET_URI?.trim();
        if (kvUri) {
            try {
                const u = new URL(kvUri);
                const vaultName = u.hostname.split(".")[0];
                const secretName = decodeURIComponent((u.pathname.match(/\/secrets\/([^/]+)/) || [])[1] || "");
                if (!vaultName || !secretName) throw new Error(`malformed ADO_PAT_KEYVAULT_SECRET_URI: ${kvUri}`);
                pat = await fetchKeyVaultSecret({ vaultName, secretName, trace: (m) => console.log(m) });
                console.log(`[git-repo-worker] ADO PAT resolved from Key Vault ${vaultName}/${secretName}`);
            } catch (err) {
                console.warn(`[git-repo-worker] Key Vault PAT fetch failed (continuing without ADO auth): ${err?.message ?? err}`);
            }
        }
    }
    return pat;
}

// NuGet feed auth (Windows only): some repo-declared stdio MCP servers launch a
// .NET tool via `dnx` that restores from
// a PRIVATE Azure DevOps Artifacts feed. `dnx` reads NuGet credentials from the
// user-level NuGet.Config, so — mirroring how PluginSpec authenticates git
// clones — write that file at boot with the same ADO PAT (never baked into the
// image). Feed URL(s) come from ADO_NUGET_FEED_URLS (';'- or ','-delimited).
//
// LOCAL_NUGET_SOURCE_DIRS (';'- or ','-delimited absolute paths) additionally
// registers local FOLDER package sources. A directory source needs no
// credentials, so these are honored even without a feed or PAT — letting an
// operator sideload a locally-built .NET tool (a `.nupkg` staged on the image
// or a mounted volume) for validation without publishing it to a feed. An
// unpinned `dnx <tool>` then resolves the highest version across all sources,
// so a locally-staged build with a higher version wins over the feed.
//
// No-op off Windows, or when neither ADO_NUGET_FEED_URLS nor
// LOCAL_NUGET_SOURCE_DIRS is set.
async function writeNuGetAuthConfig(pat) {
    if (process.platform !== "win32") return;
    const feeds = (process.env.ADO_NUGET_FEED_URLS || "")
        .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    const localDirs = (process.env.LOCAL_NUGET_SOURCE_DIRS || "")
        .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    if (feeds.length === 0 && localDirs.length === 0) return;
    const credentialedFeeds = pat ? feeds : [];
    if (feeds.length > 0 && !pat) {
        console.warn("[git-repo-worker] NuGet auth: ADO_NUGET_FEED_URLS set but no ADO PAT resolved — credentialed feeds skipped");
    }
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const sources = [];
    const creds = [];
    credentialedFeeds.forEach((url, i) => {
        const key = `ado_feed_${i}`;
        sources.push(`    <add key="${key}" value="${esc(url)}" />`);
        creds.push(`    <${key}>\n      <add key="Username" value="pat" />\n      <add key="ClearTextPassword" value="${esc(pat)}" />\n    </${key}>`);
    });
    localDirs.forEach((dir, i) => {
        sources.push(`    <add key="local_src_${i}" value="${esc(dir)}" />`);
    });
    const credsXml = creds.length > 0
        ? `  <packageSourceCredentials>\n${creds.join("\n")}\n  </packageSourceCredentials>\n`
        : "";
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n  <packageSources>\n${sources.join("\n")}\n  </packageSources>\n${credsXml}</configuration>\n`;
    const cfgDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "NuGet");
    const cfgPath = path.join(cfgDir, "NuGet.Config");
    try {
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.writeFileSync(cfgPath, xml);
        console.log(`[git-repo-worker] NuGet auth: wrote ${credentialedFeeds.length} credentialed feed(s)`
            + (localDirs.length ? ` + ${localDirs.length} local source(s)` : "") + ` to ${cfgPath}`);
    } catch (err) {
        console.warn(`[git-repo-worker] NuGet auth: failed to write ${cfgPath} (continuing): ${err?.message ?? err}`);
    }
}

// Resolve the ADO PAT once, then wire NuGet feed auth (Windows worker + a
// configured private feed) so repo stdio MCP servers that `dnx`-restore a .NET
// tool from that feed can authenticate.
const adoPat = await resolveAdoPat();
await writeNuGetAuthConfig(adoPat);

// Repo-declared stdio MCP servers authenticate to Azure DevOps via the standard
// `az devops` CLI variable (AZURE_DEVOPS_EXT_PAT). Surface the already-resolved
// PAT under that name so such a server, spawned as a child of this worker, can
// authenticate non-interactively. Windows-only (matches the NuGet auth wiring
// above); no-op when no PAT resolved.
if (process.platform === "win32" && adoPat) {
    process.env.AZURE_DEVOPS_EXT_PAT = adoPat;
}

const pluginSpec = process.env.PLUGIN_SPEC ?? process.env.PluginSpec;
if (pluginSpec && pluginSpec.trim()) {
    const cacheDir = process.env.PLUGIN_SPEC_CACHE_DIR
        || path.join(process.env.HOME || "/home/node", ".copilot", "plugin-spec");
    console.log(`[git-repo-worker] PluginSpec: loading external plugins (cacheDir=${cacheDir})`);
    const t0 = Date.now();

    // ADO clones need a Code:Read credential — resolved once at boot into adoPat
    // (direct env or Key Vault via the worker's managed identity).
    try {
        const { pluginDirs: specDirs, results } = await installPluginSpecs({
            spec: pluginSpec,
            cacheDir,
            adoPat,
            githubToken: process.env.GITHUB_TOKEN || undefined,
            trace: (m) => console.log(m),
        });
        for (const dir of specDirs) pluginDirs.push(dir);
        const failed = results.filter((r) => r.status === "error");
        console.log(
            `[git-repo-worker] PluginSpec: ${specDirs.length} resolved, ${failed.length} failed ` +
            `in ${Date.now() - t0}ms; pluginDirs now ${pluginDirs.length}`,
        );
        for (const dir of specDirs) console.log(`[git-repo-worker] PluginSpec dir: ${dir}`);
        for (const f of failed) console.warn(`[git-repo-worker] PluginSpec entry failed: ${f.entry.raw} — ${f.error}`);
    } catch (err) {
        console.warn(`[git-repo-worker] PluginSpec install error (continuing): ${err?.message ?? err}`);
    }
}

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
    blobUseManagedIdentity: process.env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY?.trim()
        ? ["1", "true", "yes", "on"].includes(
            process.env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY.trim().toLowerCase(),
        )
        : undefined,
    sessionStateDir: process.env.SESSION_STATE_DIR || undefined,
    modelProvidersPath: process.env.PS_MODEL_PROVIDERS_PATH || process.env.MODEL_PROVIDERS_PATH || undefined,
    workerNodeId: podName,
    systemMessage: SYSTEM_MESSAGE,
    pluginDirs,
    // Repo-stored MCP servers from the enlistment's .vscode/mcp.json, merged
    // over the fleet-default servers (DEFAULT_MCP_JSON). Direct worker-config
    // mcpServers apply to EVERY session on this (repo-pinned) worker. A repo
    // that declares its OWN server of the same name WINS over the fleet default
    // (e.g. a repo may pin `ado` with a narrower toolset) -- repo spread last.
    mcpServers: mergeMcpServers(defaultMcpServers, repoMcpServers),
    // Pre-turn reconcile (git-hydration MVP): sync the local enlistment from
    // the node-local mirror before each job. Undefined unless a mirror is set.
    beforeRunTurn,
    // Post-turn dehydrate: persist uncommitted git work to durable blobs so it
    // survives a hard cross-pod session move (§8.5). Paired with beforeRunTurn.
    afterRunTurn,
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
// Enlistment is synced and the worker is now polling — advertise Ready.
markReady();
if (worker.loadedAgents.length > 0) {
    console.log(`[git-repo-worker] Agents: ${worker.loadedAgents.map(a => a.name).join(", ")}`);
}

// Graceful drain (lifecycle protocol §3.8): stop fetching, let in-flight turns
// finish and commit within the drain budget, then exit. The pod's
// terminationGracePeriodSeconds must exceed the drain budget.
async function shutdown(signal) {
    console.log(`[git-repo-worker] ${signal} received, draining...`);
    // Flip NotReady before draining so nothing counts us as available while we
    // finish in-flight turns (rolling updates / Endpoints see us leave first).
    clearReady();
    await worker.gracefulShutdown();
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Block forever — worker polls in background.
await new Promise(() => {});
