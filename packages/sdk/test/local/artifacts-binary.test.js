import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { NodeSdkTransport } from "../../../cli/src/node-sdk-transport.js";
import { FilesystemArtifactStore } from "../../src/session-store.ts";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
    0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe("binary artifact store", () => {
    it("round-trips binary artifacts with metadata and blocks text reads", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifacts-"));
        const store = new FilesystemArtifactStore(artifactDir);

        try {
            const metadata = await store.uploadArtifact("session-binary", "tiny.png", PNG_BYTES, "image/png");

            assertEqual(metadata.filename, "tiny.png", "uploaded metadata should preserve the filename");
            assertEqual(metadata.contentType, "image/png", "uploaded metadata should preserve the mime type");
            assertEqual(metadata.isBinary, true, "png uploads should be marked binary");
            assertEqual(metadata.sizeBytes, PNG_BYTES.length, "binary uploads should report the decoded byte size");

            const download = await store.downloadArtifact("session-binary", "tiny.png");
            assertEqual(download.isBinary, true, "binary download should stay marked binary");
            assertEqual(download.contentType, "image/png", "binary download should keep its mime type");
            assertEqual(Buffer.compare(download.body, PNG_BYTES), 0, "downloaded bytes should match the uploaded bytes");

            const listed = await store.listArtifacts("session-binary");
            assertEqual(listed.length, 1, "listArtifacts should return one metadata record");
            assertEqual(listed[0].filename, "tiny.png", "listed metadata should include the filename");
            assertEqual(listed[0].isBinary, true, "listed metadata should mark png as binary");

            let error = null;
            try {
                await store.downloadArtifactText("session-binary", "tiny.png");
            } catch (err) {
                error = err;
            }

            assert(error, "downloadArtifactText should reject binary artifacts");
            assertEqual(error.code, "ARTIFACT_IS_BINARY", "binary text reads should throw the binary error code");
            assertEqual(error.contentType, "image/png", "binary text read errors should expose the content type");
            assertEqual(error.sizeBytes, PNG_BYTES.length, "binary text read errors should expose the byte size");
        } finally {
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });

    it("decodes base64 uploads and preserves default text behavior", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifacts-"));
        const store = new FilesystemArtifactStore(artifactDir);

        try {
            const binaryMetadata = await store.uploadArtifact(
                "session-base64",
                "tiny.png",
                PNG_BYTES.toString("base64"),
                "image/png",
                { encoding: "base64" },
            );
            assertEqual(binaryMetadata.sizeBytes, PNG_BYTES.length, "base64 uploads should report decoded byte size");

            await store.uploadArtifact("session-base64", "note.md", "# hello artifacts\n");
            const note = await store.downloadArtifactText("session-base64", "note.md");
            assertIncludes(note, "# hello artifacts", "text uploads should remain readable as utf-8 text");
        } finally {
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });
});

describe("binary artifact transport", () => {
    it("uploads file paths as raw bytes and saves raw-byte downloads intact", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifact-transport-"));
        const sourcePath = path.join(tempDir, "tiny.png");
        fs.writeFileSync(sourcePath, PNG_BYTES);

        const uploaded = [];
        const fakeTransport = {
            artifactStore: {
                async uploadArtifact(sessionId, filename, content, contentType) {
                    uploaded.push({ sessionId, filename, content, contentType });
                    return {
                        filename,
                        sizeBytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content || ""), "utf8"),
                        contentType,
                        isBinary: true,
                        uploadedAt: new Date().toISOString(),
                        source: "user",
                    };
                },
                async downloadArtifact(sessionId, filename) {
                    return {
                        filename,
                        sizeBytes: PNG_BYTES.length,
                        contentType: "image/png",
                        isBinary: true,
                        uploadedAt: new Date().toISOString(),
                        source: "user",
                        body: PNG_BYTES,
                    };
                },
                async downloadArtifactText() {
                    throw new Error("downloadArtifactText should not be called in this test");
                },
            },
        };

        let saved = null;
        try {
            const uploadResult = await NodeSdkTransport.prototype.uploadArtifactFromPath.call(fakeTransport, "session-transport", sourcePath);
            assertEqual(uploaded.length, 1, "uploadArtifactFromPath should write exactly one artifact");
            assert(Buffer.isBuffer(uploaded[0].content), "path uploads should pass raw bytes to the artifact store");
            assertEqual(uploaded[0].contentType, "image/png", "path uploads should infer the png content type");
            assertEqual(uploadResult.sizeBytes, PNG_BYTES.length, "path uploads should report the file byte size");

            saved = await NodeSdkTransport.prototype.saveArtifactDownload.call(fakeTransport, "session-transport", "tiny.png");
            const written = fs.readFileSync(saved.localPath);
            assertEqual(Buffer.compare(written, PNG_BYTES), 0, "saveArtifactDownload should write raw artifact bytes to disk");
        } finally {
            if (saved?.localPath) {
                fs.rmSync(path.dirname(saved.localPath), { recursive: true, force: true });
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});