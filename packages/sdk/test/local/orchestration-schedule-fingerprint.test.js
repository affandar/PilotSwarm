/**
 * Schedule-drift guard for the durable-session orchestration.
 *
 * Durable orchestrations replay recorded history against the handler
 * registered for the version in that history. If the SCHEDULE — the set and
 * ordering of durable yields (activities, timers, guids, continue-as-new) — of
 * an ALREADY-DEPLOYED version changes without a version bump, in-flight
 * orchestrations fail replay with a Nondeterminism / schedule-mismatch error
 * and terminally fail on their next wake. This is exactly what happened when
 * the needsHydration probe was removed in place under a still-deployed 1.0.57.
 *
 * Two layers guard against a recurrence reaching a prod cluster:
 *   1. SURFACE — the set of durable operations the latest orchestration can
 *      schedule. Adding/removing any activity kind (e.g. dropping the probe)
 *      trips this on ANY code path, not just the one a drive happens to hit.
 *   2. DRIVE — the ordered yield sequence for a canonical LLM-free command,
 *      which additionally catches reordering on that path.
 *
 * If either fails on an INTENTIONAL change you MUST, in order:
 *   1. freeze the current latest as `orchestration_<v>/` and register it,
 *   2. bump `DURABLE_SESSION_LATEST_VERSION`, then
 *   3. regenerate the golden below (the failure prints the new value).
 */
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

// ── Layer 1 golden: the durable-operation surface of the latest orchestration.
// Distinct schedule-bearing proxy/ctx calls across orchestration/*.ts. Sorted.
const GOLDEN_SURFACE = [
    "ctx.continueAsNewVersioned",
    "ctx.newGuid",
    "ctx.scheduleTimer",
    "ctx.utcNow",
    "runtime.manager.commitEpochBoundary",
    "runtime.manager.computeCronAtNextFire",
    "runtime.manager.deleteSession",
    "runtime.manager.getDescendantSessionIds",
    "runtime.manager.getOrchestrationStats",
    "runtime.manager.getSessionStatus",
    "runtime.manager.getWorkerSessionPolicy",
    "runtime.manager.listChildSessions",
    "runtime.manager.listModels",
    "runtime.manager.listSessions",
    "runtime.manager.loadKnowledgeIndex",
    "runtime.manager.recordRegenerated",
    "runtime.manager.recordSessionEvent",
    "runtime.manager.resolveAgentConfig",
    "runtime.manager.runRegenArchive",
    "runtime.manager.runRegenCancelDistiller",
    "runtime.manager.runRegenCheckDistiller",
    "runtime.manager.runRegenCollectDistiller",
    "runtime.manager.runRegenDistill",
    "runtime.manager.runRegenSpawnDistiller",
    "runtime.manager.sendCommandToSession",
    "runtime.manager.sendToSession",
    "runtime.manager.spawnChildSession",
    "runtime.manager.summarizeSession",
    "runtime.manager.updateCmsState",
    "runtime.manager.updateSessionModel",
    "runtime.session.abortTurn",
    "runtime.session.destroy",
    "runtime.session.hydrate",
    "runtime.session.runTurn"
];

// ── Layer 2 golden: ordered durable yields for a get_info command, blob on.
const GOLDEN_DRIVE = ["recordSessionEvent", "recordSessionEvent", "continueAsNew"];

const SURFACE_RE = /(?:runtime\.session|runtime\.manager)\.[a-zA-Z0-9_]+\(|ctx\.(?:newGuid|utcNow|scheduleTimer|continueAsNewVersioned|callActivity|waitForExternalEvent)\(/g;

function scheduleSurface(dir) {
    const found = new Set();
    for (const name of readdirSync(new URL(dir, import.meta.url))) {
        if (!name.endsWith(".ts")) continue;
        const src = readFileSync(new URL(`${dir}/${name}`, import.meta.url), "utf8");
        for (const m of src.matchAll(SURFACE_RE)) {
            found.add(m[0].replace(/\($/, ""));
        }
    }
    return [...found].sort();
}

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
                    if (queuedEvents.length === 0) throw new Error("Queue underflow");
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

function driveFingerprint(gen, ctx) {
    const schedule = [];
    let input;
    for (let step = 0; step < 200; step += 1) {
        const next = gen.next(input);
        if (next.done) return [...schedule, "return"];
        const effect = next.value?.effect;
        if (effect === "continueAsNew") return [...schedule, "continueAsNew"];
        if (effect === "dequeueEvent" && !ctx.hasQueuedEvents()) return [...schedule, "dequeueEvent(block)"];
        if (!["utcNow", "dequeueEvent"].includes(effect)) schedule.push(effect);
        input = ctx.resolveEffect(next.value);
    }
    throw new Error("Exceeded step limit");
}

describe("orchestration schedule-drift guard", () => {
    beforeEach(() => {
        mockSession = {
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            hydrate: vi.fn(() => ({ effect: "hydrate" })),
            dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
            needsHydration: vi.fn(() => ({ effect: "needsHydration" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        };
        mockManager = { recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })) };
    });

    it("latest durable-operation surface matches golden (bump version + regenerate on change)", () => {
        const surface = scheduleSurface("../../src/orchestration");
        if (JSON.stringify(surface) !== JSON.stringify(GOLDEN_SURFACE)) {
            const added = surface.filter((x) => !GOLDEN_SURFACE.includes(x));
            const removed = GOLDEN_SURFACE.filter((x) => !surface.includes(x));
            throw new Error(
                `Latest orchestration schedule surface changed — this can break replay of in-flight ` +
                    `orchestrations. If intentional: freeze the current latest as a versioned module, register ` +
                    `it, bump DURABLE_SESSION_LATEST_VERSION, then set GOLDEN_SURFACE to:\n` +
                    `${JSON.stringify(surface, null, 4)}\n` +
                    `  added:   ${JSON.stringify(added)}\n  removed: ${JSON.stringify(removed)}`,
            );
        }
        expect(surface).toEqual(GOLDEN_SURFACE);
    });

    it("latest command-path drive matches golden", async () => {
        const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
        const mod = await import("../../src/orchestration.ts");
        const latest = mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
        expect(latest, `latest handler export for ${DURABLE_SESSION_LATEST_VERSION} must exist`).toBeTypeOf("function");

        const ctx = createCtx(new Map(), [JSON.stringify({ type: "cmd", cmd: "get_info", id: "fp" })]);
        const gen = latest(ctx, {
            sessionId: "fp",
            config: { model: "github-copilot:gpt-5.4" },
            sourceOrchestrationVersion: DURABLE_SESSION_LATEST_VERSION,
            iteration: 0,
            isSystem: true,
            blobEnabled: true,
        });
        expect(driveFingerprint(gen, ctx)).toEqual(GOLDEN_DRIVE);
    });

    it("frozen 1.0.57 still yields the needsHydration probe it was deployed with", async () => {
        // In-flight 1.0.57 histories recorded the probe on the turn path. The
        // frozen module MUST keep that yield or those histories fail replay.
        const src = readFileSync(new URL("../../src/orchestration_1_0_57/turn.ts", import.meta.url), "utf8");
        expect(src).toMatch(/yield\s+runtime\.session\.needsHydration\(\)/);
        const mod = await import("../../src/orchestration_1_0_57/index.ts");
        expect(mod.durableSessionOrchestration_1_0_57).toBeTypeOf("function");
        expect(mod.CURRENT_ORCHESTRATION_VERSION).toBe("1.0.57");
    });
});
