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
    isLegacyEpoch,
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

/**
 * `epoch` scopes every operation to one snapshot key family (see the epoch
 * key-scoping contract in snapshot-protocol.ts): absent/0 is the legacy
 * layout every pre-regen session keeps forever; >= 1 addresses that epoch's
 * own chain. The legacy (non-versioned) write paths only ever run for
 * epoch 0 — epoch chains are versioned-only and go through the
 * {@link VersionedSnapshotStore} methods.
 */
export interface SessionStateStore {
    dehydrate(sessionId: string, meta?: Record<string, unknown>, epoch?: number): Promise<void>;
    hydrate(sessionId: string, epoch?: number): Promise<void>;
    checkpoint(sessionId: string, epoch?: number): Promise<void>;
    getSnapshotSizeBytes(sessionId: string, epoch?: number): Promise<number | undefined>;
    exists(sessionId: string, epoch?: number): Promise<boolean>;
    /** With epoch >= 1 removes ONLY that epoch's chain; absent/0 removes the legacy family. */
    delete(sessionId: string, epoch?: number): Promise<void>;
    /** Remove the legacy family AND every epoch chain (real session deletion). */
    deleteAllEpochs(sessionId: string): Promise<void>;
}

export type ArtifactEncoding = "utf-8" | "base64";
export type ArtifactSource = "agent" | "user" | "system" | "file" | "copy";

export interface ArtifactMetadata {
    filename: string;
    sizeBytes: number;
    contentType: string;
    isBinary: boolean;
    uploadedAt: string;
    source: ArtifactSource;
    /** SHA-256 (hex) of the stored bytes. Absent only on legacy artifacts written before digests. */
    sha256?: string;
    /** How the bytes arrived when source is "file" or "copy" (origin path / artifact ref). */
    sourceDetail?: string;
    /** Pinned artifacts survive session cleanup (deleteArtifacts skips them by default). */
    pinned?: boolean;
}

export interface ArtifactUploadOptions {
    encoding?: ArtifactEncoding;
    source?: ArtifactSource;
    sourceDetail?: string;
    pinned?: boolean;
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
            sha256: crypto.createHash("sha256").update(body).digest("hex"),
            ...(opts.sourceDetail ? { sourceDetail: opts.sourceDetail } : {}),
            ...(opts.pinned ? { pinned: true } : {}),
        },
    };
}

const DEFAULT_FILE_ARTIFACT_MAX_BYTES = 268_435_456; // 256MB — never transits a context window

export function getFileArtifactMaxBytes(): number {
    const raw = Number(process.env.PILOTSWARM_ARTIFACT_FILE_MAX_BYTES);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FILE_ARTIFACT_MAX_BYTES;
}

/**
 * Resolve metadata for a data-plane upload from a local file: size gate,
 * streamed SHA-256, and content-type sniffing from the head bytes. The
 * body is never buffered whole — stores stream the file themselves.
 */
