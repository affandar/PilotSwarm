import test from "node:test";
import assert from "node:assert/strict";
import {
    appendEventToHistory,
    applyLiveTurnToHistory,
    appReducer,
    buildHistoryModel,
    createInitialState,
    createStore,
    PilotSwarmUiController,
    selectChatLines,
} from "../src/index.js";

const evt = (seq, eventType, data = {}) => ({
    sessionId: "s1",
    seq,
    eventType,
    data,
    createdAt: 1_700_000_000_000 + seq,
});

function state(history) {
    return {
        sessions: { activeSessionId: "s1", byId: { s1: { sessionId: "s1", status: "running" } } },
        history: { bySessionId: new Map([["s1", history]]) },
        auth: {}, ui: {}, branding: {}, connection: {}, outbox: { bySessionId: {} },
    };
}

test("a live snapshot replaces its own bubble without advancing durable history", () => {
    const initial = buildHistoryModel([evt(7, "user.message", { content: "hello" })], {});
    const first = applyLiveTurnToHistory(initial, {
        phase: "live", messageId: "m1", text: "hel", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 4, createdAt: 10 });
    const second = applyLiveTurnToHistory(first, {
        phase: "live", messageId: "m1", text: "hello", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 5, createdAt: 11 });

    assert.equal(second.chat.filter((item) => item.liveTurn).length, 1);
    assert.equal(second.chat.at(-1).text, "hello");
    assert.equal(second.lastSeq, initial.lastSeq, "ephemeral seq never becomes the durable replay cursor");
    assert.deepEqual(second.events, initial.events, "live snapshots never enter durable history");
});

test("reasoning and answer share one stable turn item and two message ids retain order", () => {
    let history = buildHistoryModel([], {});
    history = applyLiveTurnToHistory(history, {
        phase: "live", messageId: "m1", text: "one", reasoningId: "r1", reasoningText: "because",
    }, { sessionId: "s1", seq: 1 });
    history = applyLiveTurnToHistory(history, {
        phase: "live", messageId: "m2", text: "two", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 2 });

    assert.deepEqual(history.chat.filter((item) => item.liveTurn).map((item) => [item.messageId, item.reasoningText]), [
        ["m1", "because"], ["m2", ""],
    ]);

    history = applyLiveTurnToHistory(history, {
        phase: "live", messageId: "m1", text: "one updated", reasoningId: "r1", reasoningText: "because",
    }, { sessionId: "s1", seq: 3 });
    assert.deepEqual(history.chat.filter((item) => item.liveTurn).map((item) => item.messageId), ["m1", "m2"],
        "an update replaces the original keyed slot instead of moving it past a later model call");
});

test("reasoning-only ticks reconcile into the message slot when its id arrives", () => {
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: null, text: "", reasoningId: "r1", reasoningText: "thinking",
    }, { sessionId: "s1", seq: 1 });
    history = applyLiveTurnToHistory(history, {
        phase: "live", messageId: "m1", text: "answer", reasoningId: "r1", reasoningText: "thinking more",
    }, { sessionId: "s1", seq: 2 });
    assert.equal(history.chat.filter((item) => item.liveTurn).length, 1);
    assert.ok(history.chat.filter((item) => item.liveTurn).every((item) => item.messageId === "m1"));
    assert.equal(history.chat.find((item) => item.liveTurn)?.reasoningText, "thinking more");
});

test("a growing live turn preserves its first-seen timestamp", () => {
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: "m1", text: "a", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 1, createdAt: 1_000 });
    history = applyLiveTurnToHistory(history, {
        phase: "live", messageId: "m1", text: "answer", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 2, createdAt: 9_000 });

    assert.equal(history.chat.at(-1).liveStartedAt, 1_000);
    assert.equal(history.chat.at(-1).createdAt, 1_000);
});

