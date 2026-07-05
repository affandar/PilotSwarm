import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileTypeFromBuffer } from "file-type";
import { faultPoint } from "./fault-injection.js";
import {
    SnapshotConflictError,
    type SnapshotCommitInput,
    type SnapshotCommitResult,
    type SnapshotHydrateResult,
    type SnapshotProbe,
    type VersionedSnapshotStore,
} from "./snapshot-protocol.js";

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const DEFAULT_FILESYSTEM_STORE_DIR = path.join(os.homedir(), ".copilot", "session-store");

export interface SessionMetadata {
    sessionId: string;
    dehydratedAt: string;
    worker: string;
    /** Compressed (stored) tar size in bytes. */
    sizeBytes: number;
    /** Uncompressed tar-stream size in bytes (feeds the compression-ratio stat). */
    rawSizeBytes?: number;
    /** Compression codec of the stored tar; absent = legacy gzip. */
    codec?: SnapshotCodec;
    reason?: string;
    iteration?: number;
    [key: string]: unknown;
}

export interface SessionStateStore {
    dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void>;
    hydrate(sessionId: string): Promise<void>;
    checkpoint(sessionId: string): Promise<void>;
    getSnapshotSizeBytes(sessionId: string): Promise<number | undefined>;
    exists(sessionId: string): Promise<boolean>;
    delete(sessionId: string): Promise<void>;
}

export type ArtifactEncoding = "utf-8" | "base64";
export type ArtifactSource = "agent" | "user" | "system";

export interface ArtifactMetadata {
    filename: string;
    sizeBytes: number;
    contentType: string;
    isBinary: boolean;
    uploadedAt: string;
    source: ArtifactSource;
}

export interface ArtifactUploadOptions {
    encoding?: ArtifactEncoding;
    source?: ArtifactSource;
}

export interface ArtifactDownloadResult extends ArtifactMetadata {
    body: Buffer;
}

