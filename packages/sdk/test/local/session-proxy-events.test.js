import { describe, expect, it, vi } from "vitest";
import { registerActivities } from "../../src/session-proxy.ts";
import { SESSION_STATE_MISSING_PREFIX } from "../../src/types.ts";

function makeHarness() {
    const handlers = {};
    const runtime = {
        registerActivity(name, handler) {
            handlers[name] = handler;
        },
    };

    const session = {
        abort: vi.fn(),
        runTurn: vi.fn(async () => ({ type: "completed", content: "ok", events: [] })),
    };

    const sessionManager = {
        getOrCreate: vi.fn(async () => session),
        getModelSummary: vi.fn(() => undefined),
        invalidateWarmSession: vi.fn(async () => {}),
        dehydrate: vi.fn(async () => {}),
    };

    const recordedEvents = [];
    const catalog = {
        recordEvents: vi.fn(async (_sessionId, events) => {
            recordedEvents.push(...events);
        }),
        updateSession: vi.fn(async () => {}),
    };

    registerActivities(
        runtime,
        sessionManager,
        null,
        undefined,
        catalog,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "worker-1",
    );

    return {
        runTurn: handlers.runTurn,
        dehydrateSession: handlers.dehydrateSession,
        recordedEvents,
        session,
        sessionManager,
        catalog,
    };
}

describe("session-proxy CMS prompt classification", () => {
    it("records orchestration-generated followups as system.message", async () => {
        const { runTurn, recordedEvents } = makeHarness();

        await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-1",
                prompt: "Sub-agent spawned successfully.\n  Agent ID: child-123\n  Task: \"Inspect infra\"",
                config: {},
                turnIndex: 0,
            },
        );

        const matching = recordedEvents.filter((event) => event.data?.content?.includes("Sub-agent spawned successfully."));
        expect(matching).toHaveLength(1);
        expect(matching[0].eventType).toBe("system.message");
    });

    it("records normal prompts as user.message", async () => {
        const { runTurn, recordedEvents } = makeHarness();

        await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-2",
                prompt: "summary?",
                config: {},
                turnIndex: 0,
            },
        );

        const matching = recordedEvents.filter((event) => event.data?.content === "summary?");
        expect(matching).toHaveLength(1);
        expect(matching[0].eventType).toBe("user.message");
    });

    it("does not re-record the same prompt on retry attempts", async () => {
        const { runTurn, recordedEvents } = makeHarness();

        await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-2-retry",
                prompt: "summary?",
                config: {},
                turnIndex: 0,
                retryCount: 1,
            },
        );

        const matching = recordedEvents.filter((event) => event.data?.content === "summary?");
        expect(matching).toHaveLength(0);
    });

    it("does not re-record turn system prompts on retry attempts", async () => {
        const { runTurn, recordedEvents } = makeHarness();

        await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-2-system-retry",
                prompt: "summary?",
                config: {
                    turnSystemPrompt: "[SYSTEM: retrying prior failed turn]",
                },
                turnIndex: 0,
                retryCount: 1,
            },
        );

        const matching = recordedEvents.filter((event) => event.data?.content === "[SYSTEM: retrying prior failed turn]");
        expect(matching).toHaveLength(0);
    });

    it("records child update prompts as system.message", async () => {
        const { runTurn, recordedEvents } = makeHarness();

        await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-3",
                prompt: "[CHILD_UPDATE from=session-child type=completed iter=3]\nDone.",
                config: {},
                turnIndex: 0,
            },
        );

        const matching = recordedEvents.filter((event) => event.data?.content?.startsWith("[CHILD_UPDATE from=session-child"));
        expect(matching).toHaveLength(1);
        expect(matching[0].eventType).toBe("system.message");
    });

    it("recovers a lost live Copilot session by invalidating and resuming once", async () => {
        const { runTurn, recordedEvents, sessionManager } = makeHarness();
        const staleSession = {
            abort: vi.fn(),
            runTurn: vi.fn(async () => ({
                type: "error",
                message: "Request session.send failed with message: Session not found: session-recover",
            })),
        };
        const recoveredSession = {
            abort: vi.fn(),
            runTurn: vi.fn(async (prompt) => {
                expect(prompt).toContain("runtime recovered this session");
                expect(prompt).toContain("Some very recent in-memory state may have been lost");
                expect(prompt).toContain("deploy the worker");
                return { type: "completed", content: "recovered ok", events: [] };
            }),
        };
        sessionManager.getOrCreate = vi
            .fn()
            .mockResolvedValueOnce(staleSession)
            .mockResolvedValueOnce(recoveredSession);

        const result = await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-recover",
                prompt: "deploy the worker",
                config: {},
                turnIndex: 4,
            },
        );

        expect(result).toMatchObject({ type: "completed", content: "recovered ok" });
        expect(sessionManager.invalidateWarmSession).toHaveBeenCalledWith("session-recover");
        const recoveryNotice = recordedEvents.find((event) =>
            event.eventType === "system.message"
            && String(event.data?.content || "").includes("worker lost the live Copilot session"),
        );
        expect(recoveryNotice).toBeTruthy();
    });

    it("returns an unrecoverable missing-state error when recovery cannot resume or hydrate", async () => {
        const { runTurn, sessionManager, catalog } = makeHarness();
        const staleSession = {
            abort: vi.fn(),
            runTurn: vi.fn(async () => ({
                type: "error",
                message: "Execution failed: Session not found: session-fatal",
            })),
        };
        sessionManager.getOrCreate = vi
            .fn()
            .mockResolvedValueOnce(staleSession)
            .mockRejectedValueOnce(
                new Error(`${SESSION_STATE_MISSING_PREFIX} turn 7 expected resumable Copilot session state for session-fatal, but none was found in memory, on disk, or in the session store.`),
            );

        const result = await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-fatal",
                prompt: "continue the deployment",
                config: {},
                turnIndex: 7,
            },
        );

        expect(result.type).toBe("error");
        expect(result.message).toContain(SESSION_STATE_MISSING_PREFIX);
        expect(result.message).toContain("unrecoverable live Copilot session loss");
        expect(catalog.updateSession).toHaveBeenCalledWith(
            "session-fatal",
            expect.objectContaining({
                state: "failed",
                lastError: expect.stringContaining("unrecoverable live Copilot session loss"),
            }),
        );
    });

    it("records structured dehydration details for observability", async () => {
        const { dehydrateSession, recordedEvents, sessionManager } = makeHarness();

        await dehydrateSession(
            { traceInfo: () => {} },
            {
                sessionId: "session-lossy",
                reason: "lossy_handoff",
                eventData: {
                    detail: "Live Copilot connection stayed closed after 3 retries; dehydrating for handoff.",
                    error: "Connection is closed.",
                    retries: 3,
                    retryDelaySeconds: 15,
                },
            },
        );

        expect(sessionManager.dehydrate).toHaveBeenCalledWith("session-lossy", "lossy_handoff");
        expect(recordedEvents).toContainEqual({
            eventType: "session.dehydrated",
            data: {
                reason: "lossy_handoff",
                detail: "Live Copilot connection stayed closed after 3 retries; dehydrating for handoff.",
                error: "Connection is closed.",
                retries: 3,
                retryDelaySeconds: 15,
            },
        });
    });
});
