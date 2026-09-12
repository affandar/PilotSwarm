import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore, buildHistoryModel, appendEventToHistory, selectActiveChat, selectChatLines } from "../src/index.js";

const T = Date.parse("2026-09-09T01:00:00Z");
const event = (seq, eventType, data = {}) => ({ sessionId: "s1", seq, eventType, data, createdAt: T + seq * 1000 });
const task = { toolName: "task", toolCallId: "native-1", arguments: { description: "Inspect the runtime", agent_type: "swarm-explore", prompt: "full native-only prompt" } };
const warnings = chat => chat.filter(item => item.kind === "session-warning");
function state(history) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "running", orchestrationStatus: "Running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "history/set", sessionId: "s1", history });
    return store;
}

test("generic chat calls coexist with one abridged native task in live and reloaded history", () => {
    const events = [
        event(1, "tool.execution_start", task),
        event(2, "external_tool.requested", { ...task, requestId: "native-request" }),
        event(3, "tool.execution_progress", { toolCallId: "native-1", progressMessage: "hidden native progress" }),
        event(4, "tool.execution_partial_result", { toolCallId: "native-1", partialOutput: "hidden native output" }),
        event(5, "external_tool.completed", { requestId: "native-request" }),
        event(6, "tool.execution_start", { toolName: "bash", toolCallId: "parent-1", arguments: { command: "git status" } }),
        event(7, "tool.execution_start", { toolName: "spawn_agent", toolCallId: "durable-1", arguments: { task: "Review independently" } }),
        event(8, "tool.execution_complete", { ...task, success: true, result: { content: "Native result" } }),
    ];
    const bulk = buildHistoryModel(events), live = events.reduce(appendEventToHistory, buildHistoryModel());
    assert.deepEqual(live.chat, bulk.chat);
    for (const history of [bulk, live]) {
        assert.equal(history.chat.filter(item => item.kind === "native-task-group").length, 1);
        assert.deepEqual(history.chat.filter(item => item.kind === "chat-call").map(item => item.name), ["bash", "spawn_agent"]);
        const lines = selectChatLines(state(history).getState(), 80, { tableMode: "sentinel" });
        assert.equal(lines.filter(item => item.kind === "nativeTasks").length, 1);
        assert.equal(lines.filter(item => item.kind === "chatCall").length, 2);
        assert.doesNotMatch(JSON.stringify(lines), /full native-only prompt|hidden native output|hidden native progress/);
    }
});

test("native failed-turn summary coalesces with its SDK error across an intervening parent tool card", () => {
    const events = [event(1, "tool.execution_start", task), event(2, "session.error", { message: "Turn timed out" }),
        event(3, "tool.execution_complete", { toolName: "bash", toolCallId: "parent-1", success: true, result: "Done" }),
        event(4, "session.turn_completed", { resultType: "error", errorMessage: "Execution failed: Turn timed out" }),
        event(5, "user.message", { content: "Continue" }), event(6, "assistant.message", { content: "Recovered" })];
    for (const history of [buildHistoryModel(events), events.reduce(appendEventToHistory, buildHistoryModel())]) {
        assert.equal(warnings(history.chat).length, 1);
        assert.equal(warnings(history.chat)[0].warningSeq, 2);
        assert.equal(warnings(history.chat)[0].turnCompletedSeq, 4);
        assert.equal(history.chat.find(item => item.kind === "native-task-group").tasks[0].status, "interrupted");
        assert.equal(history.chat.at(-1).text, "Recovered");
    }
});

test("a later regular tool keeps its disclosure even if its SDK call ID repeats an earlier native task", () => {
    const events = [event(1, "tool.execution_start", { ...task, durableSessionId: "first-sdk-session" }),
        event(2, "tool.execution_start", { toolName: "bash", toolCallId: "native-1", durableSessionId: "second-sdk-session", arguments: { command: "git status" } }),
        event(3, "tool.execution_complete", { toolCallId: "native-1", durableSessionId: "second-sdk-session", success: true, result: "Clean" })];
    for (const history of [buildHistoryModel(events), events.reduce(appendEventToHistory, buildHistoryModel())]) {
        const calls = history.chat.filter(item => item.kind === "chat-call");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, "Done");
        assert.equal(calls[0].result, "Clean");
        assert.equal(history.chat.filter(item => item.kind === "native-task-group").length, 1);
    }
});

for (const sdkError of [false, true]) {
    for (const statusFirst of [false, true]) {
        test(`status and failed-turn warning reconcile once (SDK error: ${sdkError}, status first: ${statusFirst})`, () => {
            const events = [event(1, "user.message", { content: "Try native work" }),
                ...(sdkError ? [event(2, "session.error", { message: "Turn timed out" })] : []),
                event(3, "session.turn_completed", { resultType: "error", errorMessage: "Execution failed: Turn timed out" })];
            const store = state(buildHistoryModel(statusFirst ? events.slice(0, 1) : events));
            store.dispatch({ type: "sessions/merged", session: { sessionId: "s1", status: "error", error: "Execution failed: Turn timed out (retry 1/3)", updatedAt: T + (statusFirst ? 2000 : 4000) } });
            const id = warnings(selectActiveChat(store.getState()))[0].id;
            store.dispatch({ type: "history/set", sessionId: "s1", history: buildHistoryModel([...events,
                event(4, "user.message", { content: "Continue" }), event(5, "assistant.message", { content: "Recovered" })]) });
            const chat = selectActiveChat(store.getState());
            assert.equal(warnings(chat).length, 1);
            assert.equal(warnings(chat)[0].id, id);
            assert.equal(chat.at(-1).text, "Recovered");
        });
    }
}

test("failed-turn-only warnings preserve separate episodes and suppress silent-turn diagnostics", () => {
    const events = [event(1, "session.turn_completed", { resultType: "error", errorMessage: "Unavailable" }),
        event(2, "user.message", { content: "Retry" }),
        event(3, "session.turn_completed", { resultType: "error", errorMessage: "Unavailable" }),
        event(4, "session.turn_completed", { resultType: "error", errorMessage: "Execution failed: No response was returned. Send your message again to retry." })];
    for (const history of [buildHistoryModel(events), events.reduce(appendEventToHistory, buildHistoryModel())]) {
        assert.equal(warnings(history.chat).length, 2);
        assert.notEqual(warnings(history.chat)[0].id, warnings(history.chat)[1].id);
        assert.doesNotMatch(JSON.stringify(history.chat), /No response was returned/);
    }
});

test("empty uncorrelated tool diagnostics stay in Activity rather than evicting warning cards", () => {
    const events = [event(1, "session.error", { message: "Unavailable" }),
        ...Array.from({ length: 320 }, (_, index) => event(index + 2, "tool.execution_complete", {}))];
    for (const history of [buildHistoryModel(events), events.reduce(appendEventToHistory, buildHistoryModel())]) {
        assert.equal(history.chat.length, 1);
        assert.equal(history.chat[0].text, "Unavailable");
        assert.ok(history.activity.some(item => item.eventType === "tool.execution_complete"));
    }
});