test("a successfully completed streamed answer uses the normal Agent prefix without changing its preview key", () => {
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: "m1", text: "answer", reasoningId: "r1", reasoningText: "thought",
    }, { sessionId: "s1", seq: 1, createdAt: Date.now() - 1000 });
    history = appendEventToHistory(history, evt(2, "assistant.message", { messageId: "m1", content: "answer" }));
    const interim = selectChatLines(state(history), 100, { tableMode: "sentinel" }).find(line => line?.kind === "assistantPreview");
    assert.equal(interim.final, false, "saved output alone does not complete a turn");
    history = appendEventToHistory(history, evt(3, "session.turn_completed", { resultType: "completed" }));
    const lines = selectChatLines(state(history), 100, { tableMode: "sentinel" });
    const card = lines.find(line => line?.kind === "assistantPreview");
    assert.equal(card.final, true);
    assert.equal(card.isLive, false);
    assert.equal(card.previewKey, interim.previewKey);
    assert.equal(card.previewKey, "assistant:m1");
    assert.match(card.headerRuns.map(run => run.text).join(""), /Agent: /);
    assert.doesNotMatch(JSON.stringify(lines), /Agent responded|streamingCaret/);
});

test("matching durable final replaces live; a different id leaves it until turn completion", () => {
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: "m1", text: "draft", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 1 });
    history = appendEventToHistory(history, evt(1, "assistant.message", { messageId: "m2", content: "other" }));
    assert.equal(history.chat.filter((item) => item.liveTurn).length, 1, "different model call stays distinct");

    history = appendEventToHistory(history, evt(2, "assistant.message", { messageId: "m1", content: "final" }));
    assert.equal(history.chat.filter((item) => item.liveTurn).length, 0);
    assert.equal(history.chat.filter((item) => item.messageId === "m1").length, 1);

    history = applyLiveTurnToHistory(history, {
        phase: "live", messageId: "m3", text: "orphan", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 3 });
    history = appendEventToHistory(history, evt(3, "session.turn_completed", { result: "error" }));
    assert.equal(history.chat.filter((item) => item.liveTurn).length, 0);
});

test("a durable final keeps its live slot ahead of a later streaming message", () => {
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: "m1", text: "first draft", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 1 });
    history = applyLiveTurnToHistory(history, {
        phase: "live", messageId: "m2", text: "second draft", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 2 });
    history = appendEventToHistory(history, evt(1, "assistant.message", { messageId: "m1", content: "first final" }));

    assert.deepEqual(history.chat.map((item) => [item.messageId, item.text, Boolean(item.liveTurn)]), [
        ["m1", "first final", false],
        ["m2", "second draft", true],
    ]);
});

test("a completion before the reveal threshold promotes the same body without live chrome", () => {
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: "m1", text: "draft", reasoningId: "r1", reasoningText: "brief thought",
    }, { sessionId: "s1", seq: 1, createdAt: Date.now() });
    history = appendEventToHistory(history, evt(1, "assistant.message", { messageId: "m1", content: "final" }));
    history = appendEventToHistory(history, evt(2, "session.turn_completed", { resultType: "completed" }));

    const final = history.chat.find((item) => item.messageId === "m1");
    assert.equal(final?.responseFinal, true);
    assert.equal(final?.liveTurn, undefined);
    const preview = selectChatLines(state(history), 100, { tableMode: "sentinel" }).find(line => line?.kind === "assistantPreview");
    assert.equal(preview.final, true);
    assert.equal(preview.isLive, false);
    assert.equal(preview.body, "final");
    assert.equal(preview.reasoningText, "brief thought", "reasoning remains available on demand");
});

test("idle clears stale live content, including an error path with no durable final", () => {
    const live = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: "m1", text: "partial", reasoningId: "r1", reasoningText: "thinking",
    }, { sessionId: "s1", seq: 1 });
    const idle = applyLiveTurnToHistory(live, {
        phase: "idle", messageId: null, text: "", reasoningId: null, reasoningText: "",
    }, { sessionId: "s1", seq: 2 });
    assert.equal(idle.chat.filter((item) => item.liveTurn).length, 0);
});

