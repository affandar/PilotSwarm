import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel, appendEventToHistory, applyLiveTurnToHistory, CHAT_HISTORY_EVENT_TYPES } from "../src/history.js";
import { selectActiveChat, selectChatLines } from "../src/selectors.js";

const ID = "warning-history";
const T = Date.parse("2026-09-09T01:55:10.000Z");
const ERROR = "Copilot was taking too long to process and was killed.";
const event = (seq, eventType, data, createdAt = T + seq * 1000) => ({ sessionId: ID, seq, eventType, data, createdAt });
const failed = event(2, "session.turn_completed", { resultType: "error", errorMessage: ERROR });
const initial = [event(1, "user.message", { content: "Investigate the architecture" }), failed];
const following = [
    event(3, "user.message", { content: "Continue the investigation" }),
    event(4, "assistant.message", { content: "The investigation is complete." }),
    event(5, "session.turn_completed", { resultType: "completed", errorMessage: null }),
];
const makeState = (history, session = {}) => ({
    sessions: { activeSessionId: ID, byId: { [ID]: { sessionId: ID, status: "running", orchestrationStatus: "Running", ...session } } },
    history: { bySessionId: new Map([[ID, history]]) }, ui: {},
});
const warnings = (chat) => chat.filter(m => m.kind === "session-warning");

test("a failed turn stays before subsequent conversation during live append and replay", () => {
    let live = buildHistoryModel(initial);
    const anchor = warnings(live.chat)[0];
    for (const ev of following) live = appendEventToHistory(live, ev);
    const replay = buildHistoryModel([...initial, ...following]);
    assert.deepEqual(live.chat, replay.chat);
    const state = makeState(live, { error: ERROR, updatedAt: T + 60_000 });
    const chat = selectActiveChat(state);
    assert.deepEqual(chat.map(m => m.kind || m.role), ["user", "session-warning", "user", "assistant"]);
    assert.equal(warnings(chat)[0].id, anchor.id);
    assert.equal(warnings(chat)[0].createdAt, failed.createdAt);
    assert.equal(warnings(chat)[0].text, ERROR, "historical warning must not claim a current failure");
    const text = JSON.stringify(selectChatLines(state, 120));
    assert.ok(text.indexOf(ERROR) < text.indexOf("Continue the investigation"));
});

test("clearing the current error preserves the historical warning, including after reload", () => {
    for (const session of [{ error: null }, { status: "completed", orchestrationStatus: "Completed" }]) {
        const chat = selectActiveChat(makeState(buildHistoryModel([...initial, ...following]), session));
        assert.equal(warnings(chat).length, 1);
        assert.equal(chat.at(-1).role, "assistant");
    }
});

test("retry status decorates the current card without changing its identity or time", () => {
    const history = buildHistoryModel(initial);
    const original = warnings(history.chat)[0];
    for (const error of [ERROR, `${ERROR} (retry 2/3 in 30s)`, `${ERROR} (connection recovery retry)`]) {
        const chat = selectActiveChat(makeState(history, { error }));
        assert.equal(chat.length, 2);
        assert.equal(chat.at(-1).id, original.id);
        assert.equal(chat.at(-1).createdAt, original.createdAt);
        assert.ok(chat.at(-1).text.startsWith(error));
    }
    const terminal = selectActiveChat(makeState(history, { error: ERROR, status: "failed", orchestrationStatus: "Failed" }));
    assert.equal(terminal.at(-1).cardTitle, "Error");
    assert.equal(terminal.at(-1).id, original.id);
});

test("live response snapshots appear below an old warning", () => {
    const history = applyLiveTurnToHistory(buildHistoryModel(initial),
        { phase: "live", streamId: "next-turn", messageId: "reply", text: "Checking recovery now." },
        { sessionId: ID, createdAt: T + 20_000 });
    const chat = selectActiveChat(makeState(history, { error: ERROR }));
    assert.equal(warnings(chat).length, 1);
    assert.equal(chat.at(-1).text, "Checking recovery now.");
});

