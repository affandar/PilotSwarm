import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { createArtifactTools } from "../../src/artifact-tools.ts";
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

function parseToolResult(result) {
    return JSON.parse(String(result || "{}"));
}

function getTool(tools, name) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert(tool, `Expected to find tool ${name}`);
    return tool;
}

describe("binary artifact tools", () => {
    it("writes binary artifacts via base64, lists metadata, and rejects binary text reads", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifact-tools-"));
        const store = new FilesystemArtifactStore(artifactDir);
        const tools = createArtifactTools({ blobStore: store });
        const context = { durableSessionId: "session-tools" };

        try {
            const writeTool = getTool(tools, "write_artifact");
            const listTool = getTool(tools, "list_artifacts");
            const readTool = getTool(tools, "read_artifact");

            const binaryWrite = parseToolResult(await writeTool.handler({
                filename: "tiny.png",
                content: PNG_BYTES.toString("base64"),
                content_type: "image/png",
                encoding: "base64",
            }, context));
            assertEqual(binaryWrite.success, true, "binary write should succeed");
            assertEqual(binaryWrite.isBinary, true, "binary write should report binary metadata");
            assertEqual(binaryWrite.contentType, "image/png", "binary write should keep the png content type");
            assertEqual(binaryWrite.sizeBytes, PNG_BYTES.length, "binary write should report decoded byte size");

            const textWrite = parseToolResult(await writeTool.handler({
                filename: "note.md",
                content: "# hello tools\n",
            }, context));
            assertEqual(textWrite.success, true, "text write should succeed");
            assertEqual(textWrite.isBinary, false, "text write should remain text");

            const listed = parseToolResult(await listTool.handler({}, context));
            assertEqual(listed.success, true, "list_artifacts should succeed");
            assertEqual(listed.count, 2, "list_artifacts should return both files");
            assertEqual(Array.isArray(listed.files), true, "list_artifacts should return metadata records");
            assertEqual(Array.isArray(listed.filenames), true, "list_artifacts should preserve the legacy filename list");
            assert(listed.files.some((file) => file.filename === "tiny.png" && file.isBinary === true), "listed metadata should include the binary artifact");
            assert(listed.filenames.includes("note.md"), "legacy filenames should include text artifacts");

            const binaryRead = parseToolResult(await readTool.handler({ sessionId: "session-tools", filename: "tiny.png" }));
            assertEqual(binaryRead.error, "ARTIFACT_IS_BINARY", "read_artifact should reject binary artifacts as text");
            assertEqual(binaryRead.contentType, "image/png", "binary read errors should include the mime type");
            assertEqual(binaryRead.sizeBytes, PNG_BYTES.length, "binary read errors should include the byte size");

            const textRead = parseToolResult(await readTool.handler({ sessionId: "session-tools", filename: "note.md" }));
            assertEqual(textRead.success, true, "read_artifact should still read text artifacts");
            assertIncludes(textRead.content, "# hello tools", "text read should preserve markdown content");
        } finally {
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });
});