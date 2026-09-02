// selectCanvasView keeps its identity across unrelated state changes.
//
// WHY THIS EXISTS: the view carries a `slots` array. Built fresh on every
// call, it failed every shallow-equal subscriber on every dispatch — and the
// subscribers are the app root and the toolbar, so a keystroke in the
// composer re-rendered the session list, the transcript and every text run.
import test from "node:test";
import assert from "node:assert/strict";
import { selectCanvasView } from "../src/selectors.js";
import { canvasKey } from "../src/state.js";

function makeState(overrides = {}) {
    return {
        sessions: { activeSessionId: "s1", byId: {} },
        canvas: { bySessionId: { [canvasKey("s1", 1)]: { latestRev: 3, sizeBytes: 120, name: "report" } }, prefs: {} },
        ui: { canvasSlot: 1, canvasOpen: false, prompt: "" },
        ...overrides,
    };
}

test("the same canvas inputs return the same view object", () => {
    const base = makeState();
    const a = selectCanvasView(base);
    // A keystroke: ui changes, the canvas slices do not.
    const b = selectCanvasView({ ...base, ui: { ...base.ui, prompt: "hello" } });
    assert.equal(b, a, "an unrelated ui change produced a new canvas view");
    assert.equal(a.slots.length, 1);
});

test("a canvas change still produces a new view", () => {
    const base = makeState();
    const a = selectCanvasView(base);
    const b = selectCanvasView({ ...base, canvas: { ...base.canvas, bySessionId: { [canvasKey("s1", 1)]: { latestRev: 4, sizeBytes: 130, name: "report" } } } });
    assert.notEqual(b, a);
    assert.equal(b.slots[0].latestRev, 4);
    const c = selectCanvasView({ ...base, ui: { ...base.ui, canvasOpen: true } });
    assert.notEqual(c, a);
    assert.equal(c.mode, "canvas");
    // The agent's flip tick moves with NO other key changing (a redraw of the
    // already-open slot); the phone opens its canvas tab off it.
    const d = selectCanvasView({ ...base, canvas: { ...base.canvas, flipSeq: 7 } });
    assert.notEqual(d, a, "a flipSeq change must not be served from cache");
    assert.equal(d.flipSeq, 7);
});
