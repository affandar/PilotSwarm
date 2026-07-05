/**
 * Versioned CAS conformance — Azure Blob backend, against REAL storage
 * (session-lifecycle-protocol §4.1: the ETag/metadata construction must
 * agree with the filesystem backend on every contract rule).
 *
 * Credentials come from .env.remote's AZURE_STORAGE_CONNECTION_STRING,
 * parsed directly from the file so no other production env vars leak into
 * the test process. All blobs live in a dedicated throwaway container
 * (`ps-proto-test-<stamp>`) created before and deleted after the suite —
 * the production `copilot-sessions` container is never touched.
 *
 * Skips (with a visible notice) when .env.remote or the connection string
 * is unavailable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, describe, it } from "vitest";
import { BlobServiceClient } from "@azure/storage-blob";
import { SessionBlobStore } from "../../src/blob-store.ts";
import { registerSnapshotConformanceSuite, makeSessionLayout } from "../helpers/snapshot-conformance.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readRemoteConnectionString() {
    try {
        const raw = fs.readFileSync(path.join(REPO_ROOT, ".env.remote"), "utf8");
        const match = raw.match(/^AZURE_STORAGE_CONNECTION_STRING=(.+)$/m);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
}

const connectionString = readRemoteConnectionString();
const CONTAINER = `ps-proto-test-${Date.now().toString(36)}`;

const cleanupRoots = [];
let containerCreated = false;

afterAll(async () => {
    for (const root of cleanupRoots) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
    if (connectionString && containerCreated) {
        const service = BlobServiceClient.fromConnectionString(connectionString);
        await service.getContainerClient(CONTAINER).deleteIfExists();
    }
}, 60_000);

if (!connectionString) {
    describe("snapshot protocol conformance (azure blob)", () => {
        it.skip("skipped: .env.remote AZURE_STORAGE_CONNECTION_STRING unavailable", () => {});
    });
} else {
    registerSnapshotConformanceSuite("snapshot protocol conformance (azure blob)", async () => {
        const service = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = service.getContainerClient(CONTAINER);
        await containerClient.createIfNotExists();
        containerCreated = true;

        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-snap-blob-"));
        cleanupRoots.push(root);
        const sessionStateDir = path.join(root, "session-state");
        fs.mkdirSync(sessionStateDir, { recursive: true });

        const store = new SessionBlobStore(connectionString, CONTAINER, sessionStateDir);
        return {
            store,
            sessionStateDir,
            newSessionId: () => `snap-blob-${randomUUID()}`,
            writeLegacySnapshot: (sessionId) => store.checkpoint(sessionId),
        };
    }, { timeout: 120_000 });

    describe("azure blob CAS specifics", () => {
        it("survives an interleaved writer between HEAD and PUT (412 retry loop)", { timeout: 120_000 }, async () => {
            const service = BlobServiceClient.fromConnectionString(connectionString);
            const containerClient = service.getContainerClient(CONTAINER);
            await containerClient.createIfNotExists();
            containerCreated = true;

            const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-snap-blob-race-"));
            cleanupRoots.push(root);
            const sessionStateDir = path.join(root, "session-state");
            fs.mkdirSync(sessionStateDir, { recursive: true });
            const store = new SessionBlobStore(connectionString, CONTAINER, sessionStateDir);

            const id = `snap-blob-race-${randomUUID()}`;
            makeSessionLayout(sessionStateDir, id, "interleave");
            await store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });

            // Interleave a foreign write between this commit's HEAD and PUT
            // by mutating the blob out-of-band via a second client mid-flight.
            // The retry loop must re-HEAD, discover the foreign advance, and
            // surface a conflict rather than clobbering it.
            const foreign = new SessionBlobStore(connectionString, CONTAINER, sessionStateDir);
            fs.appendFileSync(path.join(sessionStateDir, id, "events.jsonl"), '{"foreign":true}\n');
            await foreign.commitSnapshot(id, { baseVersion: 1, turnKey: "t-foreign" });

            let conflict = null;
            try {
                await store.commitSnapshot(id, { baseVersion: 1, turnKey: "t-mine" });
            } catch (error) {
                conflict = error;
            }
            if (!conflict || conflict.name !== "SnapshotConflictError") {
                throw new Error(`expected SnapshotConflictError, got ${conflict?.message ?? "success"}`);
            }
        });
    });
}