const DEFAULT_ARTIFACT_CONTENT_TYPE = "text/markdown";
const DEFAULT_ARTIFACT_SOURCE: ArtifactSource = "agent";
const TEXT_ARTIFACT_MAX_BYTES = 1_048_576;
const DEFAULT_BINARY_ARTIFACT_MAX_BYTES = 10_485_760;
const OCTET_STREAM_CONTENT_TYPE = "application/octet-stream";
const YAML_ARTIFACT_CONTENT_TYPES = new Set(["application/yaml", "application/x-yaml", "text/yaml"]);
const TEXT_ARTIFACT_CONTENT_TYPES = new Set([
    "application/json",
    "application/javascript",
    "application/xml",
    "application/x-ndjson",
    "image/svg+xml",
    "text/yaml",
]);
const ZIP_COMPATIBLE_ARTIFACT_TYPES = new Set([
    "application/zip",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function normalizeArtifactContentType(contentType?: string | null): string {
    const normalized = String(contentType || "").trim().toLowerCase();
    if (!normalized) return DEFAULT_ARTIFACT_CONTENT_TYPE;
    if (YAML_ARTIFACT_CONTENT_TYPES.has(normalized)) return "text/yaml";
    return normalized;
}

export function isBinaryArtifactContentType(contentType?: string | null): boolean {
    const normalized = normalizeArtifactContentType(contentType);
    if (normalized.startsWith("text/")) return false;
    return !TEXT_ARTIFACT_CONTENT_TYPES.has(normalized);
}

export function getBinaryArtifactMaxBytes(): number {
    const raw = Number(process.env.PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BINARY_ARTIFACT_MAX_BYTES;
}

function createArtifactError(code: string, message: string, extra: Record<string, unknown> = {}): Error & Record<string, unknown> {
    const error = new Error(message) as Error & Record<string, unknown>;
    error.code = code;
    Object.assign(error, extra);
    return error;
}

function validateArtifactSize(body: Buffer, contentType: string): void {
    const maxBytes = isBinaryArtifactContentType(contentType)
        ? getBinaryArtifactMaxBytes()
        : TEXT_ARTIFACT_MAX_BYTES;
    if (body.length <= maxBytes) return;
    throw createArtifactError(
        "ARTIFACT_TOO_LARGE",
        `Artifact too large: ${body.length} bytes (max ${maxBytes})`,
        { maxBytes, actualBytes: body.length },
    );
}

async function sniffArtifactContentType(body: Buffer): Promise<string | null> {
    const detected = await fileTypeFromBuffer(body);
    return detected?.mime ? normalizeArtifactContentType(detected.mime) : null;
}

function isCompatibleDetectedArtifactType(declaredType: string, detectedType: string | null): boolean {
    if (!detectedType) return true;
    if (declaredType === detectedType) return true;
    if (detectedType === "application/zip" && ZIP_COMPATIBLE_ARTIFACT_TYPES.has(declaredType)) return true;
    if (declaredType === OCTET_STREAM_CONTENT_TYPE) return true;
    return false;
}

export async function resolveArtifactUpload(
    content: string | Buffer,
    contentType?: string,
    opts: ArtifactUploadOptions = {},
): Promise<{ body: Buffer; metadata: Omit<ArtifactMetadata, "filename" | "uploadedAt"> }> {
    const encoding = opts.encoding || "utf-8";
    const source = opts.source || DEFAULT_ARTIFACT_SOURCE;
    const normalizedContentType = normalizeArtifactContentType(
        contentType || (encoding === "utf-8" && typeof content === "string" ? DEFAULT_ARTIFACT_CONTENT_TYPE : undefined),
    );

    if (typeof content !== "string" && !Buffer.isBuffer(content)) {
        throw createArtifactError("ARTIFACT_INVALID_CONTENT", "Artifact content must be a string or Buffer.");
    }
    if ((encoding === "base64" || Buffer.isBuffer(content)) && !contentType) {
        throw createArtifactError("ARTIFACT_CONTENT_TYPE_REQUIRED", "contentType is required for binary artifact uploads.");
    }

    const body = Buffer.isBuffer(content)
        ? content
        : Buffer.from(content, encoding === "base64" ? "base64" : "utf8");

    validateArtifactSize(body, normalizedContentType);

    const detectedType = await sniffArtifactContentType(body);
    if (!isCompatibleDetectedArtifactType(normalizedContentType, detectedType)) {
        throw createArtifactError(
            "ARTIFACT_CONTENT_TYPE_MISMATCH",
            `Artifact content type mismatch: declared ${normalizedContentType}, detected ${detectedType}`,
            { declaredType: normalizedContentType, detectedType },
        );
    }

    return {
        body,
        metadata: {
            sizeBytes: body.length,
            contentType: normalizedContentType,
            isBinary: isBinaryArtifactContentType(normalizedContentType),
            source,
        },
    };
}

function metadataFromStat(
    filename: string,
    stat: fs.Stats,
    stored: Partial<ArtifactMetadata> | null,
): ArtifactMetadata {
    const contentType = normalizeArtifactContentType(stored?.contentType || undefined);
    return {
        filename,
        sizeBytes: Number(stored?.sizeBytes) || stat.size,
        contentType,
        isBinary: typeof stored?.isBinary === "boolean" ? stored.isBinary : isBinaryArtifactContentType(contentType),
        uploadedAt: String(stored?.uploadedAt || stat.mtime.toISOString()),
        source: (stored?.source as ArtifactSource) || DEFAULT_ARTIFACT_SOURCE,
    };
}

// ─── Snapshot compression codec ─────────────────────────────────────────────
//
// New writes use brotli quality 4: the lab measured it beating gzip-6 on BOTH
// speed (295 vs 62 MB/s) and ratio (11.6:1 vs 3.1:1) on real session tars, and
// under commit-per-turn the codec sits on every turn's critical path. Brotli
// has no magic bytes, so the codec is DECLARED (fs meta `codec`, blob metadata
// `pscodec`, `.tar.br` extension) and never sniffed. Legacy gzip snapshots stay
// readable forever; every chain self-migrates to brotli on its next commit.
export type SnapshotCodec = "gzip" | "brotli";
export const DEFAULT_SNAPSHOT_CODEC: SnapshotCodec = "brotli";
const BROTLI_QUALITY = 4;

/** Resolve the codec from a stored marker/metadata value; default gzip (legacy). */
export function resolveSnapshotCodec(value: unknown): SnapshotCodec {
    return value === "brotli" ? "brotli" : "gzip";
}

function makeCompressor(codec: SnapshotCodec): zlib.BrotliCompress | zlib.Gzip {
    return codec === "brotli"
        ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
        : zlib.createGzip();
}

function makeDecompressor(codec: SnapshotCodec): zlib.BrotliDecompress | zlib.Gunzip {
    return codec === "brotli" ? zlib.createBrotliDecompress() : zlib.createGunzip();
}

/** Await a spawned process's exit, rejecting on non-zero / signal with its stderr. */
function awaitProcess(child: ReturnType<typeof spawn>, label: string): Promise<void> {
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`${label} failed (code=${code} signal=${signal}): ${stderr.trim()}`));
        });
    });
}

const TAR_EXCLUDES = [
    "--exclude=inuse.*.lock",
    "--exclude=.ps-snapshot-version*",
    "--exclude=.ps-turn-inprogress*",
];

function tarFileName(sessionId: string): string {
    return `${sessionId}.tar.gz`;
}

/** Version-named snapshot tar for the given codec (`.tar.br` for brotli). */
function versionedTarFileName(sessionId: string, version: number, codec: SnapshotCodec): string {
    return codec === "brotli" ? `${sessionId}.v${version}.tar.br` : `${sessionId}.v${version}.tar.gz`;
}

function metaFileName(sessionId: string): string {
    return `${sessionId}.meta.json`;
}

function buildMetadata(tarPath: string, sessionId: string, meta?: Record<string, unknown>): SessionMetadata {
    return {
        sessionId,
        dehydratedAt: new Date().toISOString(),
        worker: os.hostname(),
        sizeBytes: fs.statSync(tarPath).size,
        ...meta,
    };
}

