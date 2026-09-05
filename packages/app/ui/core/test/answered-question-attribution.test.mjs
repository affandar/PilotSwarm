import test from "node:test";
import assert from "node:assert/strict";
import { parseAskedAndAnsweredExchange, buildHistoryModel, appendEventToHistory } from "../src/history.js";
import { appReducer, createInitialState, selectActiveChat, selectChatLines } from "../src/index.js";

const question = '**Review the proposed change.**\n\n| Task | Revision |\n| --- | --- |\n| Example | 5 |\n\nApply "this" change?';
const answer = 'Confirm bulk\nKeep the label "): " intact.';
const wrap = (attribution = "", q = question, a = answer) => `The user was asked: "${q}"\nThe user responded${attribution}: "${a}"`;

for (const attribution of ["", " (answered by Ada Reviewer)", " (answered by Ada (owner))"]) {
    test(`parses the question/answer wrapper ${attribution || "without attribution"}`, () => {
        assert.deepEqual(parseAskedAndAnsweredExchange(wrap(attribution)), { question, answer });
        assert.deepEqual(parseAskedAndAnsweredExchange(wrap(attribution).replaceAll("\n", "\r\n")), { question, answer });
    });
}

test("ordinary prose and incomplete wrappers remain ordinary messages", () => {
    for (const text of ["Confirm bulk", "Example: " + wrap(), wrap().slice(0, -1), wrap("", "", answer), wrap("", question, ""), wrap(" (answered by )")]) {
        assert.equal(parseAskedAndAnsweredExchange(text), null);
    }
});

test("attributed durable answers replace optimistic answers and render the question only once", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{
        sessionId: "s1", title: "Review", status: "running",
        answeredPendingQuestion: { question, answer, answeredAt: 100, pendingPhase: "queued" },
    }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    assert.equal(selectActiveChat(state).filter(m => m.optimistic).length, 1);
    const event = { seq: 1, sessionId: "s1", eventType: "user.message", createdAt: 200,
        data: { content: wrap(" (answered by Ada Reviewer)"), sender: { display: "Ada Reviewer" } } };
    const history = buildHistoryModel([event]);
    state = appReducer(state, { type: "history/set", sessionId: "s1", history });
    assert.equal(selectActiveChat(state).length, 1);
    assert.ok(!selectActiveChat(state)[0].optimistic);
    const lines = selectChatLines(state, 120, { tableMode: "sentinel" });
    assert.equal(lines.filter(line => line.kind === "cardStart").length, 1);
    const text = lines.map(line => (Array.isArray(line) ? line : line.runs || []).map(run => run.text || "").join("")).join("\n");
    assert.match(text, /QUESTION/);
    assert.match(text, /Confirm bulk/);
    assert.doesNotMatch(text, /The user was asked|The user responded/);

    const withOptimistic = { ...buildHistoryModel([]), chat: [{ id: "pending", role: "user", text: answer, optimistic: true }] };
    const appended = appendEventToHistory(withOptimistic, event);
    assert.equal(appended.chat.length, 1);
    assert.ok(!appended.chat[0].optimistic);
});
