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

function createHarness({ messages = [], inputOverrides = {}, failDistill = false } = {}) {
    const values = new Map();
    const scheduledMessages = [...messages]
        .map((entry) => ({ atMs: entry.atMs ?? 0, payload: entry.payload }))
        .sort((left, right) => left.atMs - right.atMs);

    const state = {
        nowMs: 0,
        runTurnCall: null,
        continueAsNew: null,
        recordedEvents: [],
        archiveCalls: [],
        distillCalls: [],
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

    it("runs archive → distill → flip and applies the flip-mutation table", async () => {
        const h = createHarness({
            inputOverrides: {
                iteration: 8,
                contextUsage: { tokenLimit: 100, currentTokens: 90, utilization: 0.9, messagesLength: 5 },
                sharedPreambleSent: true,
                multiWriter: true,
            },
            messages: [{ atMs: 0, payload: regenCmd() }],
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
            messages: [{ atMs: 0, payload: regenCmd() }],
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
            messages: [{ atMs: 0, payload: regenCmd({ id: "regen-attempt-2" }) }],
        });
        await retry.run();
        expect(retry.state.continueAsNew).toBeTruthy();
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
            messages: [{ atMs: 0, payload: regenCmd({ args: { source: "parent" }, requestedBy: "real-parent" }) }],
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
