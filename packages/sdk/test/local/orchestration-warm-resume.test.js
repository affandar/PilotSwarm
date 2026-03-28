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
            version: "1.0.30",
        });
        expect(third.value.input.prompt).toContain("Sub-agent spawned successfully");
        expect(calls).toEqual([
            "spawnChildSession",
            "checkpoint",
            "continueAsNew:1.0.30",
        ]);

        const done = gen.next();
        expect(done.done).toBe(true);
        expect(done.value).toBe("");
    });
});
