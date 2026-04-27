import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const DEFAULT_FILESYSTEM_STORE_DIR = path.join(os.homedir(), ".copilot", "session-store");

export interface SessionMetadata {
    sessionId: string;
    dehydratedAt: string;
    worker: string;
    sizeBytes: number;
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

function tarFileName(sessionId: string): string {
    return `${sessionId}.tar.gz`;
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

function archiveSessionDir(sessionStateDir: string, sessionId: string, tarPath: string): void {
    // Exclude live `inuse.<pid>.lock` files: they are scoped to the live SDK
    // process and would resurrect a stale lock when extracted on another node.
    execSync(
        `tar --exclude='inuse.*.lock' -czf "${tarPath}" -C "${sessionStateDir}" "${sessionId}"`,
    );
}

function extractSessionArchive(sessionStateDir: string, tarPath: string): void {
    fs.mkdirSync(sessionStateDir, { recursive: true });
    execSync(`tar xzf "${tarPath}" -C "${sessionStateDir}"`);
}

async function waitForPath(pathToCheck: string, timeoutMs = 5_000, pollMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(pathToCheck)) return true;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return fs.existsSync(pathToCheck);
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

export class FilesystemSessionStore implements SessionStateStore {
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

    async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const snapshot = await waitForSessionSnapshot(this.sessionStateDir, sessionId);
        if (!snapshot.ready) {
            throw new Error(
                `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                `Missing: ${snapshot.missing.join(", ") || "unknown"}`,
            );
        }

        const tarPath = this.tarPath(sessionId);
        archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Session archive was not created during dehydrate: ${sessionId} (${tarPath})`);
        }
        const metadata = buildMetadata(tarPath, sessionId, meta);
        fs.writeFileSync(this.metaPath(sessionId), JSON.stringify(metadata));
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    async hydrate(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const tarPath = this.tarPath(sessionId);
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Session archive not found: ${sessionId}`);
        }
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        extractSessionArchive(this.sessionStateDir, tarPath);
    }

    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        const tarPath = this.tarPath(sessionId);
        archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
        const metadata = buildMetadata(tarPath, sessionId, { reason: "checkpoint" });
        fs.writeFileSync(this.metaPath(sessionId), JSON.stringify(metadata));
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
            const tarPath = this.tarPath(sessionId);
            if (fs.existsSync(tarPath)) {
                const sizeBytes = fs.statSync(tarPath).size;
                if (Number.isFinite(sizeBytes)) return sizeBytes;
            }
        } catch {}

        return undefined;
    }

    async exists(sessionId: string): Promise<boolean> {
        return fs.existsSync(this.tarPath(sessionId));
    }

    async delete(sessionId: string): Promise<void> {
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
        const safe = filename.replace(/[/\\]/g, "_");
        return path.join(this.artifactDir, sessionId, safe);
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
        const dir = path.join(this.artifactDir, sessionId);
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