export async function resolveArtifactFileUpload(
    filePath: string,
    contentType?: string,
    opts: ArtifactUploadOptions = {},
): Promise<{ metadata: Omit<ArtifactMetadata, "filename" | "uploadedAt"> }> {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw createArtifactError("ARTIFACT_INVALID_CONTENT", `Not a regular file: ${filePath}`);
    }
    const maxBytes = getFileArtifactMaxBytes();
    if (stat.size > maxBytes) {
        throw createArtifactError(
            "ARTIFACT_TOO_LARGE",
            `File too large for artifact upload: ${stat.size} bytes (max ${maxBytes})`,
            { maxBytes, actualBytes: stat.size },
        );
    }

    const hash = crypto.createHash("sha256");
    const headChunks: Buffer[] = [];
    let headBytes = 0;
    await pipeline(
        fs.createReadStream(filePath),
        new Transform({
            transform(chunk, _enc, cb) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                hash.update(buf);
                if (headBytes < 4100) {
                    headChunks.push(buf.subarray(0, 4100 - headBytes));
                    headBytes += headChunks[headChunks.length - 1].length;
                }
                cb();
            },
        }),
    );
    const sha256 = hash.digest("hex");
    const head = Buffer.concat(headChunks);
    const detectedType = await sniffArtifactContentType(head);
    // file-type only recognizes binary magic bytes; NUL-free UTF-8 heads are text.
    const looksLikeText = !detectedType && !head.includes(0) && isValidUtf8(head);
    const normalizedContentType = contentType
        ? normalizeArtifactContentType(contentType)
        : (detectedType || (looksLikeText ? "text/plain" : OCTET_STREAM_CONTENT_TYPE));
    if (contentType && !isCompatibleDetectedArtifactType(normalizedContentType, detectedType)) {
        throw createArtifactError(
            "ARTIFACT_CONTENT_TYPE_MISMATCH",
            `Artifact content type mismatch: declared ${normalizedContentType}, detected ${detectedType}`,
            { declaredType: normalizedContentType, detectedType },
        );
    }

    return {
        metadata: {
            sizeBytes: stat.size,
            contentType: normalizedContentType,
            isBinary: isBinaryArtifactContentType(normalizedContentType),
            source: opts.source || "file",
            sha256,
            ...(opts.sourceDetail ? { sourceDetail: opts.sourceDetail } : {}),
            ...(opts.pinned ? { pinned: true } : {}),
        },
    };
}

function isValidUtf8(buf: Buffer): boolean {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return true;
    } catch {
        return false;
    }
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
        ...(stored?.sha256 ? { sha256: stored.sha256 } : {}),
        ...(stored?.sourceDetail ? { sourceDetail: stored.sourceDetail } : {}),
        ...(stored?.pinned ? { pinned: true } : {}),
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

// ─── Epoch-scoped names (session regeneration) ──────────────────────────────
//
// Epoch chains (>= 1) are brotli-only, so the names bake `.tar.br`. The blob
// variant of this family must NEVER end `.tar.gz` — that is the only shape
// old resource-manager purge binaries collect as delete candidates, and the
// name invisibility (not fail-closed parsing in new code) is what protects
// retained epochs from them. See the key-shape invariant in
// snapshot-protocol.ts. The filesystem store is worker-local and never
// exposed to the blob purge tool, so its meta name is unconstrained.

/** Filesystem epoch-chain tar: `S.e<E>.v<N>.tar.br`. */
export function epochVersionedTarFileName(sessionId: string, epoch: number, version: number): string {
    return `${sessionId}.e${epoch}.v${version}.tar.br`;
}

