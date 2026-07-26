/**
 * Transcript selection — isolated tests.
 *
 * The module is pure, so these need no database, no session, and no network:
 * synthetic transcripts in, selection out. The final case is an LLM JUDGE —
 * it asks a model whether the selected subset preserves what a resumed agent
 * would need, which is the property unit assertions cannot express. It runs
 * with the suite — test/local is LLM-backed by design, so an eval that only
 * runs behind a flag is an eval that never runs.
 */
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    exchangeClusteredStrategy,
    listSelectionStrategies,
    resolveSelectionStrategy,
    scoreByExchangeProximity,
    selectTranscript,
} from "../../src/transcript-selection.ts";

const TIMEOUT = 120_000;
const JUDGE_TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

/**
 * Synthetic long-running watch session, shaped like the real thing that
 * motivated this: a handful of owner exchanges buried in a sea of routine
 * cycle chatter, with system noise interleaved.
 */
function buildWatchTranscript({ cycles = 120, exchangesEvery = 20 } = {}) {
    const messages = [];
    let seq = 0;
    const push = (role, text) => { messages.push({ seq: (seq += 1), role, text }); };

    push("user", "Run an eternal sev2 customer incident watch for the 14 tracked customers, 52-minute cadence.");
    push("assistant", "Understood. Standing watch armed: 14 customers, 52-minute cycles, escalate material findings by email.");

    for (let c = 1; c <= cycles; c += 1) {
        push("system", `[SYSTEM: cron wake cycle ${c}]`);
        push("assistant", `Cycle ${c}: dispatched detection worker, refreshed 4 trackers.`);
        push("assistant", `Cycle ${c}: no new qualifying incidents. Cron re-armed.`);
        push("system", `[SYSTEM: tool result cycle ${c}]`);

        if (c % exchangesEvery === 0) {
            push("user", `Cycle ${c}: also start tracking PGBouncer utilization and tell me if it drops below band.`);
            push("assistant", `Added PGBouncer utilization to the watch at cycle ${c}; band is 75-85%.`);
            push("assistant", `Baseline captured at cycle ${c}: 77.68%.`);
        }
    }

    push("user", "Status?");
    push("assistant", "PGBouncer decline CONFIRMED as a 2-cycle trend, 77.68% -> 71.84%. Operator notified.");
    return messages;
}

const renderTranscript = (list) => list.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join("\n");

/**
 * The single judge used by BOTH the positive case and the mutation controls.
 * Shared deliberately: if the negative cases used a different prompt or a
 * different model from the positive one, their passing would say nothing
 * about the judge that actually grades the algorithm.
 *
 * The prompt forbids inference on purpose. A judge allowed to reason "this
 * is clearly an incident watch, so the mission survives" would pass a subset
 * that dropped the mission statement outright.
 */
async function judgeResumability(client, fullMessages, subset) {
    const session = await client.createSession({});
    const verdict = await session.sendAndWait([
        "You are grading a transcript-compression algorithm. Answer with JSON only.",
        "",
        "FULL TRANSCRIPT (ground truth):",
        renderTranscript(fullMessages.filter((m) => m.role !== "system")),
        "",
        "SELECTED SUBSET the algorithm kept:",
        renderTranscript(subset),
        "",
        "Question: if an agent had to resume this work from the SELECTED SUBSET alone,",
        "would it still know (a) its mission, (b) the instructions the user gave it, and",
        "(c) the current state of the work?",
        "",
        "Judge STRICTLY on what is explicitly stated in the SELECTED SUBSET. Do not infer,",
        "guess, or credit the subset for anything you only know from the full transcript.",
        "If a fact is absent from the subset, the answer for that dimension is false.",
        "",
        "Reply exactly:",
        '{"mission":true|false,"instructions":true|false,"currentState":true|false,"why":"one sentence"}',
    ].join("\n"), JUDGE_TIMEOUT);

    // sendAndWait can resolve undefined (timeout, empty turn). Coerce BEFORE
    // interpolating, or the failure surfaces as a TypeError instead of the
    // assertion that explains what went wrong.
    const text = typeof verdict === "string" ? verdict : (JSON.stringify(verdict) ?? "");
    const match = /\{[\s\S]*?"why"\s*:\s*"[^"]*"\s*\}/.exec(text) || /\{[\s\S]*\}/.exec(text);
    assert(match, `judge returned no JSON: ${text.slice(0, 200)}`);
    let parsed;
    try {
        parsed = JSON.parse(match[0]);
    } catch (err) {
        throw new Error(`judge returned unparseable JSON (${err.message}): ${text.slice(0, 300)}`);
    }
    for (const key of ["mission", "instructions", "currentState"]) {
        assert(typeof parsed[key] === "boolean", `judge returned non-boolean ${key}: ${text.slice(0, 200)}`);
    }
    return parsed;
}

