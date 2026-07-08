/**
 * runTurn preamble/postamble for the session lifecycle protocol
 * (docs/proposals/session-lifecycle-protocol.md §3.2–3.3).
 *
 * The whole lifecycle lives inside the single runTurn activity (principle
 * P5 — no other session activity depends on landing where a previous one
 * did). Reconcile is STORE-WINS (docs/proposals/snapshot-store-wins.md): one
 * probe per turn is the only oracle — never the orchestration's expectation,
 * which goes stale the moment a stopped/zombie turn advances the store the
 * control plane discarded.
 *
 *   preamble  p1. one probe. Store bears this turn's own turnKey →
 *                 already-committed recovery (restore, never replay).
 *             p2. store empty → trust a clean local dir (only truth), else fresh;
 *                 legacy snapshot → trust clean local, else hydrate.
 *             p3. warm ONLY when a clean local dir's marker matches the store's
 *                 (version AND content hash); every other state — store ahead
 *                 (a discarded/foreign turn advanced it — NO fence, we adopt it),
 *                 a same-version content swap, a torn/dirty dir, or no marker —
 *                 hydrates the store. Store below the marker is hydrated too and
 *                 flagged `regressed`.
 *             p4. (caller) write the turn sentinel just before the body
 *   postamble c1. write .ps-turn-commit.json {turnKey, result} into the dir
 *             c2. commit the tar (store.commitSnapshot) at base+1. alreadyCommitted
 *                 (same turnKey) → restore the winner's snapshot + result. A
 *                 SnapshotConflictError (store moved off base while we ran) is NOT
 *                 fatal: the turn is left UNPUBLISHED (superseded), the sentinel
 *                 stays dirty so the next preamble rehydrates the winner, and the
 *                 caller emits `session.snapshot_unpublished`. A user-stopped
 *                 result skips the commit entirely (also unpublished).
 *             c3. write the local version marker (published turns only)
 *             c4. clear the turn sentinel (published turns only)
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
    | {
        kind: "hydrated";
        baseVersion: number;
        storeBehindExpected: boolean;
        /**
         * Store-wins anomaly: the store's version was BELOW this worker's
         * local marker (a restore from an older backup, or store data loss).
         * The store still wins — we hydrate what it holds — but the caller
         * emits `session.snapshot_regressed` so the regression is visible.
         */
        regressed?: { markerVersion: number; storeVersion: number };
      }
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
    /** Committed (compressed) tar size — feeds session persistence stats. */
    sizeBytes?: number;
    /** Uncompressed tar-stream size — feeds the compression-ratio stat. */
    rawSizeBytes?: number;
    /** A racing/prior attempt of this same turn committed first. */
    alreadyCommitted: boolean;
    /**
     * The winning attempt's recorded result (from .ps-turn-commit.json in
     * the restored snapshot). Present only when alreadyCommitted and the
     * commit file was readable; the caller must return THIS result, not
     * its own body's (§3.2 restore-not-replay).
     */
    storedResult?: unknown;
    /**
     * Store-wins: whether this commit actually advanced the store.
     *   true  — a new version (or an alreadyCommitted same-turnKey winner) landed.
     *   false — the snapshot was NOT published: the turn was user-stopped, or a
     *           discarded/foreign turn advanced the store off our base while we
     *           ran (superseded). The sentinel is left dirty so the next turn
     *           rehydrates the winner; the caller emits `snapshot_unpublished`.
     */
    published: boolean;
    /** Why the snapshot was not published (only when `published` is false). */
    unpublishedReason?: "stopped" | "superseded";
    /**
     * For a `superseded` unpublish: the store coordinates of the writer that
     * won the base — carried from the `SnapshotConflictError` so the emitted
     * `snapshot_unpublished` event can name what superseded this turn (foreign
     * writer vs restore race vs the session's own discarded turn). Absent for a
     * `stopped` unpublish (no commit was attempted, so nothing was observed).
     */
    observedStoreVersion?: number;
    observedStoreTurnKey?: string;
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
// Tunable so fault-injection tests don't pay real backoff delays.
const COMMIT_RETRY_BASE_DELAY_MS =
    Number.parseInt(process.env.PILOTSWARM_COMMIT_RETRY_DELAY_MS ?? "", 10) || 1_000;

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

