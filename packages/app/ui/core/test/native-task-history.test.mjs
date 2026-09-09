import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel, appendEventToHistory, CHAT_HISTORY_EVENT_TYPES } from "../src/history.js";
import { applyNativeTaskSnapshot } from "../src/native-tasks.js";
import { selectActiveChat, selectChatLines } from "../src/selectors.js";
const T = Date.parse("2026-09-09T01:00:00Z");
const ev = (seq, eventType, data) => ({ seq, sessionId: "s1", createdAt: T + seq * 1000, eventType, data });
const tool = { toolName: "task", toolCallId: "call-1", arguments: { agent_type: "swarm-explore", description: "Map runtime boundaries" } };
const start = ev(3, "tool.execution_start", tool);
const child = { ...tool, nativeAgentId: "agent-1" };
const initial = [ev(1, "user.message", { content: "Research the runtime" }), ev(2, "assistant.message", { content: "I’ll delegate the investigation." }), start,
    ev(4, "subagent.started", child), ev(5, "subagent.configured", { nativeAgentId: "agent-1", model: "claude-opus-5", reasoningEffort: "high" })];
const taskGroups = h => h.chat.filter(m => m.kind === "native-task-group");
const tasks = h => taskGroups(h).flatMap(g => g.tasks);
const state = history => ({ sessions: { activeSessionId: "s1", byId: { s1: { sessionId: "s1", status: "running" } } },
    history: { bySessionId: new Map([["s1", history]]) }, ui: {}, auth: {} });

test("native dispatch, lifecycle and results update one anchored row in live and replay", () => {
    const events = [...initial,
        ev(6, "native.tool.execution_start", { nativeAgentId: "agent-1", parentToolCallId: "call-1", toolCallId: "read-1", toolName: "view", arguments: { description: "Read session manager" } }),
        ev(7, "subagent.completed", { ...child, totalToolCalls: 35, durationMs: 52000 }),
        ev(8, "tool.execution_complete", { ...tool, success: true, result: { content: "Saved full output to disk", detailedContent: "Mapped client, orchestration and worker boundaries." } }),
        ev(9, "assistant.message", { content: "Here are the findings." }), ev(10, "session.turn_completed", { resultType: "completed" })];
    const replay = buildHistoryModel(events);
    let live = buildHistoryModel([]);
    for (const event of events) live = appendEventToHistory(live, event);
    assert.deepEqual(live.chat, replay.chat);
    assert.equal(tasks(replay).length, 1);
    assert.equal(tasks(replay)[0].title, "Map runtime boundaries");
    assert.equal(tasks(replay)[0].toolCalls, 35);
    assert.equal(tasks(replay)[0].status, "completed");
    assert.equal(tasks(replay)[0].result, "Mapped client, orchestration and worker boundaries.");
    assert.equal(tasks(replay)[0].model, "claude-opus-5");
    assert.equal(taskGroups(replay)[0].createdAt, start.createdAt);
    assert.equal(replay.chat.at(-1).text, "Here are the findings.");
    const rendered = selectChatLines(state(replay), 80, { tableMode: "sentinel" });
    assert.equal(rendered.filter(l => l.kind === "nativeTasks").length, 1);
    assert.match(JSON.stringify(selectChatLines(state(replay), 80)), /Native tasks/i);
});

test("cancelled completion remains Cancelled when parent task and cleanup report completion", () => {
    const history = buildHistoryModel([...initial,
        ev(6, "subagent.completed", { ...child, cancelled: true, totalToolCalls: 115 }),
        ev(7, "tool.execution_complete", { ...tool, success: true, result: { content: "Agent cancelled" } }),
        ev(8, "session.turn_completed", { resultType: "error", errorMessage: "Turn timed out" })]);
    assert.equal(tasks(history)[0].status, "cancelled");
    assert.doesNotMatch(tasks(history)[0].error, /user/i);
    const done = buildHistoryModel([...initial, ev(6, "subagent.completed", child), ev(7, "subagent.completed", { ...child, cancelled: true })]);
    assert.equal(tasks(done)[0].status, "completed", "cleanup must not reverse a completed result");
});

test("denied task before child start is Failed; an internal tool error is not task failure", () => {
    const denied = buildHistoryModel([start, ev(4, "tool.execution_complete", { ...tool, success: false, error: { message: "Background mode unavailable" } })]);
    assert.equal(tasks(denied)[0].status, "failed");
    assert.match(tasks(denied)[0].error, /Background/);
    const recovered = buildHistoryModel([...initial, ev(6, "native.tool.execution_complete", { nativeAgentId: "agent-1", success: false }), ev(7, "subagent.completed", child)]);
    assert.equal(tasks(recovered)[0].status, "completed");
});

test("identical task titles remain separate, while durable spawn_agent produces no native card", () => {
    const history = buildHistoryModel([start, ev(4, "tool.execution_start", { ...tool, toolCallId: "call-2" }),
        ev(5, "tool.execution_start", { toolName: "spawn_agent", toolCallId: "durable-1", arguments: { task: "Map runtime boundaries" } })]);
    assert.equal(tasks(history).length, 2);
    assert.notEqual(tasks(history)[0].id, tasks(history)[1].id);
    assert.equal(taskGroups(history).length, 1);
});

test("reusing a native agent record for another invocation keeps two task rows", () => {
    const history = buildHistoryModel([...initial, ev(6, "subagent.completed", child),
        ev(7, "subagent.started", { ...child, toolCallId: "call-2" }),
        ev(8, "subagent.configured", { nativeAgentId: "agent-1", model: "claude-opus-5" })]);
    assert.equal(tasks(history).length, 2);
    assert.deepEqual(tasks(history).map(t => t.status), ["completed", "running"]);
    assert.equal(tasks(history)[1].toolCallId, "call-2");
});

