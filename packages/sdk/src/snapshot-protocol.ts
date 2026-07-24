/**
 * Session lifecycle protocol: versioned CAS snapshot contract + worker-local
 * marker/sentinel files (docs/proposals/session-lifecycle-protocol.md §3.1–3.3).
 *
 * The store keeps a monotonic per-session `version`, advanced only by
 * compare-and-swap commits. The worker keeps two protocol files inside the
 * session directory:
 *
 *   - `.ps-snapshot-version` (marker) — the version the local files represent.
 *     Written after every successful commit and hydrate; EXCLUDED from tars
 *     (it describes the dir relative to the store; a tarred copy would be
 *     stale by construction).
 *   - `.ps-turn-inprogress` (sentinel) — presence marks the dir as
 *     mid-mutation by a turn body. Written before the LLM body starts,
 *     removed only after the post-turn commit lands. EXCLUDED from tars.
 *   - `.ps-turn-commit.json` — the committed turn's {turnKey, result},
 *     written just before the commit tar so the already-committed recovery
 *     path can return the stored result without re-running the turn.
 *     INCLUDED in tars (it rides in the snapshot itself, dodging any
 *     store-metadata size cap).
 *
 * @internal
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PS_MARKER_FILE = ".ps-snapshot-version";
export const PS_SENTINEL_FILE = ".ps-turn-inprogress";
export const PS_TURN_COMMIT_FILE = ".ps-turn-commit.json";

export interface SnapshotMarker {
    version: number;
    turnKey?: string;
    contentHash?: string;
    /**
     * Transcript epoch the local files belong to (session regeneration).
     * Absent = 0 (legacy). A marker whose epoch differs from the
     * orchestration's current epoch names a DEAD incarnation: the lifecycle
     * preamble must treat the dir as untrusted and resolve from the
     * epoch-scoped store — never trust it warm, never throw.
     */
    epoch?: number;
    updatedAt: string;
}

export interface TurnSentinel {
    turnKey?: string;
    startedAt: string;
}

export interface SnapshotProbe {
    exists: boolean;
    /** Monotonic version; 0 when the snapshot predates the protocol (legacy). */
    version: number;
    turnKey?: string;
    contentHash?: string;
    /** Compressed (stored) tar size in bytes. */
    sizeBytes?: number;
    /** Uncompressed tar-stream size in bytes (feeds the compression-ratio stat). */
    rawSizeBytes?: number;
    /** True when a snapshot exists but carries no version metadata. */
    legacy?: boolean;
}

export interface SnapshotCommitInput {
    /** The stored version this commit is based on (preamble-resolved). */
    baseVersion: number;
    /** Deterministic per-turn key — makes commit retries idempotent. */
    turnKey: string;
}

export interface SnapshotCommitResult {
    version: number;
    contentHash: string;
    /** Committed (compressed) tar size — feeds session persistence stats. */
    sizeBytes?: number;
    /** Uncompressed tar-stream size — feeds the compression-ratio stat. */
    rawSizeBytes?: number;
    /**
     * True when the store already held baseVersion+1 under the same turnKey —
     * a prior attempt of this same turn committed. The caller must treat this
     * as success without re-writing.
     */
    alreadyCommitted: boolean;
}

export interface SnapshotHydrateResult {
    version: number;
    turnKey?: string;
    contentHash?: string;
    sizeBytes?: number;
    rawSizeBytes?: number;
    legacy?: boolean;
}

/**
 * Foreign writer advanced the session past the caller's base — split-brain
 * fence. Loud by design: the activity fails and re-validates via retry.
 */
export class SnapshotConflictError extends Error {
    storedVersion: number;
    storedTurnKey?: string;
    constructor(sessionId: string, baseVersion: number, storedVersion: number, storedTurnKey?: string) {
        super(
            `Snapshot CAS conflict for ${sessionId}: expected stored version ${baseVersion}, ` +
            `found ${storedVersion}${storedTurnKey ? ` (turnKey ${storedTurnKey})` : ""}`,
        );
        this.name = "SnapshotConflictError";
        this.storedVersion = storedVersion;
        this.storedTurnKey = storedTurnKey;
    }
}

/**
 * Versioned CAS contract implemented by session snapshot stores
 * (filesystem + Azure blob in this phase; PG later). All methods operate on
 * whole snapshots — the same tar the legacy dehydrate/hydrate/checkpoint
 * paths move around.
 */
