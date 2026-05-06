/**
 * S3ArtifactStore — AWS S3-backed implementation of ArtifactStore.
 *
 * Drop-in replacement for SessionBlobStore (Azure) or FilesystemArtifactStore (local).
 * Implements only the four methods required by the ArtifactStore interface so
 * Phase 4 artifact auto-offload and the agent's write_artifact / read_artifact
 * tools work without any other changes.
 *
 * Authentication uses the standard AWS credential chain:
 *   - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
 *   - ~/.aws/credentials file
 *   - IAM instance role (EC2 / ECS / Lambda)
 *
 * Configuration:
 *   bucket      — S3 bucket name (required)
 *   region      — AWS region (default: us-east-1, or AWS_REGION env var)
 *   keyPrefix   — key prefix inside the bucket (default: "artifacts")
 *
 * Key layout: `{keyPrefix}/{sessionId}/{filename}`
 */

import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
    type ArtifactDownloadResult,
    type ArtifactMetadata,
    type ArtifactStore,
    type ArtifactUploadOptions,
    isBinaryArtifactContentType,
    normalizeArtifactContentType,
    resolveArtifactUpload,
} from "./session-store.js";

export interface S3ArtifactStoreOptions {
    /** S3 bucket name. */
    bucket: string;
    /** AWS region. Falls back to AWS_REGION env var, then "us-east-1". */
    region?: string;
    /** Key prefix inside the bucket. Default: "artifacts". */
    keyPrefix?: string;
}

const MAX_ARTIFACT_SIZE = 1_048_576; // 1 MB — matches FilesystemArtifactStore limit

export class S3ArtifactStore implements ArtifactStore {
    private client: S3Client;
    private bucket: string;
    private keyPrefix: string;

    constructor(options: S3ArtifactStoreOptions) {
        this.bucket = options.bucket;
        this.keyPrefix = options.keyPrefix ?? "artifacts";
        this.client = new S3Client({
            region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
        });
    }

    private objectKey(sessionId: string, filename: string): string {
        const safe = filename.replace(/[/\\]/g, "_");
        return `${this.keyPrefix}/${sessionId}/${safe}`;
    }

    async uploadArtifact(
        sessionId: string,
        filename: string,
        content: string | Buffer,
        contentType?: string,
        opts: ArtifactUploadOptions = {},
    ): Promise<ArtifactMetadata> {
        const key = this.objectKey(sessionId, filename);
        const safeFilename = filename.replace(/[/\\]/g, "_");
        const { body, metadata } = await resolveArtifactUpload(content, contentType, opts);
        const uploadedAt = new Date().toISOString();
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: metadata.contentType,
        }));
        return {
            filename: safeFilename,
            uploadedAt,
            ...metadata,
        };
    }

    async downloadArtifact(sessionId: string, filename: string): Promise<ArtifactDownloadResult> {
        const key = this.objectKey(sessionId, filename);
        const response = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }));
        if (!response.Body) {
            throw new Error(`Artifact not found: ${filename} in session ${sessionId}`);
        }
        // Consume the readable stream into a string
        const chunks: Buffer[] = [];
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
            chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const contentType = normalizeArtifactContentType(response.ContentType || undefined);
        return {
            filename: filename.replace(/[/\\]/g, "_"),
            sizeBytes: Number(response.ContentLength) || body.length,
            contentType,
            isBinary: isBinaryArtifactContentType(contentType),
            uploadedAt: new Date().toISOString(),
            source: "agent",
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

    async listArtifacts(sessionId: string): Promise<ArtifactMetadata[]> {
        const prefix = `${this.keyPrefix}/${sessionId}/`;
        const response = await this.client.send(new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
        }));
        return (response.Contents ?? [])
            .map(obj => obj.Key ?? "")
            .filter(key => key.startsWith(prefix))
            .map(key => key.slice(prefix.length))
            .filter(name => name.length > 0)
            .map((name) => ({
                filename: name,
                sizeBytes: 0,
                contentType: "application/octet-stream",
                isBinary: true,
                uploadedAt: "",
                source: "agent" as const,
            }));
    }

    async artifactExists(sessionId: string, filename: string): Promise<boolean> {
        const key = this.objectKey(sessionId, filename);
        try {
            await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: key,
            }));
            return true;
        } catch (err: any) {
            if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
                return false;
            }
            throw err;
        }
    }

    async deleteArtifact(_sessionId: string, _filename: string): Promise<boolean> {
        return false;
    }
}