test("the controller gives cross-plane idle a grace window for durable reconciliation", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    let initial = createInitialState();
    initial = appReducer(initial, { type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "running" }] });
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, initial), transport: {} });
    controller.mergeSessionEvent("s1", {
        transient: true,
        eventType: "assistant.live_tick",
        liveSeq: 1,
        data: { phase: "live", messageId: "m1", text: "draft", reasoningId: null, reasoningText: "" },
    });
    t.mock.timers.tick(250);
    controller.mergeSessionEvent("s1", {
        transient: true,
        eventType: "assistant.live_tick",
        liveSeq: 2,
        data: { phase: "idle", messageId: null, text: "", reasoningId: null, reasoningText: "" },
    });

    assert.equal(
        controller.getState().history.bySessionId.get("s1").chat.filter((item) => item.liveTurn).length,
        1,
        "idle must not tear down the live card before its durable message can replace it",
    );
    controller.mergeSessionEvent("s1", evt(1, "assistant.message", { messageId: "m1", content: "final" }));
    assert.equal(controller.getState().history.bySessionId.get("s1").chat.some((item) => item.liveTurn), false);
});

test("partial markdown remains visible and carries the streaming caret", () => {
    const history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live",
        messageId: "m1",
        text: "before\n```js\nconst answer = 42;\ntext after the opening fence",
        reasoningId: null,
        reasoningText: "",
    }, { sessionId: "s1", seq: 1 });
    const lines = selectChatLines(state(history), 100);
    const encoded = JSON.stringify(lines);
    assert.match(encoded, /text after the opening fence/);
    assert.match(encoded, /streamingCaret/);
});

test("the browser receives a stable disclosure and unparsed markdown as the live answer grows", () => {
    const initial = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live",
        messageId: "m1",
        text: "A growing answer",
        reasoningId: null,
        reasoningText: "",
    }, { sessionId: "s1", seq: 1 });
    const updated = applyLiveTurnToHistory(initial, {
        phase: "live",
        messageId: "m1",
        text: "A growing answer\n\n| A | B |\n| - | - |\n| 1 | 2 |",
        reasoningId: null,
        reasoningText: "",
    }, { sessionId: "s1", seq: 2 });

    for (const history of [initial, updated]) {
        const lines = selectChatLines(state(history), 100, { tableMode: "sentinel" });
        const preview = lines.find((line) => line?.kind === "assistantPreview");
        assert.equal(preview?.previewKey, "assistant:m1");
        assert.equal(preview?.isLive, true);
        assert.equal(preview?.final, false);
        assert.equal(preview?.text, "Message preview", "header must not cycle through delta text");
        assert.equal(preview?.body, history.chat[0].text);
        assert.equal(lines.some(line => line?.kind === "cardStart" || line?.kind === "table"), false, "hidden markdown is parsed only when expanded in the browser");
    }
});

test("live reasoning is carried separately in the stable browser disclosure", () => {
    const history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live",
        messageId: null,
        text: "",
        reasoningId: "r1",
        reasoningText: "considering alternatives",
    }, { sessionId: "s1", seq: 1 });
    const lines = selectChatLines(state(history), 100, { tableMode: "sentinel" });
    const preview = lines.find((line) => line?.kind === "assistantPreview");
    assert.equal(preview?.previewKey, "assistant:reasoning:r1");
    assert.equal(preview?.isLive, true);
    assert.equal(preview?.body, "");
    assert.equal(preview?.reasoningText, "considering alternatives");
    assert.equal(preview?.final, false);
});

