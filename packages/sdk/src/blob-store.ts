/**
 * @file Azure Blob Storage backing for {@link SessionStateStore} +
 * {@link ArtifactStore}.
 *
 * This module supports two coexisting authentication modes; the legacy
 * mode is preserved verbatim so the in-cluster `scripts/deploy-aks.sh`
 * flow, local Docker storage, and CI all keep working untouched.
 *
 * - **Connection-string (legacy, default)**: pass `AZURE_STORAGE_CONNECTION_STRING`.
 *   `AccountName` + `AccountKey` are parsed from the conn string into a
 *   `StorageSharedKeyCredential`, which is reused to mint short-lived
 *   read-only SAS URLs in {@link SessionBlobStore.generateArtifactSasUrl}.
 *
 * - **Managed identity (opt-in, bicep-deploy flow)**: set
 *   `PILOTSWARM_USE_MANAGED_IDENTITY=1` *and*
 *   `AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net`.
 *   The factory uses {@link DefaultAzureCredential} (workload-identity in
 *   AKS, `az login`/env creds locally). No shared key is available, so
 *   `generateArtifactSasUrl()` throws with
 *   `code = "NotSupportedInManagedIdentityMode"` and callers must stream
 *   artifacts through the worker (see TUI/portal proxy paths) rather
 *   than handing a direct SAS URL to the client.
 *
 * Selection is done by {@link createSessionBlobStore}; see that function
 * for the precedence rules. `useManagedIdentity` is *not* inferred from
 * the absence of a connection string — it is an explicit opt-in flag so
 * unmigrated stamps stay on the legacy path.
 */
