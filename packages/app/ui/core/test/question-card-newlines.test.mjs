import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel, selectActiveChat, selectChatLines } from "../src/index.js";
import { normalizeQuestionForDisplay } from "../src/question-display.js";

const plain = "To start I need two things:\n\n1. Backfill window?\n2. Monitor cadence?\n\nOr ask a specific question.";
const escaped = plain.replaceAll("\n", "\\n");
const choices = ["Default backfill", "Custom window"];
const answer = String.raw`Keep the literal \n in my answer.`;

function stateFor(question, phase = "pending") {
    const session = { sessionId: "q1", status: "input_required", updatedAt: 1000 };
    let history = buildHistoryModel([]);
    if (phase === "pending") session.pendingQuestion = { question, choices, allowFreeform: true };
    if (phase === "optimistic") session.answeredPendingQuestion = { question, answer, answeredAt: 1000 };
    if (phase === "answered") history = buildHistoryModel([{
        seq: 1, sessionId: "q1", eventType: "user.message", createdAt: 1000,
        data: { content: `The user was asked: "${question}"\nThe user responded: "${answer}"` },
    }]);
    return {
        sessions: { activeSessionId: "q1", byId: { q1: session } },
        history: { bySessionId: new Map([["q1", history]]) }, auth: {}, ui: {}, branding: {},
    };
}

// Card keys intentionally retain the original question identity, not display text.
const withoutKeys = lines => lines.map(line => {
    if (line?.kind !== "cardStart") return line;
    const { cardKey, ...display } = line;
    return display;
});

for (const tableMode of [null, "sentinel"]) {
    for (const phase of ["pending", "optimistic", "answered"]) {
        test(`${phase} question renders escaped paragraphs/list items like real newlines (${tableMode || "terminal"})`, () => {
            const actualState = stateFor(escaped, phase);
            const before = structuredClone(actualState);
            assert.deepEqual(withoutKeys(selectChatLines(actualState, 110, { tableMode })),
                withoutKeys(selectChatLines(stateFor(plain, phase), 110, { tableMode })));
            assert.deepEqual(actualState, before, "display must not rewrite the stored question or answer");
        });
    }
}

test("display normalization does not duplicate a question already present in answered history", () => {
    const state = stateFor(escaped, "answered");
    state.sessions.byId.q1.pendingQuestion = { question: escaped, choices };
    assert.equal(selectActiveChat(state).length, 1);
    assert.equal(selectChatLines(state, 110, { tableMode: "sentinel" }).filter(line => line.kind === "cardStart").length, 1);
});

test("normalizes mixed real and escaped LF/CRLF paragraphs before choices are appended", () => {
    assert.equal(normalizeQuestionForDisplay("Intro\nDetails:\\r\\n1. First\\n2. Second\\n\\nDone"),
        "Intro\nDetails:\n1. First\n2. Second\n\nDone");
    const state = stateFor("Choose:");
    state.sessions.byId.q1.pendingQuestion.choices = ["Backfill\\nThen monitor"];
    assert.match(selectActiveChat(state)[0].text, /Backfill\nThen monitor/);
    assert.equal(state.sessions.byId.q1.pendingQuestion.choices[0], "Backfill\\nThen monitor");
});

for (const literal of [
    "Use `\\n` as the delimiter.",
    String.raw`Keep "\n" and '\r\n' literal.`,
    String.raw`Read C:\new\notes.txt and \\network\new\notes.txt.`,
    String.raw`Read "C:\new folder\notes.txt".`,
    String.raw`Keep doubled \\n and other escapes \t \u1234.`,
    "```js\nconst separator = '\\n';\n```",
    "~~~js\nconst separator = '\\n';\n~~~",
]) {
    test(`preserves literal content while decoding surrounding question prose: ${JSON.stringify(literal)}`, () => {
        assert.equal(normalizeQuestionForDisplay(`Question:\\n\\n${literal}\\n\\nProceed?`),
            `Question:\n\n${literal}\n\nProceed?`);
        assert.equal(normalizeQuestionForDisplay(literal), literal);
    });
}
