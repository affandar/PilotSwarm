/**
 * Resume scenarios for the provider-budget gate (orchestration 1.0.69).
 *
 * Three defects, found live on 2026-08-21, each pinned here so it cannot
 * come back:
 *
 * 1. PROMPT DESTRUCTION. The transcript write for a prompt lives inside the
 *    turn, so a prompt whose turn the gate refused was consumed from the
 *    queue and lost — no user.message, no replay. Across four independent
 *    live agents the queued text appeared in the event log exactly twice out
 *    of dozens of probes. Now: a refused prompt is durably recorded at stash
 *    time and rides into the next turn attempt as `stashedPrompts`.
 *
 * 2. BURNED TURN INDEX. `state.iteration++` ran for every result, including
 *    a gate refusal — a turn that never created Copilot state. The next turn
 *    then asked for resumable state at an index that never existed, the
 *    worker threw SESSION_STATE_MISSING, and the runtime wrote a
 *    lossy_handoff blaming "a worker restart" that never happened —
 *    deterministically, on any session whose first turn was refused.
 *
 * 3. FABRICATED REPLY. "I'm here. Resuming the timer." was synthesized for
 *    any user-interrupted wait with an empty reply — including a gate
 *    refusal, where the model was never called. 38 fabricated replies were
 *    in the live event log, answering messages that were not there.
 *
 * The drives here run the REAL latest orchestration generator end to end
 * with a scripted session proxy, so they exercise the actual drain,
 * turn-cycle and wait paths rather than a re-implementation.
 *
 * Run: npx vitest run test/local/orchestration-budget-resume.test.js
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

const WAKE_PROMPT_RE = /^\[SYSTEM: The budget/;

/** A budget-gate refusal, exactly as session-proxy returns one. */
const gateRefusal = (reason = "azure-openai has reached its daily limit") => ({
    type: "wait", seconds: 3600, reason, budget: true,
});

/**
 * Drive harness.
 *
 * `turnResults` scripts what runTurn returns, in order. `queue` holds
 * incoming messages (delivered whenever the loop races a dequeue against a
 * timer). Every runTurn invocation is captured with its prompt, its turn
 * index and its options, which is what the assertions read.
 */
