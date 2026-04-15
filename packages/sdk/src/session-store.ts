import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    execSync(`tar czf "${tarPath}" -C "${sessionStateDir}" "${sessionId}"`);
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

async function waitForSessionSnapshot(
    sessionStateDir: string,
    sessionId: string,
    timeoutMs = 5_000,
    pollMs = 100,
    stablePolls = 3,
): Promise<{ ready: boolean; missing: string[] }> {
    const sessionDir = path.join(sessionStateDir, sessionId);
    let lastSignature = "";
    let stableCount = 0;
    let missing = [`${sessionId}/`];

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!fs.existsSync(sessionDir)) {
            missing = [`${sessionId}/`];
            stableCount = 0;
            lastSignature = "";
        } else {
            missing = REQUIRED_SESSION_FILES
                .filter((file) => !fs.existsSync(path.join(sessionDir, file)))
                .map((file) => `${sessionId}/${file}`);

            if (missing.length === 0) {
                const snapshotEntries = collectSessionSnapshotEntries(sessionDir);

                // Support both the current Copilot session layout and older
                // layouts that included events.jsonl. We intentionally ignore
                // inuse.*.lock churn so active sessions can stabilize.
                const hasCurrentLayoutSignal = snapshotEntries.some((entry) => {
                    const relPath = entry.split(":")[1] || "";
                    return relPath === "workspace.yaml"
                        || relPath === "checkpoints"
                        || relPath.startsWith("checkpoints/")
                        || relPath === "files"
                        || relPath.startsWith("files/")
                        || relPath === "research"
                        || relPath.startsWith("research/");
                });
                const hasLegacyLayoutSignal = LEGACY_SESSION_FILES.every((file) =>
                    fs.existsSync(path.join(sessionDir, file)),
                );

                if (!hasCurrentLayoutSignal && !hasLegacyLayoutSignal) {
                    missing = [`${sessionId}/workspace.yaml or legacy session files`];
                    stableCount = 0;
                    lastSignature = "";
                    await new Promise((resolve) => setTimeout(resolve, pollMs));
                    continue;
                }

                const signature = snapshotEntries.join("|");

                if (signature === lastSignature) {
                    stableCount += 1;
                } else {
                    lastSignature = signature;
                    stableCount = 1;
                }

                if (stableCount >= stablePolls) {
                    return { ready: true, missing: [] };
                }
            } else {
                stableCount = 0;
                lastSignature = "";
            }
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (missing.length === 0) {
        missing = [`${sessionId}/snapshot still changing`];
    }
    return { ready: false, missing };
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
    uploadArtifact(sessionId: string, filename: string, content: string, contentType?: string): Promise<string>;
    downloadArtifact(sessionId: string, filename: string): Promise<string>;
    listArtifacts(sessionId: string): Promise<string[]>;
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

    async uploadArtifact(
        sessionId: string,
        filename: string,
        content: string,
        _contentType = "text/markdown",
    ): Promise<string> {
        const MAX_SIZE = 1_048_576; // 1MB
        if (content.length > MAX_SIZE) {
            throw new Error(`Artifact too large: ${content.length} bytes (max ${MAX_SIZE})`);
        }
        const filePath = this.safePath(sessionId, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        return filePath;
    }

    async downloadArtifact(sessionId: string, filename: string): Promise<string> {
        const filePath = this.safePath(sessionId, filename);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Artifact not found: ${filename} in session ${sessionId}`);
        }
        return fs.readFileSync(filePath, "utf-8");
    }

    async listArtifacts(sessionId: string): Promise<string[]> {
        const dir = path.join(this.artifactDir, sessionId);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => !f.startsWith("."));
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
