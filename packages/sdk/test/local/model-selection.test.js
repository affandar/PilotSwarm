/**
 * Model selection tests.
 *
 * Covers: creating sessions with specific GitHub models,
 * verifying model is recorded in CMS, and model persists across turns.
 *
 * Run: npx vitest run test/local/model-selection.test.js
 */

import { describe, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assertEqual, assertNotNull, assertThrows } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { TEST_CLAUDE_MODEL, TEST_GPT_MODEL } from "../helpers/fixtures.js";
import { ModelProviderRegistry, ManagedSession, PilotSwarmManagementClient, SessionManager } from "../../src/index.ts";
import { detectFailedModelSwitch } from "../../src/orchestration/turn.ts";
import { handleTurnResult, processPrompt } from "../../src/orchestration/turn.ts";
import { handleCommand } from "../../src/orchestration/lifecycle.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const FORCE_SINGLE_MODEL = Boolean(process.env.PS_TEST_FORCE_MODEL || process.env.TEST_FORCE_MODEL);
const describeModelSelection = FORCE_SINGLE_MODEL ? describe.skip : describe;
const INVALID_MODEL_ID = "github-copilot:gpt-nonexistent-9000";

// ─── Model-switch discovery helpers ──────────────────────────────

function providerOf(qualified) {
    const q = String(qualified || "");
    return q.includes(":") ? q.slice(0, q.indexOf(":")) : "";
}

function modelShort(qualified) {
    return String(qualified || "").split(":").pop();
}

function resolveQualified(mgmt, wanted) {
    const models = mgmt.listModels();
    const match = models.find((m) =>
        m.qualifiedName === wanted
        || m.modelName === wanted
        || m.qualifiedName.endsWith(`:${wanted}`),
    );
    return match?.qualifiedName ?? null;
}

function findSameProviderModel(mgmt, fromQ) {
    const fromProvider = providerOf(fromQ);
    const fromShort = modelShort(fromQ);
    const match = mgmt.listModels().find((m) =>
        providerOf(m.qualifiedName) === fromProvider
        && modelShort(m.qualifiedName) !== fromShort,
    );
    return match?.qualifiedName ?? null;
}

function findCrossProviderModel(mgmt, fromQ) {
    const fromProvider = providerOf(fromQ);
    const match = mgmt.listModels().find((m) =>
        providerOf(m.qualifiedName)
        && providerOf(m.qualifiedName) !== fromProvider,
    );
    return match?.qualifiedName ?? null;
}