function createHarness({ turnResults = [], queue = [] } = {}) {
    const turns = [];
    const recorded = [];
    // Messages are STAGED: an entry only becomes deliverable once the drive
    // has completed `afterTurns` turn attempts. Without this the drain's
    // prompt-merging (real behavior: consecutive queued prompts become one
    // turn) collapses a temporal scenario — send, get blocked, THEN wake —
    // into a single merged turn that never blocked at all.
    const pendingMessages = queue.map((entry) =>
        typeof entry === "string" ? { afterTurns: 0, msg: entry } : entry);
    const script = [...turnResults];
    const nextDeliverable = () => {
        const ix = pendingMessages.findIndex((e) => e.afterTurns <= turns.length);
        if (ix < 0) return null;
        return pendingMessages.splice(ix, 1)[0].msg;
    };
    const hasDeliverable = () => pendingMessages.some((e) => e.afterTurns <= turns.length);

    mockSession = new Proxy({}, {
        get: (_t, prop) => {
            if (prop === "runTurn") {
                return (prompt, bootstrap, turnIndex, opts) => {
                    turns.push({ prompt, turnIndex, opts: opts ?? {} });
                    return { effect: "runTurn" };
                };
            }
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
        hasQueuedEvents: () => hasDeliverable(),
    };

    let now = 1_750_000_000_000;
    const resolve = (effect) => {
        if (!effect || typeof effect !== "object") return undefined;
        switch (effect.effect) {
            case "utcNow": return (now += 1000);
            case "newGuid": return "00000000-0000-0000-0000-000000000001";
            case "dequeueEvent": {
                const msg = nextDeliverable();
                if (msg == null) throw new Error(`dequeue underflow (${effect.name ?? "?"})`);
                return msg;
            }
            case "race": {
                // The turn race: the scripted result wins over the stop queue.
                if (effect.left?.effect === "runTurn") {
                    if (script.length === 0) throw new Error("runTurn past the script");
                    return { index: 0, value: script.shift() };
                }
                // An idle race (timer vs messages): a queued message wins.
                const sides = [effect.left, effect.right];
                const dequeueIx = sides.findIndex((s) => s?.effect === "dequeueEvent");
                if (dequeueIx >= 0 && hasDeliverable()) {
                    return { index: dequeueIx, value: nextDeliverable() };
                }
                // Nothing queued. The drain's NON-BLOCKING sweep (a 10ms
                // timer) must fire so the batch gets processed; a REAL wait
                // timer parks the session, which ends the drive — that is
                // the state the tests leave a blocked session in.
                const timerIx = sides.findIndex((s) => s?.effect === "scheduleTimer");
                if (timerIx >= 0 && sides[timerIx].ms <= 1000) {
                    return { index: timerIx };
                }
                return { effect: "PARKED" };
            }
            default:
                if (effect.effect === "manager.recordSessionEvent") {
                    const [sessionId, events] = effect.args;
                    for (const e of events ?? []) recorded.push({ sessionId, ...e });
                    return undefined;
                }
                // Startup reads the drive does not care about, answered with
                // the emptiest value each caller tolerates.
                if (effect.effect === "manager.getWorkerSessionPolicy") {
                    return { policy: null, allowedAgentNames: [] };
                }
                if (effect.effect === "manager.resolveAgentConfig") return null;
                if (effect.effect === "manager.listModels") return [];
                if (effect.effect === "manager.loadKnowledgeIndex") return null;
                if (effect.effect === "manager.getSessionStatus") return null;
                if (effect.effect === "manager.getOrchestrationStats") return null;
                if (effect.effect === "manager.listChildSessions") return [];
                return undefined;
        }
    };

    return { ctx, turns, recorded, resolve, pendingMessages, hasDeliverable };
}

async function latestHandler() {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    const mod = await import("../../src/orchestration.ts");
    const fn = mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
    expect(fn, `latest handler for ${DURABLE_SESSION_LATEST_VERSION}`).toBeTypeOf("function");
    return fn;
}

/** Run the generator until it parks on a timer, continues-as-new, or returns. */
function drive(gen, harness, { maxSteps = 400 } = {}) {
    let input;
    for (let i = 0; i < maxSteps; i += 1) {
        const next = gen.next(input);
        if (next.done) return { kind: "return", value: next.value };
        const effect = next.value;
        if (effect?.effect === "continueAsNew") {
            return { kind: "continueAsNew", input: effect.input, version: effect.version };
        }
        if (effect?.effect === "dequeueEvent" && !harness.hasDeliverable()) {
            return { kind: "blocked" };
        }
        input = harness.resolve(effect);
        if (input?.effect === "PARKED") return { kind: "parked" };
    }
    throw new Error("drive exceeded step limit");
}

const INPUT = (overrides = {}) => ({
    sessionId: "resume-test",
    config: { model: "azure-openai:gpt-5.4-mini" },
    iteration: 0,
    isSystem: false,
    blobEnabled: false,
    ...overrides,
});

const userMessages = (h) => h.recorded.filter((e) => e.eventType === "user.message");
const syntheticReplies = (h) => h.recorded.filter(
    (e) => e.eventType === "assistant.message" && e.data?.synthetic === true);

describe("budget-gate resume scenarios (orchestration 1.0.69)", () => {
    beforeEach(() => { mockSession = null; mockManager = null; });

    it("a refused FIRST prompt is recorded, stashed, and does not burn the turn index", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [gateRefusal()],
            queue: [JSON.stringify({ prompt: "PROBE-ONE please summarize the build", clientMessageIds: ["cm-1"] })],
        });
        const gen = handler(h.ctx, INPUT());
        const outcome = drive(gen, h);
        expect(outcome.kind).toBe("parked");

        // The person's words are durably in the transcript, ids intact, and
        // marked as waiting on the budget rather than run.
        const um = userMessages(h);
        expect(um).toHaveLength(1);
        expect(um[0].data.content).toBe("PROBE-ONE please summarize the build");
        expect(um[0].data.clientMessageIds).toEqual(["cm-1"]);
        expect(um[0].data.budgetQueued).toBe(true);

        // The refused attempt ran at index 0 — and did NOT consume it.
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0].turnIndex).toBe(0);

        // No reply was fabricated for a turn that never reached the model.
        expect(syntheticReplies(h)).toHaveLength(0);
    });

    it("the wake replays the stashed prompt on the SAME turn index, then clears it", async () => {
        const handler = await latestHandler();
        const { PROVIDER_BUDGET_WAKE_PROMPT } = await import("../../src/provider-budgets.ts");
        const h = createHarness({
            turnResults: [
                gateRefusal(),                              // attempt 1: refused
                { type: "completed", content: "done" },     // attempt 2: runs
                { type: "completed", content: "again" },    // attempt 3: proves the stash is gone
            ],
            queue: [
                JSON.stringify({ prompt: "PROBE-TWO run the report", clientMessageIds: ["cm-2"] }),
                { afterTurns: 1, msg: JSON.stringify({ prompt: PROVIDER_BUDGET_WAKE_PROMPT }) },
                { afterTurns: 2, msg: JSON.stringify({ prompt: "a later ordinary message" }) },
            ],
        });
        const gen = handler(h.ctx, INPUT());
        drive(gen, h);

        expect(h.turns.length).toBeGreaterThanOrEqual(3);

        // Attempt 1: the original prompt at index 0, refused.
        expect(h.turns[0].prompt).toBe("PROBE-TWO run the report");
        expect(h.turns[0].turnIndex).toBe(0);

        // Attempt 2: the WAKE turn re-uses index 0 — a refused turn never
        // existed as far as resumable state is concerned — and carries the
        // stashed prompt for the activity to replay. The nudge's [SYSTEM:]
        // body is extracted into system context, so the turn arrives on the
        // substituted internal prompt with no new user words.
        const { INTERNAL_SYSTEM_TURN_PROMPT } = await import("../../src/orchestration/state.ts");
        expect(h.turns[1].prompt).toBe(INTERNAL_SYSTEM_TURN_PROMPT);
        expect(h.turns[1].turnIndex).toBe(0);
        expect(h.turns[1].opts.stashedPrompts).toEqual(["PROBE-TWO run the report"]);

        // Attempt 3: the turn RAN, so the stash is spent — nothing replays twice.
        expect(h.turns[2].turnIndex).toBe(1);
        expect(h.turns[2].opts.stashedPrompts).toBeUndefined();

        // Exactly one durable record of the prompt, from stash time.
        const um = userMessages(h).filter((e) => e.data.content.includes("PROBE-TWO"));
        expect(um).toHaveLength(1);
    });

    it("a message queued WHILE blocked is stashed too, and repeat refusals never duplicate", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [
                gateRefusal(),   // first prompt refused
                gateRefusal(),   // queued message also refused — still blocked
            ],
            queue: [
                JSON.stringify({ prompt: "PROBE-FIRST", clientMessageIds: ["cm-f"] }),
                { afterTurns: 1, msg: JSON.stringify({ prompt: "PROBE-QUEUED while blocked", clientMessageIds: ["cm-q"] }) },
            ],
        });
        const gen = handler(h.ctx, INPUT());
        const outcome = drive(gen, h);
        expect(outcome.kind).toBe("parked");

        // Both prompts recorded once each, both marked queued.
        const um = userMessages(h);
        expect(um.map((e) => e.data.content)).toEqual([
            "PROBE-FIRST",
            "PROBE-QUEUED while blocked",
        ]);
        expect(um.every((e) => e.data.budgetQueued === true)).toBe(true);

        // The second attempt carried the first prompt as stash and STILL did
        // not advance the index: two refusals, zero turns burned.
        expect(h.turns[1].opts.stashedPrompts).toEqual(["PROBE-FIRST"]);
        expect(h.turns[0].turnIndex).toBe(0);
        expect(h.turns[1].turnIndex).toBe(0);

        // The interrupting message hit an ARMED budget wait — exactly the
        // shape that used to fabricate "I'm here. Resuming the timer." as an
        // assistant reply to a message that was not in the transcript. A
        // refused turn never reached the model; nothing may speak for it.
        expect(syntheticReplies(h)).toHaveLength(0);
    });

    it("an ORDINARY wait interrupt keeps the old contract: index advances, no stash, synthetic reply stands in", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [
                { type: "wait", seconds: 300, reason: "agent asked to nap" }, // real turn, wants a nap
                { type: "wait", seconds: 300, reason: "agent asked to nap" }, // interrupted, model said nothing
            ],
            queue: [
                JSON.stringify({ prompt: "start the long job" }),
                { afterTurns: 1, msg: JSON.stringify({ prompt: "are you there?", clientMessageIds: ["cm-3"] }) },
            ],
        });
        const gen = handler(h.ctx, INPUT());
        const outcome = drive(gen, h);
        expect(outcome.kind).toBe("parked");

        // The nap turn RAN: its index is consumed, the interrupting turn is 1.
        expect(h.turns[0].turnIndex).toBe(0);
        expect(h.turns[1].turnIndex).toBe(1);
        // No budget refusal, so nothing was stashed…
        expect(h.turns[1].opts.stashedPrompts).toBeUndefined();
        expect(userMessages(h).filter((e) => e.data.budgetQueued)).toHaveLength(0);
        // …and the empty interrupted reply is still papered over, as before.
        expect(syntheticReplies(h)).toHaveLength(1);
        expect(syntheticReplies(h)[0].data.reason).toBe("wait_interrupt_empty_reply");
    });

    it("continue-as-new carries the stash across the epoch boundary", async () => {
        // The handoff input is built by ONE exported function; a blocked
        // session that continues-as-new (history cap, iteration cap, a
        // command) rebuilds its state from exactly this. If the stash is not
        // in it, the boundary is one more way to destroy the prompt.
        const { continueInput } = await import("../../src/orchestration/lifecycle.ts");
        const { createInitialState, deriveOptions } = await import("../../src/orchestration/state.ts");

        const stash = [{ prompt: "PROBE-CAN survive the epoch boundary", clientMessageIds: ["cm-4"] }];
        const state = createInitialState(INPUT(), deriveOptions(INPUT()));
        state.budgetStash = stash;
        const runtime = {
            ctx: { traceInfo: () => {} },
            input: INPUT(),
            options: {},
            state,
            versions: { currentVersion: "test", latestVersion: "test" },
        };
        const handoff = continueInput(runtime);
        expect(handoff.budgetStash).toEqual(stash);

        // And the rebuilt state on the far side picks it up again.
        const reborn = createInitialState(handoff, deriveOptions(handoff));
        expect(reborn.budgetStash).toEqual(stash);

        // An EMPTY stash is dropped from the wire, not carried as [].
        state.budgetStash = [];
        expect(continueInput(runtime).budgetStash).toBeUndefined();
    });

    it("the wake nudge is internal traffic: [SYSTEM:-prefixed and never stashed as a user prompt", async () => {
        const { PROVIDER_BUDGET_WAKE_PROMPT } = await import("../../src/provider-budgets.ts");
        // The prefix is what isInternalSystemPrompt keys on. Without it the
        // wake painted "Internal wake-up: …" into transcripts as words the
        // USER said — live-observed the first day the wake actually fired.
        expect(PROVIDER_BUDGET_WAKE_PROMPT).toMatch(WAKE_PROMPT_RE);

        const handler = await latestHandler();
        const h = createHarness({
            // Still blocked when the wake lands: refused, refused again.
            turnResults: [gateRefusal(), gateRefusal()],
            queue: [
                JSON.stringify({ prompt: "PROBE-SIX", clientMessageIds: ["cm-6"] }),
                { afterTurns: 1, msg: JSON.stringify({ prompt: PROVIDER_BUDGET_WAKE_PROMPT }) },
            ],
        });
        const gen = handler(h.ctx, INPUT());
        drive(gen, h);

        // The nudge itself must never enter the stash or the transcript as a
        // user message — only PROBE-SIX is anybody's words.
        const um = userMessages(h);
        expect(um.map((e) => e.data.content)).toEqual(["PROBE-SIX"]);
        expect(h.turns[1].opts.stashedPrompts).toEqual(["PROBE-SIX"]);
    });
});
