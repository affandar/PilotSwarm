/**
 * Session regeneration orchestration harness tests (proposal §15.1) — the
 * generator driven deterministically with mocked effects, in the style of
 * child-update-batching.test.js. No LLM, no database, milliseconds.
 *
 * Covers: gate refusals, the staged pipeline (archive → distill → flip),
 * the flip-mutation table on the CAN input, the fail-safe on a distill
 * failure, the new execution's boundary emission, and the rebirth proof.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

function createHarness({ messages = [], inputOverrides = {}, failDistill = false, distillerPlan = ["completed"], startNowMs = 0 } = {}) {
    const values = new Map();
    const scheduledMessages = [...messages]
        .map((entry) => ({ atMs: entry.atMs ?? 0, payload: entry.payload }))
        .sort((left, right) => left.atMs - right.atMs);

    const state = {
        nowMs: startNowMs,
        runTurnCall: null,
        continueAsNew: null,
        recordedEvents: [],
        archiveCalls: [],
        distillCalls: [],
        // Service-session distiller (1.0.68): spawn → poll → collect/cancel.
        spawnCalls: [],
        checkCalls: [],
        collectCalls: [],
        cancelCalls: [],
        boundaryCommits: [],
        regeneratedRecords: [],
    };

    mockSession = {
        needsHydration: vi.fn(() => ({ effect: "needsHydration" })),
        hydrate: vi.fn(() => ({ effect: "hydrate" })),
        checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
        dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
        destroy: vi.fn(() => ({ effect: "destroy" })),
        runTurn: vi.fn((prompt, bootstrap, iteration, opts) => ({
            effect: "runTurn", prompt, bootstrap, iteration, opts,
        })),
    };

    mockManager = {
        loadKnowledgeIndex: vi.fn(() => ({ effect: "loadKnowledgeIndex" })),
        recordSessionEvent: vi.fn((sessionId, events) => ({ effect: "recordSessionEvent", sessionId, events })),
        summarizeSession: vi.fn(() => ({ effect: "summarizeSession" })),
        listChildSessions: vi.fn(() => ({ effect: "listChildSessions" })),
        getOrchestrationStats: vi.fn((sessionId) => ({ effect: "getOrchestrationStats", sessionId })),
        getSessionStatus: vi.fn((sessionId) => ({ effect: "getSessionStatus", sessionId })),
        sendCommandToSession: vi.fn(() => ({ effect: "sendCommandToSession" })),
        sendToSession: vi.fn(() => ({ effect: "sendToSession" })),
        updateCmsState: vi.fn(() => ({ effect: "updateCmsState" })),
        updateSessionModel: vi.fn(() => ({ effect: "updateSessionModel" })),
        getDescendantSessionIds: vi.fn(() => ({ effect: "getDescendantSessionIds" })),
        deleteSession: vi.fn(() => ({ effect: "deleteSession" })),
        runRegenArchive: vi.fn((sessionId, epoch, attemptId) => ({ effect: "runRegenArchive", sessionId, epoch, attemptId })),
        runRegenDistill: vi.fn((sessionId, epoch, attemptId, opts) => ({ effect: "runRegenDistill", sessionId, epoch, attemptId, opts })),
        runRegenSpawnDistiller: vi.fn((sessionId, epoch, attemptId, opts) => ({ effect: "runRegenSpawnDistiller", sessionId, epoch, attemptId, opts })),
        runRegenCheckDistiller: vi.fn((distillerSessionId) => ({ effect: "runRegenCheckDistiller", distillerSessionId })),
        runRegenCollectDistiller: vi.fn((sessionId, epoch, attemptId, distillerSessionId, opts) => ({ effect: "runRegenCollectDistiller", sessionId, epoch, attemptId, distillerSessionId, opts })),
        runRegenCancelDistiller: vi.fn((distillerSessionId) => ({ effect: "runRegenCancelDistiller", distillerSessionId })),
        commitEpochBoundary: vi.fn((sessionId, commit) => ({ effect: "commitEpochBoundary", sessionId, commit })),
        recordRegenerated: vi.fn((sessionId, payload) => ({ effect: "recordRegenerated", sessionId, payload })),
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

    function normalizePayload(payload) {
        return typeof payload === "string" ? payload : JSON.stringify(payload);
    }

    function resolveBlockingDequeue() {
        const next = scheduledMessages.shift();
        if (!next) throw new Error("BLOCKING_DEQUEUE_WITH_NO_MESSAGES");
        state.nowMs = Math.max(state.nowMs, next.atMs);
        return normalizePayload(next.payload);
    }

    function resolveRace(left, right) {
        if (left?.effect === "runTurn") {
            state.runTurnCall = left;
            return STOP;
        }
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
        if (effect == null) return undefined;
        switch (effect.effect) {
            case "utcNow": return state.nowMs;
            case "needsHydration": return false;
            case "hydrate": case "checkpoint": case "dehydrate": case "destroy":
            case "loadKnowledgeIndex": case "summarizeSession": case "sendCommandToSession":
            case "sendToSession": case "updateCmsState": case "updateSessionModel":
            case "deleteSession":
                return undefined;
            case "recordSessionEvent":
                state.recordedEvents.push({ sessionId: effect.sessionId, events: effect.events });
                return undefined;
            case "listChildSessions": return JSON.stringify([]);
            case "getOrchestrationStats":
                return { historyEventCount: 0, historySizeBytes: 0, queuePendingCount: 0 };
            case "getSessionStatus": return JSON.stringify({ status: "running" });
            case "getDescendantSessionIds": return [];
            case "runRegenArchive":
                state.archiveCalls.push(effect);
                return { archiveArtifactId: `transcript-e${effect.epoch}-${effect.attemptId}.jsonl`, turnsArchived: 6, compactionsArchived: 2, archiveMs: 12 };
            case "runRegenDistill":
                state.distillCalls.push(effect);
                if (failDistill) return { __throw: new Error("distiller exploded") };
                return { packageArtifactId: `package-e${effect.epoch}-${effect.attemptId}.json`, bootstrap: "[CONTEXT REGENERATED] mission…", distillMs: 34, distillerModel: "m", packageBytes: 512 };
            case "runRegenSpawnDistiller":
                state.spawnCalls.push(effect);
                return { distillerSessionId: "distiller-svc-1", distillerModel: "cluster-default" };
            case "runRegenCheckDistiller": {
                const plan = distillerPlan;
                const status = plan[Math.min(state.checkCalls.length, plan.length - 1)];
                state.checkCalls.push(effect);
                return status === "failed" ? { status: "failed", reason: "failed" } : { status };
            }
            case "runRegenCollectDistiller":
                state.collectCalls.push(effect);
                return { packageArtifactId: `package-e${effect.epoch}-${effect.attemptId}.json`, bootstrap: "[CONTEXT REGENERATED] llm mission…", distillerModel: "cluster-default", distillMode: "llm", packageBytes: 2048 };
            case "runRegenCancelDistiller":
                state.cancelCalls.push(effect);
                return { ok: true };
            case "scheduleTimer":
                // Bare durable pause (the distiller poll): advance virtual time.
                state.nowMs += Number(effect.ms) || 0;
                return undefined;
            case "commitEpochBoundary":
                state.boundaryCommits.push(effect);
                return 4242;
            case "recordRegenerated":
                state.regeneratedRecords.push(effect);
                return 4243;
            case "newGuid": return "generated-guid";
            case "dequeueEvent": return resolveBlockingDequeue();
            case "race": return resolveRace(effect.left, effect.right);
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

    async function makeGenerator() {
        const orchestrationModule = await import("../../src/orchestration.ts");
        const handlerName = `durableSessionOrchestration_${String(orchestrationModule.CURRENT_ORCHESTRATION_VERSION || "").replace(/\./g, "_")}`;
        const handler = orchestrationModule[handlerName];
        if (typeof handler !== "function") throw new Error(`missing handler ${handlerName}`);
        return handler(ctx, {
            sessionId: "regen-session",
            config: { model: "prov:model-x" },
            iteration: 8,
            isSystem: false,
            blobEnabled: false,
            ...inputOverrides,
        });
    }

    async function run({ resumeWith } = {}) {
        const gen = await makeGenerator();
        let input;
        let pendingThrow = null;
        for (let step = 0; step < 600; step += 1) {
            let next;
            try {
                next = pendingThrow ? gen.throw(pendingThrow) : gen.next(input);
            } catch (err) {
                // A drained-dry blocking dequeue means the session parked
                // waiting for its next message — a terminal state for the
                // harness, not an error.
                if (String(err?.message).includes("BLOCKING_DEQUEUE_WITH_NO_MESSAGES")) {
                    return { done: false, blocked: true, state };
                }
                throw err;
            } finally {
                pendingThrow = null;
            }
            if (next.done) return { done: true, value: next.value, state };
            let resolved;
            try {
                resolved = resolve(next.value);
            } catch (err) {
                if (String(err?.message).includes("BLOCKING_DEQUEUE_WITH_NO_MESSAGES")) {
                    return { done: false, blocked: true, state };
                }
                throw err;
            }
            if (resolved === STOP) {
                if (resumeWith) {
                    // Resume the stop-turn race with the supplied turn result.
                    input = { index: 0, value: resumeWith };
                    resumeWith = null;
                    continue;
                }
                return { done: false, runTurnCall: state.runTurnCall, state };
            }
            if (resolved && typeof resolved === "object" && "__throw" in resolved) {
                pendingThrow = resolved.__throw;
                input = undefined;
                continue;
            }
            input = resolved;
        }
        throw new Error("Exceeded step limit.");
    }

    return { run, state };
}

const regenCmd = (over = {}) => ({
    type: "cmd",
    cmd: "regenerate",
    id: "regen-attempt-1",
    args: { source: "operator" },
    ...over,
});

function eventsOfType(state, type) {
    return state.recordedEvents.flatMap(({ events }) => events).filter((e) => e.eventType === type);
}

describe("session regeneration orchestration", () => {
    beforeEach(() => vi.resetModules());

    it("refuses an infant session with too_young (durable event + no pipeline)", async () => {
        const h = createHarness({
            inputOverrides: { iteration: 3 },
            messages: [{ atMs: 0, payload: regenCmd() }],
        });
        const r = await h.run();
        expect(r.done || r.blocked).toBe(true);
        const refused = eventsOfType(h.state, "session.regenerate_refused");
        expect(refused).toHaveLength(1);
        expect(refused[0].data.reason).toBe("too_young");
        expect(h.state.archiveCalls).toHaveLength(0);
        expect(h.state.continueAsNew?.input?.regen ?? undefined).toBeUndefined();
    });

    it("runs archive → distill → flip and applies the flip-mutation table (deterministic mode)", async () => {
        const h = createHarness({
            inputOverrides: {
                iteration: 8,
                contextUsage: { tokenLimit: 100, currentTokens: 90, utilization: 0.9, messagesLength: 5 },
                sharedPreambleSent: true,
                multiWriter: true,
            },
            messages: [{ atMs: 0, payload: regenCmd({ args: { source: "operator", distill_mode: "deterministic" } }) }],
        });
        const result = await h.run();

        expect(eventsOfType(h.state, "session.regenerate_requested")).toHaveLength(1);
        expect(h.state.archiveCalls).toHaveLength(1);
        expect(h.state.distillCalls).toHaveLength(1);
        expect(h.state.distillCalls[0].opts.sessionModel).toBe("prov:model-x");
        expect(eventsOfType(h.state, "session.regenerate_failed")).toHaveLength(0);

        const can = h.state.continueAsNew;
        expect(can, "the flip must continue-as-new").toBeTruthy();
        const input = can.input;
        expect(input.transcriptEpoch).toBe(1);
        expect(input.epochStartPending).toBe(true);
        expect(input.epochStartIteration).toBe(8);
        expect(input.regen).toBeUndefined();
        expect(input.contextUsage).toBeUndefined();
        expect(input.sharedPreambleSent).toBe(false);
        expect(input.multiWriter).toBe(true);
        expect(input.iteration).toBe(8);
        expect(input.bootstrapPrompt).toBe(true);
        expect(String(input.prompt)).toContain("CONTEXT REGENERATED");
        expect(input.pendingEpochCommit).toMatchObject({
            fromEpoch: 0,
            toEpoch: 1,
            attemptId: "regen-attempt-1",
        });
        expect(input.pendingEpochCommit.archiveArtifactId).toContain("regen-attempt-1");
        expect(input.pendingEpochCommit.packageArtifactId).toContain("regen-attempt-1");
        expect(result.done).toBe(true);
    });

    it("fail-safe: a distill failure clears the pipeline and the session lives on", async () => {
        const h = createHarness({
            failDistill: true,
            inputOverrides: { iteration: 8 },
            messages: [{ atMs: 0, payload: regenCmd({ args: { source: "operator", distill_mode: "deterministic" } }) }],
        });
        const r = await h.run();
        expect(r.done || r.blocked).toBe(true);
        const failed = eventsOfType(h.state, "session.regenerate_failed");
        expect(failed).toHaveLength(1);
        expect(failed[0].data.stage).toBe("archived");
        // Only the idle CAN may have run — never the flip.
        expect(h.state.continueAsNew?.input?.transcriptEpoch ?? 0).toBe(0);
        // A later attempt is accepted (state.regen was cleared): rerun with a
        // fresh harness whose distill succeeds.
        const retry = createHarness({
            inputOverrides: { iteration: 8 },
            messages: [{ atMs: 0, payload: regenCmd({ id: "regen-attempt-2", args: { source: "operator", distill_mode: "deterministic" } }) }],
        });
        await retry.run();
        expect(retry.state.continueAsNew).toBeTruthy();
    });

    it("llm mode (default): spawn → poll → collect → flip, distiller provenance on the boundary", async () => {
        const h = createHarness({
            distillerPlan: ["running", "completed"],
            inputOverrides: { iteration: 8 },
            messages: [{ atMs: 0, payload: regenCmd() }],
        });
        const result = await h.run();

        expect(h.state.archiveCalls).toHaveLength(1);
        expect(h.state.spawnCalls).toHaveLength(1);
        expect(h.state.checkCalls.length).toBeGreaterThanOrEqual(2); // running, then completed
        expect(h.state.collectCalls).toHaveLength(1);
        expect(h.state.collectCalls[0].distillerSessionId).toBe("distiller-svc-1");
        expect(h.state.distillCalls, "deterministic path must not run").toHaveLength(0);
        expect(h.state.cancelCalls).toHaveLength(0);

        const input = h.state.continueAsNew?.input;
        expect(input?.transcriptEpoch).toBe(1);
        expect(String(input?.prompt)).toContain("llm mission");
        expect(input?.pendingEpochCommit).toMatchObject({
            distillMode: "llm",
            distillerModel: "cluster-default",
            distillerSessionId: "distiller-svc-1",
        });
        expect(result.done).toBe(true);
    });

    it("llm mode: a failed distiller session cancels and falls back deterministically", async () => {
        const h = createHarness({
            distillerPlan: ["failed"],
            inputOverrides: { iteration: 8 },
            messages: [{ atMs: 0, payload: regenCmd() }],
        });
        await h.run();
        expect(h.state.spawnCalls).toHaveLength(1);
        expect(h.state.cancelCalls).toHaveLength(1);
        expect(h.state.distillCalls, "deterministic fallback runs").toHaveLength(1);
        const input = h.state.continueAsNew?.input;
        expect(input?.transcriptEpoch).toBe(1);
        expect(input?.pendingEpochCommit?.distillMode).toBe("deterministic");
        // The flip still happened — a broken distiller never blocks the regen.
        expect(eventsOfType(h.state, "session.regenerate_failed")).toHaveLength(0);
    });

    it("llm mode: the 5-minute deadline cancels a hung distiller and falls back", async () => {
        // A hung distillation legitimately spans continue-as-news (the poll
        // loop hits the per-execution iteration cap; state.regen rides the CAN
        // input). Drive the CAN chain like the runtime does, carrying virtual
        // time forward, until the flip lands.
        const totals = { checks: 0, cancels: 0, distills: 0 };
        let overrides = { iteration: 8 };
        let messages = [{ atMs: 0, payload: regenCmd() }];
        let nowMs = 0;
        let flipInput = null;
        for (let hop = 0; hop < 16 && !flipInput; hop++) {
            const h = createHarness({ distillerPlan: ["running"], inputOverrides: overrides, messages, startNowMs: nowMs });
            await h.run();
            totals.checks += h.state.checkCalls.length;
            totals.cancels += h.state.cancelCalls.length;
            totals.distills += h.state.distillCalls.length;
            nowMs = h.state.nowMs;
            const can = h.state.continueAsNew;
            expect(can, "each execution must end in a CAN while the pipeline is pending").toBeTruthy();
            if (can.input.transcriptEpoch === 1) { flipInput = can.input; break; }
            overrides = { ...can.input };
            messages = [];
        }
        expect(flipInput, "the deadline must eventually flip via the fallback").toBeTruthy();
        expect(totals.checks).toBeGreaterThanOrEqual(2);
        expect(totals.cancels).toBe(1);
        expect(totals.distills).toBe(1);
        expect(flipInput.pendingEpochCommit?.distillMode).toBe("deterministic");
    });

    it("cancel_regen mid-distilling cancels the distiller service session (no orphan leak)", async () => {
        const h = createHarness({
            distillerPlan: ["running"], // parked in distilling when the cancel lands
            inputOverrides: { iteration: 8 },
            messages: [
                { atMs: 0, payload: regenCmd() },
                // atMs 5000: past the ~30ms of pre-distilling drain sweeps
                // (NON_BLOCKING_TIMER_MS=10), so it only lands once the pipeline
                // is parked in the distilling 10s poll.
                { atMs: 5000, payload: { type: "cmd", cmd: "cancel_regen", id: "cancel-1" } },
            ],
        });
        await h.run();
        // The distiller was spawned, then cancelled on teardown — never left live.
        expect(h.state.spawnCalls).toHaveLength(1);
        expect(h.state.cancelCalls, "teardown cancels the in-flight distiller").toHaveLength(1);
        expect(h.state.continueAsNew?.input?.transcriptEpoch ?? 0, "no flip").toBe(0);
    });

    it("regenerate is refused while a flip's rebirth is unproven (epoch_unsettled)", async () => {
        const h = createHarness({
            inputOverrides: { iteration: 8, transcriptEpoch: 1, epochStartPending: true, epochStartIteration: 8 },
            messages: [{ atMs: 0, payload: regenCmd({ args: { source: "operator", force: true } }) }],
        });
        await h.run();
        const refused = eventsOfType(h.state, "session.regenerate_refused");
        expect(refused[0]?.data.reason, "force cannot bypass the hard gate").toBe("epoch_unsettled");
        expect(h.state.archiveCalls, "pipeline never started").toHaveLength(0);
    });

    it("owner-sender gate: a non-owner tool trigger on a shared session is refused", async () => {
        const h = createHarness({
            inputOverrides: { iteration: 8, multiWriter: true, observedSenderKeys: ["user:a", "user:b"] },
            messages: [{
                atMs: 0,
                payload: regenCmd({
                    args: { source: "tool" },
                    sender: { kind: "user", provider: "github", subject: "mallory-123", relation: "collaborator", display: "Mallory" },
                }),
            }],
        });
        const r = await h.run();
        expect(r.done || r.blocked).toBe(true);
        const refused = eventsOfType(h.state, "session.regenerate_refused");
        expect(refused).toHaveLength(1);
        expect(refused[0].data.reason).toBe("not_owner");
    });

    it("parent-of gate: a forged parent trigger is refused; the real parent is accepted", async () => {
        const forged = createHarness({
            inputOverrides: { iteration: 8, parentSessionId: "real-parent" },
            messages: [{ atMs: 0, payload: regenCmd({ args: { source: "parent" }, requestedBy: "impostor" }) }],
        });
        const fr = await forged.run();
        expect(fr.done || fr.blocked).toBe(true);
        expect(eventsOfType(forged.state, "session.regenerate_refused")[0].data.reason).toBe("not_parent");

        const real = createHarness({
            inputOverrides: { iteration: 8, parentSessionId: "real-parent" },
            messages: [{ atMs: 0, payload: regenCmd({ args: { source: "parent", distill_mode: "deterministic" }, requestedBy: "real-parent" }) }],
        });
        await real.run();
        expect(real.state.continueAsNew?.input?.transcriptEpoch).toBe(1);
    });

    it("the new execution emits the boundary before any turn, then proves the rebirth", async () => {
        const h = createHarness({
            inputOverrides: {
                iteration: 8,
                transcriptEpoch: 1,
                epochStartPending: true,
                epochStartIteration: 8,
                prompt: "[CONTEXT REGENERATED] mission…",
                bootstrapPrompt: true,
                pendingEpochCommit: {
                    fromEpoch: 0, toEpoch: 1, attemptId: "regen-attempt-1", trigger: "operator",
                    archiveMs: 12, distillMs: 34,
                },
            },
        });
        await h.run({ resumeWith: { type: "completed", content: "grounded." } });

        // Boundary first — before the grounding turn was dispatched.
        expect(h.state.boundaryCommits).toHaveLength(1);
        expect(h.state.boundaryCommits[0].commit.toEpoch).toBe(1);
        expect(h.state.runTurnCall, "the grounding turn dispatched").toBeTruthy();
        expect(h.state.runTurnCall.opts.transcriptEpoch).toBe(1);
        expect(h.state.runTurnCall.opts.epochStart).toBe(true);

        // Rebirth proven: session.regenerated recorded with the attempt stats.
        expect(h.state.regeneratedRecords).toHaveLength(1);
        expect(h.state.regeneratedRecords[0].payload.epoch).toBe(1);
        expect(h.state.regeneratedRecords[0].payload.attemptId).toBe("regen-attempt-1");
        expect(h.state.continueAsNew?.input?.epochStartPending ?? undefined).not.toBe(true);
    });
});
