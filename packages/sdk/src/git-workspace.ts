// Git-state dehydrate/hydrate protocol (§8.5 of docs/architecture/aks-git-hydration.md).
//
// GHCP SDK session state (transcript, KV, snapshots) is durably persisted, but a
// session's *git working tree* — local commits that were never pushed, staged /
// unstaged edits, and untracked files — lives only on the pod that produced it.
// On a cold cross-pod resume that pod is gone, so without this protocol the
// user's uncommitted work is silently lost.
//
// This module makes that work durable and portable through two pure-ish
// operations that shell out to real `git` and read/write an injected durable
// layer (blob storage + the CMS git-state row):
//
//   dehydrateGitWorkspace  — end of every turn. Captures base..HEAD commits as a
//       git bundle, uncommitted tracked+untracked changes as a single patch, and
//       a meta record; writes all blobs FIRST, then the git-state row LAST (the
//       row is the commit point).
//   hydrateGitWorkspace    — start of a cold turn. Pins the base on turn 0;
//       thereafter resets to the pinned base and, when a complete dehydrate
//       exists for the committed epoch, replays the bundle + patch so the new
//       pod's working tree matches what the user last had.
//
// The worker's beforeRunTurn / afterRunTurn hooks are thin callers of these; the
// logic lives here so it is unit-testable against two real enlistments sharing
// one in-memory durable layer (see test/unit/git-workspace-cross-pod.test.mjs).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GitWorkspaceState } from "./types.js";
import type { GitWorkspaceBlobKind } from "./blob-store.js";

/**
 * Durable, session-scoped blob accessor for the three git-workspace artifacts
 * (bundle / patch / meta). Overwrite-in-place; `get` returns `null` when absent.
 * In production this is backed by {@link SessionBlobStore.getGitWorkspaceBlob} /
 * {@link SessionBlobStore.putGitWorkspaceBlob}.
 */
export interface GitBlobIO {
    get(kind: GitWorkspaceBlobKind): Promise<Buffer | null>;
    put(kind: GitWorkspaceBlobKind, data: Buffer): Promise<void>;
}

/**
 * Durable accessor for the session's git-state row (the commit point). In
 * production this maps to the CMS `getSessionGitState` / `setSessionGitState`.
 */
export interface GitStateIO {
    get(): Promise<GitWorkspaceState | null>;
    set(next: GitWorkspaceState): Promise<void>;
}

/** Meta record persisted alongside the bundle/patch blobs (the `.git.meta.json`). */
export interface GitWorkspaceMeta {
    branch: string;
    baseSha: string;
    headSha: string;
    epoch: number;
    hasBundle: boolean;
    hasPatch: boolean;
}

export interface HydrateOptions {
    /** Working enlistment to hydrate into. */
    enlistmentDir: string;
    blobs: GitBlobIO;
    state: GitStateIO;
    /** Base ref to pin on turn 0 (e.g. "origin/main"). Auto-resolved when omitted. */
    targetRef?: string;
    trace?: (message: string) => void;
}

export interface HydrateResult {
    /** `pinned-base` = turn 0 pin; `replayed` = dehydrated work restored; `base-only` = pinned but nothing (complete) to replay. */
    mode: "pinned-base" | "replayed" | "base-only";
    baseSha: string;
    headSha: string;
    epoch: number;
}

export interface DehydrateOptions {
    enlistmentDir: string;
    blobs: GitBlobIO;
    state: GitStateIO;
    trace?: (message: string) => void;
}

export interface DehydrateResult {
    epoch: number;
    headSha: string;
    branch: string;
    baseSha: string;
}

const MAX_GIT_BUFFER = 512 * 1024 * 1024; // 512 MiB — bundles/patches can be large.

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/** Run git, returning trimmed stdout as a string (for control/query commands). */
function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: gitEnv(),
        maxBuffer: MAX_GIT_BUFFER,
    }).trim();
}

/** Run git, returning raw stdout bytes (for byte-exact capture: diffs, bundles). */
function gitBuf(cwd: string, args: string[]): Buffer {
    return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv(),
        maxBuffer: MAX_GIT_BUFFER,
    }) as Buffer;
}

/** Run git feeding `input` on stdin (for `git apply`). */
function gitInput(cwd: string, args: string[], input: Buffer): void {
    execFileSync("git", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: gitEnv(),
        input,
        maxBuffer: MAX_GIT_BUFFER,
    });
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
            cwd,
            stdio: "ignore",
            env: gitEnv(),
        });
        return true;
    } catch {
        return false;
    }
}