async function pollForEvent(catalog, sessionId, predicate, label, timeoutMs = TIMEOUT) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const events = await catalog.getSessionEvents(sessionId);
        const match = events.find(predicate);
        if (match) return { event: match, events };
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function pollForTurnMetric(catalog, sessionId, predicate, label, timeoutMs = TIMEOUT) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const turns = (await catalog.getSessionTurnMetrics(sessionId)).slice().sort((a, b) => a.turnIndex - b.turnIndex);
        const match = turns.find(predicate);
        if (match) return { turn: match, turns };
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function testCreateSessionWithModel(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession({ model: TEST_GPT_MODEL });
        assertNotNull(session, "session created");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            console.log(`  CMS model: "${row.model}"`);
            assertNotNull(row.model, "model recorded in CMS");
            // Model may be normalized to include provider prefix
            assertEqual(
                row.model.includes(TEST_GPT_MODEL),
                true,
                `model contains ${TEST_GPT_MODEL} (got: ${row.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testModelRecordedAfterTurn(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession({ model: TEST_GPT_MODEL });
        assertNotNull(session, "session created");

        console.log(`  Sending prompt with ${TEST_GPT_MODEL} model...`);
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 80)}"`);
        assertNotNull(response, "got response");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            console.log(`  CMS model after turn: "${row.model}"`);
            assertNotNull(row.model, "model still in CMS after turn");
            assertEqual(
                row.model.includes(TEST_GPT_MODEL),
                true,
                `model still ${TEST_GPT_MODEL} after turn (got: ${row.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testMidSessionModelSwitch(env) {
    await withClient(env, {}, async (client) => {
        const session = await client.createSession({ model: TEST_GPT_MODEL });
        console.log(`  Created session ${session.sessionId} with ${TEST_GPT_MODEL}`);
        console.log("  Sending first turn before switch...");
        await session.sendAndWait("Say hello", TIMEOUT);
        console.log("  First turn completed");

        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            modelProvidersPath: env.modelProvidersPath,
        });
        await mgmt.start();
        try {
            const claudeModel = mgmt.listModels().find((model) =>
                model.qualifiedName === TEST_CLAUDE_MODEL
                || model.modelName === TEST_CLAUDE_MODEL
                || model.qualifiedName.endsWith(`:${TEST_CLAUDE_MODEL}`),
            );
            assertNotNull(claudeModel, `configured Claude model for ${TEST_CLAUDE_MODEL}`);
            console.log(`  Switching to ${claudeModel.qualifiedName}...`);
            await mgmt.setSessionModel(session.sessionId, claudeModel.qualifiedName);
            console.log("  Management model switch accepted; sending next turn...");
            const switchedResponse = await session.sendAndWait("Say hello again", TIMEOUT);
            console.log(`  Response after switch: "${switchedResponse?.slice(0, 120)}"`);
            assertNotNull(switchedResponse, "got response after model switch");

            const catalog = await createCatalog(env);
            try {
                const row = await catalog.getSession(session.sessionId);
                assertEqual(row.model.includes(TEST_CLAUDE_MODEL.split(":").pop()), true, `model switched to claude (got ${row.model})`);
                const buckets = await catalog.getSessionTokensByModel(session.sessionId);
                assertEqual(buckets.length >= 2, true, `two model buckets after switch (got ${buckets.length})`);
                const turns = await catalog.getSessionTurnMetrics(session.sessionId);
                const orderedTurns = turns.slice().sort((a, b) => a.turnIndex - b.turnIndex);
                assertEqual(orderedTurns.length >= 2, true, `at least two turn metrics after switch (got ${orderedTurns.length})`);
                assertEqual(orderedTurns[0].model.includes(TEST_GPT_MODEL), true, `first turn uses original model (got ${orderedTurns[0].model})`);
                assertEqual(
                    orderedTurns[orderedTurns.length - 1].model.includes(TEST_CLAUDE_MODEL.split(":").pop()),
                    true,
                    `next turn uses switched model (got ${orderedTurns[orderedTurns.length - 1].model})`,
                );
                const summary = await catalog.getSessionMetricSummary(session.sessionId);
                assertEqual(summary?.lossyHandoffCount ?? 0, 0, "warm model switch should not record lossy handoffs");
                const events = await catalog.getSessionEvents(session.sessionId);
                assertEqual(events.some((event) => event.eventType === "session.lossy_handoff"), false, "warm model switch should not emit lossy_handoff");
                const runtimeNotice = events.find((event) => event.eventType === "system.message" && String(event.data?.content || "").includes("Runtime model for this turn is"));
                assertNotNull(runtimeNotice, "runtime model notice should be injected into the first prompt after switch");
                assertEqual(
                    String(runtimeNotice.data?.content || "").includes(TEST_CLAUDE_MODEL.split(":").pop()),
                    true,
                    `runtime notice should name switched model (got ${runtimeNotice.data?.content})`,
                );
            } finally {
                await catalog.close();
            }
            await assertThrows(() => mgmt.setSessionModel(session.sessionId, "no-such-provider:no-such-model"), "Unknown model", "unknown model rejected");
        } finally {
            await mgmt.stop().catch(() => {});
        }
    });
}

/**
 * Drive a mid-session model switch and verify the durable outcome.
 *
 * @param {object} env
 * @param {object} opts
 * @param {"cp"|"llm"} opts.initiator   - control plane (management client) vs LLM tool call
 * @param {"same"|"cross"} opts.relationship - target model on the same provider or a different one
 *
 * Verifies, after the switch + one follow-up turn:
 *   - CMS + last turn metric land on the new model
 *   - the follow-up turn completed (no provider 404 from a stale binding)
 *   - exactly one model_changed event with the expected source
 *   - no lossy handoff and a one-shot runtime-model notice injected next prompt
 */
async function runModelSwitchScenario(env, { initiator, relationship }) {
    await withClient(env, {}, async (client) => {
        const fromModel = TEST_GPT_MODEL;
        const session = await client.createSession({ model: fromModel });
        await session.sendAndWait("Say hello", TIMEOUT);

        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            modelProvidersPath: env.modelProvidersPath,
        });
        await mgmt.start();
        const catalog = await createCatalog(env);
        try {
            const fromQ = resolveQualified(mgmt, fromModel);
            assertNotNull(fromQ, `from-model ${fromModel} resolves to a configured model`);
            const targetQ = relationship === "same"
                ? findSameProviderModel(mgmt, fromQ)
                : findCrossProviderModel(mgmt, fromQ);
            if (!targetQ) {
                console.warn(`  ⚠️  SKIP ${initiator}/${relationship}: no ${relationship}-provider target configured for ${fromQ}. ` +
                    `Configure a second provider in .model_providers.json to exercise this case end-to-end.`);
                return;
            }
            const crossProvider = providerOf(fromQ) !== providerOf(targetQ);
            assertEqual(crossProvider, relationship === "cross", `relationship from ${fromQ} to ${targetQ}`);
            console.log(`  ${initiator.toUpperCase()} ${relationship}-provider switch: ${fromQ} -> ${targetQ}`);

            const before = await catalog.getSessionEvents(session.sessionId);
            const boundarySeq = before.length ? before[before.length - 1].seq : 0;
            const turnsBeforeSwitch = await catalog.getSessionTurnMetrics(session.sessionId);
            const maxTurnBeforeSwitch = turnsBeforeSwitch.reduce((max, turn) => Math.max(max, turn.turnIndex), -1);

            if (initiator === "cp") {
                await mgmt.setSessionModel(session.sessionId, targetQ);
            } else {
                const switchResp = await session.sendAndWait(
                    `Call the set_session_model tool exactly once to switch this session to the exact model \`${targetQ}\`. ` +
                    `Use that literal qualified id. Do not ask for confirmation.`,
                    TIMEOUT,
                );
                assertNotNull(switchResp, "LLM switch turn returned");
            }

            const targetShort = modelShort(targetQ);
            const fromShort = modelShort(fromQ);
            await pollForTurnMetric(
                catalog,
                session.sessionId,
                (turn) => turn.turnIndex > maxTurnBeforeSwitch && turn.model.includes(targetShort) && turn.resultType === "completed",
                "automatic post-switch continuation turn metric",
            );

            const postResp = await session.sendAndWait("Reply with exactly: READY", TIMEOUT);
            assertNotNull(postResp, "post-switch turn returned");

            const row = await catalog.getSession(session.sessionId);
            assertEqual(row.model.includes(targetShort), true, `CMS model switched to ${targetShort} (got ${row.model})`);

            const turns = (await catalog.getSessionTurnMetrics(session.sessionId)).slice().sort((a, b) => a.turnIndex - b.turnIndex);
            assertEqual(turns.length >= 2, true, `at least two turn metrics (got ${turns.length})`);
            assertEqual(turns[0].model.includes(fromShort), true, `first turn used ${fromShort} (got ${turns[0].model})`);
            const last = turns[turns.length - 1];
            assertEqual(last.model.includes(targetShort), true, `last turn uses ${targetShort} (got ${last.model})`);
            assertEqual(last.resultType, "completed", `post-switch turn completed (got ${last.resultType}; err=${last.errorMessage || "-"})`);
            const targetTurnsAfterSwitch = turns.filter((turn) => turn.turnIndex > maxTurnBeforeSwitch && turn.model.includes(targetShort));
            assertEqual(
                targetTurnsAfterSwitch.length >= 1,
                true,
                `accepted switch should run automatic continuation on target model (got ${targetTurnsAfterSwitch.length} target turns)`,
            );

            const after = (await catalog.getSessionEvents(session.sessionId)).filter((e) => e.seq > boundarySeq);

            const modelChanged = after.find((e) =>
                e.eventType === "session.model_changed"
                && String(e.data?.newModel || "").includes(targetShort),
            );
            assertNotNull(modelChanged, "session.model_changed recorded for switch");
            assertEqual(
                modelChanged.data?.source,
                initiator === "cp" ? "user" : "tool",
                `model_changed source for ${initiator} switch (got ${modelChanged.data?.source})`,
            );

            const provider404 = after.find((e) =>
                (e.eventType === "model.call_failure" || e.eventType === "session.error")
                && String(e.data?.statusCode || "").includes("404"),
            );
            assertEqual(
                provider404,
                undefined,
                `no provider 404 after ${relationship}-provider switch (got ${provider404 ? JSON.stringify(provider404.data) : "none"})`,
            );

            const lossy = after.some((e) => e.eventType === "session.lossy_handoff");
            assertEqual(lossy, false, `${relationship}-provider switch should not cause a lossy handoff`);

            const notice = after.find((e) =>
                e.eventType === "system.message"
                && String(e.data?.content || "").includes("Runtime model for this turn is"),
            );
            assertNotNull(notice, "runtime model notice injected after switch");
            assertEqual(
                String(notice.data?.content || "").includes(targetShort),
                true,
                `runtime notice names ${targetShort} (got ${notice.data?.content})`,
            );

        } finally {
            await catalog.close();
            await mgmt.stop().catch(() => {});
        }
    });
}

