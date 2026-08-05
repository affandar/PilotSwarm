/**
 * Folders can be rearranged, and rearranging never crosses a band.
 *
 * The reducer and the sort already allowed it — a folder row is manually
 * orderable and its order container is "folders". What blocked it was the
 * gesture: a folder row carries a `groupId` of its OWN (its id), and
 * resolveDropIntent fed that through the filing branches. Over another folder
 * it read as "file this folder into that one"; anywhere else it read as "take
 * it out of the folder it is in". Neither is a thing a folder can do, so a
 * folder could never once be reordered. That fix lives in web-app; this file
 * pins the ordering contract underneath it.
 *
 * The uber-order is structural and outranks every placement:
 *
 *     system → pinned folders → pinned sessions → folders → loose sessions
 *
 * Manual placement orders SIBLINGS inside a band. A stored list that would
 * move a row across one must be ignored, not honoured — the bands are the
 * shape of the list, not a default the user can override by dragging.
 *
 * Run: node --test test/group-reorder.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { manualOrderContainerKey } from "../src/selectors.js";

const group = (id, title) => ({ sessionId: `group:${id}`, groupId: id, isGroup: true, title });
const session = (sessionId, extra = {}) => ({
    sessionId,
    title: sessionId,
    status: "idle",
    createdAt: 100,
    updatedAt: 100,
    ...extra,
});

function loaded() {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, {
        type: "sessions/groupsLoaded",
        groups: [group("a", "Alpha"), group("b", "Beta"), group("c", "Gamma")],
    });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            session("sys", { isSystem: true, createdAt: 1 }),
            session("member", { groupId: "a", createdAt: 20 }),
            session("loose", { createdAt: 500 }),
        ],
    });
    // Folders arrive COLLAPSED; open the one whose members these tests read.
    state = appReducer(state, { type: "sessions/expand", sessionId: "group:a" });
    return state;
}

const ids = (state) => state.sessions.flat.map((entry) => entry.sessionId);
const reorder = (state, sessionId, beforeSessionId) =>
    appReducer(state, { type: "sessions/reorder", sessionId, beforeSessionId });

test("a folder can be moved before another folder", () => {
    const state = reorder(loaded(), "group:c", "group:a");
    assert.deepEqual(ids(state), ["sys", "group:c", "group:a", "member", "group:b", "loose"]);
});

test("a folder can be moved to the end of the folders", () => {
    // beforeSessionId null means "last among your siblings".
    const state = reorder(loaded(), "group:a", null);
    assert.deepEqual(
        ids(state).filter((id) => id.startsWith("group:")),
        ["group:b", "group:c", "group:a"],
    );
});

test("a folder's members travel with it", () => {
    const state = reorder(loaded(), "group:a", null);
    const flat = ids(state);
    assert.equal(flat[flat.indexOf("group:a") + 1], "member", "the member stays under its folder");
});

test("a loose session dropped among the folders still sorts below them", () => {
    // The stored list is global and flat, so it CAN name a cross-band
    // placement. The band comparison runs first and wins.
    const state = reorder(loaded(), "loose", "group:a");
    assert.equal(ids(state).at(-1), "loose");
    assert.ok(state.sessions.manualOrder.indexOf("loose") < state.sessions.manualOrder.indexOf("group:a"),
        "the placement IS stored — it is the sort that declines to honour it across a band");
});

test("a folder dropped among loose sessions still sorts above them", () => {
    const state = reorder(loaded(), "group:b", null);
    const flat = ids(state);
    assert.ok(flat.indexOf("group:b") < flat.indexOf("loose"));
});

test("pinning lifts a folder out of the folder band, and placements survive it", () => {
    let state = reorder(loaded(), "group:c", "group:a");
    state = appReducer(state, { type: "sessions/pinToggle", sessionId: "group:b" });
    assert.deepEqual(
        ids(state).filter((id) => id.startsWith("group:")),
        ["group:b", "group:c", "group:a"],
        "pinned folder first; the c-before-a placement is untouched underneath it",
    );

    state = appReducer(state, { type: "sessions/pinToggle", sessionId: "group:b" });
    assert.deepEqual(
        ids(state).filter((id) => id.startsWith("group:")),
        ["group:c", "group:a", "group:b"],
        "unpinning drops it back into the folder band",
    );
});

test("the system row cannot be placed", () => {
    const before = loaded();
    const after = reorder(before, "sys", "group:a");
    assert.equal(after, before, "an immovable row is refused outright, not stored and ignored");
});

test("a sub-agent cannot be placed", () => {
    let state = loaded();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [
            session("sys", { isSystem: true, createdAt: 1 }),
            session("member", { groupId: "a", createdAt: 20 }),
            session("loose", { createdAt: 500 }),
            session("child", { parentSessionId: "loose", createdAt: 600 }),
        ],
    });
    state = appReducer(state, { type: "sessions/expand", sessionId: "group:a" });
    const after = reorder(state, "child", "loose");
    assert.equal(after, state, "a sub-agent's place is the shape of the run, not a preference");
});

test("folders reorder among themselves without disturbing sessions inside a folder", () => {
    let state = appReducer(loaded(), {
        type: "sessions/loaded",
        sessions: [
            session("sys", { isSystem: true, createdAt: 1 }),
            session("member", { groupId: "a", createdAt: 20 }),
            session("member2", { groupId: "a", createdAt: 30 }),
            session("loose", { createdAt: 500 }),
        ],
    });
    state = appReducer(state, { type: "sessions/expand", sessionId: "group:a" });
    state = reorder(state, "member2", "member");
    state = reorder(state, "group:c", "group:a");

    const flat = ids(state);
    assert.deepEqual(flat.slice(flat.indexOf("group:a"), flat.indexOf("group:a") + 3),
        ["group:a", "member2", "member"],
        "the members keep the order the user gave them",
    );
    assert.ok(flat.indexOf("group:c") < flat.indexOf("group:a"));
});

test("a pinned folder and a pinned session do not share a drag container", () => {
    // They are SEPARATE bands (pinned folders rank above pinned sessions), so
    // one shared container let the drag offer drop positions among the pinned
    // sessions that the sort then refused — the folder landed somewhere other
    // than the insertion line the user aimed at.
    const pinnedFolder = manualOrderContainerKey({ sessionId: "group:a", groupId: "a", isGroup: true }, true);
    const pinnedSession = manualOrderContainerKey({ sessionId: "s1" }, true);
    assert.notEqual(pinnedFolder, pinnedSession);

    // Unpinned containers are unchanged.
    assert.equal(manualOrderContainerKey({ sessionId: "group:a", groupId: "a", isGroup: true }), "folders");
    assert.equal(manualOrderContainerKey({ sessionId: "s1", groupId: "a" }), "g:a");
    assert.equal(manualOrderContainerKey({ sessionId: "s1" }), "");
});
