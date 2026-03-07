import {
    BlobServiceClient,
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters,
    BlobSASPermissions,
    SASProtocol,
} from "@azure/storage-blob";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");

export interface SessionMetadata {
    sessionId: string;
    dehydratedAt: string;
    worker: string;
    sizeBytes: number;
    reason?: string;
    iteration?: number;
    [key: string]: unknown;
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
export class SessionBlobStore {
    private containerClient;
    private connectionString: string;
    private containerName: string;
    private credential: StorageSharedKeyCredential | null = null;

    constructor(connectionString: string, containerName = "copilot-sessions") {
        this.connectionString = connectionString;
        this.containerName = containerName;
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
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            execSync(`tar czf "${tarPath}" -C "${SESSION_STATE_DIR}" "${sessionId}"`);

            // Upload tar
            const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
            await tarBlob.uploadFile(tarPath);

            // Upload metadata
            const metadata: SessionMetadata = {
                sessionId,
                dehydratedAt: new Date().toISOString(),
                worker: os.hostname(),
                sizeBytes: fs.statSync(tarPath).size,
                ...meta,
            };
            const metaBlob = this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`);
            const metaJson = JSON.stringify(metadata);
            await metaBlob.upload(metaJson, metaJson.length);

            // Remove local files
            fs.rmSync(sessionDir, { recursive: true, force: true });
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
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);

        // Always download from blob — overwrite any stale local files
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);

        try {
            await tarBlob.downloadToFile(tarPath);
            fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
            execSync(`tar xzf "${tarPath}" -C "${SESSION_STATE_DIR}"`);
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    /**
     * Checkpoint: upload current session state to blob without removing local files.
     * Used for crash resilience — the session stays warm in memory.
     */
    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try {
            execSync(`tar czf "${tarPath}" -C "${SESSION_STATE_DIR}" "${sessionId}"`);

            const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
            await tarBlob.uploadFile(tarPath);

            // Update metadata to reflect checkpoint (not full dehydration)
            const metadata: SessionMetadata = {
                sessionId,
                dehydratedAt: new Date().toISOString(),
                worker: os.hostname(),
                sizeBytes: fs.statSync(tarPath).size,
                reason: "checkpoint",
            };
            const metaBlob = this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`);
            const metaJson = JSON.stringify(metadata);
            await metaBlob.upload(metaJson, metaJson.length);
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    /** Check if a dehydrated session exists in blob storage. */
    async exists(sessionId: string): Promise<boolean> {
        const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
        return tarBlob.exists();
    }

    /** Delete a dehydrated session from blob storage. */
    async delete(sessionId: string): Promise<void> {
        await this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`).deleteIfExists();
        await this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`).deleteIfExists();
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
        content: string,
        contentType = "text/markdown",
    ): Promise<string> {
        const MAX_SIZE = 1_048_576; // 1MB
        if (content.length > MAX_SIZE) {
            throw new Error(`Artifact too large: ${content.length} bytes (max ${MAX_SIZE})`);
        }
        const blobPath = this.artifactBlobPath(sessionId, filename);
        const blob = this.containerClient.getBlockBlobClient(blobPath);
        await blob.upload(content, content.length, {
            blobHTTPHeaders: { blobContentType: contentType },
        });
        return blobPath;
    }

    /**
     * Download an artifact file from blob storage.
     * Returns the file content as a string.
     */
    async downloadArtifact(sessionId: string, filename: string): Promise<string> {
        const blobPath = this.artifactBlobPath(sessionId, filename);
        const blob = this.containerClient.getBlockBlobClient(blobPath);
        const response = await blob.download(0);
        const chunks: Buffer[] = [];
        for await (const chunk of response.readableStreamBody!) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf-8");
    }

    /**
     * List artifact files for a session.
     * Returns filenames (not full blob paths).
     */
    async listArtifacts(sessionId: string): Promise<string[]> {
        const prefix = `artifacts/${sessionId}/`;
        const files: string[] = [];
        for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
            // Strip the prefix to get just the filename
            files.push(blob.name.slice(prefix.length));
        }
        return files;
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
