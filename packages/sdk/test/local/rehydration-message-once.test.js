import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedSession } from "../../src/managed-session.js";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (_ctx, _sessionId, _affinityKey, config) => {
        mockSession._currentConfig = config;
        return mockSession;
    },
    createSessionManagerProxy: () => mockManager,
}));

function createHarness() {
    const scheduledMessages = [
        { atMs: 0, payload: { prompt: "Hey, are you there?" } },
        { atMs: 1_000, payload: { prompt: "Still there?" } },
    ];
    const runTurnCalls = [];
    const state = {
        nowMs: 0,
    };

    mockSession = {
        _currentConfig: {},
        hydrate: vi.fn(() => ({ effect: "hydrate" })),
        dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
        checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
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
        recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
        summarizeSession: vi.fn(() => ({ effect: "summarizeSession" })),
        listChildSessions: vi.fn(() => ({ effect: "listChildSessions" })),
        getOrchestrationStats: vi.fn(() => ({ effect: "getOrchestrationStats" })),
    };

    const values = new Map();
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

    function resolve(effect) {
        if (effect == null) return undefined;
        switch (effect.effect) {
            case "utcNow":
                return state.nowMs;
            case "hydrate":
            case "dehydrate":
            case "checkpoint":
            case "destroy":
            case "recordSessionEvent":
            case "summarizeSession":
                return undefined;
            case "listChildSessions":
                return JSON.stringify([]);
            case "getOrchestrationStats":
                return {
                    historyEventCount: 0,
                    historySizeBytes: 0,
                    queuePendingCount: 0,
                    kvUserKeyCount: 0,
                    kvTotalValueBytes: 0,
                };
            case "newGuid":
                return "new-affinity";
            case "dequeueEvent": {
                const next = nextMessageIfReady(state.nowMs) ?? scheduledMessages.shift()?.payload;
                if (!next) throw new Error("Blocking dequeue requested with no queued messages.");
                return normalizePayload(next);
            }
            case "race": {
                const timerMs = effect.right?.effect === "scheduleTimer" ? effect.right.ms : 0;
                const next = nextMessageIfReady(state.nowMs);
                if (effect.left?.effect === "dequeueEvent" && next) {
                    return { index: 0, value: normalizePayload(next) };
                }
                const future = scheduledMessages[0];
                if (effect.left?.effect === "dequeueEvent" && future && future.atMs < state.nowMs + timerMs) {
                    scheduledMessages.shift();
                    state.nowMs = future.atMs;
                    return { index: 0, value: normalizePayload(future.payload) };
                }

                state.nowMs += timerMs;
                return { index: 1, value: undefined };
            }
            case "runTurn":
                runTurnCalls.push(effect);
                return { type: "completed", content: `reply ${runTurnCalls.length}`, events: [] };
            case "continueAsNewVersioned":
                return undefined;
            default:
                throw new Error(`Unknown effect: ${JSON.stringify(effect)}`);
        }
    }

    async function runUntilTwoTurns() {
        const orchestrationModule = await import("../../src/orchestration.ts");
        const handlerName = `durableSessionOrchestration_${String(orchestrationModule.CURRENT_ORCHESTRATION_VERSION || "")
            .replace(/\./g, "_")}`;
        const handler = orchestrationModule[handlerName];
        if (typeof handler !== "function") {
            throw new Error(`Could not resolve latest orchestration handler: ${handlerName}`);
        }

        const gen = handler(ctx, {
            sessionId: "rehydration-session",
            config: {},
            iteration: 12,
            isSystem: true,
            blobEnabled: true,
            dehydrateThreshold: 29,
            needsHydration: true,
            rehydrationMessage:
                "The previous worker lost the live Copilot connection and handed this session off after 3 retries. " +
                "The LLM conversation history is preserved. Review the latest durable context and continue carefully. " +
                "Last transport error: Connection is closed.",
            cronSchedule: {
                intervalSeconds: 60,
                reason: "polling custom opus46 lead handoff",
            },
            activeTimerState: {
                remainingMs: 60_000,
                originalDurationMs: 60_000,
                reason: "polling custom opus46 lead handoff",
                type: "cron",
                shouldRehydrate: true,
            },
        });

        let input;
        for (let step = 0; step < 800; step += 1) {
            const next = gen.next(input);
            if (next.done) break;
            input = resolve(next.value);
            if (runTurnCalls.length >= 2) return runTurnCalls;
        }

        throw new Error("Expected to reach two runTurn calls.");
    }

    return { runUntilTwoTurns };
}

describe("rehydration message reuse", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("uses lossy handoff guidance only for the first resumed turn", async () => {
        const harness = createHarness();
        const runTurnCalls = await harness.runUntilTwoTurns();

        const firstTurnText = [runTurnCalls[0].prompt, runTurnCalls[0].systemPrompt].filter(Boolean).join("\n");
        const secondTurnText = [runTurnCalls[1].prompt, runTurnCalls[1].systemPrompt].filter(Boolean).join("\n");

        expect(firstTurnText).toContain("The previous worker lost the live Copilot connection");
        expect(secondTurnText).not.toContain("The previous worker lost the live Copilot connection");
        expect(secondTurnText).toContain("The session was dehydrated and has been rehydrated on a new worker");
        expect(secondTurnText).toContain("polling custom opus46 lead handoff");
    });

    it("normalizes assistant tool-call history entries with null content before the next turn", async () => {
        const namedHandlers = new Map();
        const fakeCopilotSession = {
            _chatMessages: [
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_wait_1",
                            type: "function",
                            function: {
                                name: "wait",
                                arguments: '{"seconds":35}',
                            },
                        },
                    ],
                },
            ],
            _systemContextMessages: [],
            registerTools: vi.fn(),
            on: vi.fn((eventOrHandler, maybeHandler) => {
                if (typeof eventOrHandler === "function") {
                    return () => {};
                }
                const handlers = namedHandlers.get(eventOrHandler) || [];
                handlers.push(maybeHandler);
                namedHandlers.set(eventOrHandler, handlers);
                return () => {};
            }),
            send: vi.fn(async () => {
                expect(fakeCopilotSession._chatMessages[0].content).toBe("");
                for (const handler of namedHandlers.get("session.idle") || []) {
                    await handler({});
                }
            }),
            abort: vi.fn(),
            disconnect: vi.fn(),
        };

        const managed = new ManagedSession("compat-session", fakeCopilotSession, {});
        const result = await managed.runTurn("ok what is going on right now");

        expect(fakeCopilotSession.send).toHaveBeenCalledTimes(1);
        expect(fakeCopilotSession._chatMessages[0].content).toBe("");
        expect(result.type).toBe("completed");
    });
});
