import { describe, it, expect } from "vitest";
import { createSweeperTools } from "../../src/sweeper-tools.ts";

describe("sweeper tools retry-loop containment", () => {
    it("scan_completed_sessions can include stale retry-loop sessions", async () => {
        const now = Date.now();
        const tools = createSweeperTools({
            catalog: {
                async initialize() {},
                async createSession() {},
                async updateSession() {},
                async softDeleteSession() {},
                async listSessions() {
                    return [{
                        sessionId: "retry-loop-session",
                        isSystem: false,
                        parentSessionId: null,
                        title: "Retry Loop Session",
                        updatedAt: new Date(now - (30 * 60 * 1000)),
                        state: "running",
                        lastError: "Model not available. retry 2/3 in 15s",
                        waitReason: null,
                    }];
                },
                async getSession() { return null; },
                async getDescendantSessionIds() { return []; },
                async getLastSessionId() { return null; },
                async recordEvents() {},
                async getSessionEvents() { return []; },
                async close() {},
            },
            duroxideClient: {
                async getStatus() {
                    return {
                        status: "Running",
                        customStatus: {
                            status: "error",
                            error: "Model not available (retry 2/3 in 15s)",
                        },
                    };
                },
            },
            factStore: null,
        });

        const scanTool = tools.find((tool) => tool.name === "scan_completed_sessions");
        expect(scanTool).toBeTruthy();

        const withRetryLoops = await scanTool.handler({
            graceMinutes: 5,
            includeRetryLoops: true,
            retryLoopGraceMinutes: 20,
        });
        expect(withRetryLoops.found).toBe(1);
        expect(withRetryLoops.sessions[0].status).toBe("retry_loop");

        const withoutRetryLoops = await scanTool.handler({
            graceMinutes: 5,
            includeRetryLoops: false,
            retryLoopGraceMinutes: 20,
        });
        expect(withoutRetryLoops.found).toBe(0);
    });

    it("interrupt_stale_retry_session cancels orchestration and updates CMS without deleting", async () => {
        const updateCalls = [];
        const cancelCalls = [];
        const softDeleteCalls = [];
        let isSystemSession = false;

        const tools = createSweeperTools({
            catalog: {
                async initialize() {},
                async createSession() {},
                async updateSession(sessionId, updates) {
                    updateCalls.push({ sessionId, updates });
                },
                async softDeleteSession(sessionId) {
                    softDeleteCalls.push(sessionId);
                },
                async listSessions() { return []; },
                async getSession(sessionId) {
                    return {
                        sessionId,
                        isSystem: isSystemSession,
                        title: "Looping Session",
                    };
                },
                async getDescendantSessionIds() { return []; },
                async getLastSessionId() { return null; },
                async recordEvents() {},
                async getSessionEvents() { return []; },
                async close() {},
            },
            duroxideClient: {
                async getStatus() { return { status: "Running" }; },
                async cancelInstance(instanceId, reason) {
                    cancelCalls.push({ instanceId, reason });
                },
                async deleteInstance() {},
            },
            factStore: null,
        });

        const interruptTool = tools.find((tool) => tool.name === "interrupt_stale_retry_session");
        expect(interruptTool).toBeTruthy();

        const result = await interruptTool.handler({
            sessionId: "retry-loop-session",
            reason: "test stale retry-loop interruption",
        });

        expect(result.ok).toBe(true);
        expect(cancelCalls.length).toBe(1);
        expect(cancelCalls[0].instanceId).toBe("session-retry-loop-session");
        expect(cancelCalls[0].reason).toContain("stale retry-loop interruption");
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0].updates.state).toBe("failed");
        expect(softDeleteCalls.length).toBe(0);

        isSystemSession = true;
        const systemResult = await interruptTool.handler({
            sessionId: "system-session",
            reason: "should fail for system sessions",
        });
        expect(systemResult.ok).toBe(false);
    });
});

