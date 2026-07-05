/**
 * runTurn preamble/postamble for the session lifecycle protocol
 * (docs/proposals/session-lifecycle-protocol.md §3.2–3.3).
 *
 * The whole lifecycle lives inside the single runTurn activity (principle
 * P5 — no other session activity depends on landing where a previous one
 * did):
 *
 *   preamble  p1. turn sentinel present → local dir untrusted → resolve from store
 *             p2. marker == expected AND the dir has a usable layout → warm
 *                 start (zero store I/O); else hydrate; store bearing this
 *                 turn's own turnKey → already-committed recovery (restore,
 *                 never replay); store AHEAD of expected under a foreign
 *                 turnKey → loud failure (zombie-duplicate fence)
 *             p3. (caller) write the turn sentinel just before the body
 *   postamble c1. write .ps-turn-commit.json {turnKey, result} into the dir
 *             c2. CAS-commit the tar (store.commitSnapshot); alreadyCommitted
 *                 → restore the winner's snapshot + result (§3.2 r1–r3)
 *             c3. write the local version marker
 *             c4. clear the turn sentinel
 *
 * The CAS base is the PREAMBLE-RESOLVED version. Rebasing is allowed only
 * when the store is BEHIND the orchestration's expectation (store restored
 * from an older backup — self-healing); a store AHEAD of the expectation
 * under a foreign turnKey means this attempt is a stale zombie duplicate
 * and must fail loudly instead of re-applying its turn.
 *
 * @internal
 */
import fs from "node:fs";
import path from "node:path";
import { faultPoint } from "./fault-injection.js";
import {
    SnapshotConflictError,
    clearTurnSentinel,
    readSnapshotMarker,
    readTurnCommitFile,
    readTurnSentinel,
    writeSnapshotMarker,
    writeTurnCommitFile,
    type SnapshotHydrateResult,
    type VersionedSnapshotStore,
} from "./snapshot-protocol.js";

export type TurnPreambleOutcome =
    | { kind: "warm"; baseVersion: number }
    | { kind: "hydrated"; baseVersion: number; storeBehindExpected: boolean }
    | { kind: "already-committed"; version: number; result: unknown }
    /**
     * Local dir was cleared (or never existed) and the store holds nothing:
     * getOrCreate decides fresh-create vs lossy replay exactly as today.
     * `lossy` marks the data-loss flavor (turns were committed but the store
     * lost them) for observability.
     */
    | { kind: "fresh"; baseVersion: number; lossy: boolean };

export interface TurnCommitOutcome {
    version: number;
    contentHash: string;
    /** A racing/prior attempt of this same turn committed first. */
    alreadyCommitted: boolean;
    /**
     * The winning attempt's recorded result (from .ps-turn-commit.json in
     * the restored snapshot). Present only when alreadyCommitted and the
     * commit file was readable; the caller must return THIS result, not
     * its own body's (§3.2 restore-not-replay).
     */
    storedResult?: unknown;
}

export interface TurnLifecycleContext {
    store: VersionedSnapshotStore;
    sessionStateDir: string;
    sessionId: string;
    /** Orchestration's last recorded snapshot version (validation input). */
    expectedVersion: number;
    /** Deterministic per-turn key (orchestration-generated GUID). */
    turnKey: string;
    /** Destroy the in-memory ManagedSession only — disk untouched. */
    dropWarmSession: () => Promise<void>;
    trace: (message: string) => void;
}

const COMMIT_TRANSIENT_RETRIES = 3;
const COMMIT_RETRY_BASE_DELAY_MS = 1_000;

function sessionDirOf(ctx: TurnLifecycleContext): string {
    return path.join(ctx.sessionStateDir, ctx.sessionId);
}

/**
 * A marker alone is not proof the dir survived intact (a crashed recursive
 * delete removes files in arbitrary order and can leave the marker while
 * the session files are gone). Require the SDK's layout anchor before
 * trusting local files without consulting the store.
 */
function hasUsableSessionLayout(sessionDir: string): boolean {
    return fs.existsSync(path.join(sessionDir, "workspace.yaml"));
}

function markerFromHydrate(sessionDir: string, hydrated: SnapshotHydrateResult): void {
    writeSnapshotMarker(sessionDir, {
        version: hydrated.version,
        ...(hydrated.turnKey ? { turnKey: hydrated.turnKey } : {}),
        ...(hydrated.contentHash ? { contentHash: hydrated.contentHash } : {}),
    });
}