async function runControlPlaneModelSwitchFailureScenario(env) {
    await withClient(env, {}, async (client) => {
        const session = await client.createSession({ model: TEST_GPT_MODEL });
        await session.sendAndWait("Say hello", TIMEOUT);

        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            modelProvidersPath: env.modelProvidersPath,
        });
        await mgmt.start();
        const catalog = await createCatalog(env);
        try {
            const before = await catalog.getSessionEvents(session.sessionId);
            const boundarySeq = before.length ? before[before.length - 1].seq : 0;
            const turnsBefore = await catalog.getSessionTurnMetrics(session.sessionId);
            const maxTurnBefore = turnsBefore.reduce((max, turn) => Math.max(max, turn.turnIndex), -1);
            await assertThrows(
                () => mgmt.setSessionModel(session.sessionId, INVALID_MODEL_ID),
                "Unknown model",
                "control-plane invalid model rejected",
            );
            const row = await catalog.getSession(session.sessionId);
            assertEqual(row.model.includes(TEST_GPT_MODEL), true, `CMS model unchanged after failed CP switch (got ${row.model})`);
            const after = (await catalog.getSessionEvents(session.sessionId)).filter((e) => e.seq > boundarySeq);
            assertEqual(after.some((e) => e.eventType === "session.model_changed"), false, "failed CP switch should not emit model_changed");
            assertEqual(
                after.some((e) => e.eventType === "system.message" && String(e.data?.content || "").includes("Continue on")),
                false,
                "failed CP switch should not schedule a chat continuation",
            );
        } finally {
            await catalog.close();
            await mgmt.stop().catch(() => {});
        }
    });
}

function runGenerator(gen) {
    let input;
    while (true) {
        const step = gen.next(input);
        if (step.done) return step.value;
        input = step.value;
    }
}

class FakeInlineCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    scriptedToolCalls = [];
    assistantContent = "assistant should not continue after model switch failure";
    aborted = false;

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAllHandlers.push(eventType);
            return () => { this.catchAllHandlers = this.catchAllHandlers.filter((candidate) => candidate !== eventType); };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => {
            const current = this.listeners.get(eventType) ?? [];
            this.listeners.set(eventType, current.filter((candidate) => candidate !== handler));
        };
    }

    registerTools(tools) {
        this.registeredTools = tools;
    }

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) handler({ type: eventType, data: payload.data ?? payload });
        const handlers = this.listeners.get(eventType) ?? [];
        for (const handler of handlers) handler(payload);
    }

    async send() {
        this.aborted = false;
        queueMicrotask(async () => {
            for (const call of this.scriptedToolCalls) {
                const tool = this.registeredTools.find((candidate) => candidate.name === call.name);
                if (!tool) throw new Error(`Missing fake tool: ${call.name}`);
                await tool.handler(call.args ?? {});
            }
            if (!this.aborted && this.assistantContent != null) {
                this.emit("assistant.message", { data: { content: this.assistantContent } });
            }
            this.emit("session.idle", { data: {} });
        });
    }

    abort() { this.aborted = true; }
}