/**
 * Content-identity gate for the warm fast path. Only a mismatch between two
 * PRESENT hashes forces a hydrate (a rule-breaking restore that overwrote the
 * same version number with different content — the ETag CAS can't catch that,
 * §5.1). When either side lacks a hash (a legacy marker/probe), fall back to
 * version-only trust so an upgrade doesn't churn every warm worker into a
 * spurious one-time hydrate.
 */
function contentMatches(markerHash?: string, probeHash?: string): boolean {
    if (markerHash && probeHash) return markerHash === probeHash;
    return true;
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

async function resolveFromStore(
    ctx: TurnLifecycleContext,
    regressed?: { markerVersion: number; storeVersion: number },
): Promise<TurnPreambleOutcome> {
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
    if (regressed) {
        ctx.trace(
            `session=${ctx.sessionId} store snapshot v${regressed.storeVersion} is BELOW the local marker ` +
            `v${regressed.markerVersion} (store restored/lost data); store wins — hydrating v${hydrated.version}`,
        );
    }
    return {
        kind: "hydrated",
        baseVersion: hydrated.version,
        storeBehindExpected,
        ...(regressed ? { regressed } : {}),
    };
}

/**
 * Preamble (store-wins). Runs under the per-session run-turn lock, before
 * getOrCreate. ONE probe per turn is the reconcile oracle — never the
 * orchestration's `expectedVersion`, which goes stale the moment a stopped or
 * zombie turn advances the store the control plane discarded (the divergence
 * this protocol removes). On return the local dir is in exactly one state:
 * trusted at `baseVersion` (warm — local marker matches the store's
 * version+hash), restored at the stored version (hydrated — the store wins),
 * absent (fresh), or restored at this turn's committed version
 * (already-committed — the caller returns the stored result without a body).
 */
export async function runTurnPreamble(ctx: TurnLifecycleContext): Promise<TurnPreambleOutcome> {
    const sessionDir = sessionDirOf(ctx);
    const sentinel = readTurnSentinel(sessionDir);
    const marker = readSnapshotMarker(sessionDir);
    const localDirUsable = fs.existsSync(sessionDir) && hasUsableSessionLayout(sessionDir);

    // Store-wins: one metadata probe is the ONLY oracle. `expectedVersion`
    // rides in the input for frozen orchestration versions but is load-bearing
    // for nothing here except the lossy-replay observability flag.
    const probe = await ctx.store.probeSnapshot(ctx.sessionId);

    if (sentinel) {
        ctx.trace(
            `session=${ctx.sessionId} turn sentinel present (started ${sentinel.startedAt || "unknown"}); ` +
            `local dir untrusted, resolving from store`,
        );
    }

    // Idempotency (keeper): the store bears THIS turn's own key — a prior
    // attempt of this very turn already committed (crash-after-commit, or a
    // racing drain/lock-steal duplicate). Restore, never replay.
    if (probe.exists && probe.turnKey && probe.turnKey === ctx.turnKey) {
        return recoverAlreadyCommitted(ctx);
    }

    // Store holds nothing.
    if (!probe.exists) {
        // A clean, usable local dir is the best (only) data — trust it over a
        // fresh replay; the fresh chain publishes from here.
        if (!sentinel && localDirUsable) {
            return { kind: "warm", baseVersion: marker?.version ?? 0 };
        }
        // Dirty or unusable local + empty store → fresh; lossy iff turns had
        // been committed before (marker present, or a frozen orchestration
        // still reports a nonzero expected version). W3 in the protocol doc.
        await ctx.dropWarmSession();
        fs.rmSync(sessionDir, { recursive: true, force: true });
        return { kind: "fresh", baseVersion: 0, lossy: (marker?.version ?? ctx.expectedVersion) > 0 };
    }

    // Legacy snapshot (pre-protocol, no version metadata, counts as v0): a
    // clean local dir is still trustworthy; otherwise hydrate what's stored.
    if (probe.legacy) {
        if (!sentinel && localDirUsable) {
            return { kind: "warm", baseVersion: marker?.version ?? 0 };
        }
        return resolveFromStore(ctx);
    }

    // Regressed: the store sits BELOW this worker's own marker — a restore from
    // an older backup, or store data loss. Anomalous (surfaced by the caller),
    // but the store still wins: we hydrate what it holds.
    const regressed = marker && probe.version < marker.version
        ? { markerVersion: marker.version, storeVersion: probe.version }
        : undefined;

    // Warm fast path: a clean local dir whose marker names EXACTLY the stored
    // state — same version AND (when both carry a hash) same content. The
    // layout anchor guards a marker orphaned by a torn delete; the hash guards
    // a rule-breaking same-version restore (§5.1). Only branch that trusts
    // local files without hydrating.
    if (!sentinel && localDirUsable && marker
        && marker.version === probe.version
        && contentMatches(marker.contentHash, probe.contentHash)) {
        return { kind: "warm", baseVersion: marker.version };
    }

    // Store wins for everything else: store AHEAD (a discarded/foreign turn
    // advanced it — the incident; adopt it, no zombie fence), a same-version
    // content swap, a torn/dirty dir, or no marker.
    return resolveFromStore(ctx, regressed);
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
    // Stop-turn divergence guard: a user-stopped turn (result type "stopped")
    // is discarded by the orchestration (stop won the ctx.race →
    // handleTurnStopped; this runTurn is the dropped race loser) and its
    // turnKey is never re-run. Committing its snapshot would advance the
    // stored version while the orchestration keeps state.snapshotVersion at the
    // base — leaving the store one ahead so every later turn fails the CAS
    // (zombie-duplicate fence: "expected N, found N+1"). Skip the commit and
    // leave the .ps-turn-inprogress sentinel in place so the next preamble
    // re-hydrates the base version and discards this partial turn. (Drain and
    // lock-steal classify as "cancelled", not "stopped", and DO commit so their
    // same-turnKey re-run adopts the already-committed snapshot.)
    if ((result as any)?.type === "stopped") {
        ctx.trace(
            `session=${ctx.sessionId} user-stopped turn: skipping snapshot commit at ` +
            `base v${baseVersion}; sentinel left dirty for next-turn re-hydrate`,
        );
        return {
            version: baseVersion,
            contentHash: "",
            alreadyCommitted: false,
            published: false,
            unpublishedReason: "stopped",
        };
    }
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
                    ...(hydrated.sizeBytes != null ? { sizeBytes: hydrated.sizeBytes } : {}),
                    ...(hydrated.rawSizeBytes != null ? { rawSizeBytes: hydrated.rawSizeBytes } : {}),
                    alreadyCommitted: true,
                    published: true,
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
            return {
                version: committed.version,
                contentHash: committed.contentHash,
                ...(committed.sizeBytes != null ? { sizeBytes: committed.sizeBytes } : {}),
                ...(committed.rawSizeBytes != null ? { rawSizeBytes: committed.rawSizeBytes } : {}),
                alreadyCommitted: false,
                published: true,
            };
        } catch (error: unknown) {
            if (error instanceof SnapshotConflictError) {
                // Store-wins: a turn the control plane discarded — or a foreign
                // writer — advanced the store off our base while this turn ran.
                // Do NOT brick (the old zombie-duplicate fence). Give up this
                // publish: leave the sentinel dirty so the next preamble
                // rehydrates the winner. The turn's result still returns to the
                // orchestration; only its snapshot memory is superseded, and
                // the caller emits `session.snapshot_unpublished{superseded}`.
                ctx.trace(
                    `session=${ctx.sessionId} commit superseded: store advanced off base v${baseVersion} ` +
                    `while this turn ran (${error.message}); leaving turn unpublished, sentinel dirty`,
                );
                return {
                    version: baseVersion,
                    contentHash: "",
                    alreadyCommitted: false,
                    published: false,
                    unpublishedReason: "superseded",
                    observedStoreVersion: error.storedVersion,
                    ...(error.storedTurnKey ? { observedStoreTurnKey: error.storedTurnKey } : {}),
                };
            }
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