describe("transcript selection", () => {
    it("drops system messages and keeps every user message", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript();
        const userTotal = messages.filter((m) => m.role === "user").length;
        const result = selectTranscript(messages, { budget: 100 });

        assertEqual(result.selected.filter((m) => m.role === "system").length, 0, "no system messages survive");
        assert(result.stats.systemDropped > 0, "system messages were present to drop");
        assertEqual(result.stats.userKept, userTotal, "every user message is retained");
        assert(result.selected.length <= 100, "budget respected");
    });

    it("keeps the assistant replies that answer user messages", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript();
        const result = selectTranscript(messages, { budget: 120 });
        const keptSeqs = new Set(result.selected.map((m) => m.seq));

        // For each user message, the immediately following assistant turn is
        // the answer — the single most valuable non-user message there is.
        const userSeqs = messages.filter((m) => m.role === "user").map((m) => m.seq);
        let answersKept = 0;
        for (const s of userSeqs) {
            const reply = messages.find((m) => m.seq > s && m.role === "assistant");
            if (reply && keptSeqs.has(reply.seq)) answersKept += 1;
        }
        assertEqual(answersKept, userSeqs.length, "every user message's reply is kept");
    });

    it("retains all exchange content and enriches it against filler", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript();
        const isExchange = (m) => /PGBouncer|watch armed|CONFIRMED|Status\?/.test(m.text);
        const isRoutine = (m) => /no new qualifying incidents/.test(m.text);

        const eligible = messages.filter((m) => m.role !== "system");
        const exchangeTotal = eligible.filter(isExchange).length;
        const routineTotal = eligible.filter(isRoutine).length;

        const result = selectTranscript(messages, { budget: 80 });
        const exchangeKept = result.selected.filter(isExchange).length;
        const routineKept = result.selected.filter(isRoutine).length;

        // The property that matters: exchange content survives in full.
        assertEqual(exchangeKept, exchangeTotal, "every exchange message is retained");
        // Filler may still fill leftover budget — but at a far lower rate,
        // which is the actual enrichment the strategy provides.
        const exchangeRate = exchangeKept / exchangeTotal;
        const routineRate = routineKept / routineTotal;
        assert(
            exchangeRate > routineRate * 3,
            `exchange retention ${(exchangeRate * 100).toFixed(0)}% should far exceed routine ${(routineRate * 100).toFixed(0)}%`,
        );
    });

    it("covers both ends of the transcript", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript();
        const result = selectTranscript(messages, { budget: 60 });
        const eligible = messages.filter((m) => m.role !== "system");
        const firstSeq = eligible[0].seq;
        const lastSeq = eligible[eligible.length - 1].seq;
        assertEqual(result.selected[0].seq, firstSeq, "opening message kept (mission)");
        assertEqual(result.selected[result.selected.length - 1].seq, lastSeq, "final message kept (current state)");
        assert(result.stats.headSelected > 0 && result.stats.tailSelected > 0, "both halves contribute");
    });

    it("returns everything when the transcript fits the budget", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript({ cycles: 3, exchangesEvery: 2 });
        const eligible = messages.filter((m) => m.role !== "system");
        const result = selectTranscript(messages, { budget: 1000 });
        assertEqual(result.selected.length, eligible.length, "no sampling when it all fits");
        assertEqual(result.elisions.length, 0, "and therefore no gaps");
        assertEqual(result.stats.droppedCount, 0);
    });

    it("reports elisions so the reader never infers continuity", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript();
        const result = selectTranscript(messages, { budget: 40 });
        assert(result.elisions.length > 0, "gaps are reported");
        const elided = result.elisions.reduce((sum, e) => sum + e.count, 0);
        assertEqual(
            result.stats.selectedCount + elided,
            result.stats.eligible,
            "selected + elided accounts for every eligible message",
        );
        for (const e of result.elisions) {
            assert(e.span[0] <= e.span[1], "elision span is ordered");
            assert(e.count > 0, "elision is non-empty");
        }
    });

    it("is chronological and deterministic across runs", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript();
        const a = selectTranscript(messages, { budget: 77 });
        const b = selectTranscript(messages.slice().reverse(), { budget: 77 });

        const seqsA = a.selected.map((m) => m.seq);
        const seqsB = b.selected.map((m) => m.seq);
        assertEqual(JSON.stringify(seqsA), JSON.stringify(seqsB), "input order does not change the result");
        for (let i = 1; i < seqsA.length; i += 1) {
            assert(seqsA[i] > seqsA[i - 1], "output is strictly chronological");
        }
    });

    it("degrades sensibly with no user messages at all", { timeout: TIMEOUT }, () => {
        const messages = [];
        for (let i = 1; i <= 500; i += 1) {
            messages.push({ seq: i, role: "assistant", text: `autonomous step ${i}` });
        }
        const result = selectTranscript(messages, { budget: 50 });
        assertEqual(result.selected.length, 50, "still fills the budget");
        assertEqual(result.selected[0].seq, 1, "keeps the beginning");
        assertEqual(result.selected[result.selected.length - 1].seq, 500, "keeps the end");
    });

    it("scores user messages above their replies, and replies above filler", { timeout: TIMEOUT }, () => {
        const msgs = [
            { seq: 1, role: "assistant", text: "routine" },
            { seq: 2, role: "assistant", text: "routine" },
            { seq: 3, role: "assistant", text: "routine" },
            { seq: 4, role: "assistant", text: "routine" },
            { seq: 5, role: "assistant", text: "routine" },
            { seq: 6, role: "assistant", text: "routine" },
            { seq: 7, role: "assistant", text: "routine" },
            { seq: 8, role: "user", text: "question" },
            { seq: 9, role: "assistant", text: "answer" },
            { seq: 10, role: "assistant", text: "follow-up" },
        ];
        const scores = scoreByExchangeProximity(msgs, 6);
        assertEqual(scores[7], Number.POSITIVE_INFINITY, "user message is always kept");
        assert(scores[8] > scores[9], "the direct answer outranks the follow-up");
        assert(scores[8] > scores[0], "the answer outranks distant filler");
        assert(scores[6] > scores[0], "a lead-in near the question outranks distant filler");
        assert(scores[8] > scores[6], "the reply outranks the lead-in at equal distance");
    });

    it("exposes a registry so a strategy can be swapped", { timeout: TIMEOUT }, () => {
        assertEqual(resolveSelectionStrategy().name, "exchange-clustered", "default strategy");
        assertEqual(resolveSelectionStrategy("nope").name, "exchange-clustered", "unknown name falls back");
        assert(listSelectionStrategies().length >= 1);
        assert(typeof exchangeClusteredStrategy.describe() === "string");
    });

    /**
     * REGRESSION — the newest messages must survive a user-dense transcript.
     *
     * User messages score +Infinity, and the tail comparator subtracted
     * scores: Infinity - Infinity is NaN, a NaN comparator result is coerced
     * to "equal", and the stable sort then preserved ascending order. So
     * `prefer: "latest"` silently degraded to "earliest" whenever the tail
     * half held more user messages than the tail budget, and the selection
     * dropped the END of the conversation — the current state, the single
     * thing a resumed session most needs.
     *
     * The suite missed it because buildWatchTranscript() has only 8 user
     * messages, so the budget-contention branch was never reached. This
     * fixture reaches it.
     */
    it("keeps the newest messages when users exceed the budget", { timeout: TIMEOUT }, () => {
        const messages = [];
        for (let i = 1; i <= 400; i += 1) {
            messages.push({ seq: i, role: i % 2 === 1 ? "user" : "assistant", text: `m${i}` });
        }
        const result = selectTranscript(messages, { budget: 40 });
        const seqs = result.selected.map((m) => m.seq);

        // Exact, not >=: the last message is a reserved anchor, so the newest
        // turn is kept even though 200 user messages compete for the budget.
        assertEqual(seqs[seqs.length - 1], 400, "the newest message is always kept");
        assertEqual(seqs[0], 1, "and the head must still start at the beginning");

        // All-user transcript: unambiguous — the last message IS the newest user turn.
        const allUsers = [];
        for (let i = 1; i <= 100; i += 1) allUsers.push({ seq: i, role: "user", text: `u${i}` });
        const flat = selectTranscript(allUsers, { budget: 10 }).selected.map((m) => m.seq);
        assertEqual(flat[flat.length - 1], 100, "the newest user message is never dropped");
        assertEqual(flat[0], 1, "nor the oldest");
    });

    it("reports elisions that are disjoint, increasing, and correctly anchored", { timeout: TIMEOUT }, () => {
        const messages = buildWatchTranscript();
        const result = selectTranscript(messages, { budget: 40 });
        const keptSeqs = result.selected.map((m) => m.seq);

        let prevEnd = -Infinity;
        for (const e of result.elisions) {
            assert(e.span[0] > prevEnd, "elision spans are disjoint and increasing");
            prevEnd = e.span[1];
            // Nothing inside an elided span may also appear as selected.
            for (const s of keptSeqs) {
                assert(!(s >= e.span[0] && s <= e.span[1]), `seq ${s} is both kept and elided`);
            }
            if (e.afterSeq === null) {
                assert(e.span[1] < keptSeqs[0], "a null anchor means the gap precedes everything kept");
            } else {
                assert(keptSeqs.includes(e.afterSeq), "afterSeq names a message that was actually kept");
                assert(e.span[0] > e.afterSeq, "the gap follows its anchor");
            }
        }
    });

    it("beats a naive tail cap on the property that matters", { timeout: TIMEOUT }, () => {
        // The behavior this replaced: keep the last N messages. It loses the
        // mission entirely, which is the whole reason for head/tail splitting.
        const messages = buildWatchTranscript();
        const eligible = messages.filter((m) => m.role !== "system");
        const budget = 60;

        const naiveTail = eligible.slice(-budget);
        const selected = selectTranscript(messages, { budget }).selected;

        const missionSeq = eligible[0].seq;
        assert(!naiveTail.some((m) => m.seq === missionSeq), "baseline: the naive tail loses the mission");
        assert(selected.some((m) => m.seq === missionSeq), "the strategy keeps it");

        const userTotal = eligible.filter((m) => m.role === "user").length;
        assert(
            selected.filter((m) => m.role === "user").length > naiveTail.filter((m) => m.role === "user").length,
            "and retains strictly more user turns than the baseline",
        );
        assertEqual(selected.filter((m) => m.role === "user").length, userTotal, "in fact all of them");
    });

    it("keeps user messages that sit in the crowded half", { timeout: TIMEOUT }, () => {
        // The failure the tiered reservation fixes: splitting the budget by
        // POSITION first meant a +Infinity user message in a user-dense half
        // lost to a zero-score filler message in a quiet half. This is the
        // shape the module targets — a chatty setup, then a long autonomous
        // run — so it was not a corner case.
        const messages = [];
        for (let i = 1; i <= 600; i += 1) messages.push({ seq: i, role: "user", text: `u${i}` });
        for (let i = 601; i <= 1200; i += 1) messages.push({ seq: i, role: "assistant", text: "cron cycle, no signal" });

        const result = selectTranscript(messages, { budget: 1000 });
        assertEqual(result.stats.userKept, 600, "every user message survives when the budget allows");
        assertEqual(result.stats.selectedCount, 1000, "and the budget is still filled exactly");
    });

    it("splits the budget by headFraction and redistributes slack", { timeout: TIMEOUT }, () => {
        // headFraction gates the only non-trivial branch in the strategy and
        // was previously never set by any test.
        const messages = [];
        for (let i = 1; i <= 400; i += 1) messages.push({ seq: i, role: "assistant", text: `a${i}` });

        // 89/11 rather than 90/10: the first and last messages are reserved
        // anchors, so one slot at each end is spent before the fraction applies.
        const headHeavy = selectTranscript(messages, { budget: 100, headFraction: 0.9 });
        assertEqual(headHeavy.stats.headSelected, 89, "the head half takes ~90% of the budget");
        assertEqual(headHeavy.stats.tailSelected, 11, "and the remainder goes to the tail");

        const tailHeavy = selectTranscript(messages, { budget: 100, headFraction: 0.1 });
        assertEqual(tailHeavy.stats.headSelected, 11, "the split follows the fraction both ways");
        assertEqual(tailHeavy.stats.tailSelected, 89);

        // Slack: when a half is too SMALL to spend its budget, the remainder
        // must flow to the other half rather than under-filling the budget.
        // The halves are positional, so this needs a transcript barely larger
        // than the budget — 55 per half against a 90-message head budget.
        const tight = [];
        for (let i = 1; i <= 110; i += 1) tight.push({ seq: i, role: "assistant", text: `a${i}` });
        const slack = selectTranscript(tight, { budget: 100, headFraction: 0.9 });
        assertEqual(slack.stats.headSelected, 55, "the head half is capped by its own size");
        assertEqual(slack.stats.selectedCount, 100, "and its unused budget flows to the tail");
        assertEqual(slack.stats.tailSelected, 45, "which over-fills relative to its 10% share");
    });

    it("reports head/tail stats by position, including when it all fits", { timeout: TIMEOUT }, () => {
        // These land on the regen record and are read by operators, so
        // "tailSelected: 0" must not appear when no split happened at all.
        const messages = buildWatchTranscript({ cycles: 3, exchangesEvery: 2 });
        const result = selectTranscript(messages, { budget: 1000 });
        assert(result.stats.tailSelected > 0, "the tail half is reported honestly on the fits-entirely path");
        assertEqual(
            result.stats.headSelected + result.stats.tailSelected,
            result.stats.selectedCount,
            "the halves account for the whole selection",
        );
    });

    it("handles degenerate inputs without throwing", { timeout: TIMEOUT }, () => {
        assertEqual(selectTranscript([], { budget: 10 }).selected.length, 0, "empty transcript");
        assertEqual(selectTranscript([], { budget: 10 }).elisions.length, 0, "and no phantom gaps");

        const onlySystem = [{ seq: 1, role: "system", text: "boot" }, { seq: 2, role: "system", text: "cron" }];
        assertEqual(selectTranscript(onlySystem, { budget: 10 }).selected.length, 0, "all-system transcript");

        const some = [{ seq: 1, role: "user", text: "a" }, { seq: 2, role: "assistant", text: "b" }];
        assertEqual(selectTranscript(some, { budget: 0 }).selected.length, 0, "zero budget selects nothing");
        assertEqual(selectTranscript(some, { budget: 1 }).selected.length, 1, "budget of one still works");
    });

    it("stays correct when seqs collide", { timeout: TIMEOUT }, () => {
        // CMS seq is a monotonic per-session counter, so duplicates cannot
        // arise in production — and the contract on SelectableMessage.seq is
        // explicit that ties break on ARRAY POSITION. So the result is
        // deliberately order-dependent here, and asserting order-independence
        // would be asserting something the module never promised. What must
        // still hold is that the invariants survive duplicate keys.
        const messages = [];
        for (let i = 1; i <= 200; i += 1) {
            messages.push({ seq: Math.ceil(i / 2), role: i % 2 === 0 ? "user" : "assistant", text: `m${i}` });
        }
        const result = selectTranscript(messages, { budget: 30 });
        assertEqual(result.selected.length, 30, "budget is filled exactly");
        for (let i = 1; i < result.selected.length; i += 1) {
            assert(result.selected[i].seq >= result.selected[i - 1].seq, "output is non-decreasing");
        }
        const elided = result.elisions.reduce((n, e) => n + e.count, 0);
        assertEqual(result.stats.selectedCount + elided, result.stats.eligible, "every message is accounted for");
    });

    /**
     * PROPERTY FUZZ — the invariants, over randomized transcripts.
     *
     * The cases above pin specific known failures. This one defends the
     * invariants as a class, on shapes nobody thought to write down. Seeded
     * deliberately: Math.random() would make a failure unreproducible, and an
     * unreproducible failure in CI is a flake nobody can act on.
     */
    it("holds every invariant across 500 randomized transcripts", { timeout: TIMEOUT }, () => {
        let seed = 12345;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        let checked = 0;

        for (let t = 0; t < 500; t += 1) {
            const n = 2 + Math.floor(rnd() * 800);
            const messages = [];
            for (let i = 1; i <= n; i += 1) {
                const p = rnd();
                messages.push({ seq: i, role: p < 0.35 ? "user" : p < 0.9 ? "assistant" : "system", text: `m${i}` });
            }
            const budget = 1 + Math.floor(rnd() * n);
            const eligible = messages.filter((m) => m.role !== "system");
            if (eligible.length === 0) continue;
            checked += 1;

            const r = selectTranscript(messages, { budget });
            const where = `n=${n} budget=${budget} eligible=${eligible.length}`;

            assertEqual(r.selected.length, Math.min(budget, eligible.length), `exact budget fill (${where})`);
            for (let i = 1; i < r.selected.length; i += 1) {
                assert(r.selected[i].seq > r.selected[i - 1].seq, `chronological (${where})`);
            }
            assertEqual(r.selected[0].seq, eligible[0].seq, `first anchor kept (${where})`);
            assertEqual(r.selected[r.selected.length - 1].seq, eligible[eligible.length - 1].seq, `last anchor kept (${where})`);
            assertEqual(r.selected.filter((m) => m.role === "system").length, 0, `no system messages (${where})`);

            const userTotal = eligible.filter((m) => m.role === "user").length;
            if (userTotal <= budget) {
                assertEqual(r.stats.userKept, userTotal, `no user message dropped while budget remains (${where})`);
            }
            const elided = r.elisions.reduce((sum, e) => sum + e.count, 0);
            assertEqual(r.stats.selectedCount + elided, r.stats.eligible, `full accounting (${where})`);

            // Determinism: input order must not change the result.
            const again = selectTranscript(messages.slice().reverse(), { budget });
            assertEqual(
                JSON.stringify(again.selected.map((m) => m.seq)),
                JSON.stringify(r.selected.map((m) => m.seq)),
                `order-independent (${where})`,
            );
        }
        assert(checked > 450, `fuzz actually ran (${checked} transcripts)`);
    });

    /**
     * LLM JUDGE. Unit assertions can prove structure (no system messages,
     * every user turn kept, chronological). They cannot answer the question
     * that actually matters: could an agent resume from this subset? So we
     * ask a model to compare the selection against the full transcript.
     *
     * See the mutation suite below — a judge that passes everything proves
     * nothing, so the same judge is required to REJECT broken selections.
     */
    it("selection preserves resumability (LLM judge)", { timeout: JUDGE_TIMEOUT }, async () => {
        const messages = buildWatchTranscript();
        const result = selectTranscript(messages, { budget: 60 });

        await withClient(getEnv(), async (client) => {
            const verdict = await judgeResumability(client, messages, result.selected);
            assert(verdict.mission === true, `judge: mission not preserved — ${verdict.why}`);
            assert(verdict.instructions === true, `judge: instructions not preserved — ${verdict.why}`);
            assert(verdict.currentState === true, `judge: current state not preserved — ${verdict.why}`);
        });
    });
});

