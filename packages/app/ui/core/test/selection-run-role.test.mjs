/**
 * The multi-select bar must not cost the row a column.
 *
 * The selector emits "▌" as a prefix run on selected rows. In the portal the
 * row already carries its own selection styling — a tinted background, an
 * inset outline and a 3px left rail — so the glyph was pure duplication that
 * consumed one character cell. The desktop session row truncates to a fixed
 * width, so a selected row truncated one character earlier than its
 * neighbours, and any row whose pin / folder / system icon landed on that
 * boundary had the icon clipped.
 *
 * The run is therefore tagged role:"selection" and the portal drops it, the
 * same contract role:"status" and role:"depth" already use. The TUI ignores
 * the tag and keeps the bar, which is why the run still exists at all.
 *
 * Run: node --test test/selection-run-role.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, selectSessionRows } from "../src/index.js";

const SESSIONS = [
    { sessionId: "s-a", title: "alpha", createdAt: 100, updatedAt: 100 },
    { sessionId: "s-b", title: "bravo", createdAt: 200, updatedAt: 200 },
];

function rowsWithSelection(selectedIds) {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: SESSIONS });
    state = appReducer(state, { type: "sessions/selectMode", enabled: true });
    for (const id of selectedIds) {
        state = appReducer(state, { type: "sessions/selectToggle", sessionId: id });
    }
    const out = new Map();
    for (const row of selectSessionRows(state)) {
        if (row?.sessionId) out.set(row.sessionId, row);
    }
    return out;
}

const runsOf = (row) => (Array.isArray(row?.runs) ? row.runs : []);
const selectionRuns = (row) => runsOf(row).filter((r) => r?.role === "selection");
/** What a host that strips tagged runs actually lays out. */
const laidOut = (row) => runsOf(row).filter((r) => r?.role !== "selection" && r?.role !== "depth");

test("a selected row's bar is tagged role:selection", () => {
    const rows = rowsWithSelection(["s-a"]);
    const marks = selectionRuns(rows.get("s-a"));
    assert.equal(marks.length, 1, "selected row lost its selection run");
    assert.equal(marks[0].text, "▌");
});

test("an unselected row has no selection run", () => {
    const rows = rowsWithSelection(["s-a"]);
    assert.deepEqual(selectionRuns(rows.get("s-b")), []);
});

test("stripping the tag leaves selected and unselected rows the SAME width", () => {
    // The regression: without the tag the selected row carried one extra cell,
    // so it truncated earlier and clipped whatever icon sat on the boundary.
    const rows = rowsWithSelection(["s-a"]);
    const width = (row) => laidOut(row).map((r) => r.text || "").join("").length;
    assert.equal(
        width(rows.get("s-a")),
        width(rows.get("s-b")),
        "selected row is still wider than its neighbour once the bar is stripped",
    );
});

test("the bar is still present for hosts that render it (the TUI)", () => {
    // Deleting the run outright would silently remove the TUI's only
    // selection affordance, so the tag — not removal — is the fix.
    const rows = rowsWithSelection(["s-a", "s-b"]);
    for (const id of ["s-a", "s-b"]) {
        assert.equal(selectionRuns(rows.get(id)).length, 1, `${id} lost its bar`);
    }
});
