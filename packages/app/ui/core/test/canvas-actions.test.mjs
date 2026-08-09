// The interactive-canvas response pipeline, pinned:
//
//   contract → validator → rate limit → canonical [canvas-action] message →
//   hidden chat item (both history pipelines) → activity line
//
// The contract is the security boundary: no contract accepts NOTHING
// (default-closed, per revision), and everything conforming arrives as a
// real user message — recorded for provenance, hidden from the portal chat.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    validateCanvasAction,
    formatCanvasActionPrompt,
    parseCanvasActionContent,
    createCanvasActionLimiter,
} from "../src/index.js";
import { selectCanvasView, selectChatLines } from "../src/selectors.js";
import { buildHistoryModel } from "../src/history.js";

const CONTRACT = { actions: { chat: { text: "string" }, approve: { id: "number", comment: "string?" } } };

function msg(action, data) {
    return { type: "canvas-action", action, data };
}

// ── The validator ───────────────────────────────────────────────────────────

test("no contract accepts nothing — interactivity is default-closed", () => {
    assert.equal(validateCanvasAction(null, msg("chat", { text: "hi" })).ok, false);
    assert.equal(validateCanvasAction({}, msg("chat", { text: "hi" })).ok, false);
});

test("conforming actions pass and come back cleaned", () => {
    const v = validateCanvasAction(CONTRACT, msg("chat", { text: "hello" }));
    assert.deepEqual(v, { ok: true, action: "chat", data: { text: "hello" } });
    const opt = validateCanvasAction(CONTRACT, msg("approve", { id: 42 }));
    assert.deepEqual(opt, { ok: true, action: "approve", data: { id: 42 } }, "optional fields may be absent");
});

test("undeclared actions, wrong types, extra fields, and garbage all bounce", () => {
    assert.equal(validateCanvasAction(CONTRACT, msg("delete", {})).ok, false, "undeclared action");
    assert.equal(validateCanvasAction(CONTRACT, msg("chat", { text: 7 })).ok, false, "wrong type");
    assert.equal(validateCanvasAction(CONTRACT, msg("chat", { text: "x", extra: true })).ok, false, "undeclared field");
    assert.equal(validateCanvasAction(CONTRACT, msg("chat", {})).ok, false, "required field missing");
    assert.equal(validateCanvasAction(CONTRACT, msg("approve", { id: Infinity })).ok, false, "non-finite number");
    assert.equal(validateCanvasAction(CONTRACT, msg("chat", { text: "x".repeat(3000) })).ok, false, "oversized string");
    assert.equal(validateCanvasAction(CONTRACT, { type: "other" }).ok, false, "wrong envelope type");
    assert.equal(validateCanvasAction(CONTRACT, msg("chat", "not-an-object")).ok, false);
    assert.equal(validateCanvasAction(CONTRACT, null).ok, false);
});

test("the canonical text round-trips", () => {
    const text = formatCanvasActionPrompt("chat", { text: "hi" });
    assert.equal(text, '[canvas-action] {"action":"chat","data":{"text":"hi"}}');
    assert.deepEqual(parseCanvasActionContent(text), { action: "chat", data: { text: "hi" } });
    assert.equal(parseCanvasActionContent("[canvas-action] not json"), null);
    assert.equal(parseCanvasActionContent("plain chat message"), null);
});

test("the limiter allows the burst and then refuses until the window slides", () => {
    const acquire = createCanvasActionLimiter({ burst: 3, windowMs: 3000 });
    const t0 = 1_000_000;
    assert.equal(acquire(t0), true);
    assert.equal(acquire(t0 + 10), true);
    assert.equal(acquire(t0 + 20), true);
    assert.equal(acquire(t0 + 30), false, "burst spent");
    assert.equal(acquire(t0 + 3050), true, "window slid");
});

// ── Contract storage per revision ───────────────────────────────────────────

test("the contract belongs to the revision: a draw without one revokes interactivity", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 1, sizeBytes: 10, responseContract: CONTRACT });
    assert.deepEqual(selectCanvasView(state).responseContract, CONTRACT);
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 2, sizeBytes: 10 });
    assert.equal(selectCanvasView(state).responseContract, null, "rev 2 drew no contract — the canvas is inert again");
});

test("a stale snapshot never clobbers a newer revision's contract", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 5, sizeBytes: 10, responseContract: CONTRACT });
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", rev: 3 });
    assert.deepEqual(state.canvas.bySessionId.s1.responseContract, CONTRACT);
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", rev: 7, responseContract: { actions: { ping: {} } } });
    assert.deepEqual(state.canvas.bySessionId.s1.responseContract, { actions: { ping: {} } }, "a NEWER snapshot rev updates it");
});

