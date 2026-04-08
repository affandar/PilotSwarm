import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionBlobStore } from "../../src/blob-store.ts";

function makeConnectionString() {
    const accountKey = Buffer.from("pilotswarm-test-key").toString("base64");
    return [
        "DefaultEndpointsProtocol=https",
        "AccountName=pilotswarmtest",
        `AccountKey=${accountKey}`,
        "EndpointSuffix=core.windows.net",
    ].join(";");
}

describe("SessionBlobStore", () => {
    it("waits for the session snapshot before archiving on dehydrate", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-store-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "delayed-session";
        const sessionDir = path.join(sessionStateDir, sessionId);

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        const uploads = [];
        const metadataWrites = [];

        store.containerClient = {
            getBlockBlobClient(name) {
                return {
                    async uploadFile(filePath) {
                        uploads.push({ name, filePath, exists: fs.existsSync(filePath) });
                    },
                    async upload(body) {
                        metadataWrites.push({ name, body: String(body) });
                    },
                    async deleteIfExists() {},
                    async downloadToFile() {
                        throw new Error("downloadToFile should not be called in this test");
                    },
                    async exists() {
                        return true;
                    },
                    url: `https://example.test/${name}`,
                };
            },
            async *listBlobsFlat() {},
        };

        setTimeout(() => {
            fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
            fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "{}\n", "utf-8");
            fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
            fs.writeFileSync(path.join(sessionDir, "checkpoints", "index.md"), "# checkpoint\n", "utf-8");
        }, 50);

        try {
            await store.dehydrate(sessionId, { reason: "cron" });

            expect(uploads).toHaveLength(1);
            expect(uploads[0].name).toBe(`${sessionId}.tar.gz`);
            expect(uploads[0].exists).toBe(true);
            expect(metadataWrites).toHaveLength(1);
            expect(metadataWrites[0].name).toBe(`${sessionId}.meta.json`);
            expect(JSON.parse(metadataWrites[0].body).reason).toBe("cron");
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });
});
