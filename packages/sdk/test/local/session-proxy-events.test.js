import { describe, expect, it, vi } from "vitest";
import { registerActivities } from "../../src/session-proxy.ts";
import { SESSION_STATE_MISSING_PREFIX } from "../../src/types.ts";

function makeHarness(options = {}) {
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
        getModelRegistry: vi.fn(() => undefined),
        getPromptGuardrails: vi.fn(() => ({ enabled: false })),
        invalidateWarmSession: vi.fn(async () => {}),
        resetSessionState: vi.fn(async () => {}),
        dehydrate: vi.fn(async () => {}),
        hydrate: vi.fn(async () => {}),
        needsHydration: vi.fn(async () => false),
    };

    const recordedEvents = [];
    const catalog = {
        recordEvents: vi.fn(async (_sessionId, events) => {
            recordedEvents.push(...events);
        }),
        upsertSessionMetricSummary: vi.fn(async () => {}),
        insertTurnMetric: vi.fn(async () => {}),
        updateSession: vi.fn(async () => {}),
    };

    const sessionStore = options.sessionStore ?? null;

    registerActivities(
        runtime,
        sessionManager,
        sessionStore,
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
        hydrateSession: handlers.hydrateSession,
        needsHydrationSession: handlers.needsHydrationSession,
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

    it("recovers a corrupted tool-call transcript by resetting stored session state and replaying once", async () => {
        const { runTurn, recordedEvents, sessionManager } = makeHarness();
        const staleSession = {
            abort: vi.fn(),
            runTurn: vi.fn(async () => ({
                type: "error",
                message: "400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: call_a, call_b",
            })),
        };
        const recoveredSession = {
            abort: vi.fn(),
            runTurn: vi.fn(async (prompt) => {
                expect(prompt).toContain("live Copilot transcript became inconsistent");
                expect(prompt).toContain("continue carefully");
                expect(prompt).toContain("check the session tree");
                return { type: "completed", content: "recovered from transcript corruption", events: [] };
            }),
        };
        sessionManager.getOrCreate = vi
            .fn()
            .mockResolvedValueOnce(staleSession)
            .mockResolvedValueOnce(recoveredSession);

        const result = await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-corrupt-transcript",
                prompt: "check the session tree",
                config: {},
                turnIndex: 3,
            },
        );

        expect(result).toMatchObject({ type: "completed", content: "recovered from transcript corruption" });
        expect(sessionManager.resetSessionState).toHaveBeenCalledWith("session-corrupt-transcript");
        expect(sessionManager.getOrCreate).toHaveBeenNthCalledWith(
            2,
            "session-corrupt-transcript",
            expect.any(Object),
            expect.objectContaining({ turnIndex: 0 }),
        );
        expect(recordedEvents).toContainEqual(expect.objectContaining({
            eventType: "session.lossy_handoff",
            data: expect.objectContaining({
                cause: "corrupted_tool_call_transcript_during_run_turn",
                recoveryMode: "fresh_session_replay",
            }),
        }));
        const recoveryNotice = recordedEvents.find((event) =>
            event.eventType === "system.message"
            && String(event.data?.content || "").includes("live Copilot transcript became inconsistent"),
        );
        expect(recoveryNotice).toBeTruthy();
    });

    it("replays the turn from a fresh Copilot session when resumable state is missing", async () => {
        const { runTurn, sessionManager, recordedEvents } = makeHarness();
        const recoveredSession = {
            abort: vi.fn(),
            runTurn: vi.fn(async (prompt) => {
                expect(prompt).toContain("worker restart lost the live Copilot session state");
                expect(prompt).toContain("previous turn may have partially executed");
                expect(prompt).toContain("continue the deployment");
                return { type: "completed", content: "replayed ok", events: [] };
            }),
        };
        sessionManager.getOrCreate = vi
            .fn()
            .mockRejectedValueOnce(
                new Error(`${SESSION_STATE_MISSING_PREFIX} turn 7 expected resumable Copilot session state for session-replay, but none was found in memory, on disk, or in the session store.`),
            )
            .mockResolvedValueOnce(recoveredSession);

        const result = await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "session-replay",
                prompt: "continue the deployment",
                config: {},
                turnIndex: 7,
            },
        );

        expect(result).toMatchObject({ type: "completed", content: "replayed ok" });
        expect(sessionManager.getOrCreate).toHaveBeenNthCalledWith(
            2,
            "session-replay",
            expect.any(Object),
            expect.objectContaining({ turnIndex: 0 }),
        );
        expect(recordedEvents).toContainEqual(expect.objectContaining({
            eventType: "session.lossy_handoff",
            data: expect.objectContaining({
                cause: "missing_resumable_state_before_run_turn",
                recoveryMode: "fresh_session_replay",
            }),
        }));
        expect(recordedEvents).toContainEqual(expect.objectContaining({
            eventType: "system.message",
            data: expect.objectContaining({
                content: expect.stringContaining("replaying this turn after a worker restart lost the live Copilot session state"),
            }),
        }));
    });

    it("returns an unrecoverable missing-state error when fresh-session replay cannot start", async () => {
        const { runTurn, sessionManager, catalog } = makeHarness();
        sessionManager.getOrCreate = vi
            .fn()
            .mockRejectedValueOnce(
                new Error(`${SESSION_STATE_MISSING_PREFIX} turn 7 expected resumable Copilot session state for session-fatal, but none was found in memory, on disk, or in the session store.`),
            )
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
        expect(catalog.insertTurnMetric).toHaveBeenCalledTimes(1);
        expect(catalog.insertTurnMetric).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "session-fatal",
            resultType: "error",
            errorMessage: expect.stringContaining("unrecoverable live Copilot session loss"),
        }));
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

        expect(sessionManager.dehydrate).toHaveBeenCalledWith(
            "session-lossy",
            "lossy_handoff",
            expect.objectContaining({ trace: expect.any(Function) }),
        );
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

    it("records snapshot size in the summary update when the session store provides it", async () => {
        const sessionStore = {
            getSnapshotSizeBytes: vi.fn(async () => 4096),
        };
        const { dehydrateSession, sessionManager, catalog } = makeHarness({ sessionStore });

        await dehydrateSession(
            { traceInfo: () => {} },
            {
                sessionId: "session-with-size",
                reason: "timer",
            },
        );

        expect(sessionManager.dehydrate).toHaveBeenCalledWith(
            "session-with-size",
            "timer",
            expect.objectContaining({ trace: expect.any(Function) }),
        );
        expect(sessionStore.getSnapshotSizeBytes).toHaveBeenCalledWith("session-with-size");
        expect(catalog.upsertSessionMetricSummary).toHaveBeenCalledWith(
            "session-with-size",
            expect.objectContaining({
                snapshotSizeBytes: 4096,
                dehydrationCountIncrement: 1,
                lastDehydratedAt: true,
            }),
        );
    });

    it("records a lossy handoff and continues when dehydrate loses local session files", async () => {
        const { dehydrateSession, recordedEvents, sessionManager, catalog } = makeHarness();
        const failure = new Error(
            "Session-store persistence failed after 3 attempts during dehydrate for session-lossy-dehydrate (reason=timer): " +
            "Session state directory not ready during dehydrate: session-lossy-dehydrate (/home/node/.copilot/session-state/session-lossy-dehydrate). Missing: session-lossy-dehydrate/",
        );
        failure.sessionStoreAttemptCount = 3;
        failure.sessionStoreError = "Session state directory not ready during dehydrate";
        sessionManager.dehydrate = vi.fn(async () => {
            throw failure;
        });

        await expect(dehydrateSession(
            { traceInfo: () => {} },
            {
                sessionId: "session-lossy-dehydrate",
                reason: "timer",
                eventData: {
                    detail: "Worker restarted during timer handoff.",
                },
            },
        )).resolves.toEqual({
            lossyHandoff: expect.objectContaining({
                reason: "timer",
                cause: "missing_local_session_state_during_dehydrate",
                recoveryMode: "fresh_session_replay",
            }),
        });

        expect(recordedEvents).toContainEqual(expect.objectContaining({
            eventType: "session.lossy_handoff",
            data: expect.objectContaining({
                reason: "timer",
                cause: "missing_local_session_state_during_dehydrate",
                recoveryMode: "fresh_session_replay",
                detail: expect.stringContaining("Local session files were unavailable during dehydrate"),
            }),
        }));
        expect(catalog.updateSession).not.toHaveBeenCalled();
    });

    it("records terminal dehydration failures as session.error and rethrows", async () => {
        const { dehydrateSession, recordedEvents, sessionManager, catalog } = makeHarness();
        const failure = new Error(
            "Session-store persistence failed after 3 attempts during dehydrate for session-dehydrate-fail (reason=cron): blob unavailable",
        );
        failure.sessionStoreAttemptCount = 3;
        failure.sessionStoreError = "blob unavailable";
        sessionManager.dehydrate = vi.fn(async () => {
            throw failure;
        });

        await expect(dehydrateSession(
            { traceInfo: () => {} },
            {
                sessionId: "session-dehydrate-fail",
                reason: "cron",
                eventData: {
                    detail: "Recurring cron handoff failed to persist.",
                },
            },
        )).rejects.toThrow("after 3 attempts");

        expect(recordedEvents).toContainEqual(expect.objectContaining({
            eventType: "session.error",
            data: expect.objectContaining({
                reason: "cron",
                detail: "Recurring cron handoff failed to persist.",
                message: expect.stringContaining("Session-store persistence failed after 3 attempts"),
                sessionStoreAttemptCount: 3,
                sessionStoreError: "blob unavailable",
            }),
        }));
        expect(catalog.updateSession).toHaveBeenCalledWith(
            "session-dehydrate-fail",
            expect.objectContaining({
                lastError: expect.stringContaining("Session-store persistence failed after 3 attempts"),
            }),
        );
    });

    it("traces hydrate lifecycle with session id and passes a trace callback to SessionManager", async () => {
        const { hydrateSession, sessionManager } = makeHarness();
        const traceInfo = vi.fn();

        await hydrateSession(
            { traceInfo },
            { sessionId: "session-hydrate-1" },
        );

        expect(sessionManager.hydrate).toHaveBeenCalledWith(
            "session-hydrate-1",
            expect.objectContaining({ trace: expect.any(Function) }),
        );
        const traces = traceInfo.mock.calls.map(([message]) => String(message)).join("\n");
        expect(traces).toContain("[hydrateSession] session=session-hydrate-1 start");
        expect(traces).toContain("[hydrateSession] session=session-hydrate-1 complete");
    });

    it("traces needsHydration lifecycle with session id and result", async () => {
        const { needsHydrationSession, sessionManager } = makeHarness();
        sessionManager.needsHydration = vi.fn(async () => true);
        const traceInfo = vi.fn();

        const result = await needsHydrationSession(
            { traceInfo },
            { sessionId: "session-needs-hydration-1" },
        );

        expect(result).toBe(true);
        expect(sessionManager.needsHydration).toHaveBeenCalledWith(
            "session-needs-hydration-1",
            expect.objectContaining({ trace: expect.any(Function) }),
        );
        const traces = traceInfo.mock.calls.map(([message]) => String(message)).join("\n");
        expect(traces).toContain("[needsHydrationSession] session=session-needs-hydration-1 start");
        expect(traces).toContain("[needsHydrationSession] session=session-needs-hydration-1 result=true");
    });
});

