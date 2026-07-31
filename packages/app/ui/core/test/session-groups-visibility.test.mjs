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
    // must NOT pop out to the root level — but it must not vanish either. A
    // stand-in folder holds it until the real row returns.
    store.dispatch({ type: "sessions/groupsLoaded", groups: [] });
    const rows = selectSessionRows(store.getState());
    const child = rows.find((row) => row.sessionId === "child");
    assert.ok(child, "the member stays visible");
    assert.ok(child.depth > 0, "a grouped session never appears at top level");
    assert.ok(rows.some((row) => row.sessionId === "group:g1" && row.depth === 0),
        "a stand-in folder holds it");
});

test("members never vanish when their folder row is missing", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/principal", principal: me });
    // Sessions arrive already filed into a folder we have NOT fetched yet —
    // the state right after a move, or any tick where the group fetch lags.
    store.dispatch({
        type: "sessions/loaded",
        sessions: [
            { sessionId: "a", title: "filed one", status: "idle", groupId: "g-unknown", owner: me },
            { sessionId: "b", title: "filed two", status: "idle", groupId: "g-unknown", owner: me },
            { sessionId: "loose", title: "loose", status: "idle", owner: me },
        ],
    });

    const ids = selectSessionRows(store.getState()).map((row) => row.sessionId);
    assert.ok(ids.includes("group:g-unknown"), "a stand-in folder appears for the unknown group");
    assert.ok(ids.includes("a") && ids.includes("b"), "its members stay visible instead of disappearing");
    assert.ok(ids.includes("loose"));

    // Depth proves containment still holds: members sit UNDER the folder.
    const rows = selectSessionRows(store.getState());
    const folder = rows.find((row) => row.sessionId === "group:g-unknown");
    const member = rows.find((row) => row.sessionId === "a");
    assert.equal(folder.depth, 0);
    assert.ok(member.depth > folder.depth, "members render inside the folder, not beside it");

    // The real folder arrives and replaces the stand-in, title and all.
    store.dispatch({
        type: "sessions/groupsLoaded",
        groups: [{ sessionId: "group:g-unknown", groupId: "g-unknown", isGroup: true, title: "Real Name", status: "group", memberCount: 2, createdAt: 1, updatedAt: 2 }],
    });
    const after = selectSessionRows(store.getState());
    const real = after.find((row) => row.sessionId === "group:g-unknown");
    assert.match(real.text || real.runs?.map((r) => r.text).join("") || "", /Real Name/);
    assert.equal(after.filter((row) => row.sessionId === "group:g-unknown").length, 1, "no duplicate folder row");
});
