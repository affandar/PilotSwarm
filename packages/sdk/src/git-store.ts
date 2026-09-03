// Shared git enlistment primitives for the repo-affinity workers.
//
// Two roles, deliberately split so the same code drives both deployment shapes:
//
//   GitStore  (WRITER)  — owns the object store: Phase-A fetches, worktree
//                         lifecycle, keepalive refs, gc/maintenance. In the AKS
//                         mirror model the "store" is the enlistment's own .git;
//                         in the devbox worktree model it is the shared
//                         dsmaindev/.git that many worktrees hang off.
//   Runner    (READER)  — owns ONE working tree: Phase-B checkout of a pinned
//                         SHA. Never fetches, never gc's.
//
// Every git command runs through an injected `runGit(cwd, args)` so callers can
// add credential/env wiring (az token helper, ADO_PAT, GIT_TERMINAL_PROMPT=0).
//
// Consumed by examples/git-repo-worker.js (both the AKS mirror path and the
// devbox self-fetch worktree path). Lives in the SDK — not the examples tree —
// so it ships in dist/ (the image's COPY manifest) and is unit-testable against
// a throwaway local origin with no network (see test/unit/git-store.test.mjs).

import { execFileSync } from "node:child_process";

/** Injected git runner: run `git <args>` in `cwd`, return trimmed stdout. */
export type RunGit = (cwd: string, args: string[]) => string;

/**
 * Build a {@link RunGit} helper. `GIT_TERMINAL_PROMPT=0` makes a missing
 * credential fail fast instead of hanging on an interactive prompt. `extraEnv`
 * lets a caller inject e.g. a credential-helper override.
 */
export function makeRunGit(extraEnv: Record<string, string> = {}): RunGit {
    return (cwd, args) => execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    }).trim();
}

/**
 * Normalize a caller-supplied ref to something the store can resolve. Bare
 * branch names map onto their remote-tracking ref (origin/<branch>); already
 * qualified refs (origin/*, refs/*) and raw SHAs pass through untouched.
 */
export function normalizeRef(ref: string | null | undefined): string {
    const r = String(ref ?? "").trim();
    if (!r) return r;
    if (/^(origin\/|refs\/)/.test(r)) return r;
    if (/^[0-9a-f]{7,40}$/i.test(r)) return r;
    return `origin/${r}`;
}

/**
 * Resolve the git ref a job resets its enlistment/worktree onto. Precedence:
 *   1. `sessionGitRef` — the per-session branch (e.g. `config.gitRef`);
 *   2. `envRef` — the worker-wide `GIT_ENLISTMENT_REF` override;
 *   3. the store's default branch — `origin/HEAD`, falling back to
 *      `origin/main` then `origin/master`.
 * The first two are passed through {@link normalizeRef}; the default-branch
 * lookup runs git through the injected `runGit` bound to `dir`. Whitespace-only
 * session/env refs are treated as absent. Throws when nothing resolves (empty
 * store, no default branch, no override).
 */
export function resolveTargetRef(
    sessionGitRef: string | null | undefined,
    opts: { dir: string; runGit: RunGit; envRef?: string | null },
): string {
    const { dir, runGit, envRef } = opts;
    const session = sessionGitRef != null ? String(sessionGitRef).trim() : "";
    const env = envRef != null ? String(envRef).trim() : "";
    const explicit = session || env;
    if (explicit) return normalizeRef(explicit);
    try {
        // e.g. "origin/main" -> the tracking ref we reset onto.
        return runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    } catch {
        for (const b of ["origin/main", "origin/master"]) {
            try { runGit(dir, ["rev-parse", "--verify", b]); return b; } catch { /* try next */ }
        }
        throw new Error("could not resolve a default ref (set GIT_ENLISTMENT_REF)");
    }
}

export interface GitStoreOptions {
    /** directory whose .git is the object store */
    dir: string;
    /** (cwd, args) => stdout */
    runGit: RunGit;
    /** optional log sink */
    trace?: (message: string) => void;
}

/**
 * WRITER role. Wraps the object store rooted at `dir` (an enlistment .git in
 * mirror mode, or the shared common-dir in worktree mode). All methods are
 * synchronous shells; callers serialize concurrent writers with their own lock.
 */
export class GitStore {
    readonly dir: string;
    private readonly git: RunGit;
    private readonly trace: (message: string) => void;

    constructor({ dir, runGit, trace }: GitStoreOptions) {
        this.dir = dir;
        this.git = runGit;
        this.trace = trace ?? (() => {});
    }

    /**
     * Maintenance posture: never repack/prune under an active job (objects stay
     * append-only), plus best-effort large-monorepo checkout accelerators. The
     * accelerators are optional — a git too old to know a key just errors and we
     * move on — so this is safe across versions.
     */
    applyConfig({ accelerators = true }: { accelerators?: boolean } = {}): void {
        this.git(this.dir, ["config", "gc.auto", "0"]);
        if (!accelerators) return;
        const knobs: Array<[string, string]> = [
            ["checkout.workers", "0"],      // parallel working-tree writes (git >= 2.32)
            ["core.fscache", "true"],       // Windows stat cache
        ];
        for (const [k, v] of knobs) {
            try { this.git(this.dir, ["config", k, v]); }
            catch (err) { this.trace(`[git-store] config ${k} skipped: ${(err as Error)?.message ?? err}`); }
        }
    }