export interface VersionedSnapshotStore {
    /** Cheap metadata read — no snapshot bytes transferred. */
    probeSnapshot(sessionId: string, epoch?: number): Promise<SnapshotProbe>;
    /**
     * Tar the local session dir and CAS-write it: succeed iff the stored
     * version equals `baseVersion` (or the same turnKey already committed
     * baseVersion+1 → `alreadyCommitted`). Local files are NOT removed.
     * Throws {@link SnapshotConflictError} on a foreign advance.
     */
    commitSnapshot(sessionId: string, input: SnapshotCommitInput, epoch?: number): Promise<SnapshotCommitResult>;
    /**
     * Download the stored snapshot and atomically replace the local session
     * dir (unpack to a temp dir, then rename — a crash mid-hydrate never
     * leaves a plausible-looking dir). Does NOT write the marker; the
     * lifecycle layer does, so marker semantics live in one place.
     */
    hydrateSnapshot(sessionId: string, epoch?: number): Promise<SnapshotHydrateResult>;
}

/**
 * Epoch key scoping (session regeneration, proposal §6):
 *
 *   epoch 0 (or absent)  →  the LEGACY key family, byte-for-byte — blob
 *                           `S.tar.gz`, fs `S.v<N>.tar.{br,gz}` + `S.meta.json`.
 *                           Every pre-regen session keeps its storage forever;
 *                           there is no migration.
 *   epoch >= 1           →  a separate CAS chain per epoch whose version
 *                           numbering restarts at 1. KEY-SHAPE INVARIANT: no
 *                           epoch-scoped BLOB name may end in `.tar.gz` or
 *                           `.meta.json` — those are the only shapes the
 *                           shipped 1.0.66 resource-manager purge collects as
 *                           delete candidates (resourcemgr-tools.ts:441-449),
 *                           and fail-closed parsing in NEW code cannot protect
 *                           against an OLD binary. Epoch blobs are
 *                           `S.e<E>.tar.br` (brotli is the only codec for new
 *                           chains) with `psepoch` metadata and no meta.json
 *                           mirror.
 *
 * Separate chains are the fence that makes a zombie old-epoch commit harmless
 * to the new epoch: it lands on its own key with its own CAS counter.
 */
export function isLegacyEpoch(epoch: number | undefined): boolean {
    return !epoch || epoch <= 0;
}

export function supportsVersionedSnapshots(store: unknown): store is VersionedSnapshotStore {
    const s = store as VersionedSnapshotStore | null;
    return Boolean(
        s
        && typeof s.probeSnapshot === "function"
        && typeof s.commitSnapshot === "function"
        && typeof s.hydrateSnapshot === "function",
    );
}

// ─── Worker-local protocol files ────────────────────────────────────────────

function markerPath(sessionDir: string): string {
    return path.join(sessionDir, PS_MARKER_FILE);
}

function sentinelPath(sessionDir: string): string {
    return path.join(sessionDir, PS_SENTINEL_FILE);
}

export function turnCommitFilePath(sessionDir: string): string {
    return path.join(sessionDir, PS_TURN_COMMIT_FILE);
}

export function readSnapshotMarker(sessionDir: string): SnapshotMarker | null {
    try {
        const raw = fs.readFileSync(markerPath(sessionDir), "utf8");
        const parsed = JSON.parse(raw) as SnapshotMarker;
        if (!Number.isFinite(parsed?.version)) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function writeSnapshotMarker(
    sessionDir: string,
    marker: Omit<SnapshotMarker, "updatedAt">,
): void {
    fs.mkdirSync(sessionDir, { recursive: true });
    const tmp = `${markerPath(sessionDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...marker, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, markerPath(sessionDir));
}

export function readTurnSentinel(sessionDir: string): TurnSentinel | null {
    try {
        const raw = fs.readFileSync(sentinelPath(sessionDir), "utf8");
        return JSON.parse(raw) as TurnSentinel;
    } catch {
        return fs.existsSync(sentinelPath(sessionDir)) ? { startedAt: "" } : null;
    }
}

export function writeTurnSentinel(sessionDir: string, turnKey?: string): void {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        sentinelPath(sessionDir),
        JSON.stringify({ ...(turnKey ? { turnKey } : {}), startedAt: new Date().toISOString() }),
    );
}

export function clearTurnSentinel(sessionDir: string): void {
    try { fs.unlinkSync(sentinelPath(sessionDir)); } catch {}
}

export function writeTurnCommitFile(sessionDir: string, turnKey: string, result: unknown): void {
    const tmp = `${turnCommitFilePath(sessionDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ turnKey, result }));
    fs.renameSync(tmp, turnCommitFilePath(sessionDir));
}

export function readTurnCommitFile(sessionDir: string): { turnKey: string; result: unknown } | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(turnCommitFilePath(sessionDir), "utf8"));
        if (typeof parsed?.turnKey !== "string") return null;
        return parsed;
    } catch {
        return null;
    }
}

export function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}
