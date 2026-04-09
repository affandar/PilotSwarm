import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandResponseKey } from "../../src/types.ts";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (_ctx, _sessionId, _affinityKey, config) => {
        mockSession._currentConfig = config;
        return mockSession;
    },
    createSessionManagerProxy: () => mockManager,
}));

const STOP = Symbol("stop");

function createHarness({ messages = [], inputOverrides = {} } = {}) {
    const values = new Map();
    const scheduledMessages = [...messages]
        .map((entry) => ({
            atMs: entry.atMs ?? 0,
            payload: entry.payload,
        }))
        .sort((left, right) => left.atMs - right.atMs);

    const state = {
        nowMs: 0,
        runTurnCall: null,
        continueAsNew: null,
        sentCommands: [],
        cmsUpdates: [],
        deletedSessions: [],
    };

    mockSession = {
        needsHydration: vi.fn(() => ({ effect: "needsHydration" })),
        hydrate: vi.fn(() => ({ effect: "hydrate" })),
        checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
        dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
        destroy: vi.fn(() => ({ effect: "destroy" })),
        runTurn: vi.fn((prompt, bootstrap, iteration, opts) => ({
            effect: "runTurn",
            prompt,
            bootstrap,
            iteration,
            opts,
            systemPrompt: mockSession._currentConfig?.turnSystemPrompt,
        })),
    };

    mockManager = {
        loadKnowledgeIndex: vi.fn(() => ({ effect: "loadKnowledgeIndex" })),
        recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
        summarizeSession: vi.fn(() => ({ effect: "summarizeSession" })),
        listChildSessions: vi.fn(() => ({ effect: "listChildSessions" })),
        getSessionStatus: vi.fn((sessionId) => ({ effect: "getSessionStatus", sessionId })),
        sendCommandToSession: vi.fn((sessionId, command) => ({ effect: "sendCommandToSession", sessionId, command })),
        updateCmsState: vi.fn((sessionId, nextState, lastError, waitReason) => ({
            effect: "updateCmsState",
            sessionId,
            state: nextState,
            lastError,
            waitReason,
        })),
        getDescendantSessionIds: vi.fn((sessionId) => ({ effect: "getDescendantSessionIds", sessionId })),
        deleteSession: vi.fn((sessionId, reason) => ({ effect: "deleteSession", sessionId, reason })),
    };

    const ctx = {
        traceInfo: () => {},
        setCustomStatus: () => {},
        getValue: (key) => (values.has(key) ? values.get(key) : null),
        setValue: (key, value) => values.set(key, value),
        clearValue: (key) => values.delete(key),
        utcNow: () => ({ effect: "utcNow" }),
        dequeueEvent: () => ({ effect: "dequeueEvent" }),
        scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNewVersioned", input, version }),
        newGuid: () => ({ effect: "newGuid" }),
    };

    function nextMessageIfReady(nowMs) {
        const next = scheduledMessages[0];
        if (!next || next.atMs > nowMs) return null;
        return scheduledMessages.shift().payload;
    }

    function normalizePayload(payload) {
        return typeof payload === "string" ? payload : JSON.stringify(payload);
    }

    function resolveBlockingDequeue() {
        const next = scheduledMessages.shift();
        if (!next) throw new Error("Blocking dequeue requested with no queued messages.");
        state.nowMs = Math.max(state.nowMs, next.atMs);
        return normalizePayload(next.payload);
    }

    function resolveRace(left, right) {
        const timerMs = right?.effect === "scheduleTimer" ? right.ms : 0;
        const next = scheduledMessages[0];
        if (left?.effect === "dequeueEvent" && next && next.atMs <= state.nowMs) {
            scheduledMessages.shift();
            return { index: 0, value: normalizePayload(next.payload) };
        }
        if (left?.effect === "dequeueEvent" && next && next.atMs < state.nowMs + timerMs) {
            scheduledMessages.shift();
            state.nowMs = next.atMs;
            return { index: 0, value: normalizePayload(next.payload) };
        }

        state.nowMs += timerMs;
        return { index: 1, value: undefined };
    }

    function resolve(effect) {
        if (effect == null) return undefined;
        switch (effect.effect) {
            case "utcNow":
                return state.nowMs;
            case "needsHydration":
                return false;
            case "hydrate":
            case "checkpoint":
            case "dehydrate":
            case "destroy":
            case "loadKnowledgeIndex":
            case "recordSessionEvent":
            case "summarizeSession":
                return undefined;
            case "listChildSessions":
                return JSON.stringify(inputOverrides.subAgents ?? []);
            case "getSessionStatus": {
                if (typeof inputOverrides.getSessionStatus === "function") {
                    const value = inputOverrides.getSessionStatus(effect.sessionId, state);
                    return typeof value === "string" ? value : JSON.stringify(value);
                }
                const statusMap = inputOverrides.sessionStatuses ?? {};
                const value = statusMap[effect.sessionId] ?? { status: "running" };
                return typeof value === "string" ? value : JSON.stringify(value);
            }
            case "sendCommandToSession":
                state.sentCommands.push({ sessionId: effect.sessionId, command: effect.command });
                return undefined;
            case "updateCmsState":
                state.cmsUpdates.push({
                    sessionId: effect.sessionId,
                    state: effect.state,
                    lastError: effect.lastError,
                    waitReason: effect.waitReason,
                });
                return undefined;
            case "getDescendantSessionIds":
                return [...(inputOverrides.descendantIdsBySessionId?.[effect.sessionId] ?? [])];
            case "deleteSession":
                state.deletedSessions.push({ sessionId: effect.sessionId, reason: effect.reason });
                return undefined;
            case "newGuid":
                return "generated-affinity";
            case "dequeueEvent":
                return resolveBlockingDequeue();
            case "race":
                return resolveRace(effect.left, effect.right);
            case "continueAsNewVersioned":
                state.continueAsNew = effect;
                return undefined;
            case "runTurn":
                state.runTurnCall = effect;
                return STOP;
            default:
                throw new Error(`Unknown effect: ${JSON.stringify(effect)}`);
        }
    }

    async function runUntilRunTurn() {
        const orchestrationModule = await import("../../src/orchestration.ts");
        const handlerName = `durableSessionOrchestration_${String(orchestrationModule.CURRENT_ORCHESTRATION_VERSION || "")
            .replace(/\./g, "_")}`;
        const handler = orchestrationModule[handlerName];
        if (typeof handler !== "function") {
            throw new Error(`Could not resolve latest orchestration handler: ${handlerName}`);
        }
        const gen = handler(ctx, {
            sessionId: "parent-session",
            config: {},
            iteration: 5,
            isSystem: true,
            blobEnabled: false,
            cronSchedule: {
                intervalSeconds: 180,
                reason: "refresh summary",
            },
            activeTimerState: {
                remainingMs: 180_000,
                originalDurationMs: 180_000,
                reason: "refresh summary",
                type: "cron",
            },
            ...inputOverrides,
        });

        let input;
        for (let step = 0; step < 400; step += 1) {
            const next = gen.next(input);
            if (next.done) {
                return {
                    done: true,
                    value: next.value,
                    state,
                };
            }

            const resolved = resolve(next.value);
            if (resolved === STOP) {
                return {
                    done: false,
                    runTurnCall: state.runTurnCall,
                    state,
                };
            }
            input = resolved;
        }

        throw new Error("Exceeded step limit before reaching runTurn.");
    }

    async function runUntilDone() {
        const orchestrationModule = await import("../../src/orchestration.ts");
        const handlerName = `durableSessionOrchestration_${String(orchestrationModule.CURRENT_ORCHESTRATION_VERSION || "")
            .replace(/\./g, "_")}`;
        const handler = orchestrationModule[handlerName];
        if (typeof handler !== "function") {
            throw new Error(`Could not resolve latest orchestration handler: ${handlerName}`);
        }
        let currentInput = {
            sessionId: "parent-session",
            config: {},
            iteration: 5,
            isSystem: true,
            blobEnabled: false,
            ...inputOverrides,
        };

        for (let execution = 0; execution < 20; execution += 1) {
            const gen = handler(ctx, currentInput);
            let input;
            for (let step = 0; step < 800; step += 1) {
                const next = gen.next(input);
                if (next.done) {
                    return {
                        done: true,
                        value: next.value,
                        state,
                        values,
                    };
                }

                state.continueAsNew = null;
                const resolved = resolve(next.value);
                if (resolved === STOP) {
                    throw new Error("Unexpected runTurn during shutdown harness test.");
                }
                input = resolved;

                if (state.continueAsNew) {
                    currentInput = state.continueAsNew.input;
                    break;
                }
            }

            if (!state.continueAsNew) {
                throw new Error("Exceeded step limit before orchestration completed.");
            }
        }

        throw new Error("Exceeded execution limit before orchestration completed.");
    }

    return {
        runUntilRunTurn,
        runUntilDone,
        state,
        values,
    };
}

