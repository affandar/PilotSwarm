/**
 * The [+N] hidden-descendant badge survives a clipped title.
 *
 * The portal clamps `.ps-session-row-title__text` with
 * `overflow:hidden; text-overflow:ellipsis`. The badge trails the title, so on
 * a narrow session pane it was the FIRST thing ellipsized away — and the count
 * of hidden children is shown nowhere else, so a collapsed parent with four
 * sub-agents rendered exactly like a childless leaf.
 *
 * The fix tags the badge run `role: "collapseBadge"` so the renderer can lift
 * it out of the clamped span and pin it beside the ctx column. This test locks
 * that contract: the tag is what the portal splits on, and the badge must stay
 * inside titleRuns so the TUI's flat runs keep it inline exactly where it was.
 *
 * Run: node --test test/collapse-badge-clipping.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectSessionRows } from "../src/selectors.js";

const PARENT = { sessionId: "p", title: "HDB Test Lead Builder · Agent Manager", createdAt: 100, updatedAt: 100 };
const KIDS = [1, 2, 3, 4].map((i) => ({
    sessionId: `k${i}`,
    title: `kid${i}`,
    parentSessionId: "p",
    createdAt: 200 + i,
    updatedAt: 200 + i,
}));

function collapsedParentRow() {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT, ...KIDS] });
    state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: ["p"] } });
    return selectSessionRows(state).find((row) => row.sessionId === "p");
}

test("the collapse badge is tagged so a clipping renderer can pin it", () => {
    const row = collapsedParentRow();
    const badges = row.titleRuns.filter((run) => run?.role === "collapseBadge");

    assert.equal(badges.length, 1, "expected exactly one tagged collapse-badge run");
    assert.match(badges[0].text, /\[\+4\]/, "badge should report the four hidden children");
});

test("splitting on the tag leaves the title intact and the badge whole", () => {
    const row = collapsedParentRow();
    // Exactly what the portal does before it clamps the title span.
    const clamped = row.titleRuns.filter((run) => run?.role !== "collapseBadge");
    const pinned = row.titleRuns.filter((run) => run?.role === "collapseBadge");

    const clampedText = clamped.map((run) => run.text).join("");
    assert.ok(clampedText.includes("HDB Test Lead Builder"), "title text must survive the split");
    assert.ok(!clampedText.includes("[+4]"), "badge must not remain in the clamped span");
    assert.match(pinned.map((run) => run.text).join(""), /\[\+4\]/, "pinned element carries the badge");
});

test("the badge stays inline in titleRuns for renderers that do not clip", () => {
    const row = collapsedParentRow();
    // The TUI renders the flat `runs`; the badge must still sit right after the
    // title there, not be relocated to the end of the row.
    const titleIndex = row.titleRuns.findIndex((run) => String(run?.text || "").includes("HDB Test Lead Builder"));
    const badgeIndex = row.titleRuns.findIndex((run) => run?.role === "collapseBadge");

    assert.ok(titleIndex >= 0 && badgeIndex >= 0, "both runs present");
    assert.equal(badgeIndex, titleIndex + 1, "badge should directly follow the title run");
    assert.match(row.runs.map((run) => run.text).join(""), /HDB Test Lead Builder · Agent Manager \[\+4\]/);
});

test("an expanded parent shows no badge (nothing is hidden)", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT, ...KIDS] });
    // Parents load collapsed, so expanding is explicit: with every child
    // visible in its own row there is nothing hidden left to count.
    state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: [] } });
    const row = selectSessionRows(state).find((r) => r.sessionId === "p");

    assert.equal(
        row.titleRuns.filter((run) => run?.role === "collapseBadge").length,
        0,
        "expanded parent hides no children, so it must not carry a badge",
    );
});