function createFakeModelSwitchRuntime(timerKind) {
    const now = 1_000_000;
    const kv = new Map();
    const events = [];
    const updates = [];
    const continuations = [];
    const runtime = {
        ctx: {
            traceInfo() {},
            getValue(key) { return kv.get(key); },
            setValue(key, value) { kv.set(key, value); },
            clearValue(key) { kv.delete(key); },
            setCustomStatus(value) { runtime.customStatus = value; },
            utcNow() { return now; },
            // Stop-turn race (v1.0.56+): processPrompt yields
            // race(runTurnTask, dequeueEvent(stopTurn.<iteration>)). The fake
            // session's runTurn() returns the TurnResult object directly, so
            // resolving the race with the left branch as the winner preserves
            // the old direct-yield behavior for these tests.
            dequeueEvent(queueName) { return { effect: "dequeueEvent", queueName }; },
            race(left) { return { index: 0, value: left }; },
            continueAsNewVersioned(input, version) {
                continuations.push({ input, version });
                return { input, version };
            },
        },
        input: { sessionId: "session-model-switch-timer", config: { model: "github-copilot:gpt-5.4" } },
        versions: { currentVersion: "1.0.test", latestVersion: "1.0.test" },
        manager: {
            loadKnowledgeIndex() { return null; },
            listChildSessions() { return "[]"; },
            summarizeSession() { return null; },
            recordSessionEvent(sessionId, batch) {
                events.push(...batch.map((event) => ({ sessionId, ...event })));
            },
            updateSessionModel(sessionId, model, reasoningEffort) {
                updates.push({ sessionId, model, reasoningEffort });
            },
        },
        session: {},
        options: {
            dehydrateThreshold: 29,
            idleTimeout: -1,
            inputGracePeriod: 0,
            checkpointInterval: -1,
            isSystem: false,
            nestingLevel: 0,
        },
        state: {
            config: { model: "github-copilot:gpt-5.4" },
            affinityKey: "affinity",
            iteration: 1,
            loopIteration: 1,
            retryCount: 0,
            needsHydration: false,
            preserveAffinityOnHydrate: false,
            blobEnabled: false,
            lastLiveSessionAction: "session-activity",
            pendingToolActions: [],
            subAgents: [],
            nextSummarizeAt: 0,
            activeTimer: {
                deadlineMs: now + 60_000,
                originalDurationMs: 60_000,
                reason: timerKind === "wait" ? "timer edge wait" : "timer edge cron",
                type: timerKind,
            },
            pendingInputQuestion: null,
            waitingForAgentIds: null,
            interruptedWaitTimer: null,
            interruptedCronTimer: null,
            pendingChildDigest: null,
            pendingShutdown: null,
            lastResponseVersion: 0,
            lastCommandVersion: 0,
            cancelledMessageIds: new Set(),
            emittedCancelledMessageIds: new Set(),
            legacyPendingMessage: undefined,
            orchestrationResult: null,
        },
    };
    return { runtime, events, updates, continuations };
}

async function testLlmSetModelFailureIsTerminal() {
    const fakeSession = new FakeInlineCopilotSession();
    let summaryCalls = 0;
    fakeSession.scriptedToolCalls = [
        { name: "set_session_model", args: { model: INVALID_MODEL_ID } },
        { name: "update_session_summary", args: { summary_state: { schemaVersion: 1, updatedAt: new Date().toISOString(), intent: "wrong", summary: "wrong", state: {}, openQuestions: [], blockers: [], nextActions: [], links: [], structureChangeLog: [] } } },
    ];
    const managed = new ManagedSession("llm-failed-switch-terminal", fakeSession, {});
    const result = await managed.runTurn("switch to an invalid model", {
        controlToolBridge: {
            setSessionModel: async () => `[SYSTEM: set_session_model failed: Unknown model: ${INVALID_MODEL_ID}]`,
            updateSessionSummary: async () => { summaryCalls += 1; return "ok"; },
        },
    });

    assertEqual(result.type, "completed", "failed set_session_model should end the turn as completed boundary");
    assertEqual(result.content, "Model switch failed. Continuing on the unchanged model.", "failed switch result should be terminal correction content");
    assertEqual(summaryCalls, 0, "tools after failed set_session_model should be blocked");
}

async function testLlmSetModelNonAcceptedResultIsTerminal() {
    const fakeSession = new FakeInlineCopilotSession();
    let summaryCalls = 0;
    fakeSession.scriptedToolCalls = [
        { name: "set_session_model", args: { model: "github-copilot:gpt-5.5" } },
        { name: "update_session_summary", args: { summary_state: { schemaVersion: 1, updatedAt: new Date().toISOString(), intent: "wrong", summary: "wrong", state: {}, openQuestions: [], blockers: [], nextActions: [], links: [], structureChangeLog: [] } } },
    ];
    const managed = new ManagedSession("llm-nonaccepted-switch-terminal", fakeSession, {});
    const result = await managed.runTurn("try to switch unavailable", {
        controlToolBridge: {
            setSessionModel: async () => "[SYSTEM: set_session_model rejected by policy.]",
            updateSessionSummary: async () => { summaryCalls += 1; return "ok"; },
        },
    });

    assertEqual(result.type, "completed", "non-accepted set_session_model should end the turn as completed boundary");
    assertEqual(result.content, "Model switch failed. Continuing on the unchanged model.", "non-accepted switch result should be terminal correction content");
    assertEqual(summaryCalls, 0, "tools after non-accepted set_session_model should be blocked");
}

