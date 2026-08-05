/**
 * A parent blocked on its sub-agents must not read as plain "idle".
 *
 * A session that delegates goes idle the moment its own turn ends, while the
 * children it spawned keep working. The list rendered that as a dormant row,
 * indistinguishable from a session with nothing to do — so a fan-out that was
 * running fine looked stalled.
 *
 * The distinguishing signal cannot be "has children": sub-agents deliberately
 * stay alive and IDLE after finishing their task, waiting for follow-up (see
 * managed-session's spawn_agent contract). A parent whose children have all
 * finished would then be stuck in the new state permanently. Only
 * running/input_required descendants count.
 *
 * Run: node --test test/awaiting-children-status.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectChatPaneChrome, selectSessionRows } from "../src/selectors.js";

const session = (sessionId, status, extra = {}) => ({
    sessionId,
    title: sessionId,
    status,
    createdAt: 100,
    updatedAt: 100,
    ...extra,
});

function loaded(sessions) {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

const rowFor = (state, sessionId) => selectSessionRows(state).find((row) => row.sessionId === sessionId);
const countFor = (state, sessionId) => state.sessions.byId[sessionId]?.activeChildCount;

// The list row carries the status as a glyph + colour; the spelled-out label
// lives in the selected-session header (buildSelectedSessionMetaRuns). Both
// read the DEBOUNCED row status, so a transition mid-session is only visible
// through rowVisualStatusCandidate until the hold expires.
const headerLabelFor = (state, sessionId) => {
    const chrome = selectChatPaneChrome({
        ...state,
        sessions: { ...state.sessions, activeSessionId: sessionId },
    });
    return (chrome?.titleRight || []).map((run) => run?.text || "").join("");
};

test("an idle parent with a running child is not just idle", () => {
    const state = loaded([
        session("parent", "idle"),
        session("child", "running", { parentSessionId: "parent" }),
    ]);

    assert.equal(countFor(state, "parent"), 1);
    assert.equal(rowFor(state, "parent").statusColor, "magenta");
    assert.match(rowFor(state, "parent").text, /^>/);
    assert.match(headerLabelFor(state, "parent"), /waiting on 1/);
});

test("finished sub-agents stay alive and idle, and must not hold the parent there", () => {
    // The whole reason the count is status-filtered rather than a child count.
    const state = loaded([
        session("parent", "idle"),
        session("child", "idle", { parentSessionId: "parent" }),
        session("other", "completed", { parentSessionId: "parent" }),
    ]);

    assert.equal(countFor(state, "parent"), undefined);
    assert.doesNotMatch(headerLabelFor(state, "parent"), /waiting on/);
    assert.equal(rowFor(state, "parent").statusColor, "white");
});

test("a child blocked on a question still counts — the parent is waiting on it", () => {
    const state = loaded([
        session("parent", "idle"),
        session("child", "input_required", { parentSessionId: "parent" }),
    ]);

    assert.equal(countFor(state, "parent"), 1);
});

test("the count is transitive, so a whole delegation chain lights up", () => {
    // Without this, a parent whose direct child is itself only waiting on a
    // grandchild reads as idle, and the delegation looks dead from the top.
    const state = loaded([
        session("grandparent", "idle"),
        session("parent", "idle", { parentSessionId: "grandparent" }),
        session("worker", "running", { parentSessionId: "parent" }),
    ]);

    assert.equal(countFor(state, "grandparent"), 1);
    assert.equal(countFor(state, "parent"), 1);
    assert.equal(rowFor(state, "grandparent").statusColor, "magenta");
});

test("the label counts every active descendant, not just direct children", () => {
    const state = loaded([
        session("parent", "idle"),
        session("a", "running", { parentSessionId: "parent" }),
        session("b", "running", { parentSessionId: "a" }),
        session("c", "input_required", { parentSessionId: "parent" }),
        session("done", "completed", { parentSessionId: "parent" }),
    ]);

    assert.equal(countFor(state, "parent"), 3);
    assert.match(headerLabelFor(state, "parent"), /waiting on 3/);
});

test("a parent that is itself running keeps reading as running", () => {
    const state = loaded([
        session("parent", "running"),
        session("child", "running", { parentSessionId: "parent" }),
    ]);

    assert.equal(rowFor(state, "parent").statusColor, "green");
});

test("a scheduled session keeps reading as scheduled", () => {
    // cron_waiting is checked first: "this fires again on a timer" outranks
    // "something is running below" for a row the user reads as dormant.
    const state = loaded([
        session("cron", "idle", { cronActive: true }),
        session("child", "running", { parentSessionId: "cron" }),
    ]);

    assert.equal(rowFor(state, "cron").statusColor, "yellow");
    assert.doesNotMatch(headerLabelFor(state, "cron"), /waiting on/);
});

test("the parent leaves the state when the last child stops", () => {
    let state = loaded([
        session("parent", "idle"),
        session("child", "running", { parentSessionId: "parent" }),
    ]);
    assert.equal(countFor(state, "parent"), 1);

    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("parent", "idle"),
        session("child", "completed", { parentSessionId: "parent" }),
    ] });

    assert.equal(countFor(state, "parent"), undefined);
});

test("a single-session merge updates the ancestor, not only the row that moved", () => {
    // sessions/merged carries one session. The parent's status depends on it,
    // and the parent is not in the payload — re-deriving only the merged row
    // would leave the parent stale until the next full listing.
    let state = loaded([
        session("parent", "idle"),
        session("child", "idle", { parentSessionId: "parent" }),
    ]);
    assert.equal(countFor(state, "parent"), undefined);

    state = appReducer(state, {
        type: "sessions/merged",
        session: session("child", "running", { parentSessionId: "parent" }),
    });

    assert.equal(countFor(state, "parent"), 1);
    // The visible flip is held for 5s by mergeSessionRowVisualStatus so the
    // list does not flap when the 4s poll and the live event disagree. What
    // this test pins is that the transition is QUEUED for the parent at all —
    // deriving only the merged row would leave it stale until the next full
    // listing, which is the bug.
    assert.equal(state.sessions.byId.parent.rowVisualStatusCandidate, "awaiting_children");
});

test("evicting the last running child clears the parent immediately", () => {
    // sessions/gone names only the evicted row. The ancestor whose status
    // depends on it is not in the action, so without re-deriving there, the
    // parent reads "waiting on 1" with nothing left to wait for until the next
    // poll — up to four seconds of a visibly wrong row.
    let state = loaded([
        session("parent", "idle"),
        session("child", "running", { parentSessionId: "parent" }),
    ]);
    assert.equal(countFor(state, "parent"), 1);

    state = appReducer(state, { type: "sessions/gone", sessionId: "child" });

    assert.equal(state.sessions.byId.child, undefined, "the row is gone");
    assert.equal(countFor(state, "parent"), undefined, "and so is the count that depended on it");
});

test("a malformed parent chain does not hang the reducer", () => {
    const state = loaded([
        session("a", "idle", { parentSessionId: "b" }),
        session("b", "idle", { parentSessionId: "a" }),
        session("worker", "running", { parentSessionId: "a" }),
    ]);

    assert.equal(countFor(state, "a"), 1);
    assert.equal(countFor(state, "b"), 1);
});

test("folders are not sessions and never claim to be waiting", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, {
        type: "sessions/groupsLoaded",
        groups: [{ sessionId: "group:g1", groupId: "g1", title: "Folder", isGroup: true }],
    });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("member", "running", { groupId: "g1" }),
    ] });

    assert.equal(countFor(state, "group:g1"), undefined);
});
