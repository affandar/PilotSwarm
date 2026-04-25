import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/session-manager.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function createSessionStoreMock() {
    return {
        dehydrate: vi.fn(),
        hydrate: vi.fn(async () => {}),
        checkpoint: vi.fn(async () => {}),
        exists: vi.fn(async () => false),
        delete: vi.fn(async () => {}),
    };
}

describe("SessionManager dehydrate", () => {
    it("persists on the first session-store attempt when the snapshot is healthy", async () => {
        // Post-disconnect, the SDK has either flushed durably or it hasn't —
        // there is no race to retry over. The store gets exactly one attempt.
        const sessionStore = createSessionStoreMock();
        sessionStore.dehydrate.mockResolvedValueOnce(undefined);
        const manager = new SessionManager(undefined, sessionStore, {}, "/tmp/pilotswarm-session-state");

        await expect(manager.dehydrate("session-happy", "cron")).resolves.toBeUndefined();

        expect(sessionStore.dehydrate).toHaveBeenCalledTimes(1);
        expect(sessionStore.dehydrate).toHaveBeenCalledWith(
            "session-happy",
            { reason: "cron" },
        );
    });

    it("bubbles the session-store dehydration failure on the first attempt", async () => {
        const sessionStore = createSessionStoreMock();
        sessionStore.dehydrate.mockRejectedValue(new Error("blob unavailable"));
        const manager = new SessionManager(undefined, sessionStore, {}, "/tmp/pilotswarm-session-state");

        const failure = await manager.dehydrate("session-fail", "cron").catch((err) => err);

        expect(sessionStore.dehydrate).toHaveBeenCalledTimes(1);
        expect(failure).toBeTruthy();
        expect(failure.message).toContain("after 1 attempts");
        expect(failure.message).toContain("reason=cron");
        expect(failure.sessionStoreAttemptCount).toBe(1);
        expect(failure.sessionStoreError).toBe("blob unavailable");
    });

    it("falls back to the pre-destroy checkpoint when the post-disconnect snapshot is missing", async () => {
        // The post-disconnect snapshot can legitimately be missing only if the
        // SDK regressed or the CLI crashed mid-disconnect. In either case we
        // try once; the pre-destroy checkpoint is the fallback.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-checkpoint-fallback";
        const sessionDir = path.join(sessionStateDir, sessionId);

        try {
            fs.mkdirSync(sessionDir, { recursive: true });

            const sessionStore = createSessionStoreMock();
            sessionStore.checkpoint.mockResolvedValue(undefined);
            sessionStore.dehydrate.mockRejectedValue(
                new Error(
                    `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                    `Missing: ${sessionId}/`,
                ),
            );

            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);
            manager.sessions.set(sessionId, {
                destroy: vi.fn(async () => {}),
            });

            await expect(manager.dehydrate(sessionId, "cron")).resolves.toBeUndefined();

            expect(sessionStore.checkpoint).toHaveBeenCalledTimes(1);
            expect(sessionStore.checkpoint).toHaveBeenCalledWith(sessionId);
            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(1);
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("bubbles missing local state so the activity can record a lossy handoff", async () => {
        // If dehydrate lands on a worker with no warm session and no local
        // files, it cannot prove that no live turn happened elsewhere. Bubble
        // the missing snapshot error so dehydrateSession records a lossy
        // handoff instead of pretending a blob was written.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-empty-brand-new";
        const sessionDir = path.join(sessionStateDir, sessionId);

        try {
            // Intentionally do NOT create sessionDir.
            const sessionStore = createSessionStoreMock();
            sessionStore.dehydrate.mockRejectedValue(
                new Error(
                    `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                    `Missing: ${sessionId}/`,
                ),
            );

            const destroy = vi.fn(async () => {});
            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);
            manager.sessions.set(sessionId, { destroy });

            const failure = await manager.dehydrate(sessionId, "cron").catch((err) => err);

            // Pre-destroy checkpoint should NOT have been attempted (no dir
            // exists), and the in-memory session must have been destroyed so
            // the worker reclaims memory.
            expect(sessionStore.checkpoint).not.toHaveBeenCalled();
            expect(destroy).toHaveBeenCalledTimes(1);
            // Single-shot dehydrate attempt is still made — that's the contract.
            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(1);
            expect(failure).toBeTruthy();
            expect(failure.message).toContain("Session state directory not ready during dehydrate");
            expect(failure.sessionStoreAttemptCount).toBe(1);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("still throws the snapshot-missing failure when the session previously had on-disk state but no checkpoint succeeded", async () => {
        // This is the genuinely lossy case: the dir existed, the SDK should
        // have flushed something durable, but neither the checkpoint nor the
        // post-disconnect snapshot survived. Caller must learn about it.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-genuine-lossy";
        const sessionDir = path.join(sessionStateDir, sessionId);

        try {
            fs.mkdirSync(sessionDir, { recursive: true });

            const sessionStore = createSessionStoreMock();
            sessionStore.checkpoint.mockRejectedValue(new Error("checkpoint blob outage"));
            sessionStore.dehydrate.mockRejectedValue(
                new Error(
                    `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                    `Missing: ${sessionId}/`,
                ),
            );

            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);
            manager.sessions.set(sessionId, { destroy: vi.fn(async () => {}) });

            const failure = await manager.dehydrate(sessionId, "cron").catch((err) => err);
            expect(failure).toBeTruthy();
            expect(failure.message).toContain("after 1 attempts");
            expect(failure.sessionStoreAttemptCount).toBe(1);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });
});