/**
 * Tar the session dir, compress with `codec`, and write to `tarPath`.
 * Returns `rawSizeBytes` (the uncompressed tar-stream length — a free
 * by-product of the pipeline, and the right "uncompressed snapshot size"
 * for compression-ratio stats) and the codec used.
 *
 * Excludes: live `inuse.<pid>.lock` (scoped to a dead SDK process), and the
 * lifecycle-protocol marker + sentinel (the marker describes the dir
 * relative to the store; the sentinel is a local dirty flag). The
 * `.ps-turn-commit.json` file IS included so already-committed recovery can
 * read the turn result out of the tar.
 */
async function archiveSessionDir(
    sessionStateDir: string,
    sessionId: string,
    tarPath: string,
    codec: SnapshotCodec = DEFAULT_SNAPSHOT_CODEC,
): Promise<{ rawSizeBytes: number; codec: SnapshotCodec }> {
    const tar = spawn("tar", [...TAR_EXCLUDES, "-cf", "-", "-C", sessionStateDir, sessionId]);
    let rawSizeBytes = 0;
    const counter = new Transform({
        transform(chunk, _enc, cb) { rawSizeBytes += chunk.length; cb(null, chunk); },
    });
    const out = fs.createWriteStream(tarPath);
    // Surface a tar failure or a pipeline failure loudly (either leaves a
    // partial file; callers stage to a temp path and rename on success).
    const [pipeResult, procResult] = await Promise.allSettled([
        pipeline(tar.stdout!, counter, makeCompressor(codec), out),
        awaitProcess(tar, "tar create"),
    ]);
    if (procResult.status === "rejected") throw procResult.reason;
    if (pipeResult.status === "rejected") throw pipeResult.reason;
    return { rawSizeBytes, codec };
}

async function extractSessionArchive(
    sessionStateDir: string,
    tarPath: string,
    codec: SnapshotCodec = "gzip",
): Promise<void> {
    fs.mkdirSync(sessionStateDir, { recursive: true });
    const input = fs.createReadStream(tarPath);
    const tar = spawn("tar", ["-xf", "-", "-C", sessionStateDir]);
    const [pipeResult, procResult] = await Promise.allSettled([
        pipeline(input, makeDecompressor(codec), tar.stdin!),
        awaitProcess(tar, "tar extract"),
    ]);
    if (procResult.status === "rejected") throw procResult.reason;
    if (pipeResult.status === "rejected") throw pipeResult.reason;
}

const LEGACY_SESSION_FILES = ["events.jsonl", "workspace.yaml"];
const REQUIRED_SESSION_FILES = ["workspace.yaml"];
// Files we treat as "the SDK actually wrote a session here" once they appear.
// Keep this list aligned with @github/copilot CLI persistence (see audit notes
// in docs/inbox or ask the SDK team before adding/removing entries).
const CURRENT_LAYOUT_SIGNAL_FILES = new Set([
    "workspace.yaml",
    "session.db",
    "session.db-wal",
    "session.db-shm",
    "events.jsonl",
]);
const CURRENT_LAYOUT_SIGNAL_DIRS = new Set(["checkpoints", "files", "research"]);
const SESSION_LOCK_FILE = /^inuse\..+\.lock$/i;

function isIgnoredSessionEntry(relativePath: string): boolean {
    const baseName = path.basename(relativePath);
    return SESSION_LOCK_FILE.test(baseName);
}

function collectSessionSnapshotEntries(sessionDir: string): string[] {
    const entries: string[] = [];

    function walk(currentDir: string, relativeDir = ""): void {
        for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const relativePath = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name;
            if (isIgnoredSessionEntry(relativePath)) continue;

            const absolutePath = path.join(currentDir, dirent.name);
            const stat = fs.statSync(absolutePath);

            if (dirent.isDirectory()) {
                entries.push(`dir:${relativePath}:${stat.mtimeMs}`);
                walk(absolutePath, relativePath);
                continue;
            }

            entries.push(`file:${relativePath}:${stat.size}:${stat.mtimeMs}`);
        }
    }

    walk(sessionDir);
    entries.sort();
    return entries;
}

/**
 * Single-shot readiness check for a session-state directory.
 *
 * As of @github/copilot 1.0.36, `client.createSession` writes `workspace.yaml`
 * (plus `checkpoints/`, `files/`, `research/`) before returning, and
 * `session.disconnect()` preserves the directory intact. There is therefore
 * no race to poll for: either the SDK has placed the directory by the time
 * we get here or it never will. We retain the legacy ("events.jsonl" +
 * "workspace.yaml") fallback for snapshots produced by older SDK builds, and
 * the lock-file filter so we ignore live `inuse.<pid>.lock` churn.
 */
