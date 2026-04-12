import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemSessionStore, waitForSessionSnapshot } from "../../src/session-store.ts";

const cleanupDirs = new Set();

function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanupDirs.add(dir);
    return dir;
}

afterEach(() => {
    for (const dir of cleanupDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
        cleanupDirs.delete(dir);
    }
});

describe("session-store snapshot layout", () => {
    it("accepts the current workspace/checkpoints/files layout without events.jsonl", async () => {
        const baseDir = makeTempDir("pilotswarm-session-store-");
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "current-layout";
        const sessionDir = path.join(sessionStateDir, sessionId);

        fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
        fs.mkdirSync(path.join(sessionDir, "files"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "checkpoints", "index.md"), "# checkpoint\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "files", "notes.md"), "artifact\n", "utf-8");

        await expect(waitForSessionSnapshot(sessionStateDir, sessionId, 500, 20, 2)).resolves.toEqual({
            ready: true,
            missing: [],
        });
    });

    it("ignores inuse lock churn while waiting for a stable snapshot", async () => {
        const baseDir = makeTempDir("pilotswarm-session-store-locks-");
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "lock-churn";
        const sessionDir = path.join(sessionStateDir, sessionId);
        const lockPath = path.join(sessionDir, "inuse.worker.lock");

        fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "checkpoints", "index.md"), "# checkpoint\n", "utf-8");

        const interval = setInterval(() => {
            fs.writeFileSync(lockPath, String(Date.now()), "utf-8");
        }, 10);

        try {
            await expect(waitForSessionSnapshot(sessionStateDir, sessionId, 1_000, 20, 2)).resolves.toEqual({
                ready: true,
                missing: [],
            });
        } finally {
            clearInterval(interval);
        }
    });

    it("archives the current layout through FilesystemSessionStore dehydrate", async () => {
        const baseDir = makeTempDir("pilotswarm-fs-store-");
        const sessionStateDir = path.join(baseDir, "session-state");
        const storeDir = path.join(baseDir, "session-store");
        const sessionId = "filesystem-layout";
        const sessionDir = path.join(sessionStateDir, sessionId);
        const store = new FilesystemSessionStore(storeDir, sessionStateDir);

        fs.mkdirSync(path.join(sessionDir, "research"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "research", "report.md"), "hello\n", "utf-8");

        await store.dehydrate(sessionId, { reason: "test" });

        expect(fs.existsSync(path.join(storeDir, `${sessionId}.tar.gz`))).toBe(true);
        expect(fs.existsSync(path.join(storeDir, `${sessionId}.meta.json`))).toBe(true);
        expect(fs.existsSync(sessionDir)).toBe(false);
    });
});
