/**
 * Manual session ordering — the reducer half: the move itself, and its
 * persistence through profile settings.
 *
 * Run: node --test test/session-reorder-action.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

function seededState(sessions) {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

const order = (state) => state.sessions.flat.map((entry) => entry.sessionId);

/** Three top-level sessions, oldest → newest, so they render a, b, c. */
const THREE = [
    { sessionId: "a", title: "alpha", createdAt: 1000, updatedAt: 1000 },
    { sessionId: "b", title: "bravo", createdAt: 2000, updatedAt: 2000 },
    { sessionId: "c", title: "charlie", createdAt: 3000, updatedAt: 3000 },
];

test("moving a row before another puts it exactly there", () => {
    let state = seededState(THREE);
    assert.deepEqual(order(state), ["a", "b", "c"]);

    state = appReducer(state, { type: "sessions/reorder", sessionId: "c", beforeSessionId: "a" });
    assert.deepEqual(order(state), ["c", "a", "b"]);
});

test("a null target moves the row to the end", () => {
    let state = seededState(THREE);
    state = appReducer(state, { type: "sessions/reorder", sessionId: "a", beforeSessionId: null });
    assert.deepEqual(order(state), ["b", "c", "a"]);
});

test("the FIRST move seeds from what is on screen, so nothing else shifts", () => {
    // The subtle one. Before any drag the stored list is empty; if the move
    // recorded only the dragged row, every other row would become "unplaced"
    // and re-sort beneath it. Seeding from the rendered order keeps the list
    // looking like it did, with one row relocated.
    let state = seededState(THREE);
    state = appReducer(state, { type: "sessions/reorder", sessionId: "b", beforeSessionId: "a" });

    assert.deepEqual(order(state), ["b", "a", "c"]);
    assert.deepEqual(state.sessions.manualOrder, ["b", "a", "c"], "the whole visible order should be recorded");
});

test("a second move edits the existing list rather than reseeding", () => {
    let state = seededState(THREE);
    state = appReducer(state, { type: "sessions/reorder", sessionId: "c", beforeSessionId: "a" });
    state = appReducer(state, { type: "sessions/reorder", sessionId: "b", beforeSessionId: "c" });
    assert.deepEqual(order(state), ["b", "c", "a"]);
});

test("a new session arrives at the END, after every placed row", () => {
    let state = seededState(THREE);
    state = appReducer(state, { type: "sessions/reorder", sessionId: "c", beforeSessionId: "a" });

    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [...THREE, { sessionId: "new", title: "newest", createdAt: 9000, updatedAt: 9000 }],
    });
    assert.deepEqual(order(state), ["c", "a", "b", "new"]);
});

test("sub-agents and the system root refuse to move", () => {
    let state = seededState([
        { sessionId: "root", title: "PilotSwarm Agent", isSystem: true, createdAt: 1, updatedAt: 1 },
        { sessionId: "parent", title: "parent", createdAt: 100, updatedAt: 100 },
        { sessionId: "kid", title: "child", parentSessionId: "parent", createdAt: 200, updatedAt: 200 },
    ]);
    const before = order(state);

    const afterKid = appReducer(state, { type: "sessions/reorder", sessionId: "kid", beforeSessionId: "parent" });
    assert.equal(afterKid, state, "a sub-agent move should be a no-op");

    const afterRoot = appReducer(state, { type: "sessions/reorder", sessionId: "root", beforeSessionId: null });
    assert.equal(afterRoot, state, "moving the system root should be a no-op");
    assert.deepEqual(order(state), before);
});

test("a move that changes nothing returns the same state object", () => {
    let state = seededState(THREE);
    state = appReducer(state, { type: "sessions/reorder", sessionId: "a", beforeSessionId: "b" });
    const settled = appReducer(state, { type: "sessions/reorder", sessionId: "a", beforeSessionId: "b" });
    assert.equal(settled, state, "a no-op move must not churn the tree");
});

test("the order round-trips through profile settings", () => {
    let state = seededState(THREE);
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { sessionOrder: ["c", "b", "a"] },
    });
    assert.deepEqual(state.sessions.manualOrder, ["c", "b", "a"]);
    assert.deepEqual(order(state), ["c", "b", "a"]);
});

test("a stored order naming unknown sessions is kept, not pruned", () => {
    // Written on a desktop that can see the whole fleet; read on a surface
    // that cannot. Pruning here would let the smaller surface erase the
    // larger one's placements on its next save.
    let state = seededState(THREE);
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { sessionOrder: ["elsewhere", "c", "a", "b"] },
    });
    assert.ok(state.sessions.manualOrder.includes("elsewhere"), "unknown id was dropped");
    assert.deepEqual(order(state), ["c", "a", "b"]);
});