describe("orchestration child update batching", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("batches descendant-triggered turns into one digest after 30 seconds", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=wait iter=7]\nWaiting for source one",
                    },
                },
                {
                    atMs: 5_000,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-2 type=completed iter=7]\nChild two done",
                    },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Monitor source one", status: "running" },
                    { orchId: "agent-2", sessionId: "child-session-2", task: "Summarize source two", status: "running" },
                ],
            },
        });

        const result = await harness.runUntilRunTurn();

        expect(result.runTurnCall.prompt).toBe("Continue with the latest system instructions.");
        expect(result.runTurnCall.systemPrompt).toContain("Buffered child updates arrived during the last 30 seconds");
        expect(result.runTurnCall.systemPrompt).toContain("Agent agent-1");
        expect(result.runTurnCall.systemPrompt).toContain("Agent agent-2");
        expect(result.runTurnCall.systemPrompt).toContain("Child two done");
        expect(result.state.nowMs).toBe(30_000);
        expect(mockSession.runTurn).toHaveBeenCalledTimes(1);
    });

    it("does not extend the 30 second digest window when later child updates arrive", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=wait iter=8]\nFirst signal",
                    },
                },
                {
                    atMs: 20_000,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=completed iter=8]\nLatest signal",
                    },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Track source", status: "running" },
                ],
            },
        });

        const result = await harness.runUntilRunTurn();

        expect(result.state.nowMs).toBe(30_000);
        expect(result.runTurnCall.systemPrompt).toContain("Latest signal");
        expect(result.runTurnCall.systemPrompt).not.toContain("First signal");
        expect(mockSession.runTurn).toHaveBeenCalledTimes(1);
    });

    it("keeps the latest child update even when the update type stays the same", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=wait iter=8]\nWaiting on source A",
                    },
                },
                {
                    atMs: 5_000,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=wait iter=8]\nWaiting on source B",
                    },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Track source", status: "running" },
                ],
            },
        });

        const result = await harness.runUntilRunTurn();

        expect(result.state.nowMs).toBe(30_000);
        expect(result.runTurnCall.systemPrompt).toContain("Waiting on source B");
        expect(result.runTurnCall.systemPrompt).not.toContain("Waiting on source A");
        expect(mockSession.runTurn).toHaveBeenCalledTimes(1);
    });

    it("flushes the child digest into a user turn while keeping the user prompt primary", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=wait iter=9]\nWaiting on reporter",
                    },
                },
                {
                    atMs: 10_000,
                    payload: {
                        prompt: "Stop checking every outlet and just tell me the top two stories.",
                    },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Watch the reporter", status: "running" },
                ],
            },
        });

        const result = await harness.runUntilRunTurn();

        expect(result.state.nowMs).toBe(10_000);
        expect(result.runTurnCall.prompt.startsWith("Stop checking every outlet and just tell me the top two stories.")).toBe(true);
        expect(result.runTurnCall.systemPrompt).toContain("Buffered child updates arrived during the last 30 seconds");
        expect(result.runTurnCall.systemPrompt).toContain("Waiting on reporter");
        expect(result.runTurnCall.systemPrompt).toContain('There is an active recurring schedule every 180 seconds for "refresh summary".');
        expect(mockSession.runTurn).toHaveBeenCalledTimes(1);
    });
});

