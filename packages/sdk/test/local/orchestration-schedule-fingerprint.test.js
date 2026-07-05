/**
 * Schedule-drift guard for the LATEST durable-session orchestration.
 *
 * Durable orchestrations replay their recorded history against the handler
 * registered for the version in that history. If the *schedule* (the ordered
 * sequence of durable yields — activities, timers, guids, continue-as-new) of
 * an ALREADY-DEPLOYED version changes without a version bump, in-flight
 * orchestrations fail replay with a Nondeterminism / schedule-mismatch error.
 *
 * This test pins a fingerprint of the latest orchestration's yield sequence
 * for a canonical, LLM-free drive. If you change the schedule you MUST:
 *   1. Freeze the current latest as `orchestration_<v>/` and register it, then
 *   2. bump `DURABLE_SESSION_LATEST_VERSION`, and finally
 *   3. regenerate GOLDEN below (the test prints the new value on mismatch).
 * A bare edit that trips this test without a version bump is the exact bug
 * that broke in-flight 1.0.57 sessions when the needsHydration probe was
 * removed in place.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

// The canonical golden schedule for the latest orchestration driven through a
// single get_info command with blob enabled (the path that carries the
// hydration probe on legacy versions). Regenerate ONLY alongside a version bump.
const GOLDEN = [
    "recordSessionEvent",
    "recordSessionEvent",
    "continueAsNew",
];

function createCtx(values, queue = []) {
    const queuedEvents = [...queue];
    return {
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
        hasQueuedEvents: () => queuedEvents.length > 0,
        resolveEffect(effect) {
            if (!effect) return undefined;
            switch (effect.effect) {
                case "utcNow":
                    return 1_713_083_589_000;
                case "newGuid":
                    return "00000000-0000-0000-0000-000000000000";
                case "dequeueEvent":
                    if (queuedEvents.length === 0) {
                        throw new Error("Queue underflow while resolving dequeueEvent");
                    }
                    return queuedEvents.shift();
                case "recordSessionEvent":
                case "checkpoint":
                case "hydrate":
                case "dehydrate":
                case "needsHydration":
                case "destroy":
                    return undefined;
                default:
                    throw new Error(`Unexpected effect: ${JSON.stringify(effect)}`);
            }
        },
    };
}

// Drive the generator, recording the ordered list of durable-yield effect
// names, until it continues-as-new or blocks on an empty queue.
function fingerprint(gen, ctx) {
    const schedule = [];
    let input;
    for (let step = 0; step < 200; step += 1) {
        const next = gen.next(input);
        if (next.done) {
            schedule.push("return");
            return schedule;
        }
        const effect = next.value?.effect;
        if (effect === "continueAsNew") {
            schedule.push("continueAsNew");
            return schedule;
        }
        if (effect === "dequeueEvent" && !ctx.hasQueuedEvents()) {
            schedule.push("dequeueEvent(block)");
            return schedule;
        }
        // Record only the durable-yield effects that define the schedule;
        // reads (getValue/utcNow/dequeueEvent) are deterministic glue.
        if (!["utcNow", "dequeueEvent"].includes(effect)) {
            schedule.push(effect);
        }
        input = ctx.resolveEffect(next.value);
    }
    throw new Error("Exceeded step limit before stop condition");
}

describe("latest orchestration schedule fingerprint", () => {
    beforeEach(() => {
        mockSession = {
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            hydrate: vi.fn(() => ({ effect: "hydrate" })),
            dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
            needsHydration: vi.fn(() => ({ effect: "needsHydration" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        };
        mockManager = {
            recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
        };
    });

    it("matches the pinned golden (bump the version + regenerate on intentional change)", async () => {
        const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
        const mod = await import("../../src/orchestration.ts");
        const latest = mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
        expect(latest, `latest handler export for ${DURABLE_SESSION_LATEST_VERSION} must exist`).toBeTypeOf("function");

        const values = new Map();
        const ctx = createCtx(values, [
            JSON.stringify({ type: "cmd", cmd: "get_info", id: "fp-get-info" }),
        ]);
        const gen = latest(ctx, {
            sessionId: "fp-session",
            config: { model: "github-copilot:gpt-5.4" },
            sourceOrchestrationVersion: DURABLE_SESSION_LATEST_VERSION,
            iteration: 0,
            isSystem: true,
            blobEnabled: true,
        });

        const schedule = fingerprint(gen, ctx);
        if (JSON.stringify(schedule) !== JSON.stringify(GOLDEN)) {
            // Surface the new fingerprint so an intentional change is a one-line update.
            throw new Error(
                `Latest orchestration schedule changed.\n` +
                    `If this was intentional, FREEZE the current latest as a versioned module, ` +
                    `register it, bump DURABLE_SESSION_LATEST_VERSION, then set GOLDEN to:\n` +
                    `${JSON.stringify(schedule, null, 4)}\n` +
                    `Got:      ${JSON.stringify(schedule)}\n` +
                    `Expected: ${JSON.stringify(GOLDEN)}`,
            );
        }
        expect(schedule).toEqual(GOLDEN);
    });

    it("frozen 1.0.57 still yields the needsHydration probe it was deployed with", async () => {
        // In-flight 1.0.57 histories recorded the probe activity (emitted on the
        // turn path). The frozen module MUST keep that yield or those histories
        // fail replay — the regression the version bump exists to prevent. The
        // probe only fires while processing a prompt (not a bare command), which
        // this LLM-free harness can't drive, so assert it at the source: the
        // frozen turn schedule must still contain the probe yield.
        const url = new URL("../../src/orchestration_1_0_57/turn.ts", import.meta.url);
        const { readFileSync } = await import("node:fs");
        const turnSource = readFileSync(url, "utf8");
        expect(turnSource).toMatch(/yield\s+runtime\.session\.needsHydration\(\)/);

        // And the module must still be registered so replay can resolve it.
        const mod = await import("../../src/orchestration_1_0_57/index.ts");
        expect(mod.durableSessionOrchestration_1_0_57).toBeTypeOf("function");
        expect(mod.CURRENT_ORCHESTRATION_VERSION).toBe("1.0.57");
    });
});
