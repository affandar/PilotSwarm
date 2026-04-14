import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

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
                case "dequeueEvent":
                    if (queuedEvents.length === 0) {
                        throw new Error("Queue underflow while resolving dequeueEvent");
                    }
                    return queuedEvents.shift();
                case "recordSessionEvent":
                case "checkpoint":
                case "hydrate":
                case "dehydrate":
                case "destroy":
                    return undefined;
                case "race":
                    throw new Error("Unexpected race in version upgrade test harness");
                default:
                    throw new Error(`Unexpected effect: ${JSON.stringify(effect)}`);
            }
        },
    };
}

async function loadHandler(version) {
    if (version === "1.0.43") {
        const mod = await import("../../src/orchestration.ts");
        return mod.durableSessionOrchestration_1_0_43;
    }
    const fileVersion = version.replace(/\./g, "_");
    const mod = await import(`../../src/orchestration_${fileVersion}.ts`);
    return mod[`durableSessionOrchestration_${fileVersion}`];
}

function driveUntilStop(gen, ctx) {
    let input;
    for (let step = 0; step < 100; step += 1) {
        const next = gen.next(input);
        if (next.done) return { done: true, value: next.value };
        if (next.value?.effect === "continueAsNew") return { done: false, effect: next.value };
        if (next.value?.effect === "dequeueEvent" && !ctx.hasQueuedEvents()) {
            return { done: false, effect: next.value };
        }
        input = ctx.resolveEffect(next.value);
    }
    throw new Error("Exceeded step limit before stop condition");
}

describe("orchestration version upgrades", () => {
    beforeEach(() => {
        mockSession = {
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            hydrate: vi.fn(() => ({ effect: "hydrate" })),
            dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        };
        mockManager = {
            recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
        };
    });

    for (const sourceVersion of ["1.0.40", "1.0.41", "1.0.42"]) {
        it(`upgrades ${sourceVersion} snapshots into the latest orchestration`, async () => {
            const values = new Map();
            const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
            const { commandResponseKey } = await import("../../src/types.ts");
            const sourceHandler = await loadHandler(sourceVersion);
            const latestHandler = await loadHandler(DURABLE_SESSION_LATEST_VERSION);

            const sourceCtx = createCtx(values, [
                JSON.stringify({
                    type: "cmd",
                    cmd: "set_model",
                    id: `set-model-${sourceVersion}`,
                    args: { model: "github-copilot:gpt-5.4-mini" },
                }),
            ]);

            const sourceGen = sourceHandler(sourceCtx, {
                sessionId: `upgrade-${sourceVersion}`,
                config: { model: "github-copilot:gpt-5.4" },
                sourceOrchestrationVersion: sourceVersion,
                iteration: 0,
                isSystem: true,
                blobEnabled: false,
            });

            const sourceResult = driveUntilStop(sourceGen, sourceCtx);
            expect(sourceResult.done).toBe(false);
            expect(sourceResult.effect).toMatchObject({
                effect: "continueAsNew",
                version: DURABLE_SESSION_LATEST_VERSION,
            });
            expect(sourceResult.effect.input.sourceOrchestrationVersion).toBe(sourceVersion);
            expect(sourceResult.effect.input.config.model).toBe("github-copilot:gpt-5.4-mini");

            const latestCtx = createCtx(values, [
                JSON.stringify({
                    type: "cmd",
                    cmd: "get_info",
                    id: `get-info-${sourceVersion}`,
                }),
            ]);

            const latestGen = latestHandler(latestCtx, sourceResult.effect.input);
            const latestResult = driveUntilStop(latestGen, latestCtx);

            expect(mockManager.recordSessionEvent).toHaveBeenCalledWith(
                `upgrade-${sourceVersion}`,
                [{ eventType: "session.command_received", data: { cmd: "get_info", id: `get-info-${sourceVersion}` } }],
            );
            const response = JSON.parse(values.get(commandResponseKey(`get-info-${sourceVersion}`)));
            expect(response).toMatchObject({
                cmd: "get_info",
                id: `get-info-${sourceVersion}`,
                result: {
                    sessionId: `upgrade-${sourceVersion}`,
                    model: "github-copilot:gpt-5.4-mini",
                },
            });
            expect(latestResult.done).toBe(false);
        });
    }
});