// ── submitCanvasAction: the controller pipeline ─────────────────────────────

function actionController(sent) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T", status: "running" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 1, sizeBytes: 10, responseContract: CONTRACT });
    const store = createStore(appReducer, state);
    return new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
            sendMessage: async (sessionId, prompt, options) => { sent.push({ sessionId, prompt, options }); },
            getSessionEvents: async () => [],
        },
    });
}

test("a valid action becomes the canonical hidden user message, fire-and-forget", async () => {
    const sent = [];
    const c = actionController(sent);
    const result = await c.submitCanvasAction("s1", msg("chat", { text: "hello from the canvas" }));
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].prompt, '[canvas-action] {"action":"chat","data":{"text":"hello from the canvas"}}');
    assert.equal(sent[0].options.enqueueOnly, true, "no outbox, no optimistic bubble — the ordinary enqueue path");
});

test("invalid actions and rate-limit overruns never reach the transport", async () => {
    const sent = [];
    const c = actionController(sent);
    assert.equal((await c.submitCanvasAction("s1", msg("nope", {}))).ok, false);
    assert.equal(sent.length, 0);
    // Burst is 3: three sends pass, the fourth bounces.
    for (let i = 0; i < 3; i += 1) {
        assert.equal((await c.submitCanvasAction("s1", msg("chat", { text: `m${i}` }))).ok, true);
    }
    const overrun = await c.submitCanvasAction("s1", msg("chat", { text: "m3" }));
    assert.equal(overrun.ok, false);
    assert.equal(overrun.reason, "rate limited");
    assert.equal(sent.length, 3);
});

// ── The hidden transcript item, in BOTH pipelines ───────────────────────────

function actionEvent(seq, text) {
    return {
        seq,
        sessionId: "s1",
        eventType: "user.message",
        createdAt: new Date().toISOString(),
        data: { content: text },
    };
}

test("bulk load and live append agree: kind canvas-action, flagged line, activity record", async () => {
    const text = formatCanvasActionPrompt("approve", { id: 42 });

    // Bulk pipeline.
    const model = buildHistoryModel([actionEvent(4, text)]);
    const bulkItem = model.chat.find((m) => m?.kind === "canvas-action");
    assert.ok(bulkItem, "bulk load must build the canvas-action item");
    assert.equal(bulkItem.action, "approve");
    assert.deepEqual(bulkItem.data, { id: 42 });
    assert.match(model.activity.map((a) => JSON.stringify(a)).join(""), /\[canvas\]/, "bulk activity line present");

    // Live pipeline, and the rendered line's flag.
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    const store = createStore(appReducer, state);
    const c = new PilotSwarmUiController({
        store,
        transport: { listSessions: async () => [], subscribeSession: () => () => {}, getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }) },
    });
    c.mergeSessionEvent("s1", actionEvent(9, text));
    const history = c.getState().history.bySessionId.get("s1");
    const liveItem = history.chat.find((m) => m?.kind === "canvas-action");
    assert.ok(liveItem, "live append must build the same item");
    assert.equal(liveItem.action, "approve");
    assert.match(history.activity.map((a) => JSON.stringify(a)).join(""), /\[canvas\]/, "live activity line present");

    const lines = selectChatLines(c.getState(), 100);
    const line = lines.find((l) => l?.canvasAction);
    assert.ok(line, "the rendered line carries the canvasAction flag — the portal's skip signal");
    assert.match(line.runs.map((r) => r.text).join(""), /approve/);
});

test("an ordinary user message that merely mentions canvases is untouched", () => {
    const model = buildHistoryModel([actionEvent(4, "please draw on the canvas")]);
    assert.ok(model.chat.every((m) => m?.kind !== "canvas-action"));
});

// ── json fields: the batched-form carrier ───────────────────────────────────

test("a json field carries one structured object (the whole form), size-capped", () => {
    const contract = { actions: { submit: { decision: "string", form: "json" } } };
    const items = Array.from({ length: 23 }, (_, i) => ({ id: i, checked: i % 3 !== 0, comment: i % 5 === 0 ? "needs a follow-up" : "" }));
    const v = validateCanvasAction(contract, msg("submit", { decision: "GO", form: { rev: 4, items } }));
    assert.equal(v.ok, true, "a 23-item sign-off submits as ONE action");
    assert.equal(v.data.form.items.length, 23);
    assert.equal(validateCanvasAction(contract, msg("submit", { decision: "GO", form: "a string" })).ok, false,
        "json means object/array, not a string");
    const huge = { blob: "x".repeat(9000) };
    assert.equal(validateCanvasAction(contract, msg("submit", { decision: "GO", form: huge })).ok, false,
        "the 8 KB payload cap still binds");
});

