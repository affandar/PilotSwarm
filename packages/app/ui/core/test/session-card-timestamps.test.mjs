// The Question and Warning cards keep a steady clock.
//
// WHY THIS EXISTS: both cards stamped session.updatedAt as their createdAt.
// That field moves on every list poll, detail sync and status tick, so the
// time in the card header jumped forward with each update — the card looked
// like it was flickering. The time now comes from the event that raised the
// card (input_required_started / session.error, else the turn end) and is
// simply absent when no such event is loaded.
import test from "node:test";
import assert from "node:assert/strict";
import { selectChatLines } from "../src/index.js";
import { formatTimestamp } from "../src/formatting.js";

const SESSION_ID = "s1";

function makeState({ session, events = [] }) {
    return {
        sessions: {
            activeSessionId: SESSION_ID,
            byId: { [SESSION_ID]: { sessionId: SESSION_ID, owner: null, ...session } },
        },
        history: {
            bySessionId: new Map([[SESSION_ID, {
                chat: [{ id: "m1", role: "user", text: "hello", createdAt: 1_000_000 }],
                activity: [],
                events,
            }]]),
        },
        ui: {},
        branding: null,
        auth: { principal: null },
    };
}

const textOf = (lines) => JSON.stringify(lines);

const QUESTION = { question: "Which region?", choices: ["east", "west"] };
const ERROR = "Execution failed: 429 rate limit (retry 1/3 in 15s)";
const RUNNING_WARNING = { status: "error", orchestrationStatus: "Running", error: ERROR };

test("the Question card does not change when only updatedAt moves", () => {
    const a = selectChatLines(makeState({ session: { status: "input_required", pendingQuestion: QUESTION, updatedAt: 1_700_000_000_000 } }), 100);
    const b = selectChatLines(makeState({ session: { status: "input_required", pendingQuestion: QUESTION, updatedAt: 1_700_000_090_000 } }), 100);
    assert.ok(textOf(a).includes("Which region?"), "the question card should be rendered");
    assert.deepEqual(b, a, "a status tick re-stamped the question card");
});

test("the Warning card does not change when only updatedAt moves", () => {
    const a = selectChatLines(makeState({ session: { ...RUNNING_WARNING, updatedAt: 1_700_000_000_000 } }), 120);
    const b = selectChatLines(makeState({ session: { ...RUNNING_WARNING, updatedAt: 1_700_000_090_000 } }), 120);
    assert.ok(textOf(a).includes("still running"), "the warning card should be rendered");
    assert.deepEqual(b, a, "a status tick re-stamped the warning card");
});

test("the cards carry the time of the event that raised them", () => {
    const askedAt = new Date("2026-09-01T12:37:37.000Z");
    const question = selectChatLines(makeState({
        session: { status: "input_required", pendingQuestion: QUESTION, updatedAt: askedAt.getTime() + 60_000 },
        events: [{ seq: 1, eventType: "session.input_required_started", createdAt: askedAt.toISOString(), data: QUESTION }],
    }), 100);
    assert.ok(textOf(question).includes(formatTimestamp(askedAt)), "question card should show the ask time");

    const failedAt = new Date("2026-09-01T12:38:10.000Z");
    const warning = selectChatLines(makeState({
        session: { ...RUNNING_WARNING, updatedAt: failedAt.getTime() + 60_000 },
        events: [{ seq: 2, eventType: "session.error", createdAt: failedAt.toISOString(), data: { message: ERROR } }],
    }), 120);
    assert.ok(textOf(warning).includes(formatTimestamp(failedAt)), "warning card should show the error time");
    assert.ok(!textOf(warning).includes(formatTimestamp(failedAt.getTime() + 60_000)), "warning card must not show updatedAt");
});
