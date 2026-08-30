/**
 * P2 of the child-wake diet (orchestration ≥1.0.71): wake a parent for child
 * updates less often.
 *
 *   R2  a digest is HELD when the parent's own wait/cron fires within 60s,
 *       and delivered inside that timer turn (processTimer flushes it)
 *   R3  the batch window is 15s × tracked children, 30s..300s
 *   R4  a child's completion is never overwritten by its later wait
 *
 * The harness below is the one from child-update-batching.test.js, verbatim
 * (kept in sync by copy; the two files must not diverge in resolve()).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandResponseKey } from "../../src/types.ts";
import { parseChildUpdate } from "../../src/orchestration/agents.ts";

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
        sentToSessions: [],
        recordedEvents: [],
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
        recordSessionEvent: vi.fn((sessionId, events) => ({ effect: "recordSessionEvent", sessionId, events })),
        summarizeSession: vi.fn(() => ({ effect: "summarizeSession" })),
        listChildSessions: vi.fn(() => ({ effect: "listChildSessions" })),
        getOrchestrationStats: vi.fn((sessionId) => ({ effect: "getOrchestrationStats", sessionId })),
        getSessionStatus: vi.fn((sessionId) => ({ effect: "getSessionStatus", sessionId })),
        sendCommandToSession: vi.fn((sessionId, command) => ({ effect: "sendCommandToSession", sessionId, command })),
        sendToSession: vi.fn((sessionId, prompt) => ({ effect: "sendToSession", sessionId, prompt })),
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
        // Stop-turn race (orchestration v1.0.56+): processPrompt yields
        // race(runTurnTask, dequeueEvent(stopTurn.<iteration>)) instead of a
        // bare runTurn. The harness treats reaching runTurn as its stopping
        // point exactly like the old direct yield; callers resume the
        // generator with the race envelope { index: 0, value: turnResult }.
        if (left?.effect === "runTurn") {
            state.runTurnCall = left;
            return STOP;
        }
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
                state.recordedEvents.push({ sessionId: effect.sessionId, events: effect.events });
                return undefined;
            case "summarizeSession":
                return undefined;
            case "listChildSessions":
                return JSON.stringify(inputOverrides.listedChildren ?? inputOverrides.subAgents ?? []);
            case "getOrchestrationStats":
                return inputOverrides.orchestrationStats ?? {
                    historyEventCount: 0,
                    historySizeBytes: 0,
                    queuePendingCount: 0,
                    kvUserKeyCount: 0,
                    kvTotalValueBytes: 0,
                };
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
            case "sendToSession":
                state.sentToSessions.push({ sessionId: effect.sessionId, prompt: effect.prompt });
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

    async function runThroughTurn(turnResult) {
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
        };

        for (let execution = 0; execution < 10; execution += 1) {
            const gen = handler(ctx, currentInput);
            let input;
            for (let step = 0; step < 800; step += 1) {
                const next = gen.next(input);
                if (next.done) {
                    return {
                        done: true,
                        value: next.value,
                        state,
                    };
                }

                state.continueAsNew = null;
                const resolved = resolve(next.value);
                if (resolved === STOP) {
                    input = { index: 0, value: turnResult };
                    continue;
                }
                input = resolved;

                if (state.continueAsNew) {
                    return {
                        done: false,
                        continueAsNew: state.continueAsNew,
                        state,
                    };
                }
            }
        }

        throw new Error("Exceeded step limit before orchestration continued as new.");
    }

    async function runUntilSecondRunTurn(firstTurnResult) {
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
        };
        let runTurnCount = 0;

        for (let execution = 0; execution < 10; execution += 1) {
            const gen = handler(ctx, currentInput);
            let input;
            for (let step = 0; step < 1000; step += 1) {
                const next = gen.next(input);
                if (next.done) {
                    return {
                        done: true,
                        value: next.value,
                        state,
                    };
                }

                state.continueAsNew = null;
                const resolved = resolve(next.value);
                if (resolved === STOP) {
                    runTurnCount += 1;
                    if (runTurnCount === 1) {
                        input = { index: 0, value: firstTurnResult };
                        continue;
                    }
                    return {
                        done: false,
                        runTurnCall: state.runTurnCall,
                        state,
                    };
                }
                input = resolved;

                if (state.continueAsNew) {
                    currentInput = state.continueAsNew.input;
                    break;
                }
            }
        }

        throw new Error("Exceeded step limit before reaching the second runTurn.");
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

    async function runUntilBlockedOrContinueAsNew() {
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
            ...inputOverrides,
        });

        let input;
        for (let step = 0; step < 800; step += 1) {
            const next = gen.next(input);
            if (next.done) {
                return { done: true, value: next.value, state };
            }

            state.continueAsNew = null;
            if (next.value?.effect === "dequeueEvent" && scheduledMessages.length === 0) {
                return { blocked: true, state };
            }

            const resolved = resolve(next.value);
            if (resolved === STOP) {
                return { blocked: false, runTurnCall: state.runTurnCall, state };
            }
            input = resolved;

            if (state.continueAsNew) {
                return { blocked: false, continueAsNew: state.continueAsNew, state };
            }
        }

        throw new Error("Exceeded step limit before blocking or continuing as new.");
    }

    return {
        runUntilRunTurn,
        runThroughTurn,
        runUntilSecondRunTurn,
        runUntilDone,
        runUntilBlockedOrContinueAsNew,
        state,
        values,
    };
}


describe("child-wake diet (orchestration ≥1.0.71)", () => {
    // R2: the parent's own cron fires in 45s → the digest waits for it and
    // rides into the cron turn's prompt. No separate wake-up.
    it("holds a child digest for a cron due within 60s and delivers it in the cron turn", async () => {
        const harness = createHarness({
            messages: [
                { atMs: 0, payload: { prompt: "[CHILD_UPDATE from=child-1 type=completed iter=3]\nChild one done" } },
                { atMs: 5_000, payload: { prompt: "[CHILD_UPDATE from=child-2 type=completed iter=3]\nChild two done" } },
            ],
            inputOverrides: {
                subAgents: [
                    { orchId: "agent-1", sessionId: "child-1", task: "One", status: "running" },
                    { orchId: "agent-2", sessionId: "child-2", task: "Two", status: "running" },
                ],
                activeTimerState: { remainingMs: 45_000, originalDurationMs: 180_000, reason: "refresh summary", type: "cron" },
            },
        });
        const result = await harness.runUntilRunTurn();
        expect(result.state.nowMs).toBe(45_000);
        expect(mockSession.runTurn).toHaveBeenCalledTimes(1);
        const prompt = result.runTurnCall.prompt;
        expect(prompt).toContain("Scheduled cron wake-up for: \"refresh summary\"");
        expect(prompt).toContain("Buffered child updates arrived");
        expect(prompt).toContain("Agent agent-1");
        expect(prompt).toContain("Agent agent-2");
        expect(prompt).toContain("Child two done");
    });

    it("does NOT hold the digest when the cron is more than 60s away — the batch window fires as before", async () => {
        const harness = createHarness({
            messages: [
                { atMs: 0, payload: { prompt: "[CHILD_UPDATE from=child-1 type=completed iter=3]\nChild one done" } },
            ],
            inputOverrides: {
                subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "One", status: "running" }],
                activeTimerState: { remainingMs: 120_000, originalDurationMs: 180_000, reason: "refresh summary", type: "cron" },
            },
        });
        const result = await harness.runUntilRunTurn();
        expect(result.state.nowMs).toBe(30_000);
        expect(result.runTurnCall.prompt).toContain("Buffered child updates arrived");
        expect(result.runTurnCall.prompt).not.toContain("Scheduled cron wake-up");
    });

    it("a failed child is not held — it wakes the parent at the batch window even with a cron due in 45s", async () => {
        const harness = createHarness({
            messages: [
                { atMs: 0, payload: { prompt: "[CHILD_UPDATE from=child-1 type=failed iter=3]\nOOM killed" } },
            ],
            inputOverrides: {
                subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "One", status: "running" }],
                activeTimerState: { remainingMs: 45_000, originalDurationMs: 180_000, reason: "refresh summary", type: "cron" },
            },
        });
        const result = await harness.runUntilRunTurn();
        expect(result.state.nowMs).toBe(30_000);
        expect(result.runTurnCall.prompt).toContain("OOM killed");
    });

    it("an idle timer due within 60s does not count as 'will wake anyway'", async () => {
        const harness = createHarness({
            messages: [
                { atMs: 0, payload: { prompt: "[CHILD_UPDATE from=child-1 type=completed iter=3]\nChild one done" } },
            ],
            inputOverrides: {
                subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "One", status: "running" }],
                activeTimerState: { remainingMs: 45_000, originalDurationMs: 45_000, reason: "idle", type: "idle" },
            },
        });
        const result = await harness.runUntilRunTurn();
        expect(result.state.nowMs).toBe(30_000);
        expect(result.runTurnCall.prompt).toContain("Child one done");
    });

    // R3: the batch window scales with fan-out — five children → 75s.
    it("buffers for 15s × children (75s for five) instead of a flat 30s", async () => {
        const subAgents = [1, 2, 3, 4, 5].map((i) => ({ orchId: `agent-${i}`, sessionId: `child-${i}`, task: `T${i}`, status: "running" }));
        const harness = createHarness({
            messages: [
                { atMs: 0, payload: { prompt: "[CHILD_UPDATE from=child-1 type=completed iter=3]\nChild one done" } },
            ],
            inputOverrides: { subAgents },
        });
        const result = await harness.runUntilRunTurn();
        expect(result.state.nowMs).toBe(75_000);
        expect(result.runTurnCall.prompt).toContain("Child one done");
    });

    // R4: a completion is never overwritten by a later wait from the same child.
    it("keeps a child's completion when a wait from the same child arrives later in the window", async () => {
        const harness = createHarness({
            messages: [
                { atMs: 0, payload: { prompt: "[CHILD_UPDATE from=child-1 type=completed iter=3]\nFinal answer here" } },
                { atMs: 10_000, payload: { prompt: "[CHILD_UPDATE from=child-1 type=wait iter=4]\nSleeping again" } },
            ],
            inputOverrides: {
                subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "One", status: "running" }],
            },
        });
        const result = await harness.runUntilRunTurn();
        expect(result.runTurnCall.prompt).toContain("Final answer here");
        expect(result.runTurnCall.prompt).not.toContain("Sleeping again");
    });
});

describe("child side: a bare wait is a heartbeat, wait({material:true}) is not (≥1.0.71)", () => {
    const childInput = {
        sessionId: "child-session",
        parentSessionId: "parent-1",
        isSystem: false,
        cronSchedule: undefined,
        activeTimerState: undefined,
    };

    it("a child's plain wait sends NOTHING to the parent and records the suppression", async () => {
        const harness = createHarness({
            messages: [{ atMs: 0, payload: { prompt: "do the work" } }],
            inputOverrides: childInput,
        });
        const result = await harness.runUntilSecondRunTurn({
            type: "wait", seconds: 60, reason: "poll again", content: "Sleeping 60s, will re-check the deploy.",
        });
        const toParent = result.state.sentToSessions.filter((s) => s.sessionId === "parent-1");
        expect(toParent.filter((s) => /type=wait/.test(s.prompt))).toHaveLength(0);
        const suppressed = result.state.recordedEvents.flatMap((r) => (Array.isArray(r?.events) ? r.events : [])).filter((e) => e?.eventType === "session.child_update_suppressed");
        expect(suppressed.length).toBeGreaterThanOrEqual(1);
        expect(suppressed[0].data.updateType).toBe("wait");
    });

    it("a child's wait({material: true}) DOES reach the parent", async () => {
        const harness = createHarness({
            messages: [{ atMs: 0, payload: { prompt: "do the work" } }],
            inputOverrides: childInput,
        });
        const result = await harness.runUntilSecondRunTurn({
            type: "wait", seconds: 60, reason: "blocker", material: true, content: "Blocker: quota exhausted; parent must decide.",
        });
        const toParent = result.state.sentToSessions.filter((s) => s.sessionId === "parent-1" && /type=wait/.test(s.prompt));
        expect(toParent).toHaveLength(1);
        expect(toParent[0].prompt).toContain("quota exhausted");
    });

    it("a child's QUESTION FOR PARENT still reaches the parent", async () => {
        const harness = createHarness({
            messages: [{ atMs: 0, payload: { prompt: "do the work" } }],
            inputOverrides: childInput,
        });
        const result = await harness.runUntilSecondRunTurn({
            type: "completed", content: "QUESTION FOR PARENT: may I delete the resource group?",
        });
        const toParent = result.state.sentToSessions.filter((s) => s.sessionId === "parent-1" && /type=wait/.test(s.prompt));
        expect(toParent).toHaveLength(1);
        expect(toParent[0].prompt).toContain("QUESTION FOR PARENT");
    });
});