/**
 * MUTATION TESTING — proving the judge can fail.
 *
 * The positive judge case above is only as meaningful as the judge's ability
 * to say no. A model that answers `true` to everything would pass it while
 * detecting nothing. So each case here deliberately breaks the selection in
 * one specific way and requires the SAME judge — same helper, same prompt,
 * same model — to flag the specific dimension that mutation destroys.
 *
 * The mutants are the realistic failure modes, not arbitrary corruption:
 *
 *   M1 head-only     — the tail preference fails entirely; current state is
 *                      lost. (Not the NaN-comparator bug, which produced head
 *                      + OLDEST-of-tail-half. On this fixture that bug was
 *                      invisible — the deterministic test at "keeps the newest
 *                      messages" is what pins it, not the judge.)
 *   M2 tail-only     — head/tail splitting collapses to a naive tail cap;
 *                      the mission scrolls out. The pre-existing behavior.
 *   M3 salience flip — a sign inversion in the comparator keeps precisely
 *                      the routine filler the strategy exists to discard.
 */
describe("transcript selection — mutation controls (LLM judge must reject)", () => {
    /** M1: keep the oldest `budget` messages. Loses everything recent. */
    function mutantHeadOnly(eligible, budget) {
        return eligible.slice(0, budget);
    }

    /** M2: keep the newest `budget` messages. Loses the mission. */
    function mutantTailOnly(eligible, budget) {
        return eligible.slice(-budget);
    }

    /** M3: the real scorer with the comparison inverted — filler wins. */
    function mutantInvertedSalience(eligible, budget) {
        const scores = scoreByExchangeProximity(eligible, 6);
        return eligible
            .map((m, i) => ({ m, i, score: scores[i] }))
            .sort((a, b) => (a.score === b.score ? a.i - b.i : a.score - b.score)) // ASCENDING = worst first
            .slice(0, budget)
            .sort((a, b) => a.i - b.i)
            .map((x) => x.m);
    }

    const BUDGET = 60;

    it("rejects a head-only selection (current state destroyed)", { timeout: JUDGE_TIMEOUT }, async () => {
        const messages = buildWatchTranscript();
        const eligible = messages.filter((m) => m.role !== "system");
        const subset = mutantHeadOnly(eligible, BUDGET);

        // Sanity: the mutation really did remove the ending.
        assert(subset[subset.length - 1].seq < eligible[eligible.length - 1].seq, "mutant must drop the tail");

        await withClient(getEnv(), async (client) => {
            const verdict = await judgeResumability(client, messages, subset);
            assert(
                verdict.currentState === false,
                `judge FAILED to notice the missing current state — it answered currentState:true (${verdict.why})`,
            );
        });
    });

    it("rejects a tail-only selection (mission destroyed)", { timeout: JUDGE_TIMEOUT }, async () => {
        const messages = buildWatchTranscript();
        const eligible = messages.filter((m) => m.role !== "system");
        const subset = mutantTailOnly(eligible, BUDGET);

        assert(subset[0].seq > eligible[0].seq, "mutant must drop the opening mission");
        assert(!subset.some((m) => /eternal sev2/.test(m.text)), "the mission statement is genuinely absent");

        await withClient(getEnv(), async (client) => {
            const verdict = await judgeResumability(client, messages, subset);
            assert(
                verdict.mission === false,
                `judge FAILED to notice the missing mission — it answered mission:true (${verdict.why})`,
            );
        });
    });

    it("rejects an inverted-salience selection (filler only)", { timeout: JUDGE_TIMEOUT }, async () => {
        const messages = buildWatchTranscript();
        const eligible = messages.filter((m) => m.role !== "system");
        const subset = mutantInvertedSalience(eligible, BUDGET);

        // Inverting the comparator must starve the selection of user turns.
        assertEqual(subset.filter((m) => m.role === "user").length, 0, "mutant keeps no user messages at all");

        await withClient(getEnv(), async (client) => {
            const verdict = await judgeResumability(client, messages, subset);
            assert(
                verdict.mission === false || verdict.instructions === false,
                `judge FAILED to notice a filler-only selection — it answered mission:${verdict.mission} `
                + `instructions:${verdict.instructions} (${verdict.why})`,
            );
        });
    });
});

