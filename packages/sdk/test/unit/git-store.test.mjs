/**
 * git-store.test.mjs — unit tests for src/git-store.ts (built to dist/).
 *
 * Fully local: spins up a throwaway bare "origin", an author clone, and a
 * "store" clone in a temp dir. No network, no ADO — so it runs anywhere
 * `git` is on PATH. Proves the Phase-A/Phase-B split, worktree + keepalive
 * lifecycle, and the load-bearing invariant for Shape C: a background fetch is
 * additive and NEVER disturbs a checked-out worktree's HEAD/files.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { makeRunGit, normalizeRef, GitStore, Runner } from "../../dist/git-store.js";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
let tmp, originDir, authorDir, storeDir;
const runGit = makeRunGit();

// Commit a file in the author clone and push main to origin; return the new SHA.
function authorCommit(file, contents) {
    fs.writeFileSync(path.join(authorDir, file), contents);
    execFileSync("git", [...ID, "-C", authorDir, "add", file], { stdio: "pipe" });
    execFileSync("git", [...ID, "-C", authorDir, "commit", "-m", `add ${file}`], { stdio: "pipe" });
    execFileSync("git", ["-C", authorDir, "push", "-q", "origin", "main"], { stdio: "pipe" });
    return execFileSync("git", ["-C", authorDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-test-"));
    originDir = path.join(tmp, "origin.git");
    authorDir = path.join(tmp, "author");
    storeDir = path.join(tmp, "store");

    execFileSync("git", ["init", "--bare", "-b", "main", originDir], { stdio: "pipe" });
    execFileSync("git", ["clone", "-q", originDir, authorDir], { stdio: "pipe" });
    authorCommit("A.txt", "A");                                   // seed origin/main
    execFileSync("git", ["clone", "-q", originDir, storeDir], { stdio: "pipe" });
});

after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("normalizeRef maps bare branches, passes through qualified refs + SHAs", () => {
    assert.equal(normalizeRef("main"), "origin/main");
    assert.equal(normalizeRef("dev/x/y"), "origin/dev/x/y");
    assert.equal(normalizeRef("origin/main"), "origin/main");
    assert.equal(normalizeRef("refs/heads/main"), "refs/heads/main");
    assert.equal(normalizeRef("0123abcd"), "0123abcd");
});

test("GitStore.hasCommit / revParse reflect local object presence", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const shaA = store.revParse("origin/main");
    assert.match(shaA, /^[0-9a-f]{40}$/);
    assert.ok(store.hasCommit(shaA));
    assert.ok(store.hasCommit("origin/main"));
    assert.equal(store.hasCommit("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), false);
});

test("Runner.checkout snaps the working tree to a pinned SHA (Phase B)", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const runner = new Runner({ dir: storeDir, runGit });
    const shaA = store.revParse("origin/main");
    runner.checkout(shaA);
    assert.equal(runner.head(), shaA);
    assert.ok(fs.existsSync(path.join(storeDir, "A.txt")));
});

test("ensureObjects narrow-fetches a missing ref (on-demand miss path)", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const shaB = authorCommit("B.txt", "B");                     // origin advances; store unaware
    assert.equal(store.hasCommit(shaB), false, "precondition: store has not fetched B yet");

    const resolved = store.ensureObjects({ ref: "main" });        // narrow fetch of just main
    assert.equal(resolved, shaB);
    assert.ok(store.hasCommit(shaB), "ensureObjects made B present locally");
});

test("ensureObjects is a no-op when the target SHA is already local", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const shaB = store.revParse("origin/main");
    // Point origin's remote URL at a bogus path: proves NO fetch is attempted.
    const saved = runGit(storeDir, ["remote", "get-url", "origin"]);
    runGit(storeDir, ["remote", "set-url", "origin", path.join(tmp, "does-not-exist.git")]);
    try {
        const resolved = store.ensureObjects({ sha: shaB });      // already present -> no fetch
        assert.equal(resolved, shaB);
    } finally {
        runGit(storeDir, ["remote", "set-url", "origin", saved]);
    }
});

test("addWorktree materializes a detached tree pinned to a SHA", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const shaA = store.revParse("origin/main~1"); // parent of B == A
    const wtDir = path.join(tmp, "wt");
    store.addWorktree(wtDir, shaA);
    assert.equal(runGit(wtDir, ["rev-parse", "HEAD"]), shaA);
    assert.ok(fs.existsSync(path.join(wtDir, "A.txt")));
    assert.equal(fs.existsSync(path.join(wtDir, "B.txt")), false, "worktree pinned at A has no B");
});

test("keep / unkeep manage a session keepalive ref", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const shaA = store.revParse("origin/main~1");
    store.keep("sess-1", shaA);
    assert.equal(store.revParse("refs/pilotswarm/keep/sess-1"), shaA);
    store.unkeep("sess-1");
    assert.equal(store.hasCommit("refs/pilotswarm/keep/sess-1"), false, "keepalive ref removed");
});

test("background tick is additive: a checked-out worktree is NOT disturbed", () => {
    const store = new GitStore({ dir: storeDir, runGit });
    const wtDir = path.join(tmp, "wt-additive");
    const shaB = store.revParse("origin/main");
    store.addWorktree(wtDir, shaB);                               // worktree pinned at B (detached)
    assert.equal(runGit(wtDir, ["rev-parse", "HEAD"]), shaB);

    const shaC = authorCommit("C.txt", "C");                     // origin advances to C
    store.tick();                                                 // additive whole-branch fetch

    assert.ok(store.hasCommit(shaC), "tick brought C into the shared store");
    assert.equal(runGit(wtDir, ["rev-parse", "HEAD"]), shaB, "worktree HEAD unchanged by tick");
    assert.ok(fs.existsSync(path.join(wtDir, "B.txt")));
    assert.equal(fs.existsSync(path.join(wtDir, "C.txt")), false, "tick did not materialize C in the worktree");
});
