/**
 * Orchestration 1.0.71: the wake-up note rides in the USER turn.
 *
 * Every wake-up (timer end, cron fire, child update) gives the model a
 * `[SYSTEM: …]` note. ≤1.0.70 parked it in config.turnSystemPrompt and
 * session-manager rendered it into the SYSTEM message, so the first bytes of
 * every wake-up request differed and the provider dropped the prefix cache
 * behind them (chk: 12% hit vs 93–99% when the system message is stable).
 *
 * This drives the REAL latest generator and pins the new delivery:
 *   - the runTurn prompt ends with a <system_context> block carrying the note
 *   - config.turnSystemPrompt is still set (session-proxy records it) and
 *     config.systemContextInPrompt is true (session-manager must not render it)
 *   - a runTurn.throw retry re-sends the note exactly once
 *   - a system-only turn retries with its prompt AND its bootstrap flag
 *
 * Each pin was verified red against the 1.0.70 behaviour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_SYSTEM_TURN_PROMPT } from "../../src/orchestration/state.ts";
import { SYSTEM_CONTEXT_OPEN, SYSTEM_CONTEXT_CLOSE } from "../../src/prompt-system-context.ts";

let mockSession;
let mockManager;
let capturedConfig;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (_ctx, _sessionId, _affinityKey, config) => {
        capturedConfig = config;
        return mockSession;
    },
    createSessionManagerProxy: () => mockManager,
}));

function createHarness({ queue = [], turnResults = null, throwOnTurn = false } = {}) {
    const turns = [];
    const script = turnResults ? [...turnResults] : null;
    const pending = queue.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));

    mockSession = new Proxy({}, {
        get: (_t, prop) => {
            if (prop === "runTurn") {
                return (prompt, bootstrap, turnIndex, opts) => {
                    turns.push({ prompt, bootstrap, turnIndex, opts: opts ?? {}, config: capturedConfig });
                    return { effect: "runTurn" };
                };
            }
            if (prop === "needsHydration") return () => ({ effect: "needsHydration" });
            return (...args) => ({ effect: `session.${String(prop)}`, args });
        },
    });
    mockManager = new Proxy({}, {
        get: (_t, prop) => (...args) => ({ effect: `manager.${String(prop)}`, args }),
    });

    const values = new Map();
    const ctx = {
        traceInfo: () => {},
        setCustomStatus: () => {},
        getValue: (k) => (values.has(k) ? values.get(k) : null),
        setValue: (k, v) => values.set(k, v),
        clearValue: (k) => values.delete(k),
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
        dequeueEvent: (name) => ({ effect: "dequeueEvent", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
        hasQueuedEvents: () => pending.length > 0,
    };

    let now = 1_750_000_000_000;
    const resolve = (effect) => {
        if (!effect || typeof effect !== "object") return undefined;
        switch (effect.effect) {
            case "utcNow": return (now += 1000);
            case "newGuid": return "00000000-0000-0000-0000-000000000001";
            case "needsHydration": return false;
            case "dequeueEvent": {
                if (pending.length === 0) throw new Error("dequeue underflow");
                return pending.shift();
            }
            case "race": {
                if (effect.left?.effect === "runTurn") {
                    if (throwOnTurn) return { throwError: new Error("LLM endpoint exploded") };
                    if (script && script.length > 0) return { index: 0, value: script.shift() };
                    return { effect: "STOP_AT_TURN" };
                }
                const sides = [effect.left, effect.right];
                const dequeueIx = sides.findIndex((s) => s?.effect === "dequeueEvent");
                if (dequeueIx >= 0 && pending.length > 0) return { index: dequeueIx, value: pending.shift() };
                const timerIx = sides.findIndex((s) => s?.effect === "scheduleTimer");
                if (timerIx >= 0 && sides[timerIx].ms <= 1000) return { index: timerIx };
                return { effect: "PARKED" };
            }
            default:
                if (effect.effect === "manager.getWorkerSessionPolicy") return { policy: null, allowedAgentNames: [] };
                if (effect.effect === "manager.resolveAgentConfig") return null;
                if (effect.effect === "manager.listModels") return [];
                if (effect.effect === "manager.loadKnowledgeIndex") return null;
                if (effect.effect === "manager.getSessionStatus") return null;
                if (effect.effect === "manager.getOrchestrationStats") return null;
                if (effect.effect === "manager.listChildSessions") return [];
                return undefined;
        }
    };
    return { ctx, turns, resolve };
}

function drive(gen, harness, { maxSteps = 400 } = {}) {
    let input;
    let pendingThrow = null;
    for (let i = 0; i < maxSteps; i += 1) {
        const next = pendingThrow ? gen.throw(pendingThrow) : gen.next(input);
        pendingThrow = null;
        if (next.done) return { kind: "return", value: next.value };
        const effect = next.value;
        if (effect?.effect === "continueAsNew") return { kind: "continueAsNew", input: effect.input, version: effect.version };
        if (effect?.effect === "dequeueEvent" && !harness.ctx.hasQueuedEvents()) return { kind: "blocked" };
        const resolved = harness.resolve(effect);
        if (resolved?.throwError) { pendingThrow = resolved.throwError; input = undefined; continue; }
        if (resolved?.effect === "STOP_AT_TURN") return { kind: "turn" };
        input = resolved;
        if (input?.effect === "PARKED") return { kind: "parked" };
    }
    throw new Error("drive exceeded step limit");
}

async function latestHandler() {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    const mod = await import("../../src/orchestration.ts");
    const fn = mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
    expect(fn, `latest handler for ${DURABLE_SESSION_LATEST_VERSION}`).toBeTypeOf("function");
    return fn;
}

const INPUT = (overrides = {}) => ({
    sessionId: "prefix-cache-test",
    config: { model: "azure-openai:gpt-5.4-mini" },
    iteration: 0,
    isSystem: false,
    blobEnabled: false,
    ...overrides,
});

const countBlocks = (text) => (String(text).match(new RegExp(SYSTEM_CONTEXT_OPEN, "g")) ?? []).length;

describe("orchestration 1.0.71: the wake-up note rides in the user turn", () => {
    beforeEach(() => { mockSession = null; mockManager = null; capturedConfig = undefined; });

    it("a wait-resume turn carries the note as a trailing <system_context> block and flags the config", async () => {
        const handler = await latestHandler();
        const harness = createHarness();
        const out = drive(handler(harness.ctx, INPUT({
            iteration: 3,
            taskContext: "Watch the deploy and report",
            activeTimerState: {
                remainingMs: 0,
                originalDurationMs: 90_000,
                reason: "let the child finish",
                type: "wait",
            },
        })), harness);

        expect(out.kind).toBe("turn");
        expect(harness.turns).toHaveLength(1);
        const { prompt, config } = harness.turns[0];

        // The user text is still the timer prompt, and the note trails it.
        expect(prompt.startsWith("The 90 second wait is now complete.")).toBe(true);
        expect(prompt.trimEnd().endsWith(SYSTEM_CONTEXT_CLOSE)).toBe(true);
        expect(countBlocks(prompt)).toBe(1);
        const note = prompt.slice(prompt.lastIndexOf(SYSTEM_CONTEXT_OPEN));
        expect(note).toContain('Wait reason: "let the child finish".');
        expect(note).toContain("Resume the interrupted task now.");

        // The note is still on the config (session-proxy records it as
        // system.message) — and the flag keeps it OUT of the system message.
        expect(config.turnSystemPrompt).toContain('Wait reason: "let the child finish".');
        expect(config.systemContextInPrompt).toBe(true);
    });

    it("a user prompt with a [SYSTEM:] suffix is delivered as user text + block, not split into the system message", async () => {
        const handler = await latestHandler();
        const harness = createHarness({ queue: [{ prompt: "ship it\n\n[SYSTEM: the owner asked for brevity]" }] });
        const out = drive(handler(harness.ctx, INPUT()), harness);
        expect(out.kind).toBe("turn");
        const { prompt, config } = harness.turns[0];
        expect(prompt).toBe(`ship it\n\n${SYSTEM_CONTEXT_OPEN}\nthe owner asked for brevity\n${SYSTEM_CONTEXT_CLOSE}`);
        expect(config.turnSystemPrompt).toBe("the owner asked for brevity");
        expect(config.systemContextInPrompt).toBe(true);
    });

    it("a runTurn.throw retry re-sends the note exactly once", async () => {
        const handler = await latestHandler();

        // Attempt 1 throws → continue-as-new with retryCount 1.
        let harness = createHarness({ queue: [{ prompt: "ship it\n\n[SYSTEM: keep it short]" }], throwOnTurn: true });
        let out = drive(handler(harness.ctx, INPUT()), harness);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.retryCount).toBe(1);
        // The note travels inside the prompt only. Forwarding systemPrompt as
        // well is how 1.0.70's shape would have appended it a second time.
        expect(out.input.systemPrompt).toBeUndefined();
        expect(countBlocks(out.input.prompt)).toBe(1);

        // Attempt 2 runs the retried prompt: still exactly one block.
        harness = createHarness();
        out = drive(handler(harness.ctx, INPUT(out.input)), harness);
        expect(out.kind).toBe("turn");
        const { prompt } = harness.turns[0];
        expect(prompt.startsWith("ship it")).toBe(true);
        expect(countBlocks(prompt)).toBe(1);
        expect(prompt).toContain("keep it short");
    });

    it("a system-only turn retries with its prompt AND its bootstrap flag", async () => {
        const handler = await latestHandler();
        const harness = createHarness({ queue: [{ prompt: "[SYSTEM: only a note, no user text]" }], throwOnTurn: true });
        const out = drive(handler(harness.ctx, INPUT()), harness);
        expect(out.kind).toBe("continueAsNew");
        // ≤1.0.70 forwarded NO prompt here and re-derived the internal prompt
        // from systemPrompt. The note now lives in the prompt, so it must ride.
        expect(out.input.prompt.startsWith(INTERNAL_SYSTEM_TURN_PROMPT)).toBe(true);
        expect(out.input.prompt).toContain("only a note, no user text");
        expect(out.input.bootstrapPrompt).toBe(true);
        expect(out.input.systemPrompt).toBeUndefined();
    });
});