function checkSessionSnapshot(
    sessionStateDir: string,
    sessionId: string,
): { ready: boolean; missing: string[] } {
    const sessionDir = path.join(sessionStateDir, sessionId);

    if (!fs.existsSync(sessionDir)) {
        return { ready: false, missing: [`${sessionId}/`] };
    }

    const missingRequired = REQUIRED_SESSION_FILES
        .filter((file) => !fs.existsSync(path.join(sessionDir, file)))
        .map((file) => `${sessionId}/${file}`);

    if (missingRequired.length === 0) {
        const snapshotEntries = collectSessionSnapshotEntries(sessionDir);
        const hasCurrentLayoutSignal = snapshotEntries.some((entry) => {
            const [kind, relPath = ""] = entry.split(":");
            if (!relPath) return false;
            if (kind === "file" && CURRENT_LAYOUT_SIGNAL_FILES.has(relPath)) return true;
            if (kind === "dir" && CURRENT_LAYOUT_SIGNAL_DIRS.has(relPath)) return true;
            const top = relPath.split(path.sep)[0];
            return CURRENT_LAYOUT_SIGNAL_DIRS.has(top);
        });
        if (hasCurrentLayoutSignal) return { ready: true, missing: [] };
        return { ready: false, missing: [`${sessionId}/workspace.yaml or layout signal`] };
    }

    const hasLegacyLayoutSignal = LEGACY_SESSION_FILES.every((file) =>
        fs.existsSync(path.join(sessionDir, file)),
    );
    if (hasLegacyLayoutSignal) return { ready: true, missing: [] };

    return { ready: false, missing: missingRequired };
}

/**
 * Backwards-compatible wrapper kept for callers that historically expected an
 * async, polling readiness check. Today this is a single-shot probe; the
 * arguments other than `sessionStateDir` and `sessionId` are accepted but
 * ignored, intentionally — see {@link checkSessionSnapshot} for rationale.
 */
async function waitForSessionSnapshot(
    sessionStateDir: string,
    sessionId: string,
    _timeoutMs?: number,
    _pollMs?: number,
    _stablePolls?: number,
): Promise<{ ready: boolean; missing: string[] }> {
    return checkSessionSnapshot(sessionStateDir, sessionId);
}

export class FilesystemSessionStore implements SessionStateStore, VersionedSnapshotStore {
    private storeDir: string;
    private sessionStateDir: string;

    constructor(storeDir = DEFAULT_FILESYSTEM_STORE_DIR, sessionStateDir?: string) {
        this.storeDir = storeDir;
        this.sessionStateDir = sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
        fs.mkdirSync(this.storeDir, { recursive: true });
    }

    private tarPath(sessionId: string): string {
        return path.join(this.storeDir, tarFileName(sessionId));
    }

    private metaPath(sessionId: string): string {
        return path.join(this.storeDir, metaFileName(sessionId));
    }

    // ─── Versioned CAS contract (session-lifecycle-protocol §3.1) ───
    //
    // The meta.json rename is the SINGLE commit point: each commit writes a
    // version-named tar (`<id>.v<N>.tar.gz`) first, then renames the meta
    // that references it (`tarFile`). A crash between the two leaves an
    // orphan tar and an untouched, fully consistent store — there is no
    // torn tar-newer-than-meta window. A meta without `version` is a legacy
    // snapshot (probe reports version 0 / legacy). Cross-process atomicity
    // uses an mkdir lock with an owner token; the tar is built OUTSIDE the
    // lock so the critical section is milliseconds, far below the reap age.

    private casLockDir(sessionId: string): string {
        return path.join(this.storeDir, `${sessionId}.cas.lock`);
    }