test("saved interim output and final promotion retain the disclosure key and reasoning", () => {
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), {
        phase: "live", messageId: "m1", text: "draft", reasoningId: "r1", reasoningText: "considered options",
    }, { sessionId: "s1", seq: 1, createdAt: 1_000 });
    history = appendEventToHistory(history, evt(1, "assistant.message", { messageId: "m1", content: "final answer" }));

    const lines = selectChatLines(state(history), 100, { tableMode: "sentinel" });
    const preview = lines.find((line) => line?.kind === "assistantPreview");
    assert.equal(preview?.previewKey, "assistant:m1");
    assert.equal(preview?.isLive, false);
    assert.equal(preview?.final, false);
    assert.equal(preview?.reasoningText, "considered options");
    history = appendEventToHistory(history, evt(2, "session.turn_completed", { resultType: "completed" }));
    const final = selectChatLines(state(history), 100, { tableMode: "sentinel" }).find(line => line?.kind === "assistantPreview");
    assert.equal(final.previewKey, preview.previewKey);
    assert.equal(final.reasoningText, preview.reasoningText);
    assert.equal(final.final, true);
});

test("model.call_start names the model in activity", () => {
    const history = appendEventToHistory(buildHistoryModel([], {}), evt(1, "model.call_start", {
        model: "github-copilot:gpt-5.6-sol",
    }));
    assert.match(history.activity.at(-1).text, /calling gpt-5\.6-sol/);
});

test("reasoning-to-answer preserves the actual identity and key", () => {
    const payload = { phase: "live", reasoningId: "r1", reasoningText: "thought" };
    const first = applyLiveTurnToHistory(buildHistoryModel([], {}), payload, { sessionId: "s1" });
    const second = applyLiveTurnToHistory(first, { ...payload, messageId: "m1", text: "answer" }, { sessionId: "s1" });
    assert.equal(second.chat[0].id, first.chat[0].id);
    assert.equal(second.chat[0].liveKey, first.chat[0].liveKey);
});

test("a final and a terminal event fence off late previews", () => {
    const payload = { phase: "live", messageId: "m1", text: "draft", reasoningId: "r1", reasoningText: "thinking" };
    let history = applyLiveTurnToHistory(buildHistoryModel([], {}), payload, { sessionId: "s1" });
    history = appendEventToHistory(history, evt(1, "assistant.message", { messageId: "m1", content: "final" }));
    assert.strictEqual(applyLiveTurnToHistory(history, payload), history);
    assert.strictEqual(applyLiveTurnToHistory(history, { ...payload, messageId: null, text: "" }), history);
    const other = { phase: "live", messageId: "m2", text: "aborted" };
    history = applyLiveTurnToHistory(history, other);
    history = appendEventToHistory(history, evt(2, "session.turn_stopped"));
    assert.strictEqual(applyLiveTurnToHistory(history, other), history);
});

test("different answers sharing a reasoning id never collapse into one slot", () => {
    const first = applyLiveTurnToHistory(buildHistoryModel([], {}), { phase: "live", messageId: "m1", reasoningId: "r1", text: "one" });
    const second = applyLiveTurnToHistory(first, { phase: "live", messageId: "m2", reasoningId: "r1", text: "two" });
    assert.equal(second.chat.length, 2);
});

test("an unrelated durable message cannot cancel orphan cleanup", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, createInitialState()), transport: {} });
    controller.mergeSessionEvent("s1", { transient: true, eventType: "assistant.live_tick", data: { phase: "live", messageId: "m1", text: "draft" } });
    controller.mergeSessionEvent("s1", { transient: true, eventType: "assistant.live_tick", data: { phase: "idle" } });
    controller.mergeSessionEvent("s1", evt(1, "assistant.message", { messageId: "different", content: "different final" }));
    t.mock.timers.tick(1200);
    assert.equal(controller.getState().history.bySessionId.get("s1").chat.some((m) => m.liveTurn), false);
});

test("live ticks reuse the already-rendered committed transcript", () => {
    const baseline = buildHistoryModel([evt(1, "assistant.message", { messageId: "old", content: "A committed **answer**." })], {});
    const first = selectChatLines(state(baseline), 100, { tableMode: "sentinel" });
    const live = applyLiveTurnToHistory(baseline, { phase: "live", messageId: "new", text: "draft" });
    const second = selectChatLines(state(live), 100, { tableMode: "sentinel" });
    assert.strictEqual(second[0], first[0], "unchanged message lines must retain identity");
});