describe("orchestration shutdown semantics", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("waits for active children before completing the parent", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: { type: "cmd", cmd: "done", id: "done-cmd", args: { reason: "Finished" } },
                },
                {
                    atMs: 6_000,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=completed iter=6]\nChild finished cleanly",
                    },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Child work", status: "running" },
                ],
                getSessionStatus: (_sessionId, state) => ({ status: state.nowMs >= 6_000 ? "completed" : "running" }),
            },
        });

        const result = await harness.runUntilDone();

        expect(result.value).toBe("done");
        expect(result.state.sentCommands).toEqual([
            expect.objectContaining({
                sessionId: "child-session-1",
                command: expect.objectContaining({ cmd: "done" }),
            }),
        ]);
        expect(result.state.cmsUpdates).toContainEqual(expect.objectContaining({
            sessionId: "parent-session",
            state: "completed",
            lastError: null,
            waitReason: null,
        }));
        expect(mockSession.destroy).toHaveBeenCalledTimes(1);

        const response = JSON.parse(result.values.get(commandResponseKey("done-cmd")));
        expect(response.result?.ok).toBe(true);
        expect(response.cmd).toBe("done");
    });

    it("waits for active children before cancelling the parent", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: { type: "cmd", cmd: "cancel", id: "cancel-cmd", args: { reason: "Stop now" } },
                },
                {
                    atMs: 6_000,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=cancelled iter=6]\nChild cancelled cleanly",
                    },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Child work", status: "running" },
                ],
                getSessionStatus: (_sessionId, state) => ({ status: state.nowMs >= 6_000 ? "cancelled" : "running" }),
            },
        });

        const result = await harness.runUntilDone();

        expect(result.value).toBe("cancelled");
        expect(result.state.sentCommands).toEqual([
            expect.objectContaining({
                sessionId: "child-session-1",
                command: expect.objectContaining({ cmd: "cancel" }),
            }),
        ]);
        expect(result.state.cmsUpdates).toContainEqual(expect.objectContaining({
            sessionId: "parent-session",
            state: "cancelled",
            lastError: null,
            waitReason: null,
        }));

        const response = JSON.parse(result.values.get(commandResponseKey("cancel-cmd")));
        expect(response.result?.ok).toBe(true);
        expect(response.cmd).toBe("cancel");
    });

    it("uses the cancel route before deleting the subtree", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: { type: "cmd", cmd: "delete", id: "delete-cmd", args: { reason: "Clean up" } },
                },
                {
                    atMs: 6_000,
                    payload: {
                        prompt: "[CHILD_UPDATE from=child-session-1 type=cancelled iter=6]\nChild cancelled for deletion",
                    },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Child work", status: "running" },
                ],
                descendantIdsBySessionId: {
                    "parent-session": ["child-session-1", "grandchild-session-1"],
                },
                getSessionStatus: (_sessionId, state) => ({ status: state.nowMs >= 6_000 ? "cancelled" : "running" }),
            },
        });

        const result = await harness.runUntilDone();

        expect(result.value).toBe("deleted");
        expect(result.state.sentCommands).toEqual([
            expect.objectContaining({
                sessionId: "child-session-1",
                command: expect.objectContaining({ cmd: "cancel" }),
            }),
        ]);
        expect(result.state.deletedSessions).toEqual([
            { sessionId: "child-session-1", reason: "Ancestor parent-session deleted: Clean up" },
            { sessionId: "grandchild-session-1", reason: "Ancestor parent-session deleted: Clean up" },
            { sessionId: "parent-session", reason: "Clean up" },
        ]);

        const response = JSON.parse(result.values.get(commandResponseKey("delete-cmd")));
        expect(response.result?.ok).toBe(true);
        expect(response.cmd).toBe("delete");
    });

    it("fails the parent when graceful completion exceeds the shutdown timeout", async () => {
        const harness = createHarness({
            messages: [
                {
                    atMs: 0,
                    payload: { type: "cmd", cmd: "done", id: "done-timeout", args: { reason: "Finished" } },
                },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-session-1", task: "Child work", status: "running" },
                ],
                getSessionStatus: () => ({ status: "running" }),
            },
        });

        const result = await harness.runUntilDone();

        expect(result.value).toBe("failed");
        expect(result.state.sentCommands).toEqual([
            expect.objectContaining({
                sessionId: "child-session-1",
                command: expect.objectContaining({ cmd: "done" }),
            }),
        ]);
        expect(result.state.cmsUpdates).toContainEqual(expect.objectContaining({
            sessionId: "parent-session",
            state: "failed",
            lastError: expect.stringContaining("Graceful done timed out after 60s"),
            waitReason: null,
        }));

        const response = JSON.parse(result.values.get(commandResponseKey("done-timeout")));
        expect(response.error).toContain("Graceful done timed out after 60s");
    });
});
