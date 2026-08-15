#!/usr/bin/env node

/**
 * Git workspace hydration/dehydration demo — a self-contained, DB-free proof of
 * the base-commit pinning durability guarantee (see
 * docs/architecture/aks-git-hydration.md §8.5).
 *
 * WHAT IT PROVES
 *   A PilotSwarm session pins the commit it started on at turn 0. When the
 *   session pauses and later resumes on a DIFFERENT pod — whose git-cache mirror
 *   has since ADVANCED to newer upstream commits — the resumed working tree must
 *   land back on the PINNED base, never on the moving mirror HEAD. Otherwise a
 *   large upstream change syncing to the mirror between turns could inject a
 *   massive merge/checkout delta mid-session and corrupt the workspace.
 *
 * WHY A STANDALONE SCRIPT
 *   The real reconcile (`reconcileEnlistment` in examples/git-repo-worker.js) is
 *   an internal closure wired to the SDK `beforeRunTurn` hook and backed by
 *   PostgreSQL CMS accessors (getSessionGitState/setSessionGitState). This demo
 *   reimplements the SAME two-phase protocol and the SAME `[git-hydration]` log
 *   lines against throwaway local repos and an in-memory pointer store, so you
 *   can watch the full pin lifecycle with only `node` + `git` installed — no
 *   database, no Kubernetes, no network.
 *
 *   Keep this faithful to git-repo-worker.js: if the reconcile protocol there
 *   changes (phase order, ref resolution, persist shape), update this too.
 *
 * RUN
 *   node examples/git-hydration-demo.js
 *   (exit 0 = pin held across resume AND explicit advance worked; exit 1 = a
 *    durability assertion failed.)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// git helpers — mirror git-repo-worker.js runGit/tryGit exactly.
// ---------------------------------------------------------------------------
const runGit = (cwd, args) => execFileSync("git", ["-c", "safe.bareRepository=all", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        // Deterministic identity so the demo runs on a machine with no global
        // git config (e.g. CI) without prompting or failing the commit.
        GIT_AUTHOR_NAME: "hydration-demo",
        GIT_AUTHOR_EMAIL: "hydration@pilotswarm.local",
        GIT_COMMITTER_NAME: "hydration-demo",
        GIT_COMMITTER_EMAIL: "hydration@pilotswarm.local",
    },
}).trim();
const tryGit = (cwd, args) => { try { return runGit(cwd, args); } catch { return ""; } };

const log = (m) => console.log(m);
const short = (sha) => (sha ? String(sha).slice(0, 12) : "(none)");

// ---------------------------------------------------------------------------
// In-memory CMS stand-in. Same contract as the real PostgreSQL-backed
// getSessionGitState/setSessionGitState the SDK forwards into the hook — a
// per-session durable pointer { baseSha, headSha, branch, epoch }. In prod this
// row survives pod death; here a Map is our "durable" store across simulated
// pods.
// ---------------------------------------------------------------------------
const cms = (() => {
    const rows = new Map();
    const empty = () => ({ baseSha: null, headSha: null, branch: null, epoch: 0 });
    return {
        async getSessionGitState(sessionId) {
            return { ...(rows.get(sessionId) ?? empty()) };
        },
        async setSessionGitState(sessionId, state) {
            const next = {
                baseSha: state?.baseSha ?? null,
                headSha: state?.headSha ?? null,
                branch: state?.branch ?? null,
                epoch: Number.isFinite(state?.epoch) ? Math.trunc(state.epoch) : 0,
            };
            rows.set(sessionId, next);
            return { ...next };
        },
    };
})();

// ---------------------------------------------------------------------------
// The reconcile protocol — a faithful port of reconcileEnlistment from
// git-repo-worker.js (two phases, same log prefix, same pin semantics).
// enlistmentDir stands in for the per-pod working enlistment; each simulated pod
// gets its own clone from the shared mirror.
// ---------------------------------------------------------------------------
async function reconcileEnlistment(enlistmentDir, { gitState, persistGitState } = {}) {
    const t0 = Date.now();

    const incomingPinned = !!(gitState && gitState.baseSha);
    const mode = incomingPinned ? "resume" : (persistGitState ? "pin" : "startup");
    log(
        `[git-hydration] reconcile begin mode=${mode} ` +
        `incoming.base=${gitState?.baseSha ? short(gitState.baseSha) : "(unpinned)"} ` +
        `incoming.head=${gitState?.headSha ? short(gitState.headSha) : "(none)"} ` +
        `incoming.branch=${gitState?.branch ?? "(default)"} incoming.epoch=${gitState?.epoch ?? 0} ` +
        `enlistment=${enlistmentDir}`,
    );

    const headBefore = tryGit(enlistmentDir, ["rev-parse", "HEAD"]);
    const dirtyBefore = tryGit(enlistmentDir, ["status", "--porcelain"]);
    if (headBefore) {
        log(`[git-hydration] pod tree before: head=${short(headBefore)} dirty=${dirtyBefore ? "yes" : "no"}`);
        if (dirtyBefore) {
            const lines = dirtyBefore.split("\n").filter(Boolean);
            log(`[git-hydration] WARN discarding ${lines.length} uncommitted path(s) on hydrate: ${lines.slice(0, 5).join(" | ")}${lines.length > 5 ? " …" : ""}`);
        }
    }

    // Phase A — objects. Local fetch from the mirror; append-only, never touches
    // the tree. We log mirror movement so a "why did my tree not advance?" is
    // answered by the very next line (pin held it back).
    const fetchStart = Date.now();
    const mirrorHeadBefore = tryGit(enlistmentDir, ["rev-parse", "origin/HEAD"]);
    runGit(enlistmentDir, ["fetch", "--prune", "--no-write-fetch-head", "origin"]);
    const mirrorHeadAfter = tryGit(enlistmentDir, ["rev-parse", "origin/HEAD"]);
    const mirrorMoved = mirrorHeadBefore && mirrorHeadAfter && mirrorHeadBefore !== mirrorHeadAfter;
    log(
        `[git-hydration] phase A fetch done in ${Date.now() - fetchStart}ms ` +
        `mirror.head=${mirrorHeadAfter ? short(mirrorHeadAfter) : "(unknown)"}` +
        (mirrorMoved ? ` (mirror ADVANCED from ${short(mirrorHeadBefore)} — pin will hold tree back)` : ""),
    );

    // Resolve the PINNED base this reconcile resets onto.
    let baseSha = gitState?.baseSha || null;
    if (!baseSha) {
        const ref = tryGit(enlistmentDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) || "origin/main";
        baseSha = runGit(enlistmentDir, ["rev-parse", ref]);
        log(`[git-hydration] unpinned: resolved moving ref ${ref} -> ${short(baseSha)} (frozen once)`);
        if (persistGitState) {
            const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
            await persistGitState({ baseSha, headSha: null, branch, epoch: gitState?.epoch ?? 0 });
            log(`[git-hydration] pinned session base -> ${short(baseSha)} branch=${branch} (ref=${ref}) — persisted`);
        } else {
            log(`[git-hydration] startup prep (no session) — tree tracks live mirror, no pin persisted`);
        }
    } else {
        log(`[git-hydration] resume: honoring pinned base ${short(baseSha)} (ignoring mirror.head)`);
    }

    // Phase B — working tree. Detached reset onto the pinned base.
    const heldBack = headBefore && mirrorHeadAfter && headBefore !== baseSha && mirrorHeadAfter === headBefore;
    log(`[git-hydration] phase B reset ${headBefore ? short(headBefore) : "(empty)"} -> ${short(baseSha)} (worker UNAVAILABLE)`);
    runGit(enlistmentDir, ["checkout", "--force", "--detach", baseSha]);
    runGit(enlistmentDir, ["reset", "--hard", baseSha]);
    const headAfter = tryGit(enlistmentDir, ["rev-parse", "HEAD"]);
    log(
        `[git-hydration] reconcile end mode=${mode} tree=${short(headAfter || baseSha)} ` +
        `in ${Date.now() - t0}ms (READY)` +
        (heldBack ? " — PIN HELD (tree kept off advanced mirror.head)" : ""),
    );
    return headAfter || baseSha;
}

// The SDK cold-turn wiring, replicated: read the pointer, log it, and hand the
// hook a durable persist callback. Mirrors session-proxy.ts runTurn.
async function runColdTurn(sessionId, enlistmentDir, turnIndex) {
    const gitState = await cms.getSessionGitState(sessionId);
    log(
        `[runTurn][git] hydrate pointer read session=${sessionId} turn=${turnIndex} ` +
        `pinned=${gitState?.baseSha ? "yes" : "no"} base=${gitState?.baseSha ? short(gitState.baseSha) : "(unpinned)"} ` +
        `head=${gitState?.headSha ? short(gitState.headSha) : "(none)"} branch=${gitState?.branch ?? "(default)"} epoch=${gitState?.epoch ?? 0}`,
    );
    const persistGitState = async (state) => {
        log(
            `[runTurn][git] persist pointer session=${sessionId} turn=${turnIndex} ` +
            `base=${state?.baseSha ? short(state.baseSha) : "(null)"} head=${state?.headSha ? short(state.headSha) : "(none)"} ` +
            `branch=${state?.branch ?? "(default)"} epoch=${state?.epoch ?? 0}`,
        );
        await cms.setSessionGitState(sessionId, state);
    };
    return reconcileEnlistment(enlistmentDir, { gitState, persistGitState });
}

// ---------------------------------------------------------------------------
// Scenario harness — build a bare "mirror", let pods clone from it, and advance
// the mirror between turns to simulate upstream sync.
// ---------------------------------------------------------------------------
function commitTo(worktreeDir, file, contents, message) {
    fs.writeFileSync(path.join(worktreeDir, file), contents);
    runGit(worktreeDir, ["add", "-A"]);
    runGit(worktreeDir, ["commit", "-m", message]);
    return runGit(worktreeDir, ["rev-parse", "HEAD"]);
}

function assert(cond, message) {
    if (!cond) {
        log(`\n❌ ASSERTION FAILED: ${message}`);
        process.exitCode = 1;
        throw new Error(message);
    }
    log(`✅ ${message}`);
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-git-hydration-"));
    log(`[demo] scratch root: ${root}\n`);

    // --- Build an "upstream" repo and push it into a bare MIRROR ------------
    const upstream = path.join(root, "upstream");
    fs.mkdirSync(upstream, { recursive: true });
    runGit(upstream, ["init", "-q", "-b", "main"]);
    const shaA = commitTo(upstream, "app.txt", "v1 — the commit the session starts on\n", "commit A (base)");
    log(`[demo] upstream commit A = ${short(shaA)}`);

    const mirror = path.join(root, "mirror.git");
    runGit(root, ["clone", "--quiet", "--bare", upstream, mirror]);
    // Give the bare mirror an origin/HEAD-style default so resolveTargetRef works
    // against it once pods clone from it.
    runGit(mirror, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    log(`[demo] mirror created at ${mirror}\n`);

    const sessionId = "sess-hydration-demo";

    // === TURN 0 on POD A: pin the base ====================================
    log("=== TURN 0 (pod A): fresh session pins its base commit ===");
    const podA = path.join(root, "pod-a-enlistment");
    runGit(root, ["clone", "--quiet", "--no-hardlinks", mirror, podA]);
    const treeAfterTurn0 = await runColdTurn(sessionId, podA, 0);
    assert(treeAfterTurn0 === shaA, `turn 0 tree is base A (${short(shaA)})`);
    const pinned = await cms.getSessionGitState(sessionId);
    assert(pinned.baseSha === shaA, `CMS pointer pinned to A (${short(shaA)})`);
    assert(pinned.branch === "main", `CMS pointer recorded branch=main`);
    log("");

    // === Upstream advances; mirror syncs it (the corruption risk) ==========
    log("=== Between turns: a large upstream change lands and syncs to the mirror ===");
    const shaB = commitTo(upstream, "app.txt", "v2 — a big upstream change that must NOT be injected mid-session\n", "commit B (upstream advance)");
    runGit(upstream, ["update-server-info"]);
    runGit(mirror, ["fetch", "--prune", upstream, "main:main"]);
    log(`[demo] mirror now points at B = ${short(shaB)} (session must stay on A)\n`);

    // === RESUME on POD B: different pod, advanced mirror ===================
    log("=== RESUME (pod B): session resumes on a different pod whose mirror already advanced ===");
    const podB = path.join(root, "pod-b-enlistment");
    runGit(root, ["clone", "--quiet", "--no-hardlinks", mirror, podB]);
    const mirrorHeadOnB = tryGit(podB, ["rev-parse", "origin/HEAD"]);
    assert(mirrorHeadOnB === shaB, `pod B mirror.head is the advanced commit B (${short(shaB)})`);
    const treeAfterResume = await runColdTurn(sessionId, podB, 1);
    assert(treeAfterResume === shaA, `RESUME tree HELD at pinned base A (${short(shaA)}), NOT mirror B (${short(shaB)})`);
    log("");

    // === EXPLICIT ADVANCE: session/user chooses to move forward to B =======
    log("=== EXPLICIT ADVANCE: the session deliberately advances its pin to B ===");
    await cms.setSessionGitState(sessionId, { baseSha: shaB, headSha: null, branch: "main", epoch: 1 });
    log(`[demo] session advanced its durable pointer -> ${short(shaB)} (epoch 1)`);
    const treeAfterAdvance = await runColdTurn(sessionId, podB, 2);
    assert(treeAfterAdvance === shaB, `after explicit advance, tree moves to B (${short(shaB)})`);
    log("");

    log("🎉 All hydration durability assertions passed.");
    log(`   • turn 0 pinned base A across a fresh session`);
    log(`   • resume on a different pod HELD the pin despite an advanced mirror`);
    log(`   • an explicit pointer advance moved the tree forward on demand`);

    // Best-effort cleanup of the scratch tree.
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* leave it for inspection */ }
}

main().catch((err) => {
    log(`\n[demo] FAILED: ${err?.stack ?? err}`);
    process.exitCode = process.exitCode || 1;
});
