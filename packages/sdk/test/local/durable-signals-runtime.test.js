import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { durableSessionOrchestration_1_0_80 } from "../../src/orchestration/index.ts";
import { durableSessionOrchestration_1_0_79 } from "../../src/orchestration_1_0_79/index.ts";
import { durableSessionOrchestration_1_0_78 } from "../../src/orchestration_1_0_78/index.ts";
import { PilotSwarmClient } from "../../src/client.ts";
import { commandResponseKey } from "../../src/types.ts";
import { AGENT_HANDOFF_CAPABILITY, HANDOFF_ACTIVITY_NAMES, SIGNAL_ACTIVITY_NAMES } from "../../src/activity-routing.ts";
import { SIGNAL_ACTIVITY_CAPABILITY, SIGNAL_MAX_INLINE_BYTES, SIGNAL_STATE_KEY, createSessionSignal } from "../../src/session-signals.ts";

const { SqliteProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");
const NAME = "durable-session-v2";
const completed = { type: "completed", content: "Done." };

async function withRuntimeTest(body) {
    const dir = await mkdtemp(join(tmpdir(), "ps-durable-signals-"));
    const SID = dir.split("/").at(-1);
    const IID = `session-${SID}`;
    const path = `sqlite:${join(dir, "signals.db")}`;
    const running = new Set();
    const turns = [];
    const events = [];
    const listeners = new Set();
    let forceCan = false;
    let waitTimeout;
    let waitingStateHook;
    let turnResults = [];

    async function createWorker(label, supportsSignals = true) {
        const provider = await SqliteProvider.open(path);
        const client = new Client(provider);
        const runtime = new Runtime(provider, {
            workerTagFilter: { defaultAnd: [
                AGENT_HANDOFF_CAPABILITY,
                ...(supportsSignals ? [SIGNAL_ACTIVITY_CAPABILITY] : []),
            ] },
            workerNodeId: `${dir.split("/").at(-1)}-${label}`,
            orchestrationConcurrency: 4,
            workerConcurrency: 4,
            workerLockTimeoutMs: 1_000,
            dispatcherPollIntervalMs: 10,
            logLevel: "error",
        });
        runtime.registerOrchestrationVersioned(NAME, "1.0.78", durableSessionOrchestration_1_0_78);
        runtime.registerOrchestrationVersioned(NAME, "1.0.79", durableSessionOrchestration_1_0_79);
        runtime.registerOrchestrationVersioned(NAME, "1.0.80", durableSessionOrchestration_1_0_80);
        for (const name of ["recordSessionEvent", "updateCmsState", "loadKnowledgeIndex", "getWorkerSessionPolicy",
            "getOrchestrationStats", HANDOFF_ACTIVITY_NAMES.listChildSessions,
            HANDOFF_ACTIVITY_NAMES.runTurn, HANDOFF_ACTIVITY_NAMES.runTurn2,
            ...Object.values(SIGNAL_ACTIVITY_NAMES)]) {
            runtime.registerActivity(name, async (ctx, input) => {
                switch (name) {
                    case "recordSessionEvent":
                        events.push(...input.events);
                        for (const listener of listeners) listener();
                        return null;
                    case "getWorkerSessionPolicy": return { policy: null, allowedAgentNames: [] };
                    case "getOrchestrationStats": return { historySizeBytes: forceCan ? 800 * 1024 : 0 };
                    case HANDOFF_ACTIVITY_NAMES.listChildSessions: return [];
                    case "updateCmsState":
                        if (input.state === "waiting" && waitingStateHook) await waitingStateHook(input);
                        return null;
                    case HANDOFF_ACTIVITY_NAMES.runTurn:
                    case HANDOFF_ACTIVITY_NAMES.runTurn2:
                    case SIGNAL_ACTIVITY_NAMES.runTurn:
                    case SIGNAL_ACTIVITY_NAMES.runTurn2:
                        turns.push({ worker: label, name, tag: ctx.tag(), affinity: ctx.sessionId, ...input });
                        if (turnResults.length) return { snapshotVersion: turns.length, ...turnResults.shift() };
                        if (input.prompt === "Wait for ready") return {
                            type: "signal-wait", action: "wait", names: ["ready"], reason: "External completion",
                            ...(waitTimeout !== undefined ? { timeoutSeconds: waitTimeout } : {}),
                            snapshotVersion: 1,
                        };
                        return { ...completed, snapshotVersion: 2 };
                    default: return null;
                }
            });
        }
        await runtime.start();
        running.add(runtime);
        return { runtime, client };
    }

    async function stop(runtime) {
        await runtime.shutdown(3000);
        running.delete(runtime);
    }

    async function statusUntil(client, predicate, timeoutMs = 15_000, instanceId = IID) {
        const deadline = Date.now() + timeoutMs;
        let status = await client.getStatus(instanceId);
        while (true) {
            if (status.status === "Failed") throw new Error(`Signal runtime failed: ${JSON.stringify(status)}`);
            const custom = typeof status.customStatus === "string" ? JSON.parse(status.customStatus) : status.customStatus;
            if (await predicate(custom, status)) return custom;
            if (Date.now() >= deadline) throw new Error(`Signal status did not converge: ${JSON.stringify(status)}`);
            status = await client.waitForStatusChange(instanceId, status.customStatusVersion ?? 0, 20, deadline - Date.now());
        }
    }

    async function eventUntil(predicate, timeoutMs = 15_000) {
        if (events.some(predicate)) return;
        await new Promise((resolve, reject) => {
            const onEvent = () => {
                if (!events.some(predicate)) return;
                clearTimeout(timer);
                listeners.delete(onEvent);
                resolve();
            };
            const timer = setTimeout(() => {
                listeners.delete(onEvent);
                reject(new Error("Expected durable signal lifecycle event did not arrive"));
            }, timeoutMs);
            listeners.add(onEvent);
        });
    }

    const enqueueSignal = (client, id, name, options = {}) => client.enqueueEvent(IID, "messages", {
        signal: createSessionSignal(name, options, { kind: "api", actorId: "fixture-operator" },
            { signalId: id, raisedAt: new Date().toISOString() }),
    });
    const start = (client, input = {}, version = "1.0.80") => client.startOrchestrationVersioned(IID, NAME, {
        sessionId: SID, config: {}, isSystem: true, blobEnabled: true, idleTimeout: -1, prompt: "Wait for ready", ...input,
    }, version);
    try {
        await body({
            createWorker, stop, statusUntil, eventUntil, enqueueSignal, start, turns, events,
            instanceId: IID,
            sessionId: SID,
            forceCan: () => { forceCan = true; },
            timeout: seconds => { waitTimeout = seconds; },
            onWaitingState: hook => { waitingStateHook = hook; },
            scriptTurns: results => { turnResults = [...results]; },
        });
    } finally {
        await Promise.all([...running].map(runtime => runtime.shutdown(3000)));
        await rm(dir, { recursive: true, force: true });
    }
}

describe.concurrent("durable signals on the native runtime", () => {
    it("replays main's 1.0.79 unchanged, rejects signals there, then upgrades at CAN to 1.0.80", { timeout: 60_000 }, async () => {
        await withRuntimeTest(async ({ createWorker, stop, statusUntil, start, turns, forceCan, instanceId, sessionId }) => {
            const original = await createWorker("main", false);
            await start(original.client, { prompt: "Ordinary request", blobEnabled: false }, "1.0.79");
            await statusUntil(original.client, status => status?.status === "idle" && status.responseVersion >= 1);
            const api = PilotSwarmClient._fromRuntime({ waitThreshold: 30 }, {
                getSession: async () => ({ sessionId, state: "idle", orchestrationId: instanceId }),
            }, original.client);
            await expect(api._raiseSignal(sessionId, "ready", { signalId: "legacy-refused", wake: true }))
                .rejects.toMatchObject({ code: "SIGNALS_UNSUPPORTED" });
            expect(await original.client.getValue(instanceId, SIGNAL_STATE_KEY)).toBeNull();
            await stop(original.runtime);

            const upgraded = await createWorker("upgraded");
            forceCan();
            await upgraded.client.enqueueEvent(instanceId, "messages", { prompt: "Continue the existing execution" });
            // This ordinary legacy turn kept its affinity: a different worker
            // must wait for the native ownership lease (about 30 seconds).
            await statusUntil(upgraded.client, async status => status?.status === "idle"
                && (await upgraded.client.getInstanceInfo(instanceId)).orchestrationVersion === "1.0.80", 45_000);
            expect(turns.map(turn => turn.name)).toEqual([HANDOFF_ACTIVITY_NAMES.runTurn, HANDOFF_ACTIVITY_NAMES.runTurn]);
            expect(turns.every(turn => !turn.config.durableSignals)).toBe(true);
            const receipt = await api._raiseSignal(sessionId, "ready", { signalId: "upgraded-wake", wake: true });
            expect(receipt.status).toBe("queued");
            await statusUntil(upgraded.client, status => status?.status === "idle" && status.responseVersion >= 3);
            expect(turns).toHaveLength(3);
            expect(turns[2]).toMatchObject({ name: SIGNAL_ACTIVITY_NAMES.runTurn, tag: SIGNAL_ACTIVITY_CAPABILITY });
            expect(turns[2].prompt).toContain('"signalId": "upgraded-wake"');
        });
    });

    it("consumes a pre-deadline queued signal after the waiting activity finishes past the deadline", { timeout: 30_000 }, async () => {
        await withRuntimeTest(async ({ createWorker, start, statusUntil, enqueueSignal, events, turns, timeout, onWaitingState }) => {
            const entered = Promise.withResolvers();
            const release = Promise.withResolvers();
            onWaitingState(async () => {
                entered.resolve();
                await release.promise;
            });
            timeout(2);
            const worker = await createWorker("delayed-wait");
            try {
                await start(worker.client, { blobEnabled: false });
                const waiting = await statusUntil(worker.client, status => status?.status === "waiting" && status.signalWait);
                await entered.promise;
                const deadline = Date.parse(waiting.signalWait.deadline);
                await enqueueSignal(worker.client, "accepted-before-deadline", "ready");
                expect(Date.now()).toBeLessThan(deadline);
                // Hold only until the persisted deadline; this is the tested
                // delayed-activity boundary, not a timing retry or grace sleep.
                await delay(Math.max(0, deadline - Date.now() + 1));
                release.resolve();
                await statusUntil(worker.client, status => status?.responseVersion >= 1 && !status.signalWait);
                expect(turns).toHaveLength(2);
                expect(turns[1].prompt).toContain('"signalId": "accepted-before-deadline"');
                expect(events.some(event => event.eventType === "session.signal_wait_timeout")).toBe(false);
                expect(events.filter(event => event.eventType === "session.signal_consumed")).toMatchObject([
                    { data: { signalId: "accepted-before-deadline", waitId: waiting.signalWait.waitId, mode: "wait" } },
                ]);
            } finally {
                release.resolve();
            }
        });
    });

    it("a matching wake satisfies a budget-interrupted wait and delivers the saved user prompt", { timeout: 30_000 }, async () => {
        await withRuntimeTest(async ({ createWorker, start, statusUntil, enqueueSignal, turns, events, scriptTurns, instanceId }) => {
            scriptTurns([
                { type: "signal-wait", action: "wait", names: ["ready"], reason: "Wait for ready" },
                { type: "wait", budget: true, seconds: 60, reason: "Budget pause" },
                completed,
            ]);
            const worker = await createWorker("budget-wake");
            await start(worker.client, { blobEnabled: false });
            const initial = await statusUntil(worker.client, status => status?.signalWait && status.status === "waiting");
            await worker.client.enqueueEvent(instanceId, "messages", { prompt: "Accepted user update" });
            await statusUntil(worker.client, status => status?.signalWaitInterrupted && status.waitReason === "Budget pause");
            await enqueueSignal(worker.client, "budget-ready", "ready", { wake: true });
            await statusUntil(worker.client, status => status?.responseVersion >= 1 && !status.signalWait);
            expect(turns).toHaveLength(3);
            expect(turns[2].stashedPrompts).toContain("Accepted user update");
            expect(events.filter(event => event.eventType === "session.signal_consumed")).toMatchObject([
                { data: { signalId: "budget-ready", mode: "wait", waitId: initial.signalWait.waitId } },
            ]);
            expect(JSON.parse(await worker.client.getValue(instanceId, SIGNAL_STATE_KEY))).toEqual({
                version: 1, interrupted: false, buffered: [],
            });
        });
    });

    it("Stop resumes an existing recurring schedule after cancelling its signal wait", { timeout: 45_000 }, async () => {
        await withRuntimeTest(async ({ createWorker, start, statusUntil, turns, scriptTurns, instanceId }) => {
            scriptTurns([
                { ...completed, queuedActions: [{ type: "cron", action: "set", intervalSeconds: 15, reason: "Recurring work" }] },
                { type: "signal-wait", action: "wait", names: ["ready"], reason: "Await event first" },
                completed,
            ]);
            const worker = await createWorker("stop-cron");
            await start(worker.client, { prompt: "Monitor", blobEnabled: false });
            await statusUntil(worker.client, status => status?.cronActive && status.status === "waiting");
            await worker.client.enqueueEvent(instanceId, "messages", { prompt: "Wait for the event" });
            const waiting = await statusUntil(worker.client, status => status?.signalWait && status.status === "waiting");
            await worker.client.enqueueEvent(instanceId, "messages", {
                type: "cmd", cmd: "cancel_signal_wait", id: "native-stop", args: { waitId: waiting.signalWait.waitId },
            });
            const response = JSON.parse(await worker.client.waitForValue(instanceId, commandResponseKey("native-stop"), 10_000));
            expect(response.result.outcome).toBe("stopped");
            await statusUntil(worker.client, status => !status?.signalWait && status?.cronActive && status.waitReason === "Recurring work");
            await statusUntil(worker.client, status => status?.responseVersion >= 2, 25_000);
            expect(turns).toHaveLength(3);
            expect(turns[2].cycleOrigin).toBe("cron");
        });
    });

    it("preserves waits, buffers and deduplication through CAN and a new worker/provider", { timeout: 45_000 }, async () => {
        await withRuntimeTest(async ({ createWorker, stop, statusUntil, eventUntil, enqueueSignal, start, turns, events, forceCan, instanceId: IID }) => {
            const first = await createWorker("first");
            await start(first.client);
            const waiting = await statusUntil(first.client, status => status?.signalWait && status.status === "waiting");
            const bufferedData = { kept: true, padding: "x".repeat(
                SIGNAL_MAX_INLINE_BYTES - Buffer.byteLength(JSON.stringify({ kept: true, padding: "" })),
            ) };
            await enqueueSignal(first.client, "buffered", "later", { data: bufferedData });
            await eventUntil(event => event.eventType === "session.signal_buffered" && event.data.signalId === "buffered");
            forceCan();
            const originalExecution = (await first.client.getInstanceInfo(IID)).currentExecutionId;
            await first.client.enqueueEvent(IID, "messages", { prompt: "Status update" });
            await statusUntil(first.client, async status => status?.status === "waiting" && status.responseVersion >= 1
                && (await first.client.getInstanceInfo(IID)).currentExecutionId > originalExecution);
            const carried = JSON.parse(await first.client.getValue(IID, SIGNAL_STATE_KEY));
            expect(carried.pendingWait).toEqual(waiting.signalWait);
            expect(carried.buffered.map(entry => entry.signalId)).toEqual(["buffered"]);
            expect(events.some(event => event.eventType === "session.affinity_released")).toBe(true);
            await stop(first.runtime);

            const replacement = await createWorker("replacement");
            await enqueueSignal(replacement.client, "consume-once", "ready", { data: { status: "ready" } });
            await statusUntil(replacement.client, status => status?.responseVersion >= 2 && !status.signalWait);
            const resumed = turns.filter(turn => turn.worker === "replacement");
            console.log("  Signal turn dispatches:", turns.map(turn => ({
                worker: turn.worker, turnIndex: turn.turnIndex, prompt: turn.prompt.split("\n")[0],
            })));
            expect(resumed).toHaveLength(1);
            expect(resumed[0].prompt).toContain('"signalId": "consume-once"');
            expect(resumed[0].tag).toBe(SIGNAL_ACTIVITY_CAPABILITY);
            expect(JSON.parse(await replacement.client.getValue(IID, "signalbuf.0")).data).toEqual(bufferedData);
            await enqueueSignal(replacement.client, "consume-once", "ready", { wake: true });
            await eventUntil(event => event.eventType === "session.signal_duplicate" && event.data.signalId === "consume-once");
            expect(turns).toHaveLength(3);
            expect(events.filter(event => event.eventType === "session.signal_consumed")).toHaveLength(1);
        });
    });

    it("routes signal turns only to upgraded workers while frozen sessions retain their old descriptors", { timeout: 30_000 }, async () => {
        await withRuntimeTest(async ({ createWorker, statusUntil, start, enqueueSignal, turns, instanceId: IID }) => {
            const old = await createWorker("old", false);
            const legacyId = `${IID}-legacy`;
            await old.client.startOrchestrationVersioned(legacyId, NAME, {
                sessionId: legacyId, config: {}, isSystem: true, prompt: "Legacy greeting", blobEnabled: false, idleTimeout: -1,
            }, "1.0.78");
            await statusUntil(old.client, status => status?.responseVersion >= 1, 15_000, legacyId);
            expect(turns[0].name).toBe(HANDOFF_ACTIVITY_NAMES.runTurn);
            expect(turns[0].config).not.toHaveProperty("durableSignals");
            const upgraded = await createWorker("upgraded");
            await start(upgraded.client);
            await statusUntil(upgraded.client, status => status?.status === "waiting" && status.signalWait);
            await enqueueSignal(upgraded.client, "mixed", "ready");
            await statusUntil(upgraded.client, status => status?.responseVersion >= 1 && !status.signalWait);
            const signalTurns = turns.filter(turn => Object.values(SIGNAL_ACTIVITY_NAMES).includes(turn.name));
            expect(signalTurns).toHaveLength(2);
            expect(signalTurns.every(turn => turn.worker === "upgraded" && turn.tag === SIGNAL_ACTIVITY_CAPABILITY)).toBe(true);
        });
    });

    it("fires a durable timeout once without polling model turns", { timeout: 20_000 }, async () => {
        await withRuntimeTest(async ({ createWorker, statusUntil, start, timeout, turns, events }) => {
            timeout(1);
            const worker = await createWorker("timer");
            await start(worker.client, { blobEnabled: false });
            const waiting = await statusUntil(worker.client, status => status?.status === "waiting" && status.signalWait);
            expect(Date.parse(waiting.signalWait.deadline) - Date.parse(waiting.signalWait.startedAt)).toBe(1000);
            await statusUntil(worker.client, status => status?.responseVersion >= 1 && !status.signalWait);
            expect(turns).toHaveLength(2);
            expect(turns[1].prompt).toContain("SIGNAL WAIT TIMED OUT");
            expect(events.filter(event => event.eventType === "session.signal_wait_timeout")).toHaveLength(1);
        });
    });
});
