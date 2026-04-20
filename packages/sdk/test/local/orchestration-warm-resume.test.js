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
});
