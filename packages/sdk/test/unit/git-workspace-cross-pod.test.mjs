// End-to-end, user-perspective test for the git-state dehydrate/hydrate protocol
// (§8.5 of docs/architecture/aks-git-hydration.md), tracked in ADO 5518357.
//
// THE USER-VISIBLE PROPERTY UNDER TEST:
//   A session does work on Pod A (edits, a new file, maybe a commit that was
//   never pushed), then the session is moved to a *fresh* Pod B (cold, cross-pod
//   resume). None of that work may be lost — Pod B's working tree must end up
//   byte-identical to what the user had on Pod A.
//
// This is deliberately a black-box, two-enlistment integration test:
//   * Pod A and Pod B are SEPARATE working directories cloned from a shared
//     bare "origin" (the git-cache mirror stand-in). Pod B has no knowledge of
//     Pod A's tree — the ONLY thing they share is the durable layer.
//   * The durable layer = an in-memory blob store + a single git-state row,
//     both persisting across the pod boundary (exactly what blob storage + the
//     CMS git-state row give us in production).
//   * Real `git` is shelled out on both sides, so the test proves the actual
//     bundle/patch bytes survive and replay — not a mock of them.
//
// It drives the SDK protocol module `dist/git-workspace.js`
// (hydrateGitWorkspace / dehydrateGitWorkspace). That module does not exist yet
// — this test is the RED spec that defines its contract (TDD).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hydrateGitWorkspace, dehydrateGitWorkspace } from "../../dist/git-workspace.js";

// --- hermetic git config ---------------------------------------------------
// Pin a private global/system git config for the WHOLE process (harness AND the
// module's own spawned git), so results don't depend on the developer's machine.
// This neutralizes `core.autocrlf` (which would otherwise corrupt line endings
// during `git clone` checkout before configRepo runs) and `safe.bareRepository`
// (which defaults to 'explicit' on some boxes and blocks bare-origin ops).
const HERMETIC_GIT_CONFIG = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-gitcfg-")),
    "gitconfig",
);
fs.writeFileSync(
    HERMETIC_GIT_CONFIG,
    "[core]\n\tautocrlf = false\n\teol = lf\n[safe]\n\tbareRepository = all\n\tdirectory = *\n",
);
process.env.GIT_CONFIG_GLOBAL = HERMETIC_GIT_CONFIG;
process.env.GIT_CONFIG_SYSTEM = HERMETIC_GIT_CONFIG;

