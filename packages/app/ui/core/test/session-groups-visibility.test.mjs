/**
 * A session group is the viewer's OWN private organization, so an owner
 * filter must never hide it. The server lists only your groups and the row
 * carries no owner, so any filter narrower than "all" used to drop the
 * folder while its member sessions stayed visible at top level — the
 * "created a group, it flickers in then vanishes" bug.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore, selectSessionRows } from "../src/index.js";

const me = { provider: "entra", subject: "user-1" };
const groupRow = {
    sessionId: "group:g1", groupId: "g1", isGroup: true, title: "Test Group",
    status: "group", owner: null, memberCount: 7, createdAt: 1, updatedAt: 2,
};
const mine = { sessionId: "s1", title: "mine", status: "idle", owner: me };

function rowsWith(filter) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/principal", principal: me });
    store.dispatch({ type: "sessions/loaded", sessions: [groupRow, mine] });
    store.dispatch({ type: "sessions/ownerFilter", filter });
    return selectSessionRows(store.getState()).map((row) => row.sessionId);
}

test("an ownerless group row survives every owner filter", () => {
    for (const [label, filter] of [
        ["all", { all: true }],
        ["mine only", { all: false, includeMe: true }],
        ["shared only", { all: false, includeShared: true }],
        ["explicit owner keys", { all: false, ownerKeys: ["entra:someone-else"] }],
        ["system only", { all: false, includeSystem: true }],
    ]) {
        assert.ok(rowsWith(filter).includes("group:g1"), `group must stay visible under "${label}"`);
    }
});

test("the filter still applies to the group's members", () => {
    const shown = rowsWith({ all: false, ownerKeys: ["entra:someone-else"] });
    assert.equal(shown.includes("s1"), false, "a session owned by someone else is still filtered out");
});

test("a session refresh that carries no folders does not delete them", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/principal", principal: me });
    store.dispatch({ type: "sessions/groupsLoaded", groups: [groupRow] });
    store.dispatch({ type: "sessions/loaded", sessions: [mine] });

    // This is the flicker: the catalog refresh rebuilds byId from its payload,
    // which never contains folders. They must survive it.
    assert.ok(selectSessionRows(store.getState()).map((r) => r.sessionId).includes("group:g1"),
        "folder survives a session refresh that omits it");

    // Repeated refreshes keep it — the state slice is the source of truth.
    store.dispatch({ type: "sessions/loaded", sessions: [mine] });
    store.dispatch({ type: "sessions/loaded", sessions: [mine] });
    assert.ok(selectSessionRows(store.getState()).map((r) => r.sessionId).includes("group:g1"));

    // Only a successful group fetch removes a folder.
    store.dispatch({ type: "sessions/groupsLoaded", groups: [] });
    assert.equal(selectSessionRows(store.getState()).map((r) => r.sessionId).includes("group:g1"), false,
        "deleting the folder server-side does remove it");
});

test("clicking empty space clears the list highlight but keeps the session attached", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [mine] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.equal(selectSessionRows(store.getState())[0].active, true);

    store.dispatch({ type: "sessions/listDeselect" });
    assert.equal(selectSessionRows(store.getState())[0].active, false, "no row is highlighted");
    assert.equal(store.getState().sessions.activeSessionId, "s1",
        "the session stays attached so chat/inspector keep rendering it");

    // Selecting a row re-arms the highlight.
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.equal(selectSessionRows(store.getState())[0].active, true);
});

test("a session inside a folder is never listed at top level, even mid-refresh", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/groupsLoaded", groups: [groupRow] });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "child", title: "in folder", status: "idle", groupId: "g1" }] });
    // Folder removed from the tree for a beat (the old flicker): its member
    // must NOT pop out to the root level.
    store.dispatch({ type: "sessions/groupsLoaded", groups: [] });
    const rows = selectSessionRows(store.getState()).map((row) => row.sessionId);
    assert.equal(rows.includes("child"), false, "a grouped session never appears outside its folder");
});