function testForceContinuePromptSchedulesBootstrapContinuation() {
    const { runtime, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = null;
    runGenerator(handleTurnResult(runtime, {
        type: "completed",
        content: "Model switch failed. Continuing on the unchanged model.",
        forceContinuePrompt: "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
    }, ""));

    assertEqual(continuations.length, 1, "forceContinuePrompt schedules one continuation");
    assertEqual(
        continuations[0].input.prompt,
        "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
        "forceContinuePrompt is carried as the bootstrap continuation prompt",
    );
    assertEqual(continuations[0].input.bootstrapPrompt, true, "correction continuation is bootstrap-only");
}

function testProcessPromptTurnsFailedSwitchIntoCorrectionContinuation() {
    const { runtime, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = null;
    runtime.session = {
        runTurn() {
            return {
                type: "completed",
                content: "Model switch failed. Continuing on the unchanged model.",
                events: [
                    {
                        eventType: "tool.execution_complete",
                        data: {
                            toolName: "set_session_model",
                            result: `[SYSTEM: set_session_model failed: Unknown model: ${INVALID_MODEL_ID}]`,
                        },
                    },
                ],
            };
        },
    };

    runGenerator(processPrompt(runtime, "try invalid model", false, "set_session_model"));

    assertEqual(continuations.length, 1, "failed set_session_model processPrompt schedules one continuation");
    assertEqual(
        continuations[0].input.prompt,
        "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
        "failed switch correction continuation prompt is generated from current model",
    );
    assertEqual(continuations[0].input.bootstrapPrompt, true, "failed switch correction continuation is bootstrap-only");
    assertEqual(
        String(continuations[0].input.runtimeModelNotice || "").includes("Previous model switch failed; current runtime model is github-copilot:gpt-5.4"),
        true,
        `runtime model correction notice carried (got ${continuations[0].input.runtimeModelNotice})`,
    );
}

function testProcessPromptTurnsRejectedSwitchIntoCorrectionContinuation() {
    const { runtime, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = null;
    runtime.session = {
        runTurn() {
            return {
                type: "completed",
                content: "Model switch failed. Continuing on the unchanged model.",
                events: [
                    {
                        eventType: "tool.execution_complete",
                        data: {
                            toolName: "set_session_model",
                            result: "[SYSTEM: set_session_model rejected by policy.]",
                        },
                    },
                ],
            };
        },
    };

    runGenerator(processPrompt(runtime, "try rejected model", false, "set_session_model"));

    assertEqual(continuations.length, 1, "rejected set_session_model processPrompt schedules one continuation");
    assertEqual(
        continuations[0].input.prompt,
        "Continue on github-copilot:gpt-5.4; the requested model switch failed.",
        "rejected switch correction continuation prompt is generated from current model",
    );
    assertEqual(continuations[0].input.bootstrapPrompt, true, "rejected switch correction continuation is bootstrap-only");
}

function testSystemSessionSetModelUsesOrdinaryCommandPath() {
    const { runtime, events, updates, continuations } = createFakeModelSwitchRuntime("wait");
    runtime.options.isSystem = true;
    runtime.input.isSystem = true;
    runtime.state.activeTimer = null;

    runGenerator(handleCommand(runtime, {
        type: "cmd",
        cmd: "set_model",
        id: "cmd-system-set-model",
        args: { model: "github-copilot:gpt-5.5", reasoningEffort: "xhigh", source: "user" },
    }));

    assertEqual(updates.length, 1, "system set_model records one model update");
    assertEqual(updates[0].model, "github-copilot:gpt-5.5", "system set_model targets selected model");
    assertEqual(updates[0].reasoningEffort, "xhigh", "system set_model carries selected effort");
    const modelChanged = events.find((event) => event.eventType === "session.model_changed");
    assertNotNull(modelChanged, "system set_model records model_changed event");
    assertEqual(modelChanged.data?.source, "user", "system set_model keeps control-plane source");
    assertEqual(continuations.length, 1, "system set_model schedules one continue-as-new");
    assertEqual(continuations[0].input.prompt, "Continue on github-copilot:gpt-5.5:xhigh.", "system set_model continuation prompt targets new model");
    assertEqual(continuations[0].input.isSystem, true, "system set_model preserves system-session input flag");
}

function testInterruptedWaitAutoResumesAfterModelSwitchContinuation() {
    const { runtime } = createFakeModelSwitchRuntime("wait");
    runtime.state.activeTimer = null;
    runtime.state.interruptedWaitTimer = {
        remainingSec: 42,
        reason: "resume after model switch",
        shouldRehydrate: false,
    };

    runGenerator(handleTurnResult(runtime, {
        type: "completed",
        content: "Continue on the selected model.",
    }, "Continue on github-copilot:gpt-5.5."));

    assertEqual(runtime.state.interruptedWaitTimer, null, "interrupted wait marker is consumed");
    assertNotNull(runtime.state.activeTimer, "interrupted wait is restored after continuation");
    assertEqual(runtime.state.activeTimer.type, "wait", "restored timer remains a wait");
    assertEqual(runtime.state.activeTimer.reason, "resume after model switch", "restored wait keeps reason");
    assertEqual(runtime.state.activeTimer.deadlineMs, 1_042_000, "restored wait keeps remaining duration");
}

function testModelSwitchInterruptsTimerCommand(timerKind) {
    const { runtime, events, updates, continuations } = createFakeModelSwitchRuntime(timerKind);
    runGenerator(handleCommand(runtime, {
        type: "cmd",
        cmd: "set_model",
        id: `cmd-${timerKind}`,
        args: { model: "github-copilot:gpt-5.5", source: "user" },
    }));

    assertEqual(runtime.state.activeTimer, null, `${timerKind} active timer is cleared before continuation`);
    if (timerKind === "wait") {
        assertNotNull(runtime.state.interruptedWaitTimer, "wait timer captured for auto-resume");
        assertEqual(runtime.state.interruptedWaitTimer.remainingSec, 60, "wait remaining time preserved");
    } else {
        assertNotNull(runtime.state.interruptedCronTimer, "cron timer captured for auto-resume");
        assertEqual(runtime.state.interruptedCronTimer.remainingMs, 60_000, "cron remaining time preserved");
    }
    assertEqual(updates.length, 1, "model update is recorded");
    assertEqual(updates[0].model, "github-copilot:gpt-5.5", "model update targets selected model");
    assertEqual(events.some((event) => event.eventType === "session.model_changed"), true, "model_changed event recorded");
    assertEqual(continuations.length, 1, "set_model schedules one continue-as-new");
    assertEqual(continuations[0].input.prompt, "Continue on github-copilot:gpt-5.5.", "continuation prompt targets new model");
    assertEqual(continuations[0].input.activeTimerState, undefined, "active timer is not carried ahead to block continuation");
}

async function testDifferentModelSameWorker(env) {
    await withClient(env, {}, async (client, worker) => {
        const s1 = await client.createSession({ model: TEST_GPT_MODEL });
        const s2 = await client.createSession({ model: TEST_CLAUDE_MODEL });
        assertNotNull(s1, "session 1 created");
        assertNotNull(s2, "session 2 created");

        console.log("  Sending prompts to both sessions...");
        const [r1, r2] = await Promise.all([
            s1.sendAndWait("Say hello", TIMEOUT),
            s2.sendAndWait("Say hello", TIMEOUT),
        ]);
        console.log(`  ${TEST_GPT_MODEL} response: "${r1?.slice(0, 60)}"`);
        console.log(`  ${TEST_CLAUDE_MODEL} response: "${r2?.slice(0, 60)}"`);
        assertNotNull(r1, `got ${TEST_GPT_MODEL} response`);
        assertNotNull(r2, "got claude response");

        const catalog = await createCatalog(env);
        try {
            const row1 = await catalog.getSession(s1.sessionId);
            const row2 = await catalog.getSession(s2.sessionId);
            console.log(`  CMS model 1: "${row1?.model}"`);
            console.log(`  CMS model 2: "${row2?.model}"`);
            assertEqual(
                row1.model.includes(TEST_GPT_MODEL),
                true,
                `session 1 model is ${TEST_GPT_MODEL} (got: ${row1.model})`,
            );
            assertEqual(
                row2.model.includes(TEST_CLAUDE_MODEL),
                true,
                `session 2 model is ${TEST_CLAUDE_MODEL} (got: ${row2.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testDefaultModelRecorded(env) {
    await withClient(env, {}, async (client, worker) => {
        // No explicit model — should use the worker's default
        const session = await client.createSession();
        assertNotNull(session, "session created");

        console.log("  Sending prompt with default model...");
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");

        const info = await session.getInfo();
        console.log(`  Session info model: "${info?.model}"`);
        // Default model should be set (either from worker config or SDK default)
    });
}

async function testInvalidConfiguredDefaultFailsFast() {
    await assertThrows(
        async () => {
            new ModelProviderRegistry({
                providers: [
                    {
                        id: "github-copilot",
                        type: "github",
                        githubToken: "env:GITHUB_TOKEN",
                        models: ["gpt-5.1"],
                    },
                ],
                defaultModel: "azure-openai:gpt-5.4-min1i",
            });
        },
        /invalid defaultmodel/i,
        "invalid configured default should fail fast",
    );
}

async function testMissingConfiguredDefaultDoesNotFallback() {
    const registry = new ModelProviderRegistry({
        providers: [
            {
                id: "github-copilot",
                type: "github",
                githubToken: "env:GITHUB_TOKEN",
                models: ["gpt-5.1"],
            },
        ],
    });

    assertEqual(
        registry.defaultModel,
        undefined,
        "registry should not silently choose the first available model as default",
    );
    assertEqual(
        registry.normalize(),
        undefined,
        "normalizing an unspecified model should stay undefined when no defaultModel is configured",
    );
}

async function testGithubModelsRemainVisibleWithoutEnvToken() {
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
        const registry = new ModelProviderRegistry({
            providers: [
                {
                    id: "github-copilot",
                    type: "github",
                    githubToken: "env:GITHUB_TOKEN",
                    models: ["gpt-5.5"],
                },
                {
                    id: "missing-openai",
                    type: "openai",
                    baseUrl: "https://example.invalid/openai/v1",
                    apiKey: "env:MISSING_OPENAI_KEY_FOR_TEST",
                    models: ["missing-model"],
                },
            ],
        });

        assertNotNull(
            registry.getDescriptor("github-copilot:gpt-5.5"),
            "GitHub models should remain visible even when env GITHUB_TOKEN is missing",
        );
        assertEqual(
            registry.getDescriptor("missing-openai:missing-model"),
            undefined,
            "non-GitHub providers should still require their API key before becoming visible",
        );
        assertEqual(
            registry.resolve("github-copilot:gpt-5.5")?.githubToken,
            undefined,
            "GitHub provider should expose missing env token as undefined for create-time enforcement",
        );
    } finally {
        if (previousToken == null) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previousToken;
    }
}

async function testReasoningEffortMetadata() {
    const registry = new ModelProviderRegistry({
        providers: [
            {
                id: "github-copilot",
                type: "github",
                githubToken: "env:GITHUB_TOKEN",
                models: [
                    {
                        name: "gpt-5.5",
                        supportedReasoningEfforts: ["medium", "xhigh"],
                        defaultReasoningEffort: "medium",
                    },
                    "legacy-model",
                ],
            },
        ],
    });

    const gpt55 = registry.getDescriptor("github-copilot:gpt-5.5");
    assertNotNull(gpt55, "gpt-5.5 descriptor should exist");
    assertEqual(
        JSON.stringify(gpt55.supportedReasoningEfforts),
        JSON.stringify(["medium", "xhigh"]),
        "supported reasoning efforts should be preserved from model config",
    );
    assertEqual(gpt55.defaultReasoningEffort, "medium", "default reasoning effort should be preserved from model config");
    const summary = registry.getModelSummaryForLLM();
    assertEqual(summary.includes("[reasoning: medium, xhigh; default: medium]"), true, "LLM model summary should advertise supported and default reasoning efforts");

    const legacy = registry.getDescriptor("github-copilot:legacy-model");
    assertNotNull(legacy, "legacy descriptor should exist");
    assertEqual(
        legacy.supportedReasoningEfforts,
        undefined,
        "legacy string model entries should remain backward compatible and omit reasoning metadata",
    );
    assertEqual(legacy.defaultReasoningEffort, undefined, "legacy string model entries should not invent a default reasoning effort");
}

async function testManagementListModelsReasoningMetadata(env) {
    const modelProvidersPath = path.join(env.baseDir, "model-providers.reasoning-list.json");
    fs.writeFileSync(modelProvidersPath, JSON.stringify({
        providers: [{
            id: "github-copilot",
            type: "github",
            githubToken: "env:GITHUB_TOKEN",
            models: [{
                name: "gpt-5.5",
                description: "Reasoning metadata test model.",
                cost: "high",
                supportedReasoningEfforts: ["medium", "xhigh"],
                defaultReasoningEffort: "medium",
            }],
        }],
        defaultModel: "github-copilot:gpt-5.5",
    }));

    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        modelProvidersPath,
    });
    try {
        await mgmt.start();
        const models = mgmt.listModels();
        const model = models.find((entry) => entry.qualifiedName === "github-copilot:gpt-5.5");
        assertNotNull(model, "management listModels should include configured model");
        assertEqual(JSON.stringify(model.supportedReasoningEfforts), JSON.stringify(["medium", "xhigh"]), "management listModels should expose supported reasoning efforts");
        assertEqual(model.defaultReasoningEffort, "medium", "management listModels should expose default reasoning effort");
    } finally {
        await mgmt.stop().catch(() => {});
    }
}

async function testSessionManagerModelSwitchConfig() {
    const registry = new ModelProviderRegistry({
        providers: [{
            id: "github-copilot",
            type: "github",
            githubToken: "env:GITHUB_TOKEN",
            models: [{
                name: "gpt-5.5",
                supportedReasoningEfforts: ["medium", "xhigh"],
                defaultReasoningEffort: "medium",
            }, "plain-model"],
        }],
        defaultModel: "github-copilot:gpt-5.5",
    });
    const manager = new SessionManager(undefined, null, { modelProviders: registry });

    assertEqual(
        JSON.stringify(manager.resolveModelSwitchConfig("github-copilot:gpt-5.5")),
        JSON.stringify({ model: "github-copilot:gpt-5.5", reasoningEffort: "medium" }),
        "switch without effort uses target default effort",
    );
    assertEqual(
        JSON.stringify(manager.resolveModelSwitchConfig("github-copilot:plain-model")),
        JSON.stringify({ model: "github-copilot:plain-model", reasoningEffort: null }),
        "switch without effort clears effort when target has no default",
    );
    assertEqual(
        JSON.stringify(manager.resolveModelSwitchConfig("github-copilot:gpt-5.5", "xhigh")),
        JSON.stringify({ model: "github-copilot:gpt-5.5", reasoningEffort: "xhigh" }),
        "explicit supported effort is preserved",
    );
    await assertThrows(() => manager.resolveModelSwitchConfig("gpt-5.5"), "exact provider:model", "bare model rejected");
    await assertThrows(() => manager.resolveModelSwitchConfig("github-copilot:gpt-5.5", "high"), "does not support", "unsupported effort rejected");
}

/**
 * Deterministic check for the model rebind decision that backs the warm-session
 * handling in SessionManager.getOrCreate. Any model or reasoning-effort switch
 * must force a rebind (disconnect + resume on the selected model config), even
 * within the same provider; unchanged config must not.
 */
function testManagedSessionRequiresModelRebind() {
    const ms = new ManagedSession("sid-rebind", {}, { model: "github-copilot:gpt-5.4" });
    assertEqual(ms.requiresModelRebind({ model: "github-copilot:claude-sonnet-4.6" }), true, "same provider, different model -> rebind");
    assertEqual(ms.requiresModelRebind({ model: "github-copilot:gpt-5.4" }), false, "same provider, same model -> no rebind");
    assertEqual(ms.requiresModelRebind({ model: "azure-openai:gpt-5.4-nano" }), true, "different provider -> rebind");
    assertEqual(ms.requiresModelRebind({}), false, "no target model -> no rebind");

    const effort = new ManagedSession("sid-effort", {}, { model: "github-copilot:gpt-5.5", reasoningEffort: "medium" });
    assertEqual(effort.requiresModelRebind({ model: "github-copilot:gpt-5.5", reasoningEffort: "xhigh" }), true, "same model, different effort -> rebind");
    assertEqual(effort.requiresModelRebind({ model: "github-copilot:gpt-5.5", reasoningEffort: "medium" }), false, "same model, same effort -> no rebind");

    const bare = new ManagedSession("sid-bare", {}, { model: "gpt-5.4" });
    assertEqual(bare.requiresModelRebind({ model: "azure-openai:gpt-5.4-nano" }), true, "bare current model to qualified target -> rebind");
}

/**
 * Deterministic check for the failed-switch detection that backs the one-shot
 * correction notice. The `set_session_model` inline control tool reports its
 * outcome as a plain string, so detection must handle a string `result` (the
 * real SDK shape) as well as an object `{ content }`.
 */
function testDetectFailedModelSwitch() {
    const failStringShape = [
        { eventType: "tool.execution_start", data: { toolName: "set_session_model" } },
        { eventType: "tool.execution_complete", data: { toolName: "set_session_model", result: "[SYSTEM: set_session_model failed: Unknown model: github-copilot:gpt-nonexistent-9000]" } },
    ];
    assertEqual(Boolean(detectFailedModelSwitch(failStringShape)), true, "detects failure when result is a plain string (real SDK shape)");

    const failObjectShape = [
        { eventType: "tool.execution_complete", data: { toolName: "set_session_model", result: { content: "[SYSTEM: set_session_model failed: no storeUrl is configured.]" } } },
    ];
    assertEqual(Boolean(detectFailedModelSwitch(failObjectShape)), true, "detects failure when result is an object with content");

    const successShape = [
        { eventType: "tool.execution_complete", data: { toolName: "set_session_model", result: "[SYSTEM: Model switch accepted. The next turn will use github-copilot:gpt-5.5.]" } },
    ];
    assertEqual(detectFailedModelSwitch(successShape), null, "a successful switch is not treated as a failure");

    const unrelatedFailure = [
        { eventType: "tool.execution_complete", data: { toolName: "spawn_agent", result: "[SYSTEM: spawn_agent failed: boom]" } },
    ];
    assertEqual(detectFailedModelSwitch(unrelatedFailure), null, "unrelated tool failures are ignored");

    assertEqual(detectFailedModelSwitch([]), null, "empty events -> null");
    assertEqual(detectFailedModelSwitch(undefined), null, "undefined events -> null");
}

describe("Model Switch Utilities", () => {
    it("SessionManager validates exact model ids and target effort defaults", async () => {
        await testSessionManagerModelSwitchConfig();
    });
    it("ManagedSession.requiresModelRebind detects model config switches", async () => {
        testManagedSessionRequiresModelRebind();
    });
    it("detectFailedModelSwitch flags failed set_session_model tool results", async () => {
        testDetectFailedModelSwitch();
    });
    it("LLM set_session_model failure is terminal", async () => {
        await testLlmSetModelFailureIsTerminal();
    });
    it("LLM set_session_model non-accepted result is terminal", async () => {
        await testLlmSetModelNonAcceptedResultIsTerminal();
    });
    it("failed model switch force-continuation is bootstrap", async () => {
        testForceContinuePromptSchedulesBootstrapContinuation();
    });
    it("processPrompt turns failed set_session_model into correction continuation", async () => {
        testProcessPromptTurnsFailedSwitchIntoCorrectionContinuation();
    });
    it("processPrompt turns rejected set_session_model into correction continuation", async () => {
        testProcessPromptTurnsRejectedSwitchIntoCorrectionContinuation();
    });
    it("system sessions use ordinary set_model command handling", async () => {
        testSystemSessionSetModelUsesOrdinaryCommandPath();
    });
    it("set_model interrupts active wait timer before auto-continuation", async () => {
        testModelSwitchInterruptsTimerCommand("wait");
    });
    it("set_model interrupts active cron timer before auto-continuation", async () => {
        testModelSwitchInterruptsTimerCommand("cron");
    });
    it("interrupted wait auto-resumes after model-switch continuation", async () => {
        testInterruptedWaitAutoResumesAfterModelSwitchContinuation();
    });
});

describeModelSelection("Model Selection", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Create Session With Explicit Model", { timeout: TIMEOUT }, async () => {
        await testCreateSessionWithModel(getEnv());
    });
    it("Model Recorded in CMS After Turn", { timeout: TIMEOUT }, async () => {
        await testModelRecordedAfterTurn(getEnv());
    });
    it("Different Models on Same Worker", { timeout: TIMEOUT }, async () => {
        await testDifferentModelSameWorker(getEnv());
    });
    it("Mid-Session Model Switch", { timeout: TIMEOUT }, async () => {
        await testMidSessionModelSwitch(getEnv());
    });
    it("Model Switch — Control Plane, Same Provider", { timeout: TIMEOUT }, async () => {
        await runModelSwitchScenario(getEnv(), { initiator: "cp", relationship: "same" });
    });
    it("Model Switch — LLM Tool, Same Provider", { timeout: TIMEOUT }, async () => {
        await runModelSwitchScenario(getEnv(), { initiator: "llm", relationship: "same" });
    });
    it("Model Switch — Control Plane, Cross Provider", { timeout: TIMEOUT }, async () => {
        await runModelSwitchScenario(getEnv(), { initiator: "cp", relationship: "cross" });
    });
    it("Model Switch — LLM Tool, Cross Provider", { timeout: TIMEOUT }, async () => {
        await runModelSwitchScenario(getEnv(), { initiator: "llm", relationship: "cross" });
    });
    it("Model Switch Failure — Control Plane Invalid Model", { timeout: TIMEOUT }, async () => {
        await runControlPlaneModelSwitchFailureScenario(getEnv());
    });
    it("Default Model Recorded", { timeout: TIMEOUT }, async () => {
        await testDefaultModelRecorded(getEnv());
    });
    it("Invalid Configured Default Fails Fast", async () => {
        await testInvalidConfiguredDefaultFailsFast();
    });
    it("Missing Configured Default Does Not Fallback", async () => {
        await testMissingConfiguredDefaultDoesNotFallback();
    });
    it("GitHub Models Remain Visible Without Env Token", async () => {
        await testGithubModelsRemainVisibleWithoutEnvToken();
    });
    it("Reasoning Effort Metadata", async () => {
        await testReasoningEffortMetadata();
    });
    it("Management List Models Includes Reasoning Metadata", async () => {
        await testManagementListModelsReasoningMetadata(getEnv());
    });
});
