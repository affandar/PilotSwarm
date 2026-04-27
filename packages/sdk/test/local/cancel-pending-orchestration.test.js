import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

function createHarness({ values = new Map(), messages = [] } = {}) {
    const scheduledMessages = [...messages]
        .map((entry) => ({
            atMs: entry.atMs ?? 0,
            payload: entry.payload,
        }))
        .sort((left, right) => left.atMs - right.atMs);
    const traces = [];
    const runTurns = [];
    const state = { nowMs: 0 };

    const ctx = {
        traceInfo: (message) => traces.push(message),
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

    function normalizePayload(payload) {
        return typeof payload === "string" ? payload : JSON.stringify(payload);
    }

    function resolveRace(left, right) {
        const timerMs = right?.effect === "scheduleTimer" ? right.ms : 0;
        const next = scheduledMessages[0];
        if (left?.effect === "dequeueEvent" && next && next.atMs <= state.nowMs + timerMs) {
            scheduledMessages.shift();
            state.nowMs = Math.max(state.nowMs, next.atMs);
            return { index: 0, value: normalizePayload(next.payload) };
        }
        state.nowMs += timerMs;
        return { index: 1, value: undefined };
    }

    function resolve(effect) {
        switch (effect?.effect) {
            case "utcNow":
                return state.nowMs;
            case "dequeueEvent":
                if (scheduledMessages.length === 0) {
                    throw new Error("Blocking dequeue requested with no queued messages.");
                }
                state.nowMs = Math.max(state.nowMs, scheduledMessages[0].atMs);
                return normalizePayload(scheduledMessages.shift().payload);
            case "race":
                return resolveRace(effect.left, effect.right);
            case "needsHydration":
                return false;
            case "runTurn":
                runTurns.push(effect);
                return { type: "completed", message: "ok" };
            case "checkpoint":
            case "hydrate":
            case "dehydrate":
            case "destroy":
            case "loadKnowledgeIndex":
            case "recordSessionEvent":
            case "summarizeSession":
                return undefined;
            case "getOrchestrationStats":
                return {
                    historyEventCount: 0,
                    historySizeBytes: 0,
                    queuePendingCount: 0,
                    kvUserKeyCount: 0,
                    kvTotalValueBytes: 0,
                };
            case "continueAsNewVersioned":
                return undefined;
            default:
                throw new Error(`Unknown effect: ${JSON.stringify(effect)}`);
        }
    }

    async function runUntilIdle() {
        const orchestrationModule = await import("../../src/orchestration.ts");
        const handlerName = `durableSessionOrchestration_${String(orchestrationModule.CURRENT_ORCHESTRATION_VERSION || "")
            .replace(/\./g, "_")}`;
        const handler = orchestrationModule[handlerName];
        const gen = handler(ctx, {
            sessionId: "cancel-session",
            config: {},
            iteration: 0,
            isSystem: true,
            blobEnabled: false,
        });

        let input;
        for (let step = 0; step < 200; step += 1) {
            const next = gen.next(input);
            if (next.done) return;
            if (next.value?.effect === "dequeueEvent" && scheduledMessages.length === 0) return;
            input = resolve(next.value);
        }
        throw new Error("Exceeded step limit before idle.");
    }

    return { runUntilIdle, traces, runTurns };
}

describe("cancelPendingMessage orchestration", () => {
    beforeEach(() => {
        vi.resetModules();
        mockSession = {
            needsHydration: vi.fn(() => ({ effect: "needsHydration" })),
            runTurn: vi.fn((prompt, bootstrap, iteration, opts) => ({
                effect: "runTurn",
                prompt,
                bootstrap,
                iteration,
                opts,
            })),
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            hydrate: vi.fn(() => ({ effect: "hydrate" })),
            dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        };
        mockManager = {
            loadKnowledgeIndex: vi.fn(() => ({ effect: "loadKnowledgeIndex" })),
            recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
            summarizeSession: vi.fn(() => ({ effect: "summarizeSession" })),
            getOrchestrationStats: vi.fn(() => ({ effect: "getOrchestrationStats" })),
        };
    });

    it("drops a FIFO prompt when any contributing client message id is tombstoned before dispatch", async () => {
        const values = new Map();
        values.set("fifo.0", JSON.stringify([{
            kind: "prompt",
            prompt: "message 1\n\nmessage 2",
            clientMessageIds: ["client-message-1", "client-message-2"],
        }]));
        const harness = createHarness({
            values,
            messages: [{
                atMs: 0,
                payload: { cancelPending: ["client-message-2"] },
            }],
        });

        await harness.runUntilIdle();

        expect(harness.runTurns).toHaveLength(0);
        expect(harness.traces.some((line) => line.includes("received cancel tombstone"))).toBe(true);
        expect(harness.traces.some((line) => line.includes("dropping FIFO prompt cancelled by tombstone"))).toBe(true);
        expect(mockManager.recordSessionEvent).toHaveBeenCalledWith(
            "cancel-session",
            [{
                eventType: "pending_messages.cancelled",
                data: {
                    clientMessageIds: ["client-message-1", "client-message-2"],
                    reason: "decide-fifo",
                },
            }],
        );
    });

    it("sweeps queued messages for later cancel tombstones before dispatching the next prompt", async () => {
        const values = new Map();
        values.set("fifo.0", JSON.stringify([{
            kind: "prompt",
            prompt: "message A",
            clientMessageIds: ["client-message-a"],
        }]));
        const harness = createHarness({
            values,
            messages: [
                {
                    atMs: 50,
                    payload: {
                        prompt: "message B",
                        clientMessageIds: ["client-message-b"],
                    },
                },
                {
                    atMs: 50,
                    payload: {
                        prompt: "message C",
                        clientMessageIds: ["client-message-c"],
                    },
                },
                {
                    atMs: 50,
                    payload: { cancelPending: ["client-message-b"] },
                },
                {
                    atMs: 50,
                    payload: { cancelPending: ["client-message-a"] },
                },
            ],
        });

        await harness.runUntilIdle();

        expect(harness.runTurns.map((turn) => turn.prompt)).toEqual(["message C"]);
        expect(harness.traces.some((line) => line.includes("[predispatch] received cancel tombstone"))).toBe(true);
        expect(mockManager.recordSessionEvent).toHaveBeenCalledWith(
            "cancel-session",
            [{
                eventType: "pending_messages.cancelled",
                data: {
                    clientMessageIds: ["client-message-b"],
                    reason: "predispatch-stash",
                },
            }],
        );
        expect(mockManager.recordSessionEvent).toHaveBeenCalledWith(
            "cancel-session",
            [{
                eventType: "pending_messages.cancelled",
                data: {
                    clientMessageIds: ["client-message-a"],
                    reason: "decide-fifo",
                },
            }],
        );
    });
});