// --- test-local git helper (mirrors the worker's runGit) -------------------
const git = (cwd, args) =>
    execFileSync("git", ["-c", "safe.bareRepository=all", ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();

// Deterministic, hermetic identity/format for every repo we touch.
const configRepo = (dir) => {
    git(dir, ["config", "user.email", "podtest@example.invalid"]);
    git(dir, ["config", "user.name", "Pod Test"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    git(dir, ["config", "core.autocrlf", "false"]);
};

// --- durable layer shared across the pod boundary --------------------------
// In production these are Azure blob storage (session-scoped, overwrite-in-place)
// and the CMS session_git_state row. Here they are plain in-memory objects that
// BOTH pods reference, which is the whole point: it's the only channel between
// a dying Pod A and a fresh Pod B.
function makeDurable() {
    const blobs = new Map(); // kind -> Buffer
    const cell = { row: null }; // GitWorkspaceState | null
    return {
        blobs: {
            async get(kind) {
                return blobs.has(kind) ? Buffer.from(blobs.get(kind)) : null;
            },
            async put(kind, data) {
                blobs.set(kind, Buffer.from(data));
            },
        },
        state: {
            async get() {
                return cell.row ? { ...cell.row } : null;
            },
            async set(next) {
                cell.row = { ...next };
            },
        },
        _blobs: blobs,
        _cell: cell,
    };
}

// --- scaffolding: a bare origin seeded with one commit on `main` -----------
function makeWorld(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pilotswarm-gitws-${label}-`));
    const originDir = path.join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", originDir], { stdio: "ignore" });

    // Seed the origin with README = "line1\n" on main via a throwaway clone.
    const seedDir = path.join(root, "seed");
    execFileSync("git", ["clone", originDir, seedDir], { stdio: "ignore" });
    configRepo(seedDir);
    fs.writeFileSync(path.join(seedDir, "README.md"), "line1\n");
    git(seedDir, ["add", "README.md"]);
    git(seedDir, ["commit", "-m", "seed"]);
    git(seedDir, ["push", "origin", "main"]);
    // Make origin/HEAD resolvable so targetRef auto-resolution works.
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    return { root, originDir };
}

// Clone a fresh enlistment for a pod off the shared origin (the mirror stand-in).
function clonePod(originDir, root, name) {
    const dir = path.join(root, name);
    execFileSync("git", ["clone", originDir, dir], { stdio: "ignore" });
    configRepo(dir);
    return dir;
}

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Test 1 — THE core user scenario: purely uncommitted work (no commit at all).
// User edits a tracked file and drops a new untracked file, never commits, and
// the session is moved. Both must survive.
// ---------------------------------------------------------------------------
test("uncommitted edits + untracked file survive a cold cross-pod move", async () => {
    const { root, originDir } = makeWorld("uncommitted");
    try {
        const durable = makeDurable();

        // ---- Pod A: cold turn 0 -> pin base, then the user does work --------
        const podA = clonePod(originDir, root, "podA");
        const h0 = await hydrateGitWorkspace({
            enlistmentDir: podA,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(h0.mode, "pinned-base", "first hydrate on an empty row pins the base");

        // The user's uncommitted work.
        fs.appendFileSync(path.join(podA, "README.md"), "line2-uncommitted\n");
        fs.writeFileSync(path.join(podA, "notes.txt"), "scratch\n"); // untracked

        await dehydrateGitWorkspace({
            enlistmentDir: podA,
            blobs: durable.blobs,
            state: durable.state,
        });

        // ---- Pod B: fresh enlistment, cold resume ---------------------------
        const podB = clonePod(originDir, root, "podB");
        // Sanity: the fresh clone starts WITHOUT the user's work.
        assert.equal(fs.readFileSync(path.join(podB, "README.md"), "utf8"), "line1\n");
        assert.ok(!fs.existsSync(path.join(podB, "notes.txt")));

        const h1 = await hydrateGitWorkspace({
            enlistmentDir: podB,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(h1.mode, "replayed", "second pod replays the dehydrated workspace");

        // ---- The property: nothing was lost ---------------------------------
        assert.equal(
            fs.readFileSync(path.join(podB, "README.md"), "utf8"),
            "line1\nline2-uncommitted\n",
            "uncommitted tracked edit replayed on the new pod",
        );
        assert.equal(
            fs.readFileSync(path.join(podB, "notes.txt"), "utf8"),
            "scratch\n",
            "untracked file replayed on the new pod",
        );
        assert.equal(git(podB, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    } finally {
        rmrf(root);
    }
});

// ---------------------------------------------------------------------------
// Test 2 — committed-but-unpushed work + uncommitted work on top. The commit
// only exists locally on Pod A (never pushed to origin), so it is just as lost
// on a naive move as the uncommitted edits. All three must survive.
// ---------------------------------------------------------------------------
test("local commit + edits on top survive a cold cross-pod move", async () => {
    const { root, originDir } = makeWorld("committed");
    try {
        const durable = makeDurable();

        const podA = clonePod(originDir, root, "podA");
        await hydrateGitWorkspace({
            enlistmentDir: podA,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });

        // A local commit that never reached origin.
        fs.writeFileSync(path.join(podA, "feature.txt"), "feature-body\n");
        git(podA, ["add", "feature.txt"]);
        git(podA, ["commit", "-m", "local: add feature"]);
        // Plus uncommitted work layered on the commit.
        fs.appendFileSync(path.join(podA, "README.md"), "line2-uncommitted\n");
        fs.writeFileSync(path.join(podA, "notes.txt"), "scratch\n");

        await dehydrateGitWorkspace({
            enlistmentDir: podA,
            blobs: durable.blobs,
            state: durable.state,
        });

        const podB = clonePod(originDir, root, "podB");
        // Fresh clone has none of it.
        assert.ok(!fs.existsSync(path.join(podB, "feature.txt")));
        const logBefore = git(podB, ["log", "--oneline"]);
        assert.ok(!/add feature/.test(logBefore), "origin never saw the local commit");

        const h = await hydrateGitWorkspace({
            enlistmentDir: podB,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        assert.equal(h.mode, "replayed");

        // The local commit came back...
        const logAfter = git(podB, ["log", "--oneline"]);
        assert.ok(/add feature/.test(logAfter), "unpushed local commit replayed on the new pod");
        assert.equal(
            fs.readFileSync(path.join(podB, "feature.txt"), "utf8"),
            "feature-body\n",
            "committed file content replayed",
        );
        // ...and the uncommitted work layered on top came back.
        assert.equal(
            fs.readFileSync(path.join(podB, "README.md"), "utf8"),
            "line1\nline2-uncommitted\n",
            "uncommitted edit on top of the local commit replayed",
        );
        assert.equal(fs.readFileSync(path.join(podB, "notes.txt"), "utf8"), "scratch\n");
        assert.equal(git(podB, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    } finally {
        rmrf(root);
    }
});

// ---------------------------------------------------------------------------
// Test 3 — negative / no-work path: a session that did nothing must resume to a
// clean base with NO fabricated changes (the protocol must not invent diffs).
// ---------------------------------------------------------------------------
test("a session with no work resumes to a clean base with no spurious changes", async () => {
    const { root, originDir } = makeWorld("noop");
    try {
        const durable = makeDurable();

        const podA = clonePod(originDir, root, "podA");
        await hydrateGitWorkspace({
            enlistmentDir: podA,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });
        // No work at all.
        await dehydrateGitWorkspace({
            enlistmentDir: podA,
            blobs: durable.blobs,
            state: durable.state,
        });

        const podB = clonePod(originDir, root, "podB");
        await hydrateGitWorkspace({
            enlistmentDir: podB,
            blobs: durable.blobs,
            state: durable.state,
            targetRef: "origin/main",
        });

        assert.equal(fs.readFileSync(path.join(podB, "README.md"), "utf8"), "line1\n");
        assert.ok(!fs.existsSync(path.join(podB, "notes.txt")));
        assert.equal(git(podB, ["status", "--porcelain"]), "", "working tree is clean, no invented diffs");
    } finally {
        rmrf(root);
    }
});
