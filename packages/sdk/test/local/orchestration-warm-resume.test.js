import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

describe("orchestration warm resume durability", () => {
    beforeEach(() => {
        mockSession = {
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        };
        mockManager = {
            spawnChildSession: vi.fn(() => ({ effect: "spawnChildSession" })),
        };
    });

    it("checkpoints queued spawn_agent follow-ups before warm continueAsNew", async () => {
        const calls = [];
        mockSession.checkpoint.mockImplementation(() => {
            calls.push("checkpoint");
            return { effect: "checkpoint" };
        });
        mockManager.spawnChildSession.mockImplementation(() => {
            calls.push("spawnChildSession");
            return { effect: "spawnChildSession" };
        });

        const { durableSessionOrchestration_1_0_30 } = await import("../../src/orchestration_1_0_30.ts");
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");

        const ctx = {
            traceInfo: () => {},
            setCustomStatus: () => {},
            setValue: () => {},
            getValue: () => null,
            continueAsNewVersioned: (nextInput, version) => {
                calls.push(`continueAsNew:${version}`);
                return { effect: "continueAsNew", input: nextInput, version };
            },
        };

        const gen = durableSessionOrchestration_1_0_30(ctx, {
            sessionId: "root-session",
            config: {},
            blobEnabled: true,
            isSystem: true,
            pendingToolActions: [
                {
                    type: "spawn_agent",
                    task: "Inspect the system state in detail, gather metrics, compare worker health, and summarize anomalies for the parent session.",
                },
            ],
        });

        const first = gen.next();
        expect(first.value).toEqual({ effect: "spawnChildSession" });
        expect(calls).toEqual(["spawnChildSession"]);

        const second = gen.next("child-session-1");
        expect(second.value).toEqual({ effect: "checkpoint" });
        expect(calls).toEqual(["spawnChildSession", "checkpoint"]);

        const third = gen.next(undefined);
        expect(third.value).toMatchObject({
            effect: "continueAsNew",
            version: DURABLE_SESSION_LATEST_VERSION,
        });
        expect(third.value.input.prompt).toContain("Sub-agent spawned successfully");
        expect(third.value.input.sourceOrchestrationVersion).toBe("1.0.30");
        expect(calls).toEqual([
            "spawnChildSession",
            "checkpoint",
            `continueAsNew:${DURABLE_SESSION_LATEST_VERSION}`,
        ]);

        const done = gen.next();
        expect(done.done).toBe(true);
        expect(done.value).toBe("");
    });

    it("preserves legacy carried command messages when upgrading into the latest orchestration", async () => {
        const values = new Map();
        const events = [];

        mockSession = {
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        };
        mockManager = {
            recordSessionEvent: vi.fn((_sessionId, batch) => {
                events.push(...batch);
                return { effect: "recordSessionEvent" };
            }),
        };

        const { durableSessionOrchestration_1_0_43 } = await import("../../src/orchestration_1_0_43.ts");
        const { commandResponseKey } = await import("../../src/types.ts");

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
            continueAsNewVersioned: (nextInput, version) => ({ effect: "continueAsNew", input: nextInput, version }),
            newGuid: () => ({ effect: "newGuid" }),
        };

        const gen = durableSessionOrchestration_1_0_43(ctx, {
            sessionId: "upgrade-session",
            config: { model: "github-copilot:gpt-5.4" },
            sourceOrchestrationVersion: "1.0.30",
            iteration: 5,
            isSystem: true,
            blobEnabled: false,
            pendingMessage: {
                type: "cmd",
                cmd: "get_info",
                id: "legacy-cmd-1",
            },
        });

        let input;
        let followupEffect = null;
        for (let step = 0; step < 50; step += 1) {
            const next = gen.next(input);
            if (next.done) break;
            const effect = next.value;
            if (effect?.effect === "utcNow") {
                input = 1234567890;
                continue;
            }
            if (effect?.effect === "recordSessionEvent") {
                input = undefined;
                continue;
            }
            if (effect?.effect === "dequeueEvent" || effect?.effect === "continueAsNew") {
                followupEffect = effect;
                break;
            }
            throw new Error(`Unexpected effect: ${JSON.stringify(effect)}`);
        }

        expect(followupEffect).toBeTruthy();
        const response = JSON.parse(values.get(commandResponseKey("legacy-cmd-1")));
        expect(response).toMatchObject({
            cmd: "get_info",
            id: "legacy-cmd-1",
            result: {
                sessionId: "upgrade-session",
                iteration: 5,
            },
        });
        expect(events).toEqual([
            { eventType: "session.command_received", data: { cmd: "get_info", id: "legacy-cmd-1" } },
            { eventType: "session.command_completed", data: { cmd: "get_info", id: "legacy-cmd-1" } },
        ]);
    });

    it("does not process a stale queued idle timer after input_required dehydration", async () => {
        const values = new Map();
        values.set("fifo.0", JSON.stringify([
            {
                kind: "timer",
                timer: {
                    deadlineMs: 0,
                    originalDurationMs: 60_000,
                    reason: "idle timeout",
                    type: "idle",
                },
                firedAtMs: 0,
            },
        ]));

        mockSession = {
            needsHydration: vi.fn(() => ({ effect: "needsHydration" })),
            hydrate: vi.fn(() => ({ effect: "hydrate" })),
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            dehydrate: vi.fn((reason, eventData) => ({ effect: "dehydrate", reason, eventData })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
            runTurn: vi.fn((prompt, bootstrap, iteration, opts) => ({
                effect: "runTurn",
                prompt,
                bootstrap,
                iteration,
                opts,
            })),
        };
        mockManager = {
            loadKnowledgeIndex: vi.fn(() => ({ effect: "loadKnowledgeIndex" })),
            recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
            summarizeSession: vi.fn(() => ({ effect: "summarizeSession" })),
            listChildSessions: vi.fn(() => ({ effect: "listChildSessions" })),
            getOrchestrationStats: vi.fn(() => ({ effect: "getOrchestrationStats" })),
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
            continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
            newGuid: () => ({ effect: "newGuid" }),
        };

        const orchestrationModule = await import("../../src/orchestration.ts");
        const handlerName = `durableSessionOrchestration_${String(orchestrationModule.CURRENT_ORCHESTRATION_VERSION || "")
            .replace(/\./g, "_")}`;
        const handler = orchestrationModule[handlerName];
        expect(typeof handler).toBe("function");

        const gen = handler(ctx, {
            sessionId: "stale-idle-input-required",
            config: {},
            prompt: "Ask me which city to use.",
            isSystem: true,
            blobEnabled: true,
            inputGracePeriod: 0,
            idleTimeout: 60,
        });

        let input;
        let blockedOnAnswerDequeue = false;
        for (let step = 0; step < 200; step += 1) {
            const next = gen.next(input);
            if (next.done) break;

            const effect = next.value;
            if (effect?.effect === "dequeueEvent") {
                blockedOnAnswerDequeue = true;
                break;
            }

            switch (effect?.effect) {
                case "utcNow":
                    input = 1_717_000_000_000;
                    break;
                case "needsHydration":
                    input = false;
                    break;
                case "race":
                    input = { index: 1, value: undefined };
                    break;
                case "loadKnowledgeIndex":
                case "recordSessionEvent":
                case "summarizeSession":
                case "hydrate":
                case "checkpoint":
                case "destroy":
                    input = undefined;
                    break;
                case "listChildSessions":
                    input = JSON.stringify([]);
                    break;
                case "getOrchestrationStats":
                    input = {
                        historyEventCount: 0,
                        historySizeBytes: 0,
                        queuePendingCount: 0,
                        kvUserKeyCount: 0,
                        kvTotalValueBytes: 0,
                    };
                    break;
                case "runTurn":
                    input = {
                        type: "input_required",
                        question: "Which city should I use?",
                        allowFreeform: true,
                        events: [],
                    };
                    break;
                case "dehydrate":
                    input = undefined;
                    break;
                case "newGuid":
                    input = "new-affinity";
                    break;
                case "continueAsNew":
                    throw new Error("Unexpected continueAsNew before waiting for the answer");
                default:
                    throw new Error(`Unexpected effect: ${JSON.stringify(effect)}`);
            }
        }

        expect(blockedOnAnswerDequeue).toBe(true);
        expect(mockSession.dehydrate).toHaveBeenCalledTimes(1);
        expect(mockSession.dehydrate).toHaveBeenCalledWith("input_required", undefined);
    });

});
