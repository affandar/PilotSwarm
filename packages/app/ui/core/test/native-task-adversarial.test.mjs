import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel, appendEventToHistory } from "../src/history.js";
import { applyNativeTaskSnapshot } from "../src/native-tasks.js";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";

const T = 1_780_000_000_000;
const event = (seq, eventType, data = {}) => ({ sessionId: "s1", seq, eventType, data, createdAt: T + seq * 1000 });
const start = event(1, "tool.execution_start", { toolName: "task", toolCallId: "call1", arguments: {
    agent_type: "swarm-explore", description: "Inspect the worker", prompt: "Read the source",
} });
const task = history => history.chat.find(item => item.kind === "native-task-group")?.tasks[0];
const snapshot = (status = "running", extra = {}) => ({ version: 1, ownerId: "owner1", ownerStartedAt: T,
    revision: 10, phase: "live", tasks: [{ id: "call1", toolCallId: "call1", status, startedAt: T + 1000,
        title: "Inspect the worker", toolCalls: 3, preview: "Reading lifecycle helpers", ...extra }] });

test("a late confirmed result replaces both inferred interruption status and its explanation", () => {
    let history = appendEventToHistory(buildHistoryModel([start]), event(2, "session.turn_completed", { resultType: "error" }));
    assert.equal(task(history).status, "interrupted");
    history = applyNativeTaskSnapshot(history, snapshot("completed", { result: "Lifecycle verified", completedAt: T + 1500 }), { sessionId: "s1", seq: 12 });
    assert.equal(task(history).status, "completed");
    assert.equal(task(history).result, "Lifecycle verified");
    assert.ok(!task(history).error, "the old interruption explanation must not hide the confirmed result");
});

test("cleanup cancellation cannot attach an error to a confirmed successful task", () => {
    let history = buildHistoryModel([start,
        event(2, "subagent.completed", { toolCallId: "call1", agentId: "agent1", totalToolCalls: 3, durationMs: 1000 }),
        event(3, "tool.execution_complete", { toolName: "task", toolCallId: "call1", success: true, result: { content: "Verified successfully" } }),
    ]);
    const before = task(history);
    history = appendEventToHistory(history, event(4, "subagent.completed", { toolCallId: "call1", agentId: "agent1", cancelled: true }));
    assert.equal(task(history).status, "completed");
    assert.equal(task(history).completedAt, before.completedAt);
    assert.equal(task(history).result, "Verified successfully");
    assert.ok(!task(history).error, "cleanup must not replace the successful result with a cancellation explanation");
});

test("a REST history load preserves a native task snapshot that arrived while loading", async () => {
    let resolve;
    const controller = new PilotSwarmUiController({
        store: createStore(appReducer, createInitialState()),
        transport: { getSessionEvents: () => new Promise(r => { resolve = r; }) },
    });
    const pending = controller.ensureSessionHistory("s1");
    controller.mergeSessionEvent("s1", { transient: true, eventType: "session.native_tasks_tick", liveSeq: 12, data: snapshot() });
    resolve([start]);
    await pending;
    const history = controller.getState().history.bySessionId.get("s1");
    assert.equal(task(history).status, "running");
    assert.equal(task(history).preview, "Reading lifecycle helpers");
    assert.equal(task(history).toolCalls, 3);
    assert.equal(history.nativeTaskSnapshot?.revision, 10);
    assert.equal(history.lastSeq, start.seq, "native snapshots must not advance the durable replay cursor");
});

test("a newer durable task result from REST wins over retained live progress", async () => {
    let resolve;
    const controller = new PilotSwarmUiController({
        store: createStore(appReducer, createInitialState()),
        transport: { getSessionEvents: () => new Promise(r => { resolve = r; }) },
    });
    const pending = controller.ensureSessionHistory("s1");
    controller.mergeSessionEvent("s1", { transient: true, eventType: "session.native_tasks_tick", liveSeq: 12, data: snapshot() });
    const completed = event(2, "native.task_updated", { ...snapshot("completed").tasks[0],
        ownerId: "owner1", revision: 11, result: "New durable result", completedAt: T + 2000 });
    resolve([start, completed]);
    await pending;
    const history = controller.getState().history.bySessionId.get("s1");
    assert.equal(task(history).status, "completed");
    assert.equal(task(history).result, "New durable result");
    assert.equal(task(history).revision, 11);
    assert.ok(!task(history).error);
});

test("loading an older chat page does not reset current native progress", async () => {
    const laterStart = { ...start, seq: 10, createdAt: T + 10_000 };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport: {
        async getSessionEventsBefore() { return [event(1, "user.message", { content: "Earlier prompt" })]; },
    } });
    const history = applyNativeTaskSnapshot({ ...buildHistoryModel([laterStart]), hasOlderEvents: true, lastSeq: 10 },
        snapshot("running", { startedAt: laterStart.createdAt }), { sessionId: "s1", seq: 12 });
    store.dispatch({ type: "history/set", sessionId: "s1", history });
    await controller.expandSessionHistory("s1", { autoTriggered: true });
    const loaded = store.getState().history.bySessionId.get("s1");
    assert.equal(task(loaded).status, "running");
    assert.equal(task(loaded).preview, "Reading lifecycle helpers");
    assert.equal(task(loaded).toolCalls, 3);
});

test("historical task tools with rejected resultType render failure without requiring a child event", () => {
    const history = buildHistoryModel([start, event(2, "tool.execution_complete", {
        toolName: "task", toolCallId: "call1", result: { resultType: "rejected", textResultForLlm: "This native profile is not permitted." },
    })]);
    assert.equal(task(history).status, "failed");
    assert.match(task(history).error, /not permitted/);
});
