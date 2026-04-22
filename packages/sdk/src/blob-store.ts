import {
    BlobServiceClient,
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters,
    BlobSASPermissions,
    SASProtocol,
} from "@azure/storage-blob";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    DEFAULT_SESSION_STATE_DIR,
    type ArtifactDownloadResult,
    type ArtifactMetadata,
    type SessionMetadata,
    type SessionStateStore,
    type ArtifactStore,
    type ArtifactUploadOptions,
    archiveSessionDir,
    buildMetadata,
    extractSessionArchive,
    isBinaryArtifactContentType,
    normalizeArtifactContentType,
    resolveArtifactUpload,
    waitForSessionSnapshot,
} from "./session-store.js";

function formatBlobLogValue(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function logBlobStore(
    level: "info" | "warn" | "error",
    sessionId: string,
    message: string,
    details: Record<string, unknown> = {},
): void {
    const suffix = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${formatBlobLogValue(value)}`)
        .join(" ");
    const line =
        `[SessionBlobStore] session=${sessionId} orch=session-${sessionId} ${message}` +
        (suffix ? ` ${suffix}` : "");

    if (level === "warn") {
        console.warn(line);
        return;
    }
    if (level === "error") {
        console.error(line);
        return;
    }
    console.info(line);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Manages session state in Azure Blob Storage.
 *
 * - `dehydrate()` — tar + upload session dir, remove local files
 * - `hydrate()` — download + untar session dir
 * - `checkpoint()` — tar + upload without removing local files
 * - `exists()` / `delete()` — blob lifecycle
 *
 * @internal
 */
export class SessionBlobStore implements SessionStateStore, ArtifactStore {
    private containerClient;
    private connectionString: string;
    private containerName: string;
    private credential: StorageSharedKeyCredential | null = null;
    private sessionStateDir: string;
    private snapshotSizeBySession = new Map<string, number>();

    constructor(connectionString: string, containerName = "copilot-sessions", sessionStateDir?: string) {
        this.connectionString = connectionString;
        this.containerName = containerName;
        this.sessionStateDir = sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
        const blobService = BlobServiceClient.fromConnectionString(connectionString);
        this.containerClient = blobService.getContainerClient(containerName);

        // Parse account name + key from connection string for SAS generation
        const accountMatch = connectionString.match(/AccountName=([^;]+)/i);
        const keyMatch = connectionString.match(/AccountKey=([^;]+)/i);
        if (accountMatch && keyMatch) {
            this.credential = new StorageSharedKeyCredential(accountMatch[1], keyMatch[1]);
        }
    }

    /**
     * Dehydrate a session: tar, upload, remove local files.
     * Frees the worker slot for another session.
     */
    async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        logBlobStore("info", sessionId, "dehydrate start", {
            container: this.containerName,
            dir: sessionDir,
            reason: meta?.reason,
        });
        const snapshot = await waitForSessionSnapshot(this.sessionStateDir, sessionId);
        if (!snapshot.ready) {
            logBlobStore("warn", sessionId, "dehydrate snapshot not ready", {
                container: this.containerName,
                missing: snapshot.missing.join(", ") || "unknown",
            });
            throw new Error(
                `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                `Missing: ${snapshot.missing.join(", ") || "unknown"}`,
            );
        }

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
            const tarSizeBytes = fs.existsSync(tarPath) ? fs.statSync(tarPath).size : undefined;

            // Upload tar
            const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
            logBlobStore("info", sessionId, "dehydrate upload tar", {
                container: this.containerName,
                blob: `${sessionId}.tar.gz`,
                tarSizeBytes,
            });
            await tarBlob.uploadFile(tarPath);

            // Upload metadata
            const metadata: SessionMetadata = buildMetadata(tarPath, sessionId, meta);
            this.snapshotSizeBySession.set(sessionId, metadata.sizeBytes);
            const metaBlob = this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`);
            const metaJson = JSON.stringify(metadata);
            logBlobStore("info", sessionId, "dehydrate upload metadata", {
                container: this.containerName,
                blob: `${sessionId}.meta.json`,
                metadataBytes: metaJson.length,
            });
            await metaBlob.upload(metaJson, metaJson.length);

            // Remove local files
            fs.rmSync(sessionDir, { recursive: true, force: true });
            logBlobStore("info", sessionId, "dehydrate complete", {
                container: this.containerName,
                tarSizeBytes,
            });
        } catch (error: unknown) {
            logBlobStore("warn", sessionId, "dehydrate failed", {
                container: this.containerName,
                error: errorMessage(error),
            });
            throw error;
        } finally {
            // Always clean up temp tar
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    /**
     * Hydrate a session: download tar from blob, extract to local disk.
     * No-op if local session files already exist.
     */
    async hydrate(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        logBlobStore("info", sessionId, "hydrate start", {
            container: this.containerName,
            dir: sessionDir,
        });

        // Always download from blob — overwrite any stale local files
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);

        try {
            logBlobStore("info", sessionId, "hydrate download tar", {
                container: this.containerName,
                blob: `${sessionId}.tar.gz`,
            });
            await tarBlob.downloadToFile(tarPath);
            extractSessionArchive(this.sessionStateDir, tarPath);
            logBlobStore("info", sessionId, "hydrate complete", {
                container: this.containerName,
                restoredDir: sessionDir,
            });
        } catch (error: unknown) {
            logBlobStore("warn", sessionId, "hydrate failed", {
                container: this.containerName,
                blob: `${sessionId}.tar.gz`,
                error: errorMessage(error),
            });
            throw error;
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    /**
     * Checkpoint: upload current session state to blob without removing local files.
     * Used for crash resilience — the session stays warm in memory.
     */
    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (!fs.existsSync(sessionDir)) {
            logBlobStore("info", sessionId, "checkpoint skipped", {
                container: this.containerName,
                reason: "local session dir missing",
            });
            return;
        }

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            logBlobStore("info", sessionId, "checkpoint start", {
                container: this.containerName,
                dir: sessionDir,
            });
            archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
            const tarSizeBytes = fs.existsSync(tarPath) ? fs.statSync(tarPath).size : undefined;

            const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
            await tarBlob.uploadFile(tarPath);

            // Update metadata to reflect checkpoint (not full dehydration)
            const metadata: SessionMetadata = buildMetadata(tarPath, sessionId, { reason: "checkpoint" });
            this.snapshotSizeBySession.set(sessionId, metadata.sizeBytes);
            const metaBlob = this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`);
            const metaJson = JSON.stringify(metadata);
            await metaBlob.upload(metaJson, metaJson.length);
            logBlobStore("info", sessionId, "checkpoint complete", {
                container: this.containerName,
                tarSizeBytes,
                metadataBytes: metaJson.length,
            });
        } catch (error: unknown) {
            logBlobStore("warn", sessionId, "checkpoint failed", {
                container: this.containerName,
                error: errorMessage(error),
            });
            throw error;
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    async getSnapshotSizeBytes(sessionId: string): Promise<number | undefined> {
        const cached = this.snapshotSizeBySession.get(sessionId);
        if (Number.isFinite(cached)) return cached;

        const metaBlob = this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`);
        try {
            if (!(await metaBlob.exists())) {
                return undefined;
            }
            const response = await metaBlob.download(0);
            const chunks: Buffer[] = [];
            for await (const chunk of response.readableStreamBody!) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const metadata = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as SessionMetadata;
            const sizeBytes = Number(metadata?.sizeBytes);
            if (Number.isFinite(sizeBytes)) {
                this.snapshotSizeBySession.set(sessionId, sizeBytes);
                return sizeBytes;
            }
        } catch (error: unknown) {
            logBlobStore("warn", sessionId, "snapshot size read failed", {
                container: this.containerName,
                blob: `${sessionId}.meta.json`,
                error: errorMessage(error),
            });
        }

        return undefined;
    }

    /** Check if a dehydrated session exists in blob storage. */
    async exists(sessionId: string): Promise<boolean> {
        const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
        try {
            const exists = await tarBlob.exists();
            logBlobStore("info", sessionId, "exists probe", {
                container: this.containerName,
                blob: `${sessionId}.tar.gz`,
                exists,
            });
            return exists;
        } catch (error: unknown) {
            logBlobStore("warn", sessionId, "exists probe failed", {
                container: this.containerName,
                blob: `${sessionId}.tar.gz`,
                error: errorMessage(error),
            });
            throw error;
        }
    }

    /** Delete a dehydrated session from blob storage. */
    async delete(sessionId: string): Promise<void> {
        logBlobStore("info", sessionId, "delete start", {
            container: this.containerName,
        });
        try {
            await this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`).deleteIfExists();
            await this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`).deleteIfExists();
            logBlobStore("info", sessionId, "delete complete", {
                container: this.containerName,
            });
        } catch (error: unknown) {
            logBlobStore("warn", sessionId, "delete failed", {
                container: this.containerName,
                error: errorMessage(error),
            });
            throw error;
        }
    }

    // ─── Artifact Storage ────────────────────────────────────

    private artifactBlobPath(sessionId: string, filename: string): string {
        // Sanitize filename — strip path separators
        const safe = filename.replace(/[/\\]/g, "_");
        return `artifacts/${sessionId}/${safe}`;
    }

    /**
     * Upload an artifact file (e.g. .md) to blob storage.
     * Max 1MB content.
     */
    async uploadArtifact(
        sessionId: string,
        filename: string,
        content: string | Buffer,
        contentType?: string,
        opts: ArtifactUploadOptions = {},
    ): Promise<ArtifactMetadata> {
        const safeFilename = path.basename(String(filename || "").trim());
        const { body, metadata } = await resolveArtifactUpload(content, contentType, opts);
        const blobPath = this.artifactBlobPath(sessionId, filename);
        const blob = this.containerClient.getBlockBlobClient(blobPath);
        const uploadedAt = new Date().toISOString();
        await blob.upload(body, body.length, {
            blobHTTPHeaders: { blobContentType: metadata.contentType },
            metadata: {
                source: metadata.source,
                uploadedAt,
            },
        });
        return {
            filename: safeFilename,
            uploadedAt,
            ...metadata,
        };
    }

    /**
     * Download an artifact file from blob storage.
     * Returns the file content as a string.
     */
    async downloadArtifact(sessionId: string, filename: string): Promise<ArtifactDownloadResult> {
        const blobPath = this.artifactBlobPath(sessionId, filename);
        const blob = this.containerClient.getBlockBlobClient(blobPath);
        const response = await blob.download(0);
        const chunks: Buffer[] = [];
        for await (const chunk of response.readableStreamBody!) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const contentType = normalizeArtifactContentType(response.contentType || undefined);
        return {
            filename: path.basename(filename),
            sizeBytes: Number(response.contentLength) || body.length,
            contentType,
            isBinary: isBinaryArtifactContentType(contentType),
            uploadedAt: response.lastModified?.toISOString() || new Date().toISOString(),
            source: (response.metadata?.source as ArtifactMetadata["source"]) || "agent",
            body,
        };
    }

    async downloadArtifactText(sessionId: string, filename: string): Promise<string> {
        const result = await this.downloadArtifact(sessionId, filename);
        if (result.isBinary) {
            const error = new Error(`Artifact '${filename}' is binary and cannot be read as text.`) as Error & Record<string, unknown>;
            error.code = "ARTIFACT_IS_BINARY";
            error.contentType = result.contentType;
            error.sizeBytes = result.sizeBytes;
            throw error;
        }
        return result.body.toString("utf8");
    }

    /**
     * List artifact files for a session.
     * Returns filenames (not full blob paths).
     */
    async listArtifacts(sessionId: string): Promise<ArtifactMetadata[]> {
        const prefix = `artifacts/${sessionId}/`;
        const files: ArtifactMetadata[] = [];
        for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
            const filename = blob.name.slice(prefix.length);
            const blobClient = this.containerClient.getBlockBlobClient(blob.name);
            const properties = await blobClient.getProperties();
            const contentType = normalizeArtifactContentType(properties.contentType || undefined);
            files.push({
                filename,
                sizeBytes: Number(properties.contentLength) || 0,
                contentType,
                isBinary: isBinaryArtifactContentType(contentType),
                uploadedAt: properties.lastModified?.toISOString() || new Date().toISOString(),
                source: (properties.metadata?.source as ArtifactMetadata["source"]) || "agent",
            });
        }
        return files;
    }

    async deleteArtifact(sessionId: string, filename: string): Promise<boolean> {
        const blobPath = this.artifactBlobPath(sessionId, filename);
        const result = await this.containerClient.getBlockBlobClient(blobPath).deleteIfExists();
        return result.succeeded === true;
    }

    /**
     * Check if an artifact exists.
     */
    async artifactExists(sessionId: string, filename: string): Promise<boolean> {
        const blobPath = this.artifactBlobPath(sessionId, filename);
        return this.containerClient.getBlockBlobClient(blobPath).exists();
    }

    /**
     * Generate a short-lived read-only SAS URL for an artifact.
     * The TUI uses this to download files without needing blob credentials.
     *
     * @param sessionId  Session that owns the artifact
     * @param filename   Artifact filename
     * @param expiryMinutes  How long the URL is valid (default: 1 minute)
     * @returns Full SAS URL string
     */
    generateArtifactSasUrl(
        sessionId: string,
        filename: string,
        expiryMinutes = 1,
    ): string {
        if (!this.credential) {
            throw new Error("Cannot generate SAS URL: connection string has no AccountKey");
        }

        const blobPath = this.artifactBlobPath(sessionId, filename);
        const now = new Date();
        const expiresOn = new Date(now.getTime() + expiryMinutes * 60_000);

        const sas = generateBlobSASQueryParameters(
            {
                containerName: this.containerName,
                blobName: blobPath,
                permissions: BlobSASPermissions.parse("r"),
                startsOn: now,
                expiresOn,
                protocol: SASProtocol.Https,
            },
            this.credential,
        );

        const blob = this.containerClient.getBlockBlobClient(blobPath);
        return `${blob.url}?${sas.toString()}`;
    }

    /**
     * Delete all artifacts for a session.
     */
    async deleteArtifacts(sessionId: string): Promise<number> {
        const prefix = `artifacts/${sessionId}/`;
        let count = 0;
        for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
            await this.containerClient.getBlockBlobClient(blob.name).deleteIfExists();
            count++;
        }
        return count;
    }
}
