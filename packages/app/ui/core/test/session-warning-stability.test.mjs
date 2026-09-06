import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore, PilotSwarmUiController, selectActiveChat, selectChatLines, buildHistoryModel, appendEventToHistory, CHAT_HISTORY_EVENT_TYPES } from "../src/index.js";

const T = 1_780_000_000_000;
const ERROR = "Execution failed: 400 Unknown parameter: 'snippy'. (retry 1/3 in 15s)";
function setup(error = ERROR) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "Recurring", status: "error", orchestrationStatus: "Running", error, updatedAt: T, statusVersion: 10 }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    let detail;
    const controller = new PilotSwarmUiController({ store, transport: { getSession: async () => detail } });
    return { store, controller, sync: async (fields) => {
        detail = { sessionId: "s1", orchestrationStatus: "Running", updatedAt: T, ...fields };
        await controller.syncSessionDetail("s1");
    } };
}
const warning = store => selectActiveChat(store.getState()).find(m => m.cardTitle === "Warning");
const card = store => selectChatLines(store.getState(), 120, { tableMode: "sentinel" }).find(l => l.kind === "cardStart");

test("catalog/detail churn and changing retry text keep one stable warning card", async () => {
    const { store, sync } = setup();
    const id = warning(store).id;
    const key = card(store).cardKey;
    assert.equal(key, id);
    for (const status of ["idle", "waiting", "running"]) {
        store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "Recurring", status, updatedAt: T }] });
        assert.equal(warning(store)?.id, id, `catalog ${status}`);
        await sync({ status, statusVersion: 10 });
        assert.equal(warning(store)?.id, id, `detail ${status}`);
        assert.equal(card(store)?.cardKey, key);
    }
    await sync({ status: "error", error: ERROR.replace("1/3 in 15s", "2/3 in 30s"), statusVersion: 11 });
    assert.equal(warning(store)?.id, id);
    assert.equal(card(store)?.cardKey, key);
    assert.match(warning(store).text, /2\/3 in 30s/);
});

test("recovery ends the active warning but keeps its historical card", async () => {
    for (const fields of [
        { status: "idle", statusVersion: 11 },
        { status: "waiting", statusVersion: 11 },
        { status: "idle", updatedAt: T + 100 },
        { status: "running", error: null },
        { status: "running", error: "" },
        { status: "input_required", statusVersion: 11 },
        { status: "completed", orchestrationStatus: "Completed" },
        { status: "cancelled", orchestrationStatus: "Terminated" },
        { status: "error", orchestrationStatus: "Completed" },
        { status: "error", orchestrationStatus: "Terminated" },
    ]) {
        const { store, sync } = setup();
        const before = warning(store);
        await sync(fields);
        assert.deepEqual(warning(store), before, JSON.stringify(fields));
        assert.equal(store.getState().sessions.byId.s1.chatWarnings.at(-1).active, false);
    }
});

const event = (seq, eventType, content, at = T + seq * 1000) => ({
    sessionId: "s1", seq, eventType, createdAt: at,
    data: eventType === "session.error" ? { message: content } : { content },
});

test("a failure stays between its preceding and following chat in live and reloaded history", () => {
    const events = [event(1, "user.message", "first"), event(2, "session.error", "Unavailable"),
        event(3, "user.message", "try again"), event(4, "assistant.message", "Recovered")];
    const bulk = buildHistoryModel(events);
    const live = events.reduce(appendEventToHistory, buildHistoryModel([]));
    for (const history of [bulk, live]) {
        assert.deepEqual(history.chat.map(m => m.text), ["first", "Unavailable", "try again", "Recovered"]);
        assert.equal(history.chat[1].cardTitle, "Warning");
        assert.equal(history.activity.filter(a => a.eventType === "session.error").length, 1);
    }
    assert.ok(CHAT_HISTORY_EVENT_TYPES.includes("session.error"), "backward paging must retain failures");
    assert.equal(appendEventToHistory(live, events[1]).chat.filter(m => m.kind === "session-warning").length, 1);
});

test("status-only warning does not migrate to the tail when new chat arrives", async () => {
    const { store, sync } = setup();
    const id = warning(store).id;
    store.dispatch({ type: "history/set", sessionId: "s1", history: buildHistoryModel([
        event(1, "user.message", "before", T - 1000),
        event(2, "user.message", "after", T + 1000),
        event(3, "assistant.message", "answer", T + 2000),
    ]) });
    await sync({ status: "running", updatedAt: T + 3000 });
    const chat = selectActiveChat(store.getState());
    assert.deepEqual(chat.map(m => m.id === id ? "warning" : m.text), ["before", "warning", "after", "answer"]);
    await sync({ status: "idle", error: null, statusVersion: 12 });
    assert.equal(warning(store).id, id);
    assert.equal(warning(store).createdAt, T);
});