/**
 * Archive chunking — the failure that motivated all of this. A 1.8 MB
 * archive threw ARTIFACT_TOO_LARGE against the 1 MiB text-artifact cap and
 * aborted regeneration at the `requested` stage, before the distiller and
 * before the deterministic fallback that needs no archive at all.
 */
describe("archive chunking", () => {
    it("splits on line boundaries and keeps every chunk under the cap", { timeout: TIMEOUT }, async () => {
        const { chunkArchiveLines } = await import("../../src/regen-worker.ts");
        const { TEXT_ARTIFACT_MAX_BYTES } = await import("../../src/session-store.ts");
        const budget = Math.floor(TEXT_ARTIFACT_MAX_BYTES * 0.9);

        // ~1.8 MB of JSONL, mirroring the real archive that failed.
        const lines = [];
        for (let i = 0; i < 1200; i += 1) {
            lines.push(JSON.stringify({ seq: i, type: "assistant.message", data: { content: "x".repeat(1500) } }));
        }
        const total = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
        assert(total > TEXT_ARTIFACT_MAX_BYTES, "fixture must exceed the single-artifact cap");

        const chunks = chunkArchiveLines(lines, budget);
        assert(chunks.length > 1, "an oversized archive is split");
        for (const c of chunks) {
            assert(Buffer.byteLength(c, "utf8") <= budget, "every chunk fits the artifact cap");
        }
        // Lossless: concatenating the chunks reproduces the input exactly.
        const rejoined = chunks.join("").trimEnd().split("\n");
        assertEqual(rejoined.length, lines.length, "no line is lost");
        assertEqual(rejoined[0], lines[0], "first line intact");
        assertEqual(rejoined[rejoined.length - 1], lines[lines.length - 1], "last line intact");
        for (const line of rejoined) JSON.parse(line); // never split mid-record
    });

    it("keeps a small archive as a single chunk", { timeout: TIMEOUT }, async () => {
        const { chunkArchiveLines } = await import("../../src/regen-worker.ts");
        const chunks = chunkArchiveLines(["{\"a\":1}", "{\"b\":2}"], 1_048_576);
        assertEqual(chunks.length, 1, "no needless splitting");
    });

    it("does not drop a single line that exceeds the cap on its own", { timeout: TIMEOUT }, async () => {
        const { chunkArchiveLines } = await import("../../src/regen-worker.ts");
        const huge = JSON.stringify({ data: "y".repeat(2_000_000) });
        const chunks = chunkArchiveLines(["{\"small\":1}", huge], 1_048_576);
        const rejoined = chunks.join("").trimEnd().split("\n");
        assertEqual(rejoined.length, 2, "the oversized record survives as its own chunk");
        assertEqual(rejoined[1], huge, "and is not truncated — the store rejects it loudly instead");
    });

    it("rejoins to the input exactly, line for line", { timeout: TIMEOUT }, async () => {
        // The looser test above checks first/last/count. This checks EVERY
        // line, which is what "lossless" actually means.
        const { chunkArchiveLines } = await import("../../src/regen-worker.ts");
        const lines = [];
        for (let i = 0; i < 500; i += 1) {
            lines.push(JSON.stringify({ seq: i, type: "assistant.message", data: { content: `c${i}`.repeat(40) } }));
        }
        const rejoined = chunkArchiveLines(lines, 4_096).join("").trimEnd().split("\n");
        assertEqual(rejoined.length, lines.length, "line count preserved");
        for (let i = 0; i < lines.length; i += 1) {
            assertEqual(rejoined[i], lines[i], `line ${i} survives byte-for-byte`);
        }
    });

    it("measures multi-byte text in bytes, not characters", { timeout: TIMEOUT }, async () => {
        // A char-length cap would overflow the artifact store on CJK/emoji.
        const { chunkArchiveLines } = await import("../../src/regen-worker.ts");
        const cap = 1_000;
        const lines = [];
        for (let i = 0; i < 40; i += 1) lines.push(JSON.stringify({ t: "日本語テキスト🌏".repeat(10) }));
        const chunks = chunkArchiveLines(lines, cap);
        for (const c of chunks) {
            assert(Buffer.byteLength(c, "utf8") <= cap, "byte cap honored for multi-byte content");
        }
        assertEqual(chunks.join("").trimEnd().split("\n").length, lines.length, "and nothing is lost");
    });

    it("always yields at least one chunk for an empty transcript", { timeout: TIMEOUT }, async () => {
        // Zero chunks meant runRegenArchive returned an archiveArtifactId for
        // an artifact it never uploaded, and the distiller's first read 404'd.
        const { chunkArchiveLines } = await import("../../src/regen-worker.ts");
        const chunks = chunkArchiveLines([], 1_048_576);
        assertEqual(chunks.length, 1, "an empty archive is still a real artifact");
        assertEqual(chunks[0], "", "and it is empty rather than absent");
    });
});

