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

describe("SessionManager dehydrate retries", () => {
    it("retries session-store dehydration before succeeding", async () => {
        vi.useFakeTimers();
        try {
            const sessionStore = createSessionStoreMock();
            sessionStore.dehydrate
                .mockRejectedValueOnce(new Error("blob timeout"))
                .mockRejectedValueOnce(new Error("socket hangup"))
                .mockResolvedValueOnce(undefined);
            const manager = new SessionManager(undefined, sessionStore, {}, "/tmp/pilotswarm-session-state");

            const promise = manager.dehydrate("session-retry-success", "cron");
            await vi.runAllTimersAsync();
            await expect(promise).resolves.toBeUndefined();

            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(3);
            expect(sessionStore.dehydrate).toHaveBeenNthCalledWith(
                1,
                "session-retry-success",
                { reason: "cron" },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("bubbles the final session-store dehydration failure after retries are exhausted", async () => {
        vi.useFakeTimers();
        try {
            const sessionStore = createSessionStoreMock();
            sessionStore.dehydrate.mockRejectedValue(new Error("blob unavailable"));
            const manager = new SessionManager(undefined, sessionStore, {}, "/tmp/pilotswarm-session-state");

            const failurePromise = manager.dehydrate("session-retry-fail", "cron").catch((err) => err);
            await vi.runAllTimersAsync();
            const failure = await failurePromise;

            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(3);
            expect(failure).toBeTruthy();
            expect(failure.message).toContain("after 3 attempts");
            expect(failure.message).toContain("reason=cron");
            expect(failure.sessionStoreAttemptCount).toBe(3);
            expect(failure.sessionStoreError).toBe("blob unavailable");
        } finally {
            vi.useRealTimers();
        }
    });

    it("falls back to the pre-destroy checkpoint when the post-destroy snapshot never appears", async () => {
        vi.useFakeTimers();
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

            const promise = manager.dehydrate(sessionId, "cron");
            await vi.runAllTimersAsync();
            await expect(promise).resolves.toBeUndefined();

            expect(sessionStore.checkpoint).toHaveBeenCalledTimes(1);
            expect(sessionStore.checkpoint).toHaveBeenCalledWith(sessionId);
            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(3);
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            vi.useRealTimers();
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });
});