for (const statusFirst of [true, false]) {
    test(`status/durable warning reconciliation avoids duplicates (status first: ${statusFirst})`, () => {
        const store = createStore(appReducer, createInitialState());
        const events = [event(1, "user.message", "request"), event(2, "session.error", "Unavailable")];
        store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "running" }] });
        store.dispatch({ type: "history/set", sessionId: "s1", history: buildHistoryModel(statusFirst ? events.slice(0, 1) : events) });
        store.dispatch({ type: "sessions/merged", session: { sessionId: "s1", status: "error", error: "Unavailable (retry 1/3)", updatedAt: T + 2000 } });
        const id = warning(store).id;
        store.dispatch({ type: "history/set", sessionId: "s1", history: buildHistoryModel([...events, event(3, "assistant.message", "Recovered")]) });
        const notices = selectActiveChat(store.getState()).filter(m => m.kind === "session-warning");
        assert.equal(notices.length, 1);
        assert.equal(notices[0].id, id);
        assert.equal(selectActiveChat(store.getState()).at(-1).text, "Recovered");
    });
}

test("a second failure after recovery keeps both notices and session deletion removes them", async () => {
    const { store, sync } = setup();
    await sync({ status: "idle", error: null, statusVersion: 11 });
    await sync({ status: "error", error: "Second failure", updatedAt: T + 10000, statusVersion: 12 });
    const notices = selectActiveChat(store.getState()).filter(m => m.kind === "session-warning");
    assert.equal(notices.length, 2);
    assert.notEqual(notices[0].id, notices[1].id);
    store.dispatch({ type: "sessions/gone", sessionId: "s1" });
    assert.ok(!JSON.stringify(selectActiveChat(store.getState())).includes("Second failure"));
});

test("cold catalog warning reconciles with history loaded later", () => {
    const { store } = setup("Unavailable (retry 1/3)");
    const id = warning(store).id;
    store.dispatch({ type: "history/set", sessionId: "s1", history: buildHistoryModel([
        event(1, "user.message", "request", T - 2000),
        event(2, "session.error", "Unavailable", T - 1000),
        event(3, "user.message", "retry", T + 1000),
        event(4, "assistant.message", "answer", T + 2000),
    ]) });
    const chat = selectActiveChat(store.getState());
    assert.equal(chat.filter(m => m.kind === "session-warning").length, 1);
    assert.equal(chat[1].id, id);
    assert.equal(chat.at(-1).text, "answer");
});

test("identical failures from distinct events stay distinct in live and reloaded history", () => {
    const events = [event(1, "session.error", "Unavailable"), event(2, "session.error", "Unavailable")];
    assert.equal(buildHistoryModel(events).chat.length, 2);
    assert.equal(events.reduce(appendEventToHistory, buildHistoryModel([])).chat.length, 2);
});

test("a retained status error does not become another warning merely because the session resumes", () => {
    const { store } = setup();
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s1", status: "input_required" } });
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s1", status: "running" } });
    assert.equal(selectActiveChat(store.getState()).filter(m => m.kind === "session-warning").length, 1);
    assert.equal(store.getState().sessions.byId.s1.chatWarnings[0].active, false);
    // The same text after an explicit recovery really is a new failure.
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s1", error: null } });
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s1", error: ERROR, updatedAt: T + 1000 } });
    assert.equal(selectActiveChat(store.getState()).filter(m => m.kind === "session-warning").length, 2);
});

test("reconciliation survives raw error events falling out of the history window", () => {
    const { store } = setup("Unavailable (retry 1/3)");
    const history = buildHistoryModel([
        event(1, "session.error", "Unavailable", T - 1000),
        event(2, "assistant.message", "Recovered", T + 1000),
    ]);
    store.dispatch({ type: "history/set", sessionId: "s1", history: { ...history, events: [event(3, "model.call_start", "", T + 2000)] } });
    const chat = selectActiveChat(store.getState());
    assert.equal(chat.filter(m => m.kind === "session-warning").length, 1);
    assert.equal(chat.at(-1).text, "Recovered");
});

test("warnings belong only to their session", () => {
    const { store } = setup();
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s2", title: "Other session", status: "idle" } });
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    assert.equal(selectActiveChat(store.getState()).some(m => m.kind === "session-warning"), false);
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.equal(selectActiveChat(store.getState()).filter(m => m.kind === "session-warning").length, 1);
});

test("a different failure after new chat does not rewrite the earlier warning", async () => {
    const { store, sync } = setup("First failure");
    store.dispatch({ type: "history/set", sessionId: "s1", history: buildHistoryModel([
        event(1, "user.message", "retry", T + 1000),
        event(2, "assistant.message", "recovered", T + 2000),
    ]) });
    await sync({ status: "error", error: "New failure", updatedAt: T + 3000 });
    assert.deepEqual(selectActiveChat(store.getState()).map(m => m.text), ["First failure", "retry", "recovered", "New failure"]);
});

test("terminal failures stay errors, and retry retention is not tied to provider wording", async () => {
    for (const text of [ERROR, "Connection is closed", "Rate limited", "Execution failed: 400 Unknown parameter: 'snippy'."]) {
        const { store, sync } = setup(text);
        await sync({ status: "running", statusVersion: 11 });
        assert.ok(warning(store)?.text.startsWith(text));
        await sync({ status: "failed", orchestrationStatus: "Failed", error: text });
        assert.equal(warning(store), undefined);
        assert.ok(selectActiveChat(store.getState()).some(m => m.cardTitle === "Error"));
    }
});