    /** Is `rev` (sha or ref) present locally as a commit? Cheap, offline. */
    hasCommit(rev: string): boolean {
        try { this.git(this.dir, ["cat-file", "-e", `${rev}^{commit}`]); return true; }
        catch { return false; }
    }

    revParse(rev: string): string { return this.git(this.dir, ["rev-parse", rev]); }

    /**
     * Full Phase-A fetch of every branch. In mirror mode this reads the local
     * node mirror (cheap); in devbox mode it hits ADO, so callers pass
     * `noTags` to skip the (very large) tag advertisement and `prune:false`
     * to stay strictly additive for the background freshener tick.
     */
    fetchAll({ prune = true, noTags = false }: { prune?: boolean; noTags?: boolean } = {}): void {
        const args = ["fetch", prune ? "--prune" : "--no-prune"];
        if (noTags) args.push("--no-tags");
        args.push("--no-write-fetch-head", "origin");
        this.git(this.dir, args);
    }

    /**
     * Narrow Phase-A fetch of a SINGLE ref — the on-demand miss path. Skips the
     * whole-repo ref advertisement, so it is fast even against a repo with tens
     * of thousands of tags/branches.
     */
    fetchRef(ref: string, { noTags = true }: { noTags?: boolean } = {}): void {
        const args = ["fetch"];
        if (noTags) args.push("--no-tags");
        args.push("--no-write-fetch-head", "origin", ref);
        this.git(this.dir, args);
    }

    /**
     * Phase A with the minimum work: if the target is already a local commit,
     * do nothing; else try a narrow single-ref fetch; if the caller didn't give
     * a fetchable ref, fall back to a full fetch. Returns the resolved SHA.
     */
    ensureObjects({ ref, sha }: { ref?: string; sha?: string } = {}): string {
        if (sha && this.hasCommit(sha)) return this.revParse(sha);
        if (ref) {
            const bare = String(ref).replace(/^origin\//, "");
            try { this.fetchRef(bare); }
            catch { this.fetchAll({ prune: false, noTags: true }); }
        } else {
            this.fetchAll({ prune: false, noTags: true });
        }
        return this.revParse(sha || normalizeRef(ref));
    }

    /** Background freshener tick: additive-only whole-branch fetch. */
    tick(): void { this.fetchAll({ prune: false, noTags: true }); }

    /** Register a new detached worktree at `worktreeDir` pinned to `sha`. */
    addWorktree(worktreeDir: string, sha: string): void {
        this.git(this.dir, ["worktree", "add", "--detach", worktreeDir, sha]);
    }

    /** Drop a worktree registration (best-effort; --force removes a dirty tree). */
    removeWorktree(worktreeDir: string): void {
        try { this.git(this.dir, ["worktree", "remove", "--force", worktreeDir]); }
        catch (err) { this.trace(`[git-store] worktree remove skipped: ${(err as Error)?.message ?? err}`); }
    }

    pruneWorktrees(): void {
        try { this.git(this.dir, ["worktree", "prune"]); }
        catch (err) { this.trace(`[git-store] worktree prune skipped: ${(err as Error)?.message ?? err}`); }
    }

    /**
     * Keepalive ref: pins `sha` under refs/pilotswarm/keep/<session> so it is a
     * reachability root immune to gc/prune for the life of an active session.
     */
    keep(session: string, sha: string): void {
        this.git(this.dir, ["update-ref", `refs/pilotswarm/keep/${session}`, sha]);
    }

    unkeep(session: string): void {
        try { this.git(this.dir, ["update-ref", "-d", `refs/pilotswarm/keep/${session}`]); }
        catch (err) { this.trace(`[git-store] unkeep skipped: ${(err as Error)?.message ?? err}`); }
    }
}

export interface RunnerOptions {
    dir: string;
    runGit: RunGit;
}

/**
 * READER role. Owns exactly one working tree at `dir`. Phase B only: snap the
 * tree to a pinned SHA. Runs detached so N runners can share one store without
 * tripping the "same branch checked out twice" rule.
 */
export class Runner {
    readonly dir: string;
    private readonly git: RunGit;

    constructor({ dir, runGit }: RunnerOptions) {
        this.dir = dir;
        this.git = runGit;
    }

    /** Snap the working tree to `sha` (force + hard reset, optional deep clean). */
    checkout(sha: string, { clean = false }: { clean?: boolean } = {}): void {
        this.git(this.dir, ["checkout", "--force", "--detach", sha]);
        this.git(this.dir, ["reset", "--hard", sha]);
        if (clean) this.git(this.dir, ["clean", "-fdx"]);
    }

    head(): string { return this.git(this.dir, ["rev-parse", "HEAD"]); }
}