    private async withCasLock<T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> {
        const lockDir = this.casLockDir(sessionId);
        const ownerToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ownerPath = path.join(lockDir, "owner");
        const deadline = Date.now() + 10_000;
        for (;;) {
            try {
                fs.mkdirSync(lockDir);
                fs.writeFileSync(ownerPath, ownerToken);
                break;
            } catch (err: any) {
                if (err?.code !== "EEXIST") throw err;
                // Reap abandoned locks (holder crashed mid-commit). Rename
                // first — atomic, so exactly one reaper wins and a freshly
                // created lock can never be reaped by a stale-age racer.
                try {
                    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
                    if (age > 60_000) {
                        const tomb = `${lockDir}.reaped-${ownerToken}`;
                        fs.renameSync(lockDir, tomb);
                        fs.rmSync(tomb, { recursive: true, force: true });
                        continue;
                    }
                } catch {}
                if (Date.now() > deadline) {
                    throw new Error(`Timed out acquiring snapshot CAS lock for ${sessionId}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        try {
            return await fn();
        } finally {
            // Release only if we still own the lock (it may have been
            // reaped and re-acquired by another process while we ran).
            try {
                if (fs.readFileSync(ownerPath, "utf8") === ownerToken) {
                    fs.rmSync(lockDir, { recursive: true, force: true });
                }
            } catch {}
        }
    }

    private readStoredMeta(sessionId: string): (SessionMetadata & { version?: number; turnKey?: string; contentHash?: string; tarFile?: string }) | null {
        try {
            return JSON.parse(fs.readFileSync(this.metaPath(sessionId), "utf8"));
        } catch {
            return null;
        }
    }

    /** Codec of the currently stored snapshot (default gzip for legacy). */
    private storedCodec(meta: { codec?: unknown; tarFile?: unknown } | null): SnapshotCodec {
        if (meta?.codec) return resolveSnapshotCodec(meta.codec);
        // Fall back to the tar extension for meta that predates the field.
        return String(meta?.tarFile ?? "").endsWith(".tar.br") ? "brotli" : "gzip";
    }

    /** The tar the current meta points at: version-named or the legacy path. */
    private currentTarPath(sessionId: string, meta: { tarFile?: string } | null): string {
        if (meta?.tarFile) return path.join(this.storeDir, path.basename(String(meta.tarFile)));
        return this.tarPath(sessionId);
    }

    private probeUnlocked(sessionId: string): SnapshotProbe & { meta: ReturnType<FilesystemSessionStore["readStoredMeta"]> } {
        const meta = this.readStoredMeta(sessionId);
        const tarExists = fs.existsSync(this.currentTarPath(sessionId, meta));
        if (!tarExists) return { exists: false, version: 0, meta: null };
        const version = Number(meta?.version);
        if (!Number.isFinite(version) || version < 1) {
            return { exists: true, version: 0, legacy: true, meta };
        }
        return {
            exists: true,
            version,
            ...(meta?.turnKey ? { turnKey: String(meta.turnKey) } : {}),
            ...(meta?.contentHash ? { contentHash: String(meta.contentHash) } : {}),
            ...(Number.isFinite(Number(meta?.sizeBytes)) ? { sizeBytes: Number(meta?.sizeBytes) } : {}),
            ...(Number.isFinite(Number(meta?.rawSizeBytes)) ? { rawSizeBytes: Number(meta?.rawSizeBytes) } : {}),
            meta,
        };
    }

    async probeSnapshot(sessionId: string): Promise<SnapshotProbe> {
        const { meta: _meta, ...probe } = this.probeUnlocked(sessionId);
        return probe;
    }

    async commitSnapshot(sessionId: string, input: SnapshotCommitInput): Promise<SnapshotCommitResult> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const snapshot = await waitForSessionSnapshot(this.sessionStateDir, sessionId);
        if (!snapshot.ready) {
            throw new Error(
                `Session state directory not ready during commit: ${sessionId} (${sessionDir}). ` +
                `Missing: ${snapshot.missing.join(", ") || "unknown"}`,
            );
        }

        // Stage the tar OUTSIDE the lock, under a per-writer unique name:
        // concurrent writers can never interleave bytes into each other's
        // staging files, and the lock hold time stays in milliseconds.
        const codec = DEFAULT_SNAPSHOT_CODEC;
        const stagedTar = path.join(
            this.storeDir,
            `${sessionId}.staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
        );
        try {
            faultPoint("store.commit.before-write");
            const { rawSizeBytes } = await archiveSessionDir(this.sessionStateDir, sessionId, stagedTar, codec);
            const contentHash = (() => {
                const hash = crypto.createHash("sha256");
                hash.update(fs.readFileSync(stagedTar));
                return hash.digest("hex");
            })();

            return await this.withCasLock(sessionId, () => {
                const probe = this.probeUnlocked(sessionId);
                const storedTurnKey = probe.turnKey;

                if (probe.exists && !probe.legacy) {
                    if (probe.version === input.baseVersion + 1 && storedTurnKey === input.turnKey) {
                        return {
                            version: probe.version,
                            contentHash: probe.contentHash ?? "",
                            alreadyCommitted: true,
                        };
                    }
                    if (probe.version !== input.baseVersion) {
                        throw new SnapshotConflictError(sessionId, input.baseVersion, probe.version, storedTurnKey);
                    }
                } else if (probe.exists && probe.legacy) {
                    // Legacy (unversioned) snapshot counts as version 0.
                    if (input.baseVersion !== 0) {
                        throw new SnapshotConflictError(sessionId, input.baseVersion, 0);
                    }
                }
                // Version: stored+1 normally; legacy restarts at 1; a missing
                // snapshot with baseVersion > 0 means the store lost data —
                // continue at baseVersion+1 to keep the chain monotonic.
                const version = probe.exists
                    ? probe.version + 1
                    : input.baseVersion + 1;

                const versionedTarName = versionedTarFileName(sessionId, version, codec);
                const versionedTarPath = path.join(this.storeDir, versionedTarName);
                const previousTar = probe.exists ? this.currentTarPath(sessionId, probe.meta) : null;
                const metadata = {
                    ...buildMetadata(stagedTar, sessionId, { reason: "turn-commit" }),
                    version,
                    turnKey: input.turnKey,
                    contentHash,
                    codec,
                    rawSizeBytes,
                    tarFile: versionedTarName,
                };
                fs.renameSync(stagedTar, versionedTarPath);
                faultPoint("store.commit.tar-renamed");
                const tmpMeta = `${this.metaPath(sessionId)}.tmp-${process.pid}-${Date.now()}`;
                fs.writeFileSync(tmpMeta, JSON.stringify(metadata));
                fs.renameSync(tmpMeta, this.metaPath(sessionId)); // ← the commit point
                faultPoint("store.commit.after-write");
                // GC the superseded tar (best-effort; never the one we wrote).
                if (previousTar && previousTar !== versionedTarPath) {
                    try { fs.unlinkSync(previousTar); } catch {}
                }
                return {
                    version,
                    contentHash,
                    sizeBytes: metadata.sizeBytes,
                    rawSizeBytes,
                    alreadyCommitted: false,
                };
            });
        } finally {
            try { fs.unlinkSync(stagedTar); } catch {}
        }
    }

    async hydrateSnapshot(sessionId: string): Promise<SnapshotHydrateResult> {
        // Read tar + meta as one consistent unit vs. concurrent commits.
        const { stagedTar, meta } = await this.withCasLock(sessionId, () => {
            const probe = this.probeUnlocked(sessionId);
            if (!probe.exists) {
                throw new Error(`Session archive not found: ${sessionId}`);
            }
            const staged = path.join(os.tmpdir(), `ps-hydrate-${sessionId}-${process.pid}-${Date.now()}.tar`);
            fs.copyFileSync(this.currentTarPath(sessionId, probe.meta), staged);
            return { stagedTar: staged, meta: probe.meta };
        });
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const codec = this.storedCodec(meta);

        try {
            // Integrity: the bytes we copied must be the bytes the meta
            // describes (detects torn legacy writes and disk corruption).
            const expectedHash = meta?.contentHash ? String(meta.contentHash) : null;
            if (expectedHash) {
                const actual = crypto.createHash("sha256").update(fs.readFileSync(stagedTar)).digest("hex");
                if (actual !== expectedHash) {
                    throw new Error(
                        `Snapshot integrity check failed for ${sessionId}: tar sha256 ${actual} != stored ${expectedHash}`,
                    );
                }
            }

            // Atomic replace: extract into a temp root, then swap dirs. A
            // crash mid-extract leaves only the temp root; a crash between
            // rm and rename leaves the dir ABSENT (self-healing: the next
            // preamble re-hydrates) — never a plausible-looking partial.
            fs.mkdirSync(this.sessionStateDir, { recursive: true });
            const tempRoot = fs.mkdtempSync(path.join(this.sessionStateDir, `.ps-hydrate-${sessionId}-`));
            try {
                await extractSessionArchive(tempRoot, stagedTar, codec);
                const extracted = path.join(tempRoot, sessionId);
                if (!fs.existsSync(extracted)) {
                    throw new Error(`Snapshot archive for ${sessionId} did not contain the session directory`);
                }
                faultPoint("store.hydrate.before-swap");
                fs.rmSync(sessionDir, { recursive: true, force: true });
                fs.renameSync(extracted, sessionDir);
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        } finally {
            try { fs.unlinkSync(stagedTar); } catch {}
        }

        const version = Number(meta?.version);
        const hasVersion = Number.isFinite(version) && version >= 1;
        return {
            version: hasVersion ? version : 0,
            ...(meta?.turnKey ? { turnKey: String(meta.turnKey) } : {}),
            ...(meta?.contentHash ? { contentHash: String(meta.contentHash) } : {}),
            ...(Number.isFinite(Number(meta?.sizeBytes)) ? { sizeBytes: Number(meta?.sizeBytes) } : {}),
            ...(Number.isFinite(Number(meta?.rawSizeBytes)) ? { rawSizeBytes: Number(meta?.rawSizeBytes) } : {}),
            ...(hasVersion ? {} : { legacy: true }),
        };
    }

    /**
     * True when the store holds a VERSIONED snapshot for this session. The
     * legacy write paths below must never clobber one: the versioned chain
     * is CAS-protected truth that another worker may have advanced, and an
     * unconditional legacy overwrite would both destroy the version
     * metadata and potentially roll the content back (review findings:
     * unfenced-legacy-write class).
     */
    private hasVersionedSnapshot(sessionId: string): boolean {
        const probe = this.probeUnlocked(sessionId);
        return probe.exists && !probe.legacy;
    }

    async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (this.hasVersionedSnapshot(sessionId)) {
            // Versioned-snapshot fence: the committed chain already holds
            // this session's durable state. Dehydrate degrades to release —
            // free the local files, write nothing.
            console.warn(
                `[FilesystemSessionStore] dehydrate(${sessionId}) skipped upload: a versioned snapshot exists; releasing local files only`,
            );
            fs.rmSync(sessionDir, { recursive: true, force: true });
            return;
        }
        const snapshot = await waitForSessionSnapshot(this.sessionStateDir, sessionId);
        if (!snapshot.ready) {
            throw new Error(
                `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                `Missing: ${snapshot.missing.join(", ") || "unknown"}`,
            );
        }

        // Staged write + rename: a concurrent reader never sees a torn tar.
        // Fixed `.tar.gz` filename is retained for legacy compatibility; the
        // codec recorded in meta is authoritative (this write is brotli).
        const codec = DEFAULT_SNAPSHOT_CODEC;
        const tarPath = this.tarPath(sessionId);
        const staged = `${tarPath}.staging-${process.pid}-${Date.now()}`;
        const { rawSizeBytes } = await archiveSessionDir(this.sessionStateDir, sessionId, staged, codec);
        if (!fs.existsSync(staged)) {
            throw new Error(`Session archive was not created during dehydrate: ${sessionId} (${staged})`);
        }
        const metadata = buildMetadata(staged, sessionId, { ...meta, codec, rawSizeBytes });
        fs.renameSync(staged, tarPath);
        const tmpMeta = `${this.metaPath(sessionId)}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpMeta, JSON.stringify(metadata));
        fs.renameSync(tmpMeta, this.metaPath(sessionId));
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    async hydrate(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const meta = this.readStoredMeta(sessionId);
        const tarPath = this.currentTarPath(sessionId, meta);
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Session archive not found: ${sessionId}`);
        }
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        await extractSessionArchive(this.sessionStateDir, tarPath, this.storedCodec(meta));
    }

    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (!fs.existsSync(sessionDir)) return;
        if (this.hasVersionedSnapshot(sessionId)) {
            // Versioned-snapshot fence: per-turn commits supersede legacy
            // checkpoints; overwriting would destroy the CAS metadata.
            console.warn(
                `[FilesystemSessionStore] checkpoint(${sessionId}) skipped: a versioned snapshot exists`,
            );
            return;
        }

        const codec = DEFAULT_SNAPSHOT_CODEC;
        const tarPath = this.tarPath(sessionId);
        const staged = `${tarPath}.staging-${process.pid}-${Date.now()}`;
        const { rawSizeBytes } = await archiveSessionDir(this.sessionStateDir, sessionId, staged, codec);
        const metadata = buildMetadata(staged, sessionId, { reason: "checkpoint", codec, rawSizeBytes });
        fs.renameSync(staged, tarPath);
        const tmpMeta = `${this.metaPath(sessionId)}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpMeta, JSON.stringify(metadata));
        fs.renameSync(tmpMeta, this.metaPath(sessionId));
    }
    async getSnapshotSizeBytes(sessionId: string): Promise<number | undefined> {
        try {
            const metadataPath = this.metaPath(sessionId);
            if (fs.existsSync(metadataPath)) {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as SessionMetadata;
                const sizeBytes = Number(metadata?.sizeBytes);
                if (Number.isFinite(sizeBytes)) return sizeBytes;
            }
        } catch {}

        try {
            const tarPath = this.currentTarPath(sessionId, this.readStoredMeta(sessionId));
            if (fs.existsSync(tarPath)) {
                const sizeBytes = fs.statSync(tarPath).size;
                if (Number.isFinite(sizeBytes)) return sizeBytes;
            }
        } catch {}

        return undefined;
    }

    async exists(sessionId: string): Promise<boolean> {
        return fs.existsSync(this.currentTarPath(sessionId, this.readStoredMeta(sessionId)));
    }

    async delete(sessionId: string): Promise<void> {
        const meta = this.readStoredMeta(sessionId);
        try { fs.unlinkSync(this.currentTarPath(sessionId, meta)); } catch {}
        try { fs.unlinkSync(this.tarPath(sessionId)); } catch {}
        try { fs.unlinkSync(this.metaPath(sessionId)); } catch {}
    }
}

/**
 * Interface for artifact (file) storage.
 * Implemented by both SessionBlobStore (Azure Blob) and FilesystemArtifactStore (local disk).
 */
export interface ArtifactStore {
    uploadArtifact(
        sessionId: string,
        filename: string,
        content: string | Buffer,
        contentType?: string,
        opts?: ArtifactUploadOptions,
    ): Promise<ArtifactMetadata>;
    downloadArtifact(sessionId: string, filename: string): Promise<ArtifactDownloadResult>;
    downloadArtifactText(sessionId: string, filename: string): Promise<string>;
    listArtifacts(sessionId: string): Promise<ArtifactMetadata[]>;
    deleteArtifact(sessionId: string, filename: string): Promise<boolean>;
    artifactExists(sessionId: string, filename: string): Promise<boolean>;
}

const DEFAULT_ARTIFACT_DIR = path.join(os.homedir(), ".copilot", "artifacts");

/**
 * Filesystem-based artifact store for local mode (no Azure Blob).
 * Stores artifacts as plain files under `<artifactDir>/<sessionId>/<filename>`.
 * @internal
 */
export class FilesystemArtifactStore implements ArtifactStore {
    private artifactDir: string;

    constructor(artifactDir = DEFAULT_ARTIFACT_DIR) {
        this.artifactDir = artifactDir;
        fs.mkdirSync(this.artifactDir, { recursive: true });
    }

    private safePath(sessionId: string, filename: string): string {
        // Both segments are attacker-influenced when reached over the Web API
        // (the sessionId path param decodes %2F to "/"). Collapse any path
        // separators in each, then verify the resolved path stays inside the
        // artifact dir so "../" traversal cannot escape the sandbox.
        const safeSession = String(sessionId).replace(/[/\\]/g, "_");
        const safeFile = String(filename).replace(/[/\\]/g, "_");
        const resolved = path.resolve(this.artifactDir, safeSession, safeFile);
        const root = path.resolve(this.artifactDir) + path.sep;
        if (!resolved.startsWith(root)) {
            throw new Error(`Invalid artifact path for session ${sessionId}`);
        }
        return resolved;
    }

    private metadataPath(sessionId: string, filename: string): string {
        return `${this.safePath(sessionId, filename)}.meta.json`;
    }

    private writeFileAtomic(targetPath: string, body: Buffer | string): void {
        const tmpPath = `${targetPath}.tmp`;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(tmpPath, body);
        fs.renameSync(tmpPath, targetPath);
    }

    private readStoredMetadata(sessionId: string, filename: string): Partial<ArtifactMetadata> | null {
        const metaPath = this.metadataPath(sessionId, filename);
        if (!fs.existsSync(metaPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        } catch {
            return null;
        }
    }

    private async buildMetadata(sessionId: string, filename: string, stat?: fs.Stats): Promise<ArtifactMetadata> {
        const filePath = this.safePath(sessionId, filename);
        const fileStat = stat || fs.statSync(filePath);
        const stored = this.readStoredMetadata(sessionId, filename);
        if (stored?.contentType) {
            return metadataFromStat(filename, fileStat, stored);
        }
        const body = fs.readFileSync(filePath);
        const detectedType = await sniffArtifactContentType(body);
        return metadataFromStat(filename, fileStat, {
            contentType: detectedType || DEFAULT_ARTIFACT_CONTENT_TYPE,
            source: stored?.source || DEFAULT_ARTIFACT_SOURCE,
            uploadedAt: stored?.uploadedAt,
        });
    }

    async uploadArtifact(
        sessionId: string,
        filename: string,
        content: string | Buffer,
        contentType?: string,
        opts: ArtifactUploadOptions = {},
    ): Promise<ArtifactMetadata> {
        const safeFilename = path.basename(String(filename || "").trim());
        if (!safeFilename) {
            throw createArtifactError("ARTIFACT_FILENAME_REQUIRED", "Artifact filename is required.");
        }
        const { body, metadata } = await resolveArtifactUpload(content, contentType, opts);
        const filePath = this.safePath(sessionId, filename);
        const uploadedAt = new Date().toISOString();
        this.writeFileAtomic(filePath, body);
        this.writeFileAtomic(
            this.metadataPath(sessionId, filename),
            JSON.stringify({ filename: safeFilename, uploadedAt, ...metadata }, null, 2),
        );
        return {
            filename: safeFilename,
            uploadedAt,
            ...metadata,
        };
    }

    async downloadArtifact(sessionId: string, filename: string): Promise<ArtifactDownloadResult> {
        const filePath = this.safePath(sessionId, filename);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Artifact not found: ${filename} in session ${sessionId}`);
        }
        const body = fs.readFileSync(filePath);
        const metadata = await this.buildMetadata(sessionId, filename, fs.statSync(filePath));
        return {
            ...metadata,
            body,
        };
    }

    async downloadArtifactText(sessionId: string, filename: string): Promise<string> {
        const result = await this.downloadArtifact(sessionId, filename);
        if (result.isBinary) {
            throw createArtifactError(
                "ARTIFACT_IS_BINARY",
                `Artifact '${filename}' is binary and cannot be read as text.`,
                {
                    contentType: result.contentType,
                    sizeBytes: result.sizeBytes,
                },
            );
        }
        return result.body.toString("utf8");
    }

    async listArtifacts(sessionId: string): Promise<ArtifactMetadata[]> {
        const dir = path.join(this.artifactDir, String(sessionId).replace(/[/\\]/g, "_"));
        if (!fs.existsSync(dir)) return [];
        const filenames = fs.readdirSync(dir)
            .filter((file) => !file.startsWith(".") && !file.endsWith(".meta.json"));
        return Promise.all(filenames.map(async (filename) => this.buildMetadata(sessionId, filename)));
    }

    async deleteArtifact(sessionId: string, filename: string): Promise<boolean> {
        const filePath = this.safePath(sessionId, filename);
        const metaPath = this.metadataPath(sessionId, filename);
        let deleted = false;

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deleted = true;
        }
        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
        }

        return deleted;
    }

    async artifactExists(sessionId: string, filename: string): Promise<boolean> {
        return fs.existsSync(this.safePath(sessionId, filename));
    }
}

export {
    DEFAULT_ARTIFACT_DIR,
    DEFAULT_FILESYSTEM_STORE_DIR,
    DEFAULT_SESSION_STATE_DIR,
    archiveSessionDir,
    buildMetadata,
    extractSessionArchive,
    waitForSessionSnapshot,
};