// ── Creator-only: the client half of the refusal ────────────────────────────

test("a viewer who is not the session creator is refused before the transport", async () => {
    const sent = [];
    const c = actionController(sent);
    // The viewer authenticates as bob; the session belongs to alice.
    c.dispatch({ type: "sessions/merged", session: { sessionId: "s1", owner: { provider: "dev", subject: "alice" } } });
    const authState = c.getState().auth;
    c.getState().auth.principal = { provider: "dev", subject: "bob" };
    const result = await c.submitCanvasAction("s1", msg("chat", { text: "hijack attempt" }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /creator/);
    assert.equal(sent.length, 0, "never reaches the transport");
    void authState;
});

// ── Data ticks: quiet, monotonic, replayable ────────────────────────────────

test("a data tick converges content and lights the badge — but never flips", () => {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 1, sizeBytes: 10 });
    state = appReducer(state, { type: "canvas/viewed", sessionId: "s1", rev: 1 });
    const modeBefore = state.ui.rightPaneMode;
    assert.equal(selectCanvasView(state).unseen, false, "fully viewed before the tick");
    state = appReducer(state, { type: "canvas/data", sessionId: "s1", dataRev: 3, payload: { stories: [1, 2] } });
    const after = selectCanvasView(state);
    assert.equal(after.latestDataRev, 3);
    assert.deepEqual(after.dataPayload, { stories: [1, 2] });
    assert.equal(after.unseen, true, "an unwatched tick IS unseen content — the badge lights");
    assert.equal(state.ui.rightPaneMode, modeBefore, "but ticks never flip the view");
    // The surface receipt clears it, exactly like a draw.
    state = appReducer(state, { type: "canvas/viewed", sessionId: "s1", dataRev: 3 });
    assert.equal(selectCanvasView(state).unseen, false);
    // Monotonic: replays never regress payload or rev.
    state = appReducer(state, { type: "canvas/data", sessionId: "s1", dataRev: 2, payload: { stale: true } });
    assert.equal(state.canvas.bySessionId.s1.latestDataRev, 3);
    assert.deepEqual(state.canvas.bySessionId.s1.dataPayload, { stories: [1, 2] });
});

test("the snapshot replays the latest tick so a cold shell can reconstruct", async () => {
    let calls = [];
    const c = controllerWithTransport({
        getSessionEventsBefore: async (sessionId, beforeSeq, limit, types) => {
            calls.push(types[0]);
            if (types[0] === "session.canvas_updated") return [{ seq: 5, sessionId, eventType: "session.canvas_updated", createdAt: new Date().toISOString(), data: { rev: 2, sizeBytes: 10 } }];
            return [{ seq: 9, sessionId, eventType: "session.canvas_data", createdAt: new Date().toISOString(), data: { dataRev: 7, sizeBytes: 20, payload: { n: 42 } } }];
        },
    });
    await c.ensureCanvasSnapshot("s1");
    assert.deepEqual(calls, ["session.canvas_updated", "session.canvas_data"]);
    const view = selectCanvasView(c.getState());
    assert.equal(view.latestRev, 2);
    assert.equal(view.latestDataRev, 7);
    assert.deepEqual(view.dataPayload, { n: 42 });
});

test("the activity feed tells ticks and redraws apart, in both pipelines", async () => {
    const { buildHistoryModel: build } = await import("../src/history.js");
    const events = [
        { seq: 1, sessionId: "s1", eventType: "session.canvas_updated", createdAt: new Date().toISOString(), data: { rev: 1, note: "shell", sizeBytes: 500 } },
        { seq: 2, sessionId: "s1", eventType: "session.canvas_data", createdAt: new Date().toISOString(), data: { dataRev: 1, sizeBytes: 410, note: "HN refresh" } },
    ];
    const model = build(events);
    const text = model.activity.map((a) => a.text).join("\n");
    assert.match(text, /rev 1 — shell/, "redraws read as revisions");
    assert.match(text, /data tick 1 \(0\.4 KB\) — HN refresh/, "ticks read as ticks, with size");
    // Live pipeline agrees.
    const c = controllerWithTransport({});
    c.mergeSessionEvent("s1", events[1]);
    const live = c.getState().history.bySessionId.get("s1");
    assert.match(live.activity.map((a) => a.text).join(""), /data tick 1/);
    assert.ok(!live.chat.some((m) => m?.kind === "canvas-update"), "and no chat item for a tick");
});

function controllerWithTransport(extra) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T", status: "running" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    const store = createStore(appReducer, state);
    return new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
            ...extra,
        },
    });
}
