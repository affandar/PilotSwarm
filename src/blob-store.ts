import { BlobServiceClient } from "@azure/storage-blob";
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

    constructor(connectionString: string, containerName = "copilot-sessions") {
        const blobService = BlobServiceClient.fromConnectionString(connectionString);
        this.containerClient = blobService.getContainerClient(containerName);
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
}