/** Restore the committed snapshot and return the stored result (§3.2 r1–r3). */
async function recoverAlreadyCommitted(ctx: TurnLifecycleContext): Promise<TurnPreambleOutcome> {
    const sessionDir = sessionDirOf(ctx);
    await ctx.dropWarmSession();
    const hydrated = await ctx.store.hydrateSnapshot(ctx.sessionId);
    markerFromHydrate(sessionDir, hydrated);
    clearTurnSentinel(sessionDir);
    const commitFile = readTurnCommitFile(sessionDir);
    if (commitFile && commitFile.turnKey === ctx.turnKey) {
        ctx.trace(
            `session=${ctx.sessionId} already-committed recovery: store at v${hydrated.version} ` +
            `under this turnKey; returning stored result without re-running the turn`,
        );
        return { kind: "already-committed", version: hydrated.version, result: commitFile.result };
    }
    // Snapshot claims our turnKey but carries no readable committed result —
    // degrade to a hydrated re-run (duplicate execution beats a wrong result).
    ctx.trace(
        `session=${ctx.sessionId} store bears this turnKey (v${hydrated.version}) but the ` +
        `turn-commit file is missing/unreadable; degrading to hydrated re-run`,
    );
    return { kind: "hydrated", baseVersion: hydrated.version, storeBehindExpected: false };
}

async function resolveFromStore(ctx: TurnLifecycleContext): Promise<TurnPreambleOutcome> {
    const sessionDir = sessionDirOf(ctx);
    await ctx.dropWarmSession();
    const hydrated = await ctx.store.hydrateSnapshot(ctx.sessionId);
    markerFromHydrate(sessionDir, hydrated);
    clearTurnSentinel(sessionDir);
    const storeBehindExpected = hydrated.version < ctx.expectedVersion;
    if (storeBehindExpected) {
        ctx.trace(
            `session=${ctx.sessionId} store snapshot v${hydrated.version} is BEHIND the orchestration's ` +
            `expected v${ctx.expectedVersion} (store restored from backup?); proceeding from stored state`,
        );
    }
    return { kind: "hydrated", baseVersion: hydrated.version, storeBehindExpected };
}

/**
 * Preamble (p1/p2). Runs under the per-session run-turn lock, before
 * getOrCreate. On return the local dir is in exactly one of these states:
 * trusted at `baseVersion` (warm/hydrated), absent (fresh), or restored at
 * the committed version (already-committed — the caller returns the stored
 * result without running the body).
 */
export async function runTurnPreamble(ctx: TurnLifecycleContext): Promise<TurnPreambleOutcome> {
    const sessionDir = sessionDirOf(ctx);
    const sentinel = readTurnSentinel(sessionDir);
    const marker = readSnapshotMarker(sessionDir);
    const localDirExists = fs.existsSync(sessionDir);
    const localDirUsable = localDirExists && hasUsableSessionLayout(sessionDir);

    // p2 fast path: trusted local files at exactly the expected version.
    // Requires the layout anchor — a marker orphaned by a torn delete must
    // not be trusted (the store may hold a perfect copy).
    if (!sentinel && marker && marker.version === ctx.expectedVersion && localDirUsable) {
        return { kind: "warm", baseVersion: marker.version };
    }

    if (sentinel) {
        ctx.trace(
            `session=${ctx.sessionId} turn sentinel present (started ${sentinel.startedAt || "unknown"}); ` +
            `local dir untrusted, resolving from store`,
        );
    }

    // Legacy warm continuity: the orchestration has never recorded a commit
    // (expected 0) and the dir is clean but unmarked — typically a
    // 1.0.56-era warm session that just migrated onto the new protocol.
    // Trust it ONLY after confirming the store doesn't hold a versioned
    // chain (a crash inside already-committed recovery of turn 1 leaves
    // exactly this local shape while the store already has v1).
    if (!sentinel && !marker && ctx.expectedVersion === 0 && localDirUsable) {
        const probe0 = await ctx.store.probeSnapshot(ctx.sessionId);
        if (!probe0.exists || probe0.legacy) {
            return { kind: "warm", baseVersion: 0 };
        }
        if (probe0.turnKey && probe0.turnKey === ctx.turnKey) {
            return recoverAlreadyCommitted(ctx);
        }
        ctx.trace(
            `session=${ctx.sessionId} unmarked local dir but the store holds versioned v${probe0.version}; ` +
            `resolving from store`,
        );
        return resolveFromStore(ctx);
    }

    // Local is untrusted (dirty sentinel) or stale (marker mismatch/absent):
    // resolve from the store.
    const probe = await ctx.store.probeSnapshot(ctx.sessionId);

    if (!probe.exists) {
        // Nothing stored. A clean, usable dir is still the best data
        // available — trust it over a fresh replay.
        if (!sentinel && localDirUsable) {
            ctx.trace(
                `session=${ctx.sessionId} store empty but clean local dir exists ` +
                `(marker=${marker?.version ?? "none"} expected=${ctx.expectedVersion}); using local files`,
            );
            return { kind: "warm", baseVersion: marker?.version ?? 0 };
        }
        // Dirty or unusable local + empty store → fresh; lossy iff turns had
        // been committed before (W3 in the protocol doc).
        await ctx.dropWarmSession();
        fs.rmSync(sessionDir, { recursive: true, force: true });
        return { kind: "fresh", baseVersion: 0, lossy: ctx.expectedVersion > 0 };
    }

    // Already-committed recovery: the store bears this very turn's turnKey —
    // the previous attempt crashed after its CAS landed (or a racing
    // duplicate attempt already won). Restore, never replay.
    if (probe.turnKey && probe.turnKey === ctx.turnKey) {
        return recoverAlreadyCommitted(ctx);
    }

    // Zombie-duplicate fence: the store is AHEAD of what this attempt was
    // scheduled against, under a DIFFERENT turn's key. A later turn already
    // committed — re-running this one would silently double-apply it (and
    // its rebased CAS would succeed). Fail loudly; duroxide's retry/poison
    // machinery surfaces it instead of corrupting the chain.
    if (ctx.expectedVersion > 0 && probe.version > ctx.expectedVersion) {
        throw new SnapshotConflictError(ctx.sessionId, ctx.expectedVersion, probe.version, probe.turnKey);
    }

    // Normal resolve: hydrate exactly what the store holds (equal to
    // expected after a migration/crash, or behind after a store restore).
    return resolveFromStore(ctx);
}

