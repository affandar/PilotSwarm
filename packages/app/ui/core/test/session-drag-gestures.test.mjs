/**
 * Two drag defects in the session list, pinned at the source.
 *
 * 1. A FOLDER could never be reordered. `resolveDropIntent` reads
 *    `pending.ownGroupId` — the group the dragged row lives in — to tell
 *    filing from reordering. A folder row's `groupId` is its OWN id, so over
 *    another folder the gesture read as "file this folder into that one" and
 *    anywhere else as "take it out of the folder it is in". Both branches fire
 *    before reorder is ever considered, so no drop position could reach it.
 *
 * 2. Auto-scroll pushed the wrong element. The scroller was resolved from
 *    `[data-session-scroll]`, which is only stamped on the pane while it holds
 *    focus — and the pane and the list inside it BOTH declare overflow, so
 *    which one actually scrolls depends on how the flex layout resolved. When
 *    it picked the one whose scrollHeight equals its clientHeight, `scrollTop
 *    +=` was silently a no-op and the list sat still while you dragged past
 *    its edge.
 *
 * Source-shape assertions: both live in pointer handlers that need a real DOM
 * with layout and a live drag, which the server-rendered smoke test (effects
 * never run) cannot provide. The reducer-level ordering contract is covered
 * separately in group-reorder.test.mjs.
 *
 * Run: node --test test/session-drag-gestures.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
    fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)),
    "utf8",
);

function block(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `${startMarker} not found — did it get renamed?`);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
    return source.slice(start, end);
}

const resolveDropIntent = block("const resolveDropIntent = React.useCallback(", "}, [resolveDropGroup");
const updateAutoScroll = block("const updateAutoScroll = React.useCallback(", "stopAutoScroll]);");

test("a folder's gesture is decided before the filing branches run", () => {
    const groupBranch = resolveDropIntent.indexOf("pending?.isGroup");
    const fileBranch = resolveDropIntent.indexOf('kind: "file"');
    const unfileBranch = resolveDropIntent.indexOf('kind: "unfile"');
    assert.notEqual(groupBranch, -1, "the folder branch is missing");
    assert.ok(groupBranch < fileBranch, "a folder must not reach the filing branch");
    assert.ok(groupBranch < unfileBranch, "a folder must not reach the unfiling branch");
});

test("the folder branch can only ever produce a reorder or nothing", () => {
    const branch = resolveDropIntent.slice(
        resolveDropIntent.indexOf("pending?.isGroup"),
        resolveDropIntent.indexOf("const ownGroupId"),
    );
    assert.match(branch, /kind: "reorder"/);
    assert.match(branch, /kind: "none"/);
    assert.doesNotMatch(branch, /kind: "file"/, "a folder cannot be filed into anything");
    assert.doesNotMatch(branch, /kind: "unfile"/, "a folder is not inside anything to be removed from");
});

test("the drag carries isGroup, or the branch above can never fire", () => {
    // `pending` is built once in onPointerDown; a field the branch reads but
    // the armed object never sets is undefined forever, and silently so.
    const armed = block("const armed = {", "const onMove = (moveEvent)");
    assert.match(armed, /isGroup: Boolean\(row\.isGroup\)/);
});

test("auto-scroll targets an element that can actually scroll", () => {
    assert.match(source, /const findSessionScroller = React\.useCallback/);
    const finder = block("const findSessionScroller = React.useCallback", "}, []);");
    assert.match(finder, /scrollHeight - node\.clientHeight > 1/, "an element at its scroll extent is not the scroller");
    assert.match(finder, /overflowY/, "and neither is one that does not scroll at all");
    assert.match(finder, /sessionListRef\.current/, "walked up from the list, not resolved from the pointer");
});

test("auto-scroll no longer depends on the focus-conditional attribute", () => {
    // `[data-session-scroll]` is absent whenever the pane is not focused, which
    // made the behaviour depend on where the user had last clicked.
    assert.doesNotMatch(updateAutoScroll, /data-session-scroll/);
});

test("the speed ramp caps at full speed past the edge", () => {
    // Dragging PAST the edge is the case this feature exists for, so the ramp
    // must saturate rather than accelerate. Each branch's guard already makes
    // its numerator positive — an earlier version of this test asserted a
    // Math.max guarding against an inversion the arithmetic cannot produce,
    // which is a fix pinned in place for a bug that was never there.
    assert.match(updateAutoScroll, /Math\.min\(1, \(box\.top \+ EDGE_PX - y\) \/ EDGE_PX\)/);
    assert.match(updateAutoScroll, /Math\.min\(1, \(y - \(box\.bottom - EDGE_PX\)\) \/ EDGE_PX\)/);
    assert.doesNotMatch(updateAutoScroll, /Math\.max\(0,/, "dead clamp — both branches are already guarded positive");
});

test("the drag ghost names the gesture that will actually happen", () => {
    // The hint keyed off `overGroupId` alone. Folders always resolve to reorder
    // with a null overGroupId, so every folder drag — whose ONLY gesture is
    // reorder — read "Release to remove from folder", which is the one thing a
    // folder can never do.
    const ghost = block('className: "ps-drag-ghost__hint"', ": null;");
    assert.match(ghost, /dragState\.intent === "file"/);
    assert.match(ghost, /dragState\.intent === "reorder"/);
    assert.match(ghost, /dragState\.intent === "unfile"/);
});

test("the scroll step is refreshed every move, not captured once", () => {
    // The rAF loop reads autoScrollStep off the live pending object. If the
    // step were only written when the loop starts, the scroll would keep the
    // speed and direction it had when the pointer first crossed the edge.
    const stepWrite = updateAutoScroll.indexOf("autoScrollStep = step");
    const loopGuard = updateAutoScroll.indexOf("autoScrollRef.current != null");
    assert.notEqual(stepWrite, -1);
    assert.ok(stepWrite < loopGuard, "the step must be recorded before the already-running early-out");
});