describe("session-proxy turn metric insertion", () => {
    it("inserts one turn metric row for a normal completed turn", async () => {
        const { runTurn, catalog } = makeHarness();

        const result = await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "metric-completed",
                prompt: "hello",
                config: {},
                turnIndex: 11,
            },
        );

        expect(result.type).toBe("completed");
        expect(catalog.upsertSessionMetricSummary).toHaveBeenCalledTimes(1);
        expect(catalog.insertTurnMetric).toHaveBeenCalledTimes(1);
        expect(catalog.insertTurnMetric).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "metric-completed",
            turnIndex: 11,
            resultType: "completed",
            errorMessage: null,
        }));
    });

    it("inserts one turn metric row for a cancelled turn", async () => {
        vi.useFakeTimers();
        try {
            const { runTurn, session, catalog } = makeHarness();
            let resolveTurn;
            session.runTurn = vi.fn(() => new Promise((resolve) => {
                resolveTurn = resolve;
            }));

            const runPromise = runTurn(
                { traceInfo: () => {}, isCancelled: () => true },
                {
                    sessionId: "metric-cancelled",
                    prompt: "cancel me",
                    config: {},
                    turnIndex: 12,
                },
            );

            await vi.advanceTimersByTimeAsync(2_100);
            resolveTurn({ type: "completed", content: "late", events: [] });
            const result = await runPromise;

            expect(result.type).toBe("cancelled");
            expect(session.abort).toHaveBeenCalledTimes(1);
            expect(catalog.insertTurnMetric).toHaveBeenCalledTimes(1);
            expect(catalog.insertTurnMetric).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: "metric-cancelled",
                resultType: "cancelled",
                errorMessage: null,
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it("inserts one turn metric row for an error turn with message", async () => {
        const { runTurn, session, catalog } = makeHarness();
        session.runTurn = vi.fn(async () => ({ type: "error", message: "boom", events: [] }));

        const result = await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "metric-error",
                prompt: "explode",
                config: {},
                turnIndex: 13,
            },
        );

        expect(result.type).toBe("error");
        expect(catalog.insertTurnMetric).toHaveBeenCalledTimes(1);
        expect(catalog.insertTurnMetric).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "metric-error",
            resultType: "error",
            errorMessage: "boom",
        }));
    });

    it("does not duplicate insertTurnMetric when finalize and finally both execute", async () => {
        const { runTurn, catalog } = makeHarness();

        await runTurn(
            { traceInfo: () => {}, isCancelled: () => false },
            {
                sessionId: "metric-no-duplicate",
                prompt: "no duplicate",
                config: {},
                turnIndex: 14,
            },
        );

        expect(catalog.insertTurnMetric).toHaveBeenCalledTimes(1);
    });
});