/** Filesystem epoch-chain meta: `S.e<E>.meta.json` (worker-local only). */
export function epochMetaFileName(sessionId: string, epoch: number): string {
    return `${sessionId}.e${epoch}.meta.json`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fail-closed parse of an epoch-scoped snapshot object name. Epoch deletion
 * paths (`delete` with epoch, `deleteAllEpochs`) may remove ONLY names this
 * accepts — anything else under the `${sessionId}.e` prefix is logged and
 * left alone, so deletion can never touch a shape the stores did not write.
 */
export function parseEpochSnapshotName(
    sessionId: string,
    name: string,
): { epoch: number; version?: number; kind: "tar" | "meta" } | null {
    const escaped = escapeRegExp(sessionId);
    const tar = name.match(new RegExp(`^${escaped}\\.e(\\d+)\\.(?:v(\\d+)\\.)?tar\\.br$`));
    if (tar) {
        return {
            epoch: Number(tar[1]),
            ...(tar[2] !== undefined ? { version: Number(tar[2]) } : {}),
            kind: "tar",
        };
    }
    const meta = name.match(new RegExp(`^${escaped}\\.e(\\d+)\\.meta\\.json$`));
    if (meta) return { epoch: Number(meta[1]), kind: "meta" };
    return null;
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

    private metaPath(sessionId: string, epoch?: number): string {
        return path.join(
            this.storeDir,
            isLegacyEpoch(epoch) ? metaFileName(sessionId) : epochMetaFileName(sessionId, epoch!),
        );
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

    private readStoredMeta(sessionId: string, epoch?: number): (SessionMetadata & { version?: number; turnKey?: string; contentHash?: string; tarFile?: string }) | null {
        try {
            return JSON.parse(fs.readFileSync(this.metaPath(sessionId, epoch), "utf8"));
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

    private probeUnlocked(sessionId: string, epoch?: number): SnapshotProbe & { meta: ReturnType<FilesystemSessionStore["readStoredMeta"]> } {
        const meta = this.readStoredMeta(sessionId, epoch);
        // Epoch chains (>= 1) are always versioned and always tarFile-named;
        // there is no fixed-name fallback inside an epoch, so any other meta
        // shape reads as an absent chain.
        if (!isLegacyEpoch(epoch)
            && (!meta?.tarFile || !Number.isFinite(Number(meta.version)) || Number(meta.version) < 1)) {
            return { exists: false, version: 0, meta: null };
        }
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

    async probeSnapshot(sessionId: string, epoch?: number): Promise<SnapshotProbe> {
        const { meta: _meta, ...probe } = this.probeUnlocked(sessionId, epoch);
        return probe;
    }

    async commitSnapshot(sessionId: string, input: SnapshotCommitInput, epoch?: number): Promise<SnapshotCommitResult> {
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
        // Epoch chains pin brotli — their names bake `.tar.br` (key-shape
        // invariant) — rather than tracking the default.
        const codec: SnapshotCodec = isLegacyEpoch(epoch) ? DEFAULT_SNAPSHOT_CODEC : "brotli";
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
                const probe = this.probeUnlocked(sessionId, epoch);
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

                const versionedTarName = isLegacyEpoch(epoch)
                    ? versionedTarFileName(sessionId, version, codec)
                    : epochVersionedTarFileName(sessionId, epoch!, version);
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
                    ...(isLegacyEpoch(epoch) ? {} : { epoch }),
                };
                fs.renameSync(stagedTar, versionedTarPath);
                faultPoint("store.commit.tar-renamed");
                const tmpMeta = `${this.metaPath(sessionId, epoch)}.tmp-${process.pid}-${Date.now()}`;
                fs.writeFileSync(tmpMeta, JSON.stringify(metadata));
                fs.renameSync(tmpMeta, this.metaPath(sessionId, epoch)); // ← the commit point
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

    async hydrateSnapshot(sessionId: string, epoch?: number): Promise<SnapshotHydrateResult> {
        // Read tar + meta as one consistent unit vs. concurrent commits.
        const { stagedTar, meta } = await this.withCasLock(sessionId, () => {
            const probe = this.probeUnlocked(sessionId, epoch);
            if (!probe.exists) {
                throw new Error(
                    `Session archive not found: ${sessionId}${isLegacyEpoch(epoch) ? "" : ` (epoch ${epoch})`}`,
                );
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
    private hasVersionedSnapshot(sessionId: string, epoch?: number): boolean {
        const probe = this.probeUnlocked(sessionId, epoch);
        return probe.exists && !probe.legacy;
    }

    async dehydrate(sessionId: string, meta?: Record<string, unknown>, epoch?: number): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (this.hasVersionedSnapshot(sessionId, epoch)) {
            // Versioned-snapshot fence: the committed chain already holds
            // this session's durable state. Dehydrate degrades to release —
            // free the local files, write nothing.
            console.warn(
                `[FilesystemSessionStore] dehydrate(${sessionId}) skipped upload: a versioned snapshot exists; releasing local files only`,
            );
            fs.rmSync(sessionDir, { recursive: true, force: true });
            return;
        }
        // Epoch chains are versioned-only: the write below produces the
        // legacy (epoch-0) tar family and must never run for epoch >= 1.
        if (!isLegacyEpoch(epoch)) {
            throw new Error(
                `dehydrate(${sessionId}) reached the legacy write path with epoch ${epoch}; epoch chains commit via commitSnapshot`,
            );
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

    async hydrate(sessionId: string, epoch?: number): Promise<void> {
        // Legacy whole-dir restore; epoch chains hydrate via hydrateSnapshot
        // (atomic swap + integrity check), so this path never sees them.
        if (!isLegacyEpoch(epoch)) {
            throw new Error(
                `hydrate(${sessionId}) is the legacy path; epoch ${epoch} chains hydrate via hydrateSnapshot`,
            );
        }
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

    async checkpoint(sessionId: string, epoch?: number): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (!fs.existsSync(sessionDir)) return;
        if (this.hasVersionedSnapshot(sessionId, epoch)) {
            // Versioned-snapshot fence: per-turn commits supersede legacy
            // checkpoints; overwriting would destroy the CAS metadata.
            console.warn(
                `[FilesystemSessionStore] checkpoint(${sessionId}) skipped: a versioned snapshot exists`,
            );
            return;
        }
        // Epoch chains are versioned-only (see dehydrate).
        if (!isLegacyEpoch(epoch)) {
            throw new Error(
                `checkpoint(${sessionId}) reached the legacy write path with epoch ${epoch}; epoch chains commit via commitSnapshot`,
            );
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
    async getSnapshotSizeBytes(sessionId: string, epoch?: number): Promise<number | undefined> {
        try {
            const metadataPath = this.metaPath(sessionId, epoch);
            if (fs.existsSync(metadataPath)) {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as SessionMetadata;
                const sizeBytes = Number(metadata?.sizeBytes);
                if (Number.isFinite(sizeBytes)) return sizeBytes;
            }
        } catch {}

        try {
            const meta = this.readStoredMeta(sessionId, epoch);
            // No fixed-name tar fallback inside an epoch chain.
            if (!isLegacyEpoch(epoch) && !meta?.tarFile) return undefined;
            const tarPath = this.currentTarPath(sessionId, meta);
            if (fs.existsSync(tarPath)) {
                const sizeBytes = fs.statSync(tarPath).size;
                if (Number.isFinite(sizeBytes)) return sizeBytes;
            }
        } catch {}

        return undefined;
    }

    async exists(sessionId: string, epoch?: number): Promise<boolean> {
        if (!isLegacyEpoch(epoch)) return this.probeUnlocked(sessionId, epoch).exists;
        return fs.existsSync(this.currentTarPath(sessionId, this.readStoredMeta(sessionId)));
    }

    async delete(sessionId: string, epoch?: number): Promise<void> {
        if (!isLegacyEpoch(epoch)) {
            this.deleteEpochObjects(sessionId, epoch);
            return;
        }
        const meta = this.readStoredMeta(sessionId);
        try { fs.unlinkSync(this.currentTarPath(sessionId, meta)); } catch {}
        try { fs.unlinkSync(this.tarPath(sessionId)); } catch {}
        try { fs.unlinkSync(this.metaPath(sessionId)); } catch {}
    }

    async deleteAllEpochs(sessionId: string): Promise<void> {
        await this.delete(sessionId);
        this.deleteEpochObjects(sessionId);
    }

    /**
     * Unlink epoch-chain objects (tars + meta), optionally narrowed to one
     * epoch. Enumerates the `${sessionId}.e` prefix and removes ONLY names
     * the fail-closed parser accepts; anything else is logged and left
     * alone. Enumeration (not meta-directed deletion) also collects orphan
     * version tars left by a crash between tar rename and meta rename.
     */
    private deleteEpochObjects(sessionId: string, onlyEpoch?: number): void {
        const prefix = `${sessionId}.e`;
        let names: string[];
        try {
            names = fs.readdirSync(this.storeDir);
        } catch {
            return;
        }
        for (const name of names) {
            if (!name.startsWith(prefix)) continue;
            const parsed = parseEpochSnapshotName(sessionId, name);
            if (!parsed) {
                console.warn(
                    `[FilesystemSessionStore] deleteEpochObjects(${sessionId}) leaving unparseable name alone: ${name}`,
                );
                continue;
            }
            if (onlyEpoch !== undefined && parsed.epoch !== onlyEpoch) continue;
            try { fs.unlinkSync(path.join(this.storeDir, name)); } catch {}
        }
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
    /** Data-plane write: stream a local file into the store without buffering the whole body. */
    uploadArtifactFromFile(
        sessionId: string,
        filename: string,
        filePath: string,
        contentType?: string,
        opts?: ArtifactUploadOptions,
    ): Promise<ArtifactMetadata>;
    /** Data-plane copy between sessions; bytes never leave the store process. */
    copyArtifact(
        fromSessionId: string,
        fromFilename: string,
        toSessionId: string,
        toFilename?: string,
        opts?: ArtifactUploadOptions,
    ): Promise<ArtifactMetadata>;
    downloadArtifact(sessionId: string, filename: string): Promise<ArtifactDownloadResult>;
    downloadArtifactText(sessionId: string, filename: string): Promise<string>;
    statArtifact(sessionId: string, filename: string): Promise<ArtifactMetadata | null>;
    listArtifacts(sessionId: string): Promise<ArtifactMetadata[]>;
    setArtifactPinned(sessionId: string, filename: string, pinned: boolean): Promise<ArtifactMetadata>;
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

    async statArtifact(sessionId: string, filename: string): Promise<ArtifactMetadata | null> {
        const filePath = this.safePath(sessionId, filename);
        if (!fs.existsSync(filePath)) return null;
        return this.buildMetadata(sessionId, filename);
    }

    async uploadArtifactFromFile(
        sessionId: string,
        filename: string,
        filePath: string,
        contentType?: string,
        opts: ArtifactUploadOptions = {},
    ): Promise<ArtifactMetadata> {
        const safeFilename = path.basename(String(filename || "").trim() || filePath);
        const { metadata } = await resolveArtifactFileUpload(filePath, contentType, {
            source: "file",
            sourceDetail: filePath,
            ...opts,
        });
        const targetPath = this.safePath(sessionId, safeFilename);
        const uploadedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(filePath, `${targetPath}.tmp`);
        fs.renameSync(`${targetPath}.tmp`, targetPath);
        this.writeFileAtomic(
            this.metadataPath(sessionId, safeFilename),
            JSON.stringify({ filename: safeFilename, uploadedAt, ...metadata }, null, 2),
        );
        return { filename: safeFilename, uploadedAt, ...metadata };
    }

    async copyArtifact(
        fromSessionId: string,
        fromFilename: string,
        toSessionId: string,
        toFilename?: string,
        opts: ArtifactUploadOptions = {},
    ): Promise<ArtifactMetadata> {
        const source = await this.downloadArtifact(fromSessionId, fromFilename);
        return this.uploadArtifact(toSessionId, toFilename || source.filename, source.body, source.contentType, {
            source: "copy",
            sourceDetail: `artifact://${fromSessionId}/${source.filename}`,
            ...opts,
        });
    }

    async setArtifactPinned(sessionId: string, filename: string, pinned: boolean): Promise<ArtifactMetadata> {
        const filePath = this.safePath(sessionId, filename);
        if (!fs.existsSync(filePath)) {
            throw createArtifactError("ARTIFACT_NOT_FOUND", `Artifact not found: ${filename} in session ${sessionId}`);
        }
        const stored = this.readStoredMetadata(sessionId, filename) || {};
        const merged = { ...stored, filename: path.basename(filename), pinned };
        this.writeFileAtomic(this.metadataPath(sessionId, filename), JSON.stringify(merged, null, 2));
        return this.buildMetadata(sessionId, filename);
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