function objectExists(cwd: string, sha: string): boolean {
    try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore", env: gitEnv() });
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve the base ref to pin. Explicit `targetRef` wins; otherwise the mirror's
 * default branch (origin/HEAD), falling back to origin/main then origin/master.
 */
function resolveTargetRef(cwd: string, explicit?: string): string {
    if (explicit) return explicit;
    try {
        return git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    } catch {
        for (const b of ["origin/main", "origin/master"]) {
            try {
                git(cwd, ["rev-parse", "--verify", b]);
                return b;
            } catch {
                /* try next */
            }
        }
        throw new Error("git-workspace: could not resolve a default ref (pass targetRef)");
    }
}

/** "origin/main" -> "main"; "refs/remotes/origin/feat/x" -> "feat/x"; "main" -> "main". */
function branchFromRef(ref: string): string {
    const stripped = ref.replace(/^refs\/remotes\//, "");
    const m = stripped.match(/^[^/]+\/(.+)$/);
    return m ? m[1] : stripped;
}

function tmpFile(suffix: string): string {
    const rand = Math.random().toString(36).slice(2);
    return path.join(os.tmpdir(), `pilotswarm-gitws-${process.pid}-${Date.now()}-${rand}${suffix}`);
}

/** Put the enlistment on `branch` at `sha` with a clean tree. */
function checkoutBranchAt(cwd: string, branch: string, sha: string): void {
    git(cwd, ["checkout", "-B", branch, sha]);
    git(cwd, ["reset", "--hard", sha]);
}

/**
 * Hydrate the enlistment for a (cold) turn. See module header. Turn 0 pins the
 * base and stops; later cold resumes reset to the pinned base and replay the
 * dehydrated bundle + patch when a complete dehydrate exists for the committed
 * epoch (torn writes — meta epoch ahead of the row — are ignored, never applied).
 */
export async function hydrateGitWorkspace(opts: HydrateOptions): Promise<HydrateResult> {
    const { enlistmentDir: dir, blobs, state, targetRef, trace } = opts;
    const log = (m: string) => trace?.(m);

    const row = await state.get();

    // --- Turn 0 (or an unpinned row): pin the base and stop. -----------------
    if (!row || !row.baseSha) {
        try {
            git(dir, ["fetch", "--prune", "--no-write-fetch-head", "origin"]);
        } catch {
            /* offline / already synced — the ref may still resolve locally */
        }
        const ref = resolveTargetRef(dir, targetRef);
        const baseSha = git(dir, ["rev-parse", ref]);
        const branch = branchFromRef(ref);
        checkoutBranchAt(dir, branch, baseSha);
        const pinned: GitWorkspaceState = { baseSha, headSha: baseSha, branch, epoch: 0 };
        await state.set(pinned);
        log(`[git-workspace] pinned base ${baseSha.slice(0, 12)} on ${branch} (turn 0)`);
        return { mode: "pinned-base", baseSha, headSha: baseSha, epoch: 0 };
    }

    // --- Pinned session: reset to base, then replay if a complete dehydrate exists.
    const baseSha = row.baseSha;
    try {
        git(dir, ["fetch", "--prune", "--no-write-fetch-head", "origin"]);
    } catch {
        /* base is expected to already be present locally */
    }
    const fallbackBranch = row.branch ?? branchFromRef(resolveTargetRef(dir, targetRef));
    checkoutBranchAt(dir, fallbackBranch, baseSha);

    const metaBuf = await blobs.get("meta");
    if (!metaBuf) {
        log(`[git-workspace] pinned base ${baseSha.slice(0, 12)}, no dehydrate to replay (base-only)`);
        return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
    }

    let meta: GitWorkspaceMeta;
    try {
        meta = JSON.parse(metaBuf.toString("utf8")) as GitWorkspaceMeta;
    } catch (err) {
        log(`[git-workspace] meta blob unparseable (${(err as Error)?.message}); base-only`);
        return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
    }

    // Torn-write guard: the row is the commit point (written last). Only trust the
    // blobs when meta's epoch matches the row's; a meta ahead of the row means the
    // dehydrate crashed after the blobs but before the row — ignore it.
    if (meta.epoch !== row.epoch) {
        log(`[git-workspace] meta epoch ${meta.epoch} != row epoch ${row.epoch}; ignoring partial dehydrate (base-only)`);
        return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
    }

    const branch = meta.branch || fallbackBranch;

    // (1) Restore local (unpushed) commits via the bundle, then move the branch
    //     tip to the recorded head so the tree matches the committed state.
    if (meta.headSha && meta.headSha !== baseSha) {
        if (meta.hasBundle) {
            const bundleBuf = await blobs.get("bundle");
            if (bundleBuf && bundleBuf.length > 0) {
                const tmp = tmpFile(".bundle");
                try {
                    fs.writeFileSync(tmp, bundleBuf);
                    git(dir, ["bundle", "unbundle", tmp]);
                } finally {
                    fs.rmSync(tmp, { force: true });
                }
            }
        }
        if (objectExists(dir, meta.headSha)) {
            checkoutBranchAt(dir, branch, meta.headSha);
        } else {
            // Bundle missing/incomplete — fall back to base rather than crash.
            log(`[git-workspace] head ${meta.headSha.slice(0, 12)} not present after unbundle; base-only`);
            checkoutBranchAt(dir, branch, baseSha);
            return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
        }
    } else {
        checkoutBranchAt(dir, branch, baseSha);
    }

    // (2) Replay uncommitted work (tracked mods + untracked, captured as one
    //     patch via intent-to-add on the dehydrate side).
    if (meta.hasPatch) {
        const patchBuf = await blobs.get("patch");
        if (patchBuf && patchBuf.length > 0) {
            gitInput(dir, ["apply", "--3way", "--whitespace=nowarn"], patchBuf);
        }
    }

    log(`[git-workspace] replayed epoch ${row.epoch} head=${(meta.headSha || baseSha).slice(0, 12)} on ${branch}`);
    return { mode: "replayed", baseSha, headSha: meta.headSha || baseSha, epoch: row.epoch };
}

/**
 * Dehydrate the enlistment at the end of a turn. See module header. Writes the
 * bundle/patch/meta blobs FIRST, then the git-state row LAST so a concurrent
 * resume never observes a half-written newer epoch.
 */
export async function dehydrateGitWorkspace(opts: DehydrateOptions): Promise<DehydrateResult> {
    const { enlistmentDir: dir, blobs, state, trace } = opts;
    const log = (m: string) => trace?.(m);

    const row = await state.get();
    const headSha = git(dir, ["rev-parse", "HEAD"]);
    // Base must have been pinned by hydrate; be defensive if it wasn't.
    const baseSha = row?.baseSha ?? headSha;

    let branch: string;
    try {
        branch = git(dir, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
        branch = row?.branch ?? git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    }

    const newEpoch = (row?.epoch ?? 0) + 1;

    // (1) bundle = local commits base..HEAD (only when HEAD truly advanced past base).
    let hasBundle = false;
    if (headSha !== baseSha && isAncestor(dir, baseSha, headSha)) {
        const tmp = tmpFile(".bundle");
        try {
            git(dir, ["bundle", "create", tmp, `${baseSha}..HEAD`]);
            await blobs.put("bundle", fs.readFileSync(tmp));
            hasBundle = true;
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    }

    // (2) patch = uncommitted tracked edits + untracked files. Intent-to-add lets
    //     a single `git diff` capture untracked files (text and binary) too.
    const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"])
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    if (untracked.length) {
        git(dir, ["add", "--intent-to-add", "--", ...untracked]);
    }
    let patch: Buffer;
    try {
        patch = gitBuf(dir, ["diff", "--binary", "--no-color", "HEAD"]);
    } finally {
        // Undo the intent-to-add so the op is idempotent if re-run on the same tree.
        if (untracked.length) {
            try {
                git(dir, ["reset", "--quiet", "--", "."]);
            } catch {
                /* dying pod — best effort */
            }
        }
    }
    let hasPatch = false;
    if (patch.length > 0) {
        await blobs.put("patch", patch);
        hasPatch = true;
    }

    // (3) meta — the last blob written, before the row.
    const meta: GitWorkspaceMeta = { branch, baseSha, headSha, epoch: newEpoch, hasBundle, hasPatch };
    await blobs.put("meta", Buffer.from(JSON.stringify(meta), "utf8"));

    // (4) COMMIT POINT: persist the git-state row last.
    const next: GitWorkspaceState = { baseSha, headSha, branch, epoch: newEpoch };
    await state.set(next);

    log(`[git-workspace] dehydrated epoch ${newEpoch} head=${headSha.slice(0, 12)} bundle=${hasBundle} patch=${hasPatch}`);
    return { epoch: newEpoch, headSha, branch, baseSha };
}