/**
 * Last-resort recovery when getOrCreate fails on missing/lost local state
 * DESPITE the preamble's resolution (e.g. the SDK refused to resume from
 * intact-looking files): restore the committed snapshot if one exists.
 * Returns the hydrated version, or null when the store holds nothing —
 * only then may the caller fall back to the lossy fresh replay, whose
 * store-deleting reset is a no-op against an empty store.
 */
export async function attemptStoreRecovery(ctx: TurnLifecycleContext): Promise<number | null> {
    const probe = await ctx.store.probeSnapshot(ctx.sessionId);
    if (!probe.exists) return null;
    const sessionDir = sessionDirOf(ctx);
    await ctx.dropWarmSession();
    const hydrated = await ctx.store.hydrateSnapshot(ctx.sessionId);
    markerFromHydrate(sessionDir, hydrated);
    clearTurnSentinel(sessionDir);
    return hydrated.version;
}

/**
 * Postamble (c1–c4). Runs under the per-session run-turn lock after the
 * body produced `result`. Transient store failures retry in place; a CAS
 * conflict (foreign writer) always throws — the activity must fail loudly.
 * An `alreadyCommitted` CAS outcome (a racing duplicate of this same turn
 * won) triggers restore-not-replay: the winner's snapshot and result are
 * adopted, discarding this attempt's divergent local state.
 */
export async function runTurnCommit(
    ctx: TurnLifecycleContext,
    baseVersion: number,
    result: unknown,
): Promise<TurnCommitOutcome> {
    const sessionDir = sessionDirOf(ctx);
    writeTurnCommitFile(sessionDir, ctx.turnKey, result);
    faultPoint("turn.commit.before-cas");

    let lastError: unknown;
    for (let attempt = 1; attempt <= COMMIT_TRANSIENT_RETRIES; attempt++) {
        try {
            const committed = await ctx.store.commitSnapshot(ctx.sessionId, {
                baseVersion,
                turnKey: ctx.turnKey,
            });
            faultPoint("turn.commit.after-cas");

            if (committed.alreadyCommitted) {
                // §3.2 restore-not-replay: a racing attempt of this same
                // turn committed first. Its snapshot is the durable lineage;
                // this attempt's local files diverge and must be replaced.
                ctx.trace(
                    `session=${ctx.sessionId} commit found this turn already committed at ` +
                    `v${committed.version} by a racing attempt; restoring the committed state`,
                );
                await ctx.dropWarmSession();
                const hydrated = await ctx.store.hydrateSnapshot(ctx.sessionId);
                markerFromHydrate(sessionDir, hydrated);
                clearTurnSentinel(sessionDir);
                const commitFile = readTurnCommitFile(sessionDir);
                return {
                    version: committed.version,
                    contentHash: hydrated.contentHash ?? committed.contentHash,
                    alreadyCommitted: true,
                    ...(commitFile && commitFile.turnKey === ctx.turnKey
                        ? { storedResult: commitFile.result }
                        : {}),
                };
            }

            writeSnapshotMarker(sessionDir, {
                version: committed.version,
                turnKey: ctx.turnKey,
                contentHash: committed.contentHash,
            });
            faultPoint("turn.commit.after-marker");
            clearTurnSentinel(sessionDir);
            faultPoint("turn.commit.after-sentinel-clear");
            return { version: committed.version, contentHash: committed.contentHash, alreadyCommitted: false };
        } catch (error: unknown) {
            if (error instanceof SnapshotConflictError) throw error;
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            ctx.trace(
                `session=${ctx.sessionId} turn commit attempt ${attempt}/${COMMIT_TRANSIENT_RETRIES} ` +
                `failed: ${message}`,
            );
            if (attempt < COMMIT_TRANSIENT_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, COMMIT_RETRY_BASE_DELAY_MS * attempt));
            }
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(`Turn commit failed for ${ctx.sessionId}: ${String(lastError)}`);
}
