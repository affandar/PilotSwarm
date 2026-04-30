import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionLockAcquireTimeoutError, SESSION_LOCK_ACQUIRE_TIMEOUT_CODE, SessionManager } from "../../src/session-manager.ts";
import { createTempSessionLayout } from "../helpers/temp-session-layout.js";

class FakeCopilotSession {}

class FakeCopilotClient {
    resumeCalls = [];
    createCalls = [];
    resumeGate = null;
    session = new FakeCopilotSession();

    async createSession(config) {
        this.createCalls.push(config);
        return this.session;
    }

    async resumeSession(sessionId, config) {
        this.resumeCalls.push({ sessionId, config });
        if (this.resumeGate) await this.resumeGate;
        return this.session;
    }

    async deleteSession() {}
    async stop() {}
}

function createNoopFactStore() {
    return {
        async initialize() {},
        async storeFact(input) {
            return { key: input.key, shared: input.shared === true, stored: true };
        },
        async readFacts() {
            return { count: 0, facts: [] };
        },
        async deleteFact(input) {
            return { key: input.key, shared: input.shared === true, deleted: true };
        },
        async deleteSessionFactsForSession() {
            return 0;
        },
        async close() {},
    };
}

function createManagerHarness(prefix = "pilotswarm-session-lock-") {
    const layout = createTempSessionLayout(prefix);
    const manager = new SessionManager(process.env.GITHUB_TOKEN, null, {}, layout.sessionStateDir);
    const fakeClient = new FakeCopilotClient();
    manager.client = fakeClient;
    manager.setFactStore(createNoopFactStore());

    return {
        manager,
        fakeClient,
        sessionStateDir: layout.sessionStateDir,
        cleanup: layout.cleanup,
    };
}

describe("SessionManager session lock", () => {
    it("serializes concurrent getOrCreate resumes for the same session id", async () => {
        const harness = createManagerHarness();
        const sessionId = "session-lock-resume";
        fs.mkdirSync(path.join(harness.sessionStateDir, sessionId), { recursive: true });

        let releaseResume;
        harness.fakeClient.resumeGate = new Promise((resolve) => { releaseResume = resolve; });

        try {
            const first = harness.manager.getOrCreate(sessionId, { toolNames: [] }, { turnIndex: 1 });
            await Promise.resolve();
            expect(harness.fakeClient.resumeCalls.length).toBe(1);

            const second = harness.manager.getOrCreate(sessionId, { toolNames: [] }, { turnIndex: 1 });
            await Promise.resolve();
            expect(harness.fakeClient.resumeCalls.length).toBe(1);

            releaseResume();
            const [firstSession, secondSession] = await Promise.all([first, second]);

            expect(harness.fakeClient.resumeCalls.length).toBe(1);
            expect(firstSession).toBe(secondSession);
        } finally {
            harness.cleanup();
        }
    });

    it("logs first contention and times out after two minutes", async () => {
        vi.useFakeTimers();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const harness = createManagerHarness("pilotswarm-session-lock-timeout-");
        const traces = [];
        let releaseFirst;

        try {
            const first = harness.manager.withRunTurnLock(
                "session-lock-timeout",
                "runTurn",
                () => new Promise((resolve) => { releaseFirst = resolve; }),
                { trace: (line) => traces.push(line) },
            );
            await Promise.resolve();

            const second = harness.manager.withRunTurnLock(
                "session-lock-timeout",
                "runTurn",
                async () => "unexpected",
                { trace: (line) => traces.push(line) },
            ).catch((error) => error);

            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(120_000);

            const error = await second;
            expect(error).toBeInstanceOf(SessionLockAcquireTimeoutError);
            expect(error.code).toBe(SESSION_LOCK_ACQUIRE_TIMEOUT_CODE);
            expect(error.message).toContain("can't acquire session lock for session session-lock-timeout");
            expect(error.message).toContain("runTurn");

            const firstErrorLog = consoleError.mock.calls
                .flat()
                .map(String)
                .find((line) => line.includes("session lock busy for session-lock-timeout during runTurn"));
            expect(firstErrorLog).toContain("backing off for 5s");
            expect(traces.some((line) => line.includes("backing off for 10s"))).toBe(true);
            expect(traces.some((line) => line.includes("backing off for 20s"))).toBe(true);

            releaseFirst();
            await first;
        } finally {
            consoleError.mockRestore();
            vi.useRealTimers();
            harness.cleanup();
        }
    });
});