/**
 * runRegenArchive END-TO-END, against a real artifact store.
 *
 * The chunking unit tests prove chunkArchiveLines is lossless, but nothing
 * exercised the activity itself — and the step most likely to fail was the
 * one no unit test can reach: whether the store ACCEPTS a zero-byte upload.
 * If it rejected it, the empty-transcript fix would be worse than the bug it
 * replaced, because regen would fail at the archive stage every time.
 */
describe("runRegenArchive (real artifact store)", () => {
    const stubCatalog = (rows) => ({
        getSessionEventsBefore: async () => rows,
        getSessionCompactionStats: async () => ({ starts: 0, completes: 0 }),
    });

    async function runArchive(rows) {
        const os = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs");
        const { runRegenArchive } = await import("../../src/regen-worker.ts");
        const { FilesystemArtifactStore } = await import("../../src/session-store.ts");

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-archive-"));
        const artifactStore = new FilesystemArtifactStore(dir);
        const result = await runRegenArchive(
            { catalog: stubCatalog(rows), artifactStore },
            { sessionId: "s1", epoch: 0, attemptId: "a1" },
        );
        return { result, artifactStore };
    }

    it("writes a real, readable artifact for an EMPTY transcript", { timeout: TIMEOUT }, async () => {
        const { result, artifactStore } = await runArchive([]);

        assertEqual(result.archiveChunkIds.length, 1, "one chunk, not zero");
        assertEqual(result.archiveArtifactId, result.archiveChunkIds[0], "the id names the chunk that exists");

        // The claim that matters: the artifact was actually uploaded, and a
        // zero-byte body is accepted rather than rejected by the store.
        const listed = await artifactStore.listArtifacts("s1");
        assertEqual(listed.length, 1, "the archive artifact exists on the store");
        assertEqual(listed[0].filename, result.archiveArtifactId, "under the id the caller was handed");
        const body = await artifactStore.downloadArtifact("s1", result.archiveArtifactId);
        assertEqual(body.body.length, 0, "and it downloads as an empty archive");
    });

    it("archives a normal transcript and reports selection stats", { timeout: TIMEOUT }, async () => {
        const rows = buildWatchTranscript({ cycles: 8, exchangesEvery: 4 }).map((m) => ({
            seq: m.seq,
            eventType: m.role === "user" ? "user.message"
                : m.role === "assistant" ? "assistant.message" : "session.compaction",
            data: { content: m.text },
            createdAt: new Date(0),
        }));
        const { result, artifactStore } = await runArchive(rows);

        const body = await artifactStore.downloadArtifact("s1", result.archiveArtifactId);
        const lines = body.body.toString("utf8").split("\n").filter((l) => l.trim());
        assertEqual(lines.length, result.selectionStats.selectedCount, "every selected message is written");
        assertEqual(result.selectionStrategy, "exchange-clustered", "strategy is reported");

        // The written shape is what the distiller's pager reads back.
        const first = JSON.parse(lines[0]);
        assert(typeof first.type === "string", "records carry `type`");
        assertEqual(first.type, "user.message", "and the transcript opens with the mission");
        assertEqual(
            lines.filter((l) => JSON.parse(l).type === "session.compaction").length,
            0,
            "system events are excluded from the archive",
        );
    });
});