test("runtime error and its failed-turn summary produce one card at the first error", () => {
    const runtimeError = event(2, "session.error", { message: ERROR });
    const summary = event(3, "session.turn_completed", { resultType: "error", errorMessage: ERROR });
    const events = [initial[0], runtimeError, summary];
    const replay = buildHistoryModel(events);
    let live = buildHistoryModel([]);
    for (const ev of events) live = appendEventToHistory(live, ev);
    live = appendEventToHistory(live, summary);
    assert.deepEqual(live.chat, replay.chat);
    assert.equal(warnings(replay.chat).length, 1);
    assert.equal(warnings(replay.chat)[0].createdAt, runtimeError.createdAt);
    const anotherFailure = event(4, "session.turn_completed", { resultType: "error", errorMessage: ERROR });
    assert.equal(warnings(appendEventToHistory(live, anotherFailure).chat).length, 2);
});

test("SDK errors coalesce with the Execution failed wrapper added by ManagedSession", () => {
    const raw = "Connection is closed";
    const wrapped = `Execution failed: ${raw}`;
    const runtimeError = event(2, "session.error", { message: raw });
    const summary = event(3, "session.turn_completed", { resultType: "error", errorMessage: wrapped });
    const events = [initial[0], runtimeError, summary];
    const replay = buildHistoryModel(events);
    let live = buildHistoryModel([]);
    for (const ev of events) live = appendEventToHistory(live, ev);
    assert.deepEqual(live.chat, replay.chat);
    for (const history of [live, replay]) {
        const chat = selectActiveChat(makeState(history, { error: `${wrapped} (retry 1/3 in 15s)` }));
        assert.equal(warnings(chat).length, 1, "raw SDK event and wrapped turn summary are one failure");
        assert.equal(chat.length, 2, "status must decorate the warning instead of adding a third card");
        assert.equal(warnings(chat)[0].createdAt, runtimeError.createdAt);
        assert.match(warnings(chat)[0].text, /retry 1\/3 in 15s/);
    }
});

test("wrapped current status decorates a raw SDK warning while its turn summary is still in flight", () => {
    const raw = "Connection is closed";
    const runtimeError = event(2, "session.error", { message: raw });
    const history = buildHistoryModel([initial[0], runtimeError]);
    const chat = selectActiveChat(makeState(history, { error: `Execution failed: ${raw} (retry 1/3 in 15s)` }));
    assert.equal(chat.length, 2, "the current status and durable SDK event must share a single warning");
    assert.equal(chat.at(-1).id, warnings(history.chat)[0].id);
    assert.equal(chat.at(-1).createdAt, runtimeError.createdAt);
    assert.match(chat.at(-1).text, /retry 1\/3 in 15s/);
});

test("similar but distinct SDK and turn errors are not collapsed by wrapper normalization", () => {
    const events = [
        initial[0],
        event(2, "session.error", { message: "Connection is closed" }),
        event(3, "session.turn_completed", { resultType: "error", errorMessage: "Execution failed: Connection is closed unexpectedly" }),
    ];
    const chat = selectActiveChat(makeState(buildHistoryModel(events), {
        error: "Execution failed: Connection is closed unexpectedly (retry 1/3 in 15s)",
    }));
    assert.equal(warnings(chat).length, 2);
    assert.equal(chat[1].text, "Connection is closed");
    assert.match(chat.at(-1).text, /unexpectedly \(retry/);
});

test("separate warnings with identical text are not deduplicated by timestamp proximity", () => {
    const events = [event(1, "session.error", { message: ERROR }), event(2, "session.error", { message: ERROR })];
    const history = buildHistoryModel(events);
    assert.equal(warnings(history.chat).length, 2);
    assert.notEqual(history.chat[0].id, history.chat[1].id);
});

test("successful turns and empty errors do not create warning cards or stamp an unrelated error", () => {
    const events = [...following, event(6, "session.error", { message: "" })];
    assert.equal(warnings(buildHistoryModel(events).chat).length, 0);
    const chat = selectActiveChat(makeState(buildHistoryModel(events), { error: ERROR }));
    assert.equal(chat.at(-1).createdAt, null);
});

test("warnings survive raw event pruning and are included in backward chat paging", () => {
    let history = buildHistoryModel(initial);
    for (let seq = 3; seq < 320; seq++) history = appendEventToHistory(history, event(seq, "tool.execution_complete", {}));
    assert.equal(history.events.some(ev => ev.seq === failed.seq), false);
    const chat = selectActiveChat(makeState(history, { error: ERROR }));
    assert.equal(warnings(chat).length, 1);
    assert.equal(warnings(chat)[0].createdAt, failed.createdAt);
    assert.ok(CHAT_HISTORY_EVENT_TYPES.includes("session.error"));
    assert.ok(CHAT_HISTORY_EVENT_TYPES.includes("session.turn_completed"));
});