test("reasoning-only streaming is visible in the native renderer", () => {
    const history = applyLiveTurnToHistory(buildHistoryModel([], {}), { phase: "live", reasoningId: "r", reasoningText: "Native thought" });
    assert.match(JSON.stringify(selectChatLines(state(history), 100)), /Native thought/);
});

test("an old stream's idle never clears or fences a newer stream", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, createInitialState()), transport: {} });
    const emit = (data) => controller.mergeSessionEvent("s1", { transient: true, eventType: "assistant.live_tick", data });
    emit({ phase: "live", streamId: "old", messageId: "m1", text: "old" });
    t.mock.timers.tick(250);
    emit({ phase: "live", streamId: "new", messageId: "m2", text: "new" });
    emit({ phase: "idle", streamId: "old" });
    t.mock.timers.tick(1200);
    const chat = controller.getState().history.bySessionId.get("s1").chat;
    assert.deepEqual(chat.filter((m) => m.liveTurn).map((m) => m.messageId), ["m2"]);
    emit({ phase: "live", streamId: "old", reasoningId: "late", reasoningText: "stale" });
    assert.equal(controller.getState().history.bySessionId.get("s1").chat.length, 1);
});

test("leaving and rejoining an active session accepts its retained stream", () => {
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, createInitialState()), transport: {} });
    const event = { transient: true, eventType: "assistant.live_tick", data: { phase: "live", streamId: "active", messageId: "m1", text: "draft" } };
    controller.mergeSessionEvent("s1", event);
    controller.activeSessionSubscriptionId = "s1";
    controller.detachActiveSession();
    assert.equal(controller.getState().history.bySessionId.get("s1").chat.length, 0);
    controller.mergeSessionEvent("s1", event);
    assert.equal(controller.getState().history.bySessionId.get("s1").chat[0].text, "draft");
});

test("a REST history load cannot erase live arrivals while it was pending", async () => {
    let resolve;
    const controller = new PilotSwarmUiController({
        store: createStore(appReducer, createInitialState()),
        transport: { getSessionEvents: () => new Promise((r) => { resolve = r; }) },
    });
    const loaded = controller.ensureSessionHistory("s1");
    controller.mergeSessionEvent("s1", { transient: true, eventType: "assistant.live_tick", data: { phase: "live", messageId: "m1", text: "arrived during REST" } });
    controller.mergeSessionEvent("s1", evt(8, "assistant.message", { messageId: "other", content: "concurrent durable" }));
    resolve([]);
    await loaded;
    const history = controller.getState().history.bySessionId.get("s1");
    assert.ok(history.chat.some((item) => item.text === "arrived during REST"));
    assert.ok(history.chat.some((item) => item.text === "concurrent durable"));
    assert.equal(history.lastSeq, 8, "REST refresh preserves the durable replay cursor");
});

test("re-entry rejects a retained reasoning snapshot older than durable completion", () => {
    const controller = new PilotSwarmUiController({ store: createStore(appReducer, createInitialState()), transport: {} });
    controller.mergeSessionEvent("s1", evt(10, "session.turn_completed"));
    const event = { transient: true, eventType: "assistant.live_tick",
        liveUpdatedAt: new Date(1_700_000_000_000).toISOString(),
        data: { phase: "live", reasoningId: "unseen", reasoningText: "stale worker preview" },
    };
    assert.equal(controller.mergeSessionEvent("s1", event), false);
    assert.equal(controller.getState().history.bySessionId.get("s1").chat.some((item) => item.liveTurn), false);
    assert.equal(controller.mergeSessionEvent("s1", { ...event, liveUpdatedAt: new Date(1_700_000_000_020).toISOString() }), true);
    assert.equal(controller.getState().history.bySessionId.get("s1").chat.some((item) => item.liveTurn), true);
});