test("late tool correlation preserves the native row identity", () => {
    let history = buildHistoryModel([ev(1, "subagent.started", { nativeAgentId: "agent-1", agentName: "swarm-explore" })]);
    const id = tasks(history)[0].id;
    history = appendEventToHistory(history, ev(2, "native.task_updated", { ...snapshot(1).tasks[0], ownerId: "owner-1", revision: 1 }));
    assert.equal(tasks(history).length, 1);
    assert.equal(tasks(history)[0].id, id);
    assert.equal(tasks(history)[0].toolCallId, "call-1");
});

test("native transcript and empty task-change feed never leak into parent chat/activity", () => {
    const history = buildHistoryModel([...initial, ev(6, "native.assistant.reasoning", { content: "private reasoning" }),
        ev(7, "session.background_tasks_changed", {}), ev(8, "native.assistant.message", { nativeAgentId: "agent-1", parentToolCallId: "call-1", content: "Reading the runtime." })]);
    assert.equal(history.chat.filter(m => m.role === "assistant").length, 1);
    assert.doesNotMatch(JSON.stringify(history.activity), /background_tasks_changed|private reasoning/);
    assert.equal(tasks(history)[0].preview, "Reading the runtime.");
});

const snapshot = (revision, status = "running", extra = {}) => ({ version: 1, ownerId: "owner-1", ownerStartedAt: T, revision, phase: "live",
    tasks: [{ id: "call-1", toolCallId: "call-1", agentId: "agent-1", startedAt: new Date(start.createdAt).toISOString(), title: "Map runtime boundaries", status, toolCalls: 12, preview: "Reading queue handling.", ...extra }] });
test("live snapshot preserves sequence, anchor and terminal outcome through stale progress", () => {
    let history = buildHistoryModel(initial);
    const anchor = taskGroups(history)[0].id;
    const events = history.events;
    history = applyNativeTaskSnapshot(history, snapshot(2), { sessionId: "s1", seq: 10 });
    assert.equal(history.events, events);
    assert.equal(taskGroups(history)[0].id, anchor);
    assert.equal(tasks(history)[0].toolCalls, 12);
    assert.equal(applyNativeTaskSnapshot(history, snapshot(1), { sessionId: "s1", seq: 9 }), history);
    history = appendEventToHistory(history, ev(6, "subagent.completed", child));
    history = applyNativeTaskSnapshot(history, snapshot(3, "waiting"), { sessionId: "s1", seq: 11 });
    assert.equal(tasks(history)[0].status, "completed");
    assert.equal(taskGroups(history)[0].id, anchor);
});

test("confirmed turn end interrupts unfinished tasks; late completion can resolve that inferred outcome", () => {
    let history = buildHistoryModel([...initial, ev(7, "session.turn_completed", { resultType: "error" })]);
    assert.equal(tasks(history)[0].status, "interrupted");
    history = appendEventToHistory(history, ev(8, "subagent.completed", child));
    assert.equal(tasks(history)[0].status, "completed");
    const stale = applyNativeTaskSnapshot(buildHistoryModel([ev(10, "session.turn_completed", { resultType: "completed" })]), snapshot(1), { sessionId: "s1", seq: 12 });
    assert.equal(tasks(stale)[0].status, "interrupted");
});

test("transport loss is Reconnecting, not task failure; old owner snapshots cannot replace a newer owner", () => {
    const current = applyNativeTaskSnapshot(buildHistoryModel(initial), snapshot(2), { sessionId: "s1", seq: 10 });
    const stale = applyNativeTaskSnapshot(current, { phase: "unavailable" }, { sessionId: "s1" });
    assert.equal(tasks(stale)[0].status, "running");
    assert.equal(tasks(stale)[0].telemetryStale, true);
    const resumed = applyNativeTaskSnapshot(stale, snapshot(3), { sessionId: "s1", seq: 1 });
    assert.equal(tasks(resumed)[0].telemetryStale, false, "live row sequence can restart after the plane becomes unavailable");
    const old = { ...snapshot(20), ownerId: "older", ownerStartedAt: T - 1000 };
    assert.equal(applyNativeTaskSnapshot(current, old, { sessionId: "s1", seq: 100 }), current);
});

test("native summary survives chat paging and duplicate summaries do not append rows", () => {
    const summary = ev(6, "native.task_updated", { ...snapshot(3, "completed", { result: "Found the answer." }).tasks[0], ownerId: "owner-1", revision: 3 });
    let history = buildHistoryModel([...initial, summary]);
    history = appendEventToHistory(history, summary);
    assert.equal(tasks(history).length, 1);
    assert.equal(tasks(history)[0].status, "completed");
    assert.ok(CHAT_HISTORY_EVENT_TYPES.includes("native.task_updated"));
    assert.ok(CHAT_HISTORY_EVENT_TYPES.includes("subagent.completed"));
    assert.equal(selectActiveChat(state(history)).filter(m => m.kind === "native-task-group").length, 1);
});

test("a reconnect rejects an old retained owner using the newer durable task summary", () => {
    const currentTask = { ...snapshot(3).tasks[0], ownerId: "new-owner", ownerStartedAt: T + 1000, revision: 1 };
    const history = buildHistoryModel([ev(6, "native.task_updated", currentTask)]);
    const reconnected = applyNativeTaskSnapshot(history, snapshot(50, "completed", { result: "Stale result" }), { sessionId: "s1", seq: 200 });
    assert.equal(tasks(reconnected)[0].ownerId, "new-owner");
    assert.equal(tasks(reconnected)[0].status, "running");
    assert.equal(tasks(reconnected)[0].result, "");
    assert.equal(tasks(reconnected)[0].telemetryStale, true);
    assert.equal(reconnected.nativeTaskSnapshot, undefined);
});
