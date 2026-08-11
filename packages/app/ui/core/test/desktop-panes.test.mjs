/**
 * Canvas and Diagnostics are two independent desktop columns.
 *
 * They used to be one enum, `ui.rightPaneMode`, so the right column could only
 * ever wear one face: either the inspector/activity split or the canvas.
 * Picking one hid the other, and there was no way to see neither.
 *
 * Now:
 *   - each has its own boolean and its own toolbar toggle
 *   - both default to OFF, so a fresh workspace is sessions and chat
 *   - Diagnostics is the old inspector/activity split, moved out of the chat
 *     pane and travelling as a unit
 *
 * The pixel geometry lives in the React portal; what is pinned here is the
 * state machine underneath it, including the parts that are easy to break by
 * accident — the agent's canvas flip must not close a user's Diagnostics, and
 * the opt-out bookkeeping must survive the split.
 *
 * Run: node --test test/unit/desktop-panes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState, normalizeStoredDesktopPanes } from "../src/state.js";
import { selectCanvasView, sessionCanvasMark } from "../src/selectors.js";

const store = (opts) => createStore(appReducer, createInitialState(opts));

// ─── Defaults ────────────────────────────────────────────────────

test("a fresh workspace has neither column open", () => {
    const s = createInitialState();
    assert.equal(s.ui.canvasOpen, false);
    assert.equal(s.ui.diagnosticsOpen, false);
});

// ─── Independence ────────────────────────────────────────────────

test("each toggle moves only its own column", () => {
    const st = store();
    st.dispatch({ type: "ui/diagnosticsOpen" });
    assert.equal(st.getState().ui.diagnosticsOpen, true);
    assert.equal(st.getState().ui.canvasOpen, false, "diagnostics must not open the canvas");

    st.dispatch({ type: "ui/canvasOpen" });
    assert.equal(st.getState().ui.canvasOpen, true);
    assert.equal(st.getState().ui.diagnosticsOpen, true, "the canvas must not close diagnostics");

    st.dispatch({ type: "ui/canvasOpen" });
    assert.equal(st.getState().ui.canvasOpen, false);
    assert.equal(st.getState().ui.diagnosticsOpen, true, "closing the canvas must leave diagnostics alone");
});

test("an explicit open flag beats the toggle default", () => {
    const st = store();
    st.dispatch({ type: "ui/canvasOpen", open: false });
    assert.equal(st.getState().ui.canvasOpen, false, "already closed stays closed");
    st.dispatch({ type: "ui/diagnosticsOpen", open: true });
    st.dispatch({ type: "ui/diagnosticsOpen", open: true });
    assert.equal(st.getState().ui.diagnosticsOpen, true);
});

// ─── The agent's flip ────────────────────────────────────────────

test("an agent drawing opens the canvas without touching diagnostics", () => {
    // The regression this guards: canvas/flip used to set an enum, so it
    // implicitly closed the inspector/activity split. An agent drawing a canvas
    // must not tear down panels the user deliberately opened.
    const st = store();
    st.dispatch({ type: "ui/diagnosticsOpen", open: true });
    const before = st.getState().canvas.flipSeq || 0;

    st.dispatch({ type: "canvas/flip" });
    assert.equal(st.getState().ui.canvasOpen, true);
    assert.equal(st.getState().ui.diagnosticsOpen, true, "the flip must not close diagnostics");
    assert.equal(st.getState().canvas.flipSeq, before + 1, "the phone's tab strip listens to this tick");
});

// ─── Opt-out bookkeeping survives the split ──────────────────────

test("closing the canvas by hand opts out of future flips; reopening withdraws that", () => {
    const st = store({ activeSessionId: "s1" });
    st.dispatch({ type: "ui/canvasOpen", open: true, sessionId: "s1" });
    assert.equal(st.getState().canvas.prefs.s1?.optedOut ?? false, false);

    st.dispatch({ type: "ui/canvasOpen", open: false, sessionId: "s1", manual: true });
    assert.equal(st.getState().canvas.prefs.s1.optedOut, true, "a manual close means do not flip me back");

    st.dispatch({ type: "ui/canvasOpen", open: true, sessionId: "s1" });
    assert.equal(st.getState().canvas.prefs.s1.optedOut, false, "opening by hand withdraws the opt-out");
});

test("a close that is NOT manual does not opt out", () => {
    // Only a deliberate close is a statement about future draws.
    const st = store({ activeSessionId: "s1" });
    st.dispatch({ type: "ui/canvasOpen", open: true, sessionId: "s1" });
    st.dispatch({ type: "ui/canvasOpen", open: false, sessionId: "s1" });
    assert.equal(st.getState().canvas.prefs.s1?.optedOut ?? false, false);
});

test("opening or closing diagnostics never touches canvas prefs", () => {
    const st = store({ activeSessionId: "s1" });
    const before = st.getState().canvas.prefs;
    st.dispatch({ type: "ui/diagnosticsOpen", open: true });
    st.dispatch({ type: "ui/diagnosticsOpen", open: false });
    assert.equal(st.getState().canvas.prefs, before, "same object — nothing was rewritten");
});

// ─── The unseen badge reads the new flag ─────────────────────────

test("the canvas badge follows canvasOpen, not the retired enum", () => {
    // selectCanvasView().mode drives the unseen-changes badge, which must light
    // whenever the canvas is off screen. Reading rightPaneMode would have kept
    // saying "canvas" after the column was closed.
    const st = store({ activeSessionId: "s1" });
    st.dispatch({ type: "ui/canvasOpen", open: true, sessionId: "s1" });
    assert.equal(selectCanvasView(st.getState()).mode, "canvas");
    st.dispatch({ type: "ui/canvasOpen", open: false, sessionId: "s1", manual: true });
    assert.equal(selectCanvasView(st.getState()).mode, "panes");
});

// ─── Migration from the old stored enum ──────────────────────────

test("a stored rightPaneMode migrates", () => {
    // "canvas" was a deliberate choice, so it is honored. "panes" was the
    // default value rather than a choice, and the new default is a clean
    // two-column workspace.
    assert.deepEqual(normalizeStoredDesktopPanes(null, "canvas"), { canvasOpen: true, diagnosticsOpen: false, zen: false });
    assert.deepEqual(normalizeStoredDesktopPanes(null, "panes"), { canvasOpen: false, diagnosticsOpen: false, zen: false });
    assert.deepEqual(normalizeStoredDesktopPanes(null, null), { canvasOpen: false, diagnosticsOpen: false, zen: false });
});

test("a stored desktopPanes wins over the legacy enum", () => {
    assert.deepEqual(
        normalizeStoredDesktopPanes({ canvasOpen: false, diagnosticsOpen: true }, "canvas"),
        { canvasOpen: false, diagnosticsOpen: true, zen: false },
    );
});

test("junk in the stored value degrades to both closed, never to a crash", () => {
    for (const junk of ["yes", 7, [], { canvasOpen: "true" }]) {
        const out = normalizeStoredDesktopPanes(junk, null);
        assert.equal(out.canvasOpen, false, `${JSON.stringify(junk)} must not open the canvas`);
        assert.equal(out.diagnosticsOpen, false);
    }
});

test("rightPaneMode is kept in step for anything still reading it", () => {
    // Nothing decides layout from it any more, but a rolled-back build and the
    // phone's preservation path both still read the key.
    const st = store();
    st.dispatch({ type: "ui/canvasOpen", open: true });
    assert.equal(st.getState().ui.rightPaneMode, "canvas");
    st.dispatch({ type: "ui/canvasOpen", open: false });
    assert.equal(st.getState().ui.rightPaneMode, "panes");
});

// ─── The canvas/diagnostics seam ─────────────────────────────────

test("the seam position is stored and defaults to an even split", () => {
    const st = store();
    assert.equal(st.getState().ui.layout.canvasPaneAdjust, 0, "0 means the columns share the side evenly");
    st.dispatch({ type: "ui/canvasPaneAdjust", canvasPaneAdjust: -140 });
    assert.equal(st.getState().ui.layout.canvasPaneAdjust, -140);
});

test("a stored seam position survives a reload", () => {
    const s = createInitialState({ layoutAdjustments: { canvasPaneAdjust: 96 } });
    assert.equal(s.ui.layout.canvasPaneAdjust, 96);
});

test("a non-numeric seam position degrades to the even split", () => {
    const s = createInitialState({ layoutAdjustments: { canvasPaneAdjust: "wide" } });
    assert.equal(s.ui.layout.canvasPaneAdjust, 0);
});

// ─── Canvas markers in the session list ──────────────────────────

test("a session with no canvas gets no marker", () => {
    const s = createInitialState();
    assert.equal(sessionCanvasMark(s, "s1"), null);
    assert.equal(sessionCanvasMark(s, null), null, "a missing id must not throw");
});

test("a drawn canvas marks the row, and a change marks it unseen", () => {
    const base = createInitialState();
    const withCanvas = (entry, prefs) => ({
        ...base,
        canvas: { ...base.canvas, bySessionId: { s1: entry }, prefs: prefs ? { s1: prefs } : {} },
    });

    // Drawn, never looked at.
    assert.equal(sessionCanvasMark(withCanvas({ latestRev: 1, sizeBytes: 40 }), "s1"), "unseen");
    // Looked at, nothing new since.
    assert.equal(
        sessionCanvasMark(withCanvas({ latestRev: 3, sizeBytes: 40 }, { lastViewedRev: 3 }), "s1"),
        "canvas",
    );
    // Redrawn after the last look.
    assert.equal(
        sessionCanvasMark(withCanvas({ latestRev: 4, sizeBytes: 40 }, { lastViewedRev: 3 }), "s1"),
        "unseen",
    );
    // A DATA tick counts as a change too — the canvas can update without a new
    // revision, and the marker is the only sign of it in the list.
    assert.equal(
        sessionCanvasMark(
            withCanvas({ latestRev: 3, latestDataRev: 9, sizeBytes: 40 }, { lastViewedRev: 3, lastViewedDataRev: 8 }),
            "s1",
        ),
        "unseen",
    );
});

test("a cleared canvas stops marking the row", () => {
    // draw_canvas("") sets sizeBytes 0. The session no longer HAS a canvas, so
    // a marker would send the reader to an empty pane.
    const base = createInitialState();
    const s = {
        ...base,
        canvas: { ...base.canvas, bySessionId: { s1: { latestRev: 5, sizeBytes: 0 } }, prefs: {} },
    };
    assert.equal(sessionCanvasMark(s, "s1"), null);
});

test("an unknown size is presumed drawn", () => {
    // sizeBytes null comes from a degraded snapshot. A marker that is
    // occasionally early beats one that silently never appears.
    const base = createInitialState();
    const s = {
        ...base,
        canvas: { ...base.canvas, bySessionId: { s1: { latestRev: 2, sizeBytes: null } }, prefs: { s1: { lastViewedRev: 2 } } },
    };
    assert.equal(sessionCanvasMark(s, "s1"), "canvas");
});

test("the marker describes the session, not the layout", () => {
    // Unlike the toolbar badge, it does not go quiet just because the canvas
    // column happens to be open — the list answers for every session at once.
    const base = createInitialState();
    const s = {
        ...base,
        ui: { ...base.ui, canvasOpen: true },
        canvas: { ...base.canvas, bySessionId: { s1: { latestRev: 7, sizeBytes: 12 } }, prefs: {} },
    };
    assert.equal(sessionCanvasMark(s, "s1"), "unseen");
});