import {
    BlobServiceClient,
    ContainerClient,
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters,
    BlobSASPermissions,
    SASProtocol,
} from "@azure/storage-blob";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { faultPoint } from "./fault-injection.js";
import {
    SnapshotConflictError,
    type SnapshotCommitInput,
    type SnapshotCommitResult,
    type SnapshotHydrateResult,
    type SnapshotProbe,
    type VersionedSnapshotStore,
} from "./snapshot-protocol.js";
import {
    DEFAULT_SESSION_STATE_DIR,
    type ArtifactDownloadResult,
    type ArtifactMetadata,
    type SessionMetadata,
    type SessionStateStore,
    type ArtifactStore,
    type ArtifactUploadOptions,
    DEFAULT_SNAPSHOT_CODEC,
    archiveSessionDir,
    buildMetadata,
    extractSessionArchive,
    isBinaryArtifactContentType,
    normalizeArtifactContentType,
    resolveArtifactUpload,
    resolveSnapshotCodec,
    waitForSessionSnapshot,
    type SnapshotCodec,
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
 * Configuration for constructing a {@link SessionBlobStore} against an
 * already-built `ContainerClient`. Used by the managed-identity path
 * (where there is no connection string to parse) and by tests that want
 * to inject a mocked client.
 *
 * @internal
 */
export interface SessionBlobStoreClientConfig {
    containerClient: ContainerClient;
    containerName: string;
    /**
     * Optional `StorageSharedKeyCredential` used solely to mint
     * read-only SAS URLs in {@link SessionBlobStore.generateArtifactSasUrl}.
     * In managed-identity mode this is intentionally `null`/absent —
     * SAS generation will throw `NotSupportedInManagedIdentityMode` so
     * callers (TUI / portal) know to proxy downloads through the worker
     * instead of relying on shared-key SAS.
     */
    sharedKeyCredential?: StorageSharedKeyCredential | null;
    sessionStateDir?: string;
}

/**
 * Manages session state in Azure Blob Storage.
 *
 * - `dehydrate()` — tar + upload session dir, remove local files
 * - `hydrate()` — download + untar session dir
 * - `checkpoint()` — tar + upload without removing local files
 * - `exists()` / `delete()` — blob lifecycle
 *
 * Two construction modes:
 * - **Connection string** (legacy / local / `scripts/deploy-aks.sh`):
 *   `new SessionBlobStore(connectionString, containerName?, sessionStateDir?)`.
 *   Parses `AccountName` + `AccountKey` out of the conn string for SAS URL
 *   generation. This is what every current caller uses.
 * - **Managed identity** (new bicep-deploy flow when
 *   `PILOTSWARM_USE_MANAGED_IDENTITY=1`): construct via
 *   {@link createSessionBlobStore} or pass a {@link SessionBlobStoreClientConfig}.
 *   No shared key is available, so SAS URL generation throws.
 *
 * @internal
 */
export class SessionBlobStore implements SessionStateStore, ArtifactStore, VersionedSnapshotStore {
    private containerClient: ContainerClient;
    private containerName: string;
    private credential: StorageSharedKeyCredential | null = null;
    private sessionStateDir: string;
    private snapshotSizeBySession = new Map<string, number>();

    constructor(
        connectionStringOrConfig: string | SessionBlobStoreClientConfig,
        containerName: string = "copilot-sessions",
        sessionStateDir?: string,
    ) {
        if (typeof connectionStringOrConfig === "string") {
            // Legacy connection-string path. Identical to the pre-MI
            // behaviour — every existing caller hits this branch.
            const connectionString = connectionStringOrConfig;
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
        } else {
            // Pre-built ContainerClient path (used by managed-identity mode
            // and by tests). The caller has already chosen a credential —
            // we just record what's needed for SAS minting.
            const cfg = connectionStringOrConfig;
            this.containerClient = cfg.containerClient;
            this.containerName = cfg.containerName;
            this.sessionStateDir = cfg.sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
            this.credential = cfg.sharedKeyCredential ?? null;
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
        // Versioned-snapshot fence: the committed chain (lifecycle protocol)
        // already holds this session's durable state, and an unconditional
        // legacy Put would replace both content and the CAS metadata
        // (psver/psturnkey/pssha). Degrade to release: free local files.
        try {
            const head = await this.headSnapshot(sessionId);
            if (head.exists && !head.legacy) {
                logBlobStore("warn", sessionId, "dehydrate skipped upload: versioned snapshot exists; releasing local files only", {
                    container: this.containerName,
                    version: head.version,
                });
                fs.rmSync(sessionDir, { recursive: true, force: true });
                return;
            }
        } catch (probeErr: unknown) {
            logBlobStore("warn", sessionId, "dehydrate version probe failed; proceeding with legacy upload", {
                container: this.containerName,
                error: errorMessage(probeErr),
            });
        }
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

        const codec = DEFAULT_SNAPSHOT_CODEC;
        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar`);
        try {
            const { rawSizeBytes } = await archiveSessionDir(this.sessionStateDir, sessionId, tarPath, codec);
            const tarSizeBytes = fs.existsSync(tarPath) ? fs.statSync(tarPath).size : undefined;

            // Upload tar. The `pscodec` metadata on the tar blob is what the
            // read path decodes by — brotli has no magic bytes, so an
            // unversioned legacy blob without it is assumed gzip.
            const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
            logBlobStore("info", sessionId, "dehydrate upload tar", {
                container: this.containerName,
                blob: `${sessionId}.tar.gz`,
                tarSizeBytes,
                codec,
            });
            await tarBlob.uploadFile(tarPath, { metadata: { pscodec: codec, psraw: String(rawSizeBytes) } });

            // Upload metadata
            const metadata: SessionMetadata = buildMetadata(tarPath, sessionId, { ...meta, codec, rawSizeBytes });
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
        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar`);

        try {
            logBlobStore("info", sessionId, "hydrate download tar", {
                container: this.containerName,
                blob: `${sessionId}.tar.gz`,
            });
            const response = await tarBlob.downloadToFile(tarPath);
            const codec = resolveSnapshotCodec((response.metadata as Record<string, string> | undefined)?.pscodec);
            await extractSessionArchive(this.sessionStateDir, tarPath, codec);
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
        // Versioned-snapshot fence (see dehydrate): never clobber the
        // CAS-protected chain with an unversioned legacy write.
        try {
            const head = await this.headSnapshot(sessionId);
            if (head.exists && !head.legacy) {
                logBlobStore("warn", sessionId, "checkpoint skipped: versioned snapshot exists", {
                    container: this.containerName,
                    version: head.version,
                });
                return;
            }
        } catch (probeErr: unknown) {
            logBlobStore("warn", sessionId, "checkpoint version probe failed; proceeding with legacy upload", {
                container: this.containerName,
                error: errorMessage(probeErr),
            });
        }

        const codec = DEFAULT_SNAPSHOT_CODEC;
        const tarPath = path.join(os.tmpdir(), `${sessionId}.tar`);
        try {
            logBlobStore("info", sessionId, "checkpoint start", {
                container: this.containerName,
                dir: sessionDir,
            });
            const { rawSizeBytes } = await archiveSessionDir(this.sessionStateDir, sessionId, tarPath, codec);
            const tarSizeBytes = fs.existsSync(tarPath) ? fs.statSync(tarPath).size : undefined;

            const tarBlob = this.containerClient.getBlockBlobClient(`${sessionId}.tar.gz`);
            await tarBlob.uploadFile(tarPath, { metadata: { pscodec: codec, psraw: String(rawSizeBytes) } });

            // Update metadata to reflect checkpoint (not full dehydration)
            const metadata: SessionMetadata = buildMetadata(tarPath, sessionId, { reason: "checkpoint", codec, rawSizeBytes });
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

    // ─── Versioned CAS contract (session-lifecycle-protocol §3.1) ───
    //
    // The version is an explicit counter in the tar blob's metadata
    // (`psver`, plus `psturnkey` + `pssha`), written atomically with the
    // content by single-shot Put Blob. The ETag is never the version — it is
    // the atomicity token binding each HEAD to the conditional PUT that
    // follows it (`If-Match`). A blob without `psver` is a legacy snapshot
    // (probe reports version 0 / legacy). Two footguns, per the store
    // proposal: never staged Put Block uploads (the condition only applies
    // at commit and concurrent stagers interleave), and never Set Blob
    // Metadata for version bumps (it would decouple counter from content).

    private static readonly COMMIT_MAX_ATTEMPTS = 5;
    private static readonly SINGLE_SHOT_MAX_BYTES = 256 * 1024 * 1024;

    private snapshotBlobName(sessionId: string): string {
        return `${sessionId}.tar.gz`;
    }

    private probeFromMetadata(
        metadata: Record<string, string> | undefined,
        etag: string | undefined,
    ): SnapshotProbe & { etag?: string; codec?: SnapshotCodec } {
        const codec = resolveSnapshotCodec(metadata?.pscodec);
        const raw = Number(metadata?.psraw);
        const version = Number(metadata?.psver);
        if (!Number.isFinite(version) || version < 1) {
            return { exists: true, version: 0, legacy: true, codec, ...(etag ? { etag } : {}) };
        }
        return {
            exists: true,
            version,
            ...(metadata?.psturnkey ? { turnKey: metadata.psturnkey } : {}),
            ...(metadata?.pssha ? { contentHash: metadata.pssha } : {}),
            ...(Number.isFinite(raw) ? { rawSizeBytes: raw } : {}),
            codec,
            ...(etag ? { etag } : {}),
        };
    }

    private async headSnapshot(sessionId: string): Promise<SnapshotProbe & { etag?: string }> {
        const blob = this.containerClient.getBlockBlobClient(this.snapshotBlobName(sessionId));
        try {
            const props = await blob.getProperties();
            return this.probeFromMetadata(props.metadata as Record<string, string> | undefined, props.etag);
        } catch (error: any) {
            if (error?.statusCode === 404) return { exists: false, version: 0 };
            throw error;
        }
    }

    async probeSnapshot(sessionId: string): Promise<SnapshotProbe> {
        const { etag: _etag, ...probe } = await this.headSnapshot(sessionId);
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

        const codec = DEFAULT_SNAPSHOT_CODEC;
        const tarPath = path.join(os.tmpdir(), `ps-commit-${sessionId}-${process.pid}-${Date.now()}.tar`);
        try {
            const { rawSizeBytes } = await archiveSessionDir(this.sessionStateDir, sessionId, tarPath, codec);
            const body = fs.readFileSync(tarPath);
            if (body.length > SessionBlobStore.SINGLE_SHOT_MAX_BYTES) {
                throw new Error(
                    `Session snapshot for ${sessionId} is ${body.length} bytes — over the ` +
                    `${SessionBlobStore.SINGLE_SHOT_MAX_BYTES} single-shot commit cap. ` +
                    `Audit the session workspace for files that belong in tar excludes.`,
                );
            }
            const contentHash = crypto.createHash("sha256").update(body).digest("hex");
            const blob = this.containerClient.getBlockBlobClient(this.snapshotBlobName(sessionId));

            for (let attempt = 1; attempt <= SessionBlobStore.COMMIT_MAX_ATTEMPTS; attempt++) {
                const head = await this.headSnapshot(sessionId);

                if (head.exists && head.version === input.baseVersion + 1 && head.turnKey === input.turnKey) {
                    logBlobStore("info", sessionId, "commit already landed (idempotent retry)", {
                        version: head.version,
                        turnKey: input.turnKey,
                    });
                    return {
                        version: head.version,
                        contentHash: head.contentHash ?? "",
                        ...(head.rawSizeBytes != null ? { rawSizeBytes: head.rawSizeBytes } : {}),
                        alreadyCommitted: true,
                    };
                }
                if (head.exists && head.version !== input.baseVersion) {
                    throw new SnapshotConflictError(sessionId, input.baseVersion, head.version, head.turnKey);
                }
                // head.exists && version === baseVersion (legacy counts as 0),
                // or !exists (any baseVersion commits as a fresh chain — the
                // store lost data and the worker's copy is the only truth).
                const version = head.exists ? head.version + 1 : input.baseVersion + 1;
                const conditions = head.exists && head.etag
                    ? { ifMatch: head.etag }
                    : { ifNoneMatch: "*" };
                faultPoint("store.commit.before-write");
                try {
                    await blob.upload(body, body.length, {
                        conditions,
                        metadata: {
                            psver: String(version),
                            psturnkey: input.turnKey,
                            pssha: contentHash,
                            pscodec: codec,
                            psraw: String(rawSizeBytes),
                        },
                    });
                    faultPoint("store.commit.after-write");
                    // Legacy compat: keep <sessionId>.meta.json fresh so
                    // getSnapshotSizeBytes and older tooling keep working.
                    // Unconditional + best-effort — it is informational only.
                    try {
                        const metadata: SessionMetadata = {
                            ...buildMetadata(tarPath, sessionId, { reason: "turn-commit" }),
                            version,
                            turnKey: input.turnKey,
                            contentHash,
                            codec,
                            rawSizeBytes,
                        };
                        this.snapshotSizeBySession.set(sessionId, metadata.sizeBytes);
                        const metaBlob = this.containerClient.getBlockBlobClient(`${sessionId}.meta.json`);
                        const metaJson = JSON.stringify(metadata);
                        await metaBlob.upload(metaJson, metaJson.length);
                    } catch (metaErr: unknown) {
                        logBlobStore("warn", sessionId, "commit meta.json refresh failed (non-fatal)", {
                            error: errorMessage(metaErr),
                        });
                    }
                    logBlobStore("info", sessionId, "commit complete", {
                        version,
                        turnKey: input.turnKey,
                        tarSizeBytes: body.length,
                        rawSizeBytes,
                        codec,
                        attempt,
                    });
                    return { version, contentHash, sizeBytes: body.length, rawSizeBytes, alreadyCommitted: false };
                } catch (error: any) {
                    // 412 Precondition Failed (If-Match lost the race) or
                    // 409 BlobAlreadyExists (If-None-Match create race):
                    // re-HEAD and re-evaluate — the winner may have been our
                    // own prior attempt (idempotent success) or a foreign
                    // writer (conflict), both handled at the top of the loop.
                    const status = error?.statusCode;
                    if (status === 412 || status === 409) {
                        logBlobStore("warn", sessionId, "commit CAS race, re-evaluating", {
                            attempt,
                            status,
                        });
                        continue;
                    }
                    throw error;
                }
            }
            throw new Error(`Snapshot commit for ${sessionId} exhausted CAS retries`);
        } finally {
            try { fs.unlinkSync(tarPath); } catch {}
        }
    }

    async hydrateSnapshot(sessionId: string): Promise<SnapshotHydrateResult> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const blob = this.containerClient.getBlockBlobClient(this.snapshotBlobName(sessionId));
        const tarPath = path.join(os.tmpdir(), `ps-hydrate-${sessionId}-${process.pid}-${Date.now()}.tar`);

        // One download response carries body + metadata consistently.
        let metadata: Record<string, string> | undefined;
        let tarSizeBytes: number | undefined;
        try {
            const response = await blob.downloadToFile(tarPath, 0);
            metadata = response.metadata as Record<string, string> | undefined;
            try { tarSizeBytes = fs.statSync(tarPath).size; } catch {}
            const codec = resolveSnapshotCodec(metadata?.pscodec);

            fs.mkdirSync(this.sessionStateDir, { recursive: true });
            const tempRoot = fs.mkdtempSync(path.join(this.sessionStateDir, `.ps-hydrate-${sessionId}-`));
            try {
                await extractSessionArchive(tempRoot, tarPath, codec);
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
            try { fs.unlinkSync(tarPath); } catch {}
        }

        const probe = this.probeFromMetadata(metadata, undefined);
        logBlobStore("info", sessionId, "versioned hydrate complete", {
            version: probe.version,
            legacy: probe.legacy,
        });
        return {
            version: probe.version,
            ...(probe.turnKey ? { turnKey: probe.turnKey } : {}),
            ...(probe.contentHash ? { contentHash: probe.contentHash } : {}),
            ...(tarSizeBytes != null ? { sizeBytes: tarSizeBytes } : {}),
            ...(probe.rawSizeBytes != null ? { rawSizeBytes: probe.rawSizeBytes } : {}),
            ...(probe.legacy ? { legacy: true } : {}),
        };
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
            // Managed-identity mode: there is no shared key on this
            // instance, so we cannot mint a shared-key SAS. We
            // intentionally do *not* fall back to user-delegation key
            // (UDK) SAS here — UDK refresh introduces non-trivial
            // lifetime tracking, and the portal/TUI proxy path is a
            // simpler answer that already works. Callers that hit this
            // branch should switch to streaming the artifact through the
            // worker rather than handing the client a direct SAS URL.
            const error = new Error(
                "Cannot generate SAS URL: SessionBlobStore is in managed-identity mode " +
                "(no shared-key credential available). Stream the artifact through " +
                "downloadArtifact/downloadArtifactText instead.",
            ) as Error & { code: string };
            error.code = "NotSupportedInManagedIdentityMode";
            throw error;
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

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Environment shape consumed by {@link createSessionBlobStore}. We accept a
 * loose `Record<string, string | undefined>` so callers can pass either
 * `process.env` or a curated env map (the deploy orchestrator's
 * `loadEnv()` output, the worker's `options`, etc.) without juggling
 * types.
 *
 * @internal
 */
export interface SessionBlobStoreEnv {
    /**
     * `1` / `true` selects managed-identity mode. When set, the factory
     * requires `AZURE_STORAGE_ACCOUNT_URL` and ignores any
     * `AZURE_STORAGE_CONNECTION_STRING` value.
     *
     * Why a flag and not "MI iff conn string is absent"? Because we want
     * the legacy code path (connection string → shared-key credential →
     * shared-key SAS) to remain the default for the existing
     * `scripts/deploy-aks.sh` flow, local Docker storage, CI, and any
     * stamp that hasn't migrated. The flag is the explicit opt-in that
     * the bicep-deploy orchestrator sets in the worker overlay
     * ConfigMap.
     */
    PILOTSWARM_USE_MANAGED_IDENTITY?: string;
    /** `https://<account>.blob.core.windows.net` — required in MI mode. */
    AZURE_STORAGE_ACCOUNT_URL?: string;
    AZURE_STORAGE_CONNECTION_STRING?: string;
    AZURE_STORAGE_CONTAINER?: string;
}

/**
 * Pick the right `SessionBlobStore` implementation based on env. Returns
 * `null` when no Azure storage backing is configured (caller falls back
 * to the filesystem store).
 *
 * Selection (first match wins):
 *   1. `PILOTSWARM_USE_MANAGED_IDENTITY=1` + `AZURE_STORAGE_ACCOUNT_URL`
 *      → managed-identity mode. Uses {@link DefaultAzureCredential}, which
 *      picks up the workload-identity token in AKS or `az login` /
 *      env-var creds locally. SAS URL minting will throw — callers must
 *      proxy downloads.
 *   2. `AZURE_STORAGE_CONNECTION_STRING` set → legacy connection-string
 *      mode. Identical to pre-MI behaviour. Used by the existing
 *      `scripts/deploy-aks.sh` flow, local Docker storage, CI, and any
 *      stamp that hasn't switched the flag on.
 *   3. Otherwise → `null`.
 *
 * @internal
 */
export function createSessionBlobStore(
    env: SessionBlobStoreEnv,
    opts: { sessionStateDir?: string } = {},
): SessionBlobStore | null {
    const containerName =
        (env.AZURE_STORAGE_CONTAINER || "").trim() || "copilot-sessions";
    const useMi = isTruthyFlag(env.PILOTSWARM_USE_MANAGED_IDENTITY);
    const accountUrl = (env.AZURE_STORAGE_ACCOUNT_URL || "").trim();
    const connStr = (env.AZURE_STORAGE_CONNECTION_STRING || "").trim();

    if (useMi) {
        if (!accountUrl) {
            throw new Error(
                "PILOTSWARM_USE_MANAGED_IDENTITY=1 but AZURE_STORAGE_ACCOUNT_URL is not set. " +
                "Set AZURE_STORAGE_ACCOUNT_URL to https://<account>.blob.core.windows.net (the bicep-deploy worker-env ConfigMap wires this automatically).",
            );
        }
        const credential: TokenCredential = new DefaultAzureCredential();
        const blobService = new BlobServiceClient(accountUrl, credential);
        const containerClient = blobService.getContainerClient(containerName);
        return new SessionBlobStore({
            containerClient,
            containerName,
            sharedKeyCredential: null,
            sessionStateDir: opts.sessionStateDir,
        });
    }

    if (connStr) {
        return new SessionBlobStore(connStr, containerName, opts.sessionStateDir);
    }

    return null;
}

function isTruthyFlag(value: string | undefined): boolean {
    if (!value) return false;
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
}