describe("session-proxy turn budget enforcement", () => {
    it("fast-fails extremely oversized prompts without invoking runTurn", async () => {
        const previousSoft = process.env.TURN_SOFT_BUDGET_CHARS;
        const previousHard = process.env.TURN_HARD_BUDGET_CHARS;
        try {
            process.env.TURN_SOFT_BUDGET_CHARS = "0";
            process.env.TURN_HARD_BUDGET_CHARS = "100";

            const { runTurn, session, recordedEvents } = makeHarness();
            session.runTurn = vi.fn(async () => ({ type: "completed", content: "should-not-run", events: [] }));

            const result = await runTurn(
                { traceInfo: () => {}, isCancelled: () => false },
                {
                    sessionId: "budget-fast-fail",
                    prompt: "A".repeat(400),
                    config: {},
                    turnIndex: 1,
                },
            );

            expect(result.type).toBe("completed");
            expect(result.content).toContain("too large to process safely");
            expect(session.runTurn).not.toHaveBeenCalled();
            expect(recordedEvents.some((event) => event.eventType === "session.turn_budget_fast_fail")).toBe(true);
        } finally {
            if (previousSoft == null) delete process.env.TURN_SOFT_BUDGET_CHARS;
            else process.env.TURN_SOFT_BUDGET_CHARS = previousSoft;
            if (previousHard == null) delete process.env.TURN_HARD_BUDGET_CHARS;
            else process.env.TURN_HARD_BUDGET_CHARS = previousHard;
        }
    });

    it("applies hard prompt cap before invoking ManagedSession.runTurn", async () => {
        const previousSoft = process.env.TURN_SOFT_BUDGET_CHARS;
        const previousHard = process.env.TURN_HARD_BUDGET_CHARS;
        try {
            process.env.TURN_SOFT_BUDGET_CHARS = "0";
            process.env.TURN_HARD_BUDGET_CHARS = "140";

            const { runTurn, session, recordedEvents } = makeHarness();
            session.runTurn = vi.fn(async (prompt) => {
                expect(prompt.length).toBeLessThanOrEqual(140);
                expect(prompt).toContain("Prompt truncated");
                return { type: "completed", content: "ok", events: [] };
            });

            const result = await runTurn(
                { traceInfo: () => {}, isCancelled: () => false },
                {
                    sessionId: "budget-prompt",
                    prompt: "A".repeat(220),
                    config: {},
                    turnIndex: 1,
                },
            );

            expect(result.type).toBe("completed");
            const budgetEvents = recordedEvents.filter((event) => event.eventType === "session.turn_budget");
            expect(budgetEvents.some((event) =>
                event.data?.stage === "prompt" && event.data?.decision === "hard",
            )).toBe(true);
        } finally {
            if (previousSoft == null) delete process.env.TURN_SOFT_BUDGET_CHARS;
            else process.env.TURN_SOFT_BUDGET_CHARS = previousSoft;
            if (previousHard == null) delete process.env.TURN_HARD_BUDGET_CHARS;
            else process.env.TURN_HARD_BUDGET_CHARS = previousHard;
        }
    });

    it("trims oversized assistant output before returning the turn result", async () => {
        const previousCap = process.env.TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS;
        try {
            process.env.TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS = "110";
            const { runTurn, session, recordedEvents } = makeHarness();
            session.runTurn = vi.fn(async () => ({
                type: "completed",
                content: "B".repeat(2_000),
                events: [],
            }));

            const result = await runTurn(
                { traceInfo: () => {}, isCancelled: () => false },
                {
                    sessionId: "budget-output",
                    prompt: "hello",
                    config: {},
                    turnIndex: 2,
                },
            );

            expect(result.type).toBe("completed");
            expect(result.content.length).toBeLessThanOrEqual(110);
            expect(result.content).toContain("Response truncated");
            const budgetEvents = recordedEvents.filter((event) => event.eventType === "session.turn_budget");
            expect(budgetEvents.some((event) => event.data?.stage === "assistant_output")).toBe(true);
        } finally {
            if (previousCap == null) delete process.env.TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS;
            else process.env.TURN_ASSISTANT_OUTPUT_HARD_BUDGET_CHARS = previousCap;
        }
    });
});
