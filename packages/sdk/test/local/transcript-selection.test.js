/**
 * Transcript selection — isolated tests.
 *
 * The module is pure, so these need no database, no session, and no network:
 * synthetic transcripts in, selection out. The final case is an LLM JUDGE —
 * it asks a model whether the selected subset preserves what a resumed agent
 * would need, which is the property unit assertions cannot express. It skips
 * automatically when no model credentials are configured.
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
     * LLM JUDGE. Unit assertions can prove structure (no system messages,
     * every user turn kept, chronological). They cannot answer the question
     * that actually matters: could an agent resume from this subset? So we
     * ask a model to compare the selection against the full transcript.
     */
    it("selection preserves resumability (LLM judge)", { timeout: JUDGE_TIMEOUT }, async ({ skip }) => {
        if (process.env.PILOTSWARM_SELECTION_JUDGE !== "1") {
            skip("set PILOTSWARM_SELECTION_JUDGE=1 to run the LLM judge");
            return;
        }
        const messages = buildWatchTranscript();
        const result = selectTranscript(messages, { budget: 60 });
        const render = (list) => list.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join("\n");

        await withClient(getEnv(), async (client) => {
            const session = await client.createSession({});
            const verdict = await session.sendAndWait([
                "You are grading a transcript-compression algorithm. Answer with JSON only.",
                "",
                "FULL TRANSCRIPT (ground truth):",
                render(messages.filter((m) => m.role !== "system")),
                "",
                "SELECTED SUBSET the algorithm kept:",
                render(result.selected),
                "",
                "Question: if an agent had to resume this work from the SELECTED SUBSET alone,",
                "would it still know (a) its mission, (b) the instructions the user gave it, and",
                "(c) the current state of the work? Reply exactly:",
                '{"mission":true|false,"instructions":true|false,"currentState":true|false,"why":"one sentence"}',
            ].join("\n"), JUDGE_TIMEOUT);

            const text = typeof verdict === "string" ? verdict : JSON.stringify(verdict);
            const match = /\{[\s\S]*\}/.exec(text);
            assert(match, `judge returned no JSON: ${text.slice(0, 200)}`);
            const parsed = JSON.parse(match[0]);
            assert(parsed.mission === true, `judge: mission not preserved — ${parsed.why}`);
            assert(parsed.instructions === true, `judge: instructions not preserved — ${parsed.why}`);
            assert(parsed.currentState === true, `judge: current state not preserved — ${parsed.why}`);
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
});
