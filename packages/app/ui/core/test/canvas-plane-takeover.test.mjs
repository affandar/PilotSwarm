// The canvas data plane's takeover semantics in the shared reducer.
//
// Plane-fed ticks (planeSeq) and legacy durable ticks (dataRev) are two
// numbering systems for one stream of states. Once a slot sees a plane tick,
// the plane OWNS it: legacy dual-written copies are strictly staler (same
// writer, written second) and must not fight the fresher state — while the
// DISPLAYED tick number stays monotonic so viewed-marking and badges never
// treat new state as already-seen.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const S = "11111111-2222-3333-4444-555555555555";
const key = S; // canvasKey: slot 1 is the bare session id

function dataAction(extra) {
    return { type: "canvas/data", sessionId: S, slot: 1, ...extra };
}

function slotState(state) {
    return state.canvas.bySessionId[key] || {};
}

test("legacy ticks order by dataRev until the plane arrives", () => {
    let state = createInitialState({});
    state = appReducer(state, dataAction({ dataRev: 5, payload: { v: 5 } }));
    state = appReducer(state, dataAction({ dataRev: 4, payload: { v: 4 } }));
    assert.equal(slotState(state).latestDataRev, 5);
    assert.deepEqual(slotState(state).dataPayload, { v: 5 });
});

test("plane takeover: a plane tick wins even with a SMALLER number, and display stays monotonic", () => {
    let state = createInitialState({});
    // A pre-plane session with a long legacy history...
    state = appReducer(state, dataAction({ dataRev: 50, payload: { legacy: true } }));
    // ...receives its first plane-fed tick (plane numbering restarts at 1).
    state = appReducer(state, dataAction({ dataRev: 1, planeSeq: 1, payload: { plane: true } }));
    assert.deepEqual(slotState(state).dataPayload, { plane: true }, "plane state applied despite the smaller number");
    assert.equal(slotState(state).planeSeq, 1);
    assert.equal(slotState(state).latestDataRev, 50, "displayed tick number never regresses");
});

test("after takeover, legacy dual-written copies are ignored", () => {
    let state = createInitialState({});
    state = appReducer(state, dataAction({ dataRev: 3, planeSeq: 3, payload: { plane: 3 } }));
    // The dual-written durable event for the same tick arrives ~500ms later
    // via polling with its own (higher) legacy numbering.
    state = appReducer(state, dataAction({ dataRev: 90, payload: { stale: "copy" } }));
    assert.deepEqual(slotState(state).dataPayload, { plane: 3 }, "legacy copy dropped after takeover");
});

test("plane ticks order by planeSeq; stale plane ticks drop", () => {
    let state = createInitialState({});
    state = appReducer(state, dataAction({ dataRev: 2, planeSeq: 2, payload: { v: 2 } }));
    state = appReducer(state, dataAction({ dataRev: 1, planeSeq: 1, payload: { v: 1 } }));
    assert.deepEqual(slotState(state).dataPayload, { v: 2 });
    state = appReducer(state, dataAction({ dataRev: 3, planeSeq: 3, payload: { v: 3 } }));
    assert.deepEqual(slotState(state).dataPayload, { v: 3 });
});

test("the patch is stored for opt-in pages and cleared on whole-state ticks", () => {
    let state = createInitialState({});
    state = appReducer(state, dataAction({ dataRev: 1, planeSeq: 1, payload: { a: 1 }, patch: { a: 1 } }));
    assert.deepEqual(slotState(state).dataPatch, { a: 1 });
    state = appReducer(state, dataAction({ dataRev: 2, planeSeq: 2, payload: { a: 1, b: 2 } }));
    assert.equal(slotState(state).dataPatch, null, "a snapshot/PUT tick hands out no delta");
});

test("takeover is per slot — a plane tick on slot 1 leaves slot 2 legacy-ordered", () => {
    let state = createInitialState({});
    state = appReducer(state, dataAction({ dataRev: 1, planeSeq: 1, payload: { plane: 1 } }));
    state = appReducer(state, { type: "canvas/data", sessionId: S, slot: 2, dataRev: 7, payload: { legacy: 7 } });
    assert.deepEqual((state.canvas.bySessionId[`${S}#2`] || {}).dataPayload, { legacy: 7 });
});

test("canvas/planeReleased lifts the takeover so fresh legacy ticks resume; stale ones still drop", () => {
    let state = createInitialState({});
    state = appReducer(state, dataAction({ dataRev: 3, planeSeq: 3, payload: { plane: 3 } }));
    // Plane dies → release. Legacy resumes by ordinary dataRev ordering.
    state = appReducer(state, { type: "canvas/planeReleased", sessionId: S });
    // Stale legacy (numbering at or below the displayed tick) still drops...
    state = appReducer(state, dataAction({ dataRev: 3, payload: { stale: true } }));
    assert.deepEqual(slotState(state).dataPayload, { plane: 3 });
    // ...while a fresh legacy tick applies again — the canvas is NOT frozen.
    state = appReducer(state, dataAction({ dataRev: 4, payload: { legacy: "resumed" } }));
    assert.deepEqual(slotState(state).dataPayload, { legacy: "resumed" });
});

test("a seq-less transient event never poisons the history replay cursor", async () => {
    const { appendEventToHistory } = await import("../src/index.js");
    const history = { chat: [], activity: [], events: [], lastSeq: 42 };
    const next = appendEventToHistory(history, {
        eventType: "session.canvas_data",
        transient: true,
        data: { slot: 1, dataRev: 7, planeSeq: 7, payload: { x: 1 } },
    });
    assert.equal(next.lastSeq, 42, "lastSeq survives a seq-less event — afterSeq must never reset to 0");
});
