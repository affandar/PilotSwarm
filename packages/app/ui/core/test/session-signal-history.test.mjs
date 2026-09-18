import test from "node:test";
import assert from "node:assert/strict";
import {
    appReducer, createInitialState, createStore, PilotSwarmUiController,
    buildHistoryModel, appendEventToHistory, CHAT_HISTORY_EVENT_TYPES,
    formatCronTimestampForClient, formatTimestamp,
    selectActivityPane, selectInspector, selectActiveHttpLinks, selectActiveArtifactLinks,
} from "../src/index.js";
import { describeSignalEvent, SIGNAL_EVENT_TYPES } from "../src/session-signals.js";

const T = Date.parse("2026-09-16T09:00:00.000Z");
const DEADLINE = "2026-09-16T09:30:00.000Z";
const WAIT = { waitId: "w1", names: ["approval"], reason: "Review", startedAt: new Date(T).toISOString() };
const SIGNAL = { version: 1, signalId: "sig-1", name: "approval", source: { kind: "api" }, raisedAt: new Date(T).toISOString(), wake: false };
const event = (seq, eventType, data = {}) => ({ seq, eventType, data, sessionId: "s1", createdAt: T + seq * 1000, workerNodeId: "worker-12345" });
const flatten = (line) => Array.isArray(line) ? line.map(run => run.text || "").join("") : line?.text || "";
function stateWith(history) {
    let state = appReducer(createInitialState(), { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "Signals", status: "waiting" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    return appReducer(state, { type: "history/set", sessionId: "s1", history });
}

const cases = [
    ["session.signal_received", SIGNAL, "[signal]", "received: approval · source api · id sig-1", "signal received: approval", "cyan"],
    ["session.signal_buffered", SIGNAL, "[signal]", "buffered: approval · source api · id sig-1", "signal buffered: approval", "cyan"],
    ["session.signal_consumed", { ...SIGNAL, mode: "wait", waitId: "w1", waitDurationMs: 5000 }, "[signal]",
        "↑ consumed: approval (wait) · source api · waited 5s · id sig-1 · wait w1", "↑ signal consumed: approval (wait)", "green"],
    ["session.signal_duplicate", SIGNAL, "[signal]", "duplicate: approval · source api · id sig-1", "signal duplicate: approval", "gray"],
    ["session.signal_dropped", { ...SIGNAL, reason: "buffer full" }, "[signal]",
        "dropped: approval · source api · id sig-1 · reason: buffer full", "signal dropped: approval", "yellow"],
    ["session.signal_rejected", { reason: "invalid name" }, "[signal]",
        "rejected: unknown · reason: invalid name", "signal rejected: unknown", "red"],
    ["session.signal_wait_started", WAIT, "[signal wait]", "started: approval · no deadline · wait w1 · reason: Review",
        "signal wait started: approval · no deadline", "yellow"],
    ["session.signal_wait_interrupted", { ...WAIT, disposition: "user_input" }, "[signal wait]",
        "interrupted: approval · no deadline · wait w1 · disposition user_input · reason: Review",
        "signal wait interrupted: approval · no deadline", "yellow"],
    ["session.signal_wait_resumed", WAIT, "[signal wait]", "resumed: approval · no deadline · wait w1 · reason: Review",
        "signal wait resumed: approval · no deadline", "yellow"],
    ["session.signal_wait_cancelled", WAIT, "[signal wait]", "cancelled: approval · no deadline · wait w1 · reason: Review",
        "signal wait cancelled: approval · no deadline", "gray"],
    ["session.signal_wait_timeout", { ...WAIT, deadline: DEADLINE }, "[signal wait]",
        `! timed out: approval · until ${formatCronTimestampForClient(DEADLINE)} · wait w1 · reason: Review`,
        `! signal wait timed out: approval · until ${formatCronTimestampForClient(DEADLINE)}`, "yellow"],
];

test("all signal lifecycle events have exact shared Activity/sequence descriptions", () => {
    assert.deepEqual(cases.map(([type]) => type), SIGNAL_EVENT_TYPES);
    for (const [type, data, label, detail, sequenceText, color] of cases) {
        const ev = event(1, type, data);
        const description = describeSignalEvent(ev);
        assert.equal(description.text, detail, type);
        assert.equal(description.sequenceText, sequenceText, type);
        assert.equal(description.color, color, type);
        const history = buildHistoryModel([ev]);
        assert.equal(history.chat.length, 0, `${type} is not a chat warning or human message`);
        assert.equal(history.activity.length, 1);
        assert.equal(history.activity[0].role, "system");
        assert.equal(history.activity[0].text, `[${formatTimestamp(ev.createdAt)}] ${label} ${detail}`);
        assert.deepEqual(selectActivityPane(stateWith(history)).lines, [history.activity[0].line]);
        const inspector = selectInspector(stateWith(history), { width: 240 });
        assert.equal(inspector.lines[0].at(-1).text.trim(), sequenceText);
        assert.equal(inspector.lines[0].at(-1).color, color);
        const headers = inspector.stickyLines.map(flatten).join("\n");
        assert.ok(headers.includes("orch"));
        assert.ok(!headers.includes("12345"), "signals are orchestration events, not user/worker turns");
        assert.ok(CHAT_HISTORY_EVENT_TYPES.includes(type), `${type} survives filtered paging`);
    }
});

test("a timed wait keeps its local deadline in start/interruption/resume/timeout and wake is consumption-only", () => {
    const deadline = "2026-09-16T09:30:00.000Z";
    const timing = `until ${formatCronTimestampForClient(deadline)}`;
    for (const type of ["started", "interrupted", "resumed", "timeout"]) {
        const detail = describeSignalEvent(event(1, `session.signal_wait_${type}`, { ...WAIT, deadline }));
        assert.equal(detail.text, `${type === "timeout" ? "! timed out" : type}: approval · ${timing} · wait w1 · reason: Review`);
        assert.ok(detail.sequenceText.endsWith(timing));
    }
    const received = describeSignalEvent(event(1, "session.signal_received", { ...SIGNAL, wake: true }));
    assert.equal(received.text, "received: approval · source api · wake requested · id sig-1");
    assert.equal(received.type, "signal");
    const consumed = describeSignalEvent(event(2, "session.signal_consumed", { ...SIGNAL, wake: true, mode: "wake" }));
    assert.equal(consumed.text, "↑ consumed: approval (wake) · source api · id sig-1");
    assert.equal(consumed.type, "signal_wake");
    assert.equal(describeSignalEvent(event(3, "session.signal_wait_timeout", { ...WAIT, deadline })).type, "signal_timeout");
});

test("fresh load, live append, and paged history retain identical lifecycle rows and system attribution", async () => {
    const events = cases.map(([type, data], index) => event(index + 1, type, data));
    const fresh = buildHistoryModel(events);
    const live = events.reduce(appendEventToHistory, buildHistoryModel());
    assert.deepEqual(live.activity, fresh.activity);
    assert.deepEqual(live.chat, fresh.chat);
    const liveStore = createStore(appReducer, stateWith(buildHistoryModel()));
    const liveController = new PilotSwarmUiController({ store: liveStore, transport: {} });
    for (const ev of events) assert.equal(liveController.mergeSessionEvent("s1", ev), true);
    assert.deepEqual(liveStore.getState().history.bySessionId.get("s1").activity, fresh.activity);
    assert.deepEqual(liveStore.getState().history.bySessionId.get("s1").chat, []);
    assert.equal(liveController.mergeSessionEvent("s1", events.at(-1)), false, "reconnect replay does not duplicate lifecycle rows");
    const initial = { ...buildHistoryModel(events.slice(5)), lastSeq: events.at(-1).seq, hasOlderEvents: true };
    const store = createStore(appReducer, stateWith(initial));
    const controller = new PilotSwarmUiController({ store, transport: {
        async getSessionEventsBefore(id, before, limit, types) {
            assert.equal(id, "s1");
            assert.equal(before, 6);
            assert.deepEqual(types, CHAT_HISTORY_EVENT_TYPES);
            return events.filter(ev => ev.seq < before && types.includes(ev.eventType));
        },
    } });
    await controller.expandSessionHistory("s1", { eventTypes: CHAT_HISTORY_EVENT_TYPES });
    const paged = store.getState().history.bySessionId.get("s1");
    assert.deepEqual(paged.activity, fresh.activity);
    assert.deepEqual(paged.events, fresh.events);
    assert.deepEqual(paged.chat, []);
    assert.deepEqual(selectInspector(stateWith(paged), { width: 240 }).lines, selectInspector(stateWith(fresh), { width: 240 }).lines);
});

test("references and hostile text stay inert; inline payloads never enter a rendered summary", () => {
    const reference = 'https://example.invalid/payload/<img src=x onerror="bad()"> artifact://other/private';
    const ev = event(1, "session.signal_received", {
        ...SIGNAL, payloadRef: reference, dataBytes: 12,
        source: { kind: "session", actorId: "<b>not a human</b>", receiptId: "receipt-1" },
        data: { instructions: "DO NOT RENDER THIS PAYLOAD" },
        content: "DO NOT RENDER THIS CONTENT",
    });
    const history = buildHistoryModel([ev]);
    assert.equal(history.activity[0].text,
        `[${formatTimestamp(ev.createdAt)}] [signal] received: approval · source session · actor <b>not a human</b> · receipt receipt-1 · id sig-1 · 12 bytes · payload ${reference}`);
    assert.ok(history.activity[0].line.every(run => !run.href && !run.html));
    assert.deepEqual(selectActiveHttpLinks(stateWith(history)), []);
    assert.deepEqual(selectActiveArtifactLinks(stateWith(history)), []);
    assert.doesNotMatch(history.activity[0].text, /DO NOT RENDER/);
    assert.deepEqual(history.chat, []);
    assert.equal(describeSignalEvent(event(2, "session.signal_received", { name: "\u001b[31mred\nname" })).text,
        "received: [31mred name");
});

test("existing timer, cron and input Activity stays on its original path", () => {
    const events = [
        event(1, "session.wait_started", { seconds: 10, reason: "Rest" }),
        event(2, "session.cron_started", { seconds: 60, reason: "Check" }),
        event(3, "session.input_required_started", { question: "Continue?" }),
    ];
    const history = buildHistoryModel(events);
    assert.ok(events.every(ev => describeSignalEvent(ev) === null));
    assert.equal(history.activity[0].text, `[${formatTimestamp(events[0].createdAt)}] [wait] 10s reason="Rest"`);
    assert.equal(history.activity[1].text, `[${formatTimestamp(events[1].createdAt)}] [cron] started 60s reason="Check"`);
    assert.ok(history.activity[2].text.includes("[input]"));
});
