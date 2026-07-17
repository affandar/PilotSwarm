import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

const ALICE = { provider: "github", subject: "alice", displayName: "Alice" };
const BOB = { provider: "github", subject: "bob", displayName: "Bob" };

function makePlacementController({
    sessions = [],
    groups = [],
    placementResults = null,
    createdSessions = [],
} = {}) {
    const calls = { placeSessionsInGroup: [], createSessionGroup: [], createSession: [] };
    let createIndex = 0;
    const transport = {
        listSessions: async () => sessions.map((session) => ({ ...session })),
        listSessionGroups: async () => groups.map((group) => ({ ...group })),
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        placeSessionsInGroup: async (sessionIds, groupId) => {
            calls.placeSessionsInGroup.push([sessionIds, groupId]);
            return placementResults ?? sessionIds.map((rootSessionId) => ({ rootSessionId, placed: true, reason: null }));
        },
        createSessionGroup: async (input) => {
            calls.createSessionGroup.push(input);
            return { groupId: "ng", title: input.title };
        },
        createSession: async (options = {}) => {
            calls.createSession.push(options);
            const created = createdSessions[createIndex] || { sessionId: `new${createIndex + 1}` };
            createIndex += 1;
            return { ...created };
        },
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, calls };
}

test("catalog rows map wire viewerGroupId to the local groupId", async () => {
    const { controller, store } = makePlacementController({
        sessions: [
            { sessionId: "s1", title: "S1", status: "idle", viewerGroupId: "g1" },
            { sessionId: "s2", title: "S2", status: "idle", groupId: "stale-legacy" },
        ],
        groups: [{ groupId: "g1", title: "G1", memberCount: 1 }],
    });

    await controller.refreshSessions();

    const state = store.getState();
    assert.equal(state.sessions.byId.s1.groupId, "g1");
    assert.equal(state.sessions.byId.s2.groupId, null);

    store.dispatch({ type: "sessions/expand", sessionId: "group:g1" });
    const flat = store.getState().sessions.flat;
    assert.equal(flat.some((entry) => entry.sessionId === "s1" && entry.depth === 1), true);
    assert.equal(flat.some((entry) => entry.sessionId === "s2" && entry.depth === 0), true);
});

test("move picker allows mixed-owner selections and places via placeSessionsInGroup(sessionIds, groupId)", async () => {
    const { controller, store, calls } = makePlacementController({
        sessions: [
            { sessionId: "s1", title: "S1", status: "idle", owner: ALICE },
            { sessionId: "s2", title: "S2", status: "idle", owner: BOB },
        ],
        groups: [{ groupId: "g1", title: "G1", memberCount: 0 }],
        placementResults: [
            { rootSessionId: "s1", placed: true, reason: null },
            { rootSessionId: "s2", placed: false, reason: "system" },
        ],
    });

    await controller.refreshSessions();
    store.dispatch({ type: "sessions/selectSet", sessionIds: ["s1", "s2"] });

    const items = await controller.openMoveToGroupModal();
    assert.deepEqual(items.map((item) => item.kind), ["noGroup", "newGroup", "group"]);
    assert.equal(items[2].groupId, "g1");

    store.dispatch({ type: "ui/modalSelection", index: 2 });
    await controller.confirmSessionGroupPickerModal();

    assert.deepEqual(calls.placeSessionsInGroup, [[["s1", "s2"], "g1"]]);
    const state = store.getState();
    assert.equal(state.sessions.activeSessionId, "group:g1");
    assert.match(state.ui.statusText, /Moved 1 session to group G1/);
    assert.match(state.ui.statusText, /skipped 1 \(1 system\)/);
});

test("new-group creation omits the owner key and places the selection", async () => {
    const { controller, store, calls } = makePlacementController({
        sessions: [{ sessionId: "s1", title: "S1", status: "idle", owner: ALICE }],
        groups: [],
    });

    await controller.refreshSessions();
    store.dispatch({ type: "sessions/selectSet", sessionIds: ["s1"] });

    await controller.openMoveToGroupModal();
    store.dispatch({ type: "ui/modalSelection", index: 1 });
    await controller.confirmSessionGroupPickerModal();

    const nameModal = store.getState().ui.modal;
    assert.equal(nameModal?.type, "sessionGroupName");
    assert.equal(Object.prototype.hasOwnProperty.call(nameModal, "owner"), false);

    await controller.confirmSessionGroupNameModal();

    assert.equal(calls.createSessionGroup.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(calls.createSessionGroup[0], "owner"), false);
    assert.deepEqual(calls.createSessionGroup[0].sessionIds, ["s1"]);
    assert.deepEqual(calls.placeSessionsInGroup, [[["s1"], "ng"]]);
});

test("ungrouping dispatches placeSessionsInGroup with a null groupId", async () => {
    const { controller, store, calls } = makePlacementController({
        sessions: [{ sessionId: "s1", title: "S1", status: "idle", owner: ALICE, viewerGroupId: "g1" }],
        groups: [{ groupId: "g1", title: "G1", memberCount: 1 }],
    });

    await controller.refreshSessions();
    store.dispatch({ type: "sessions/selectSet", sessionIds: ["s1"] });

    await controller.openMoveToGroupModal();
    store.dispatch({ type: "ui/modalSelection", index: 0 });
    await controller.confirmSessionGroupPickerModal();

    assert.deepEqual(calls.placeSessionsInGroup, [[["s1"], null]]);
});

test("creating a session with an active group follows up with placeSessionsInGroup", async () => {
    const { controller, store, calls } = makePlacementController({
        groups: [{ groupId: "g1", title: "G1", memberCount: 0 }],
        createdSessions: [{ sessionId: "new1" }],
    });

    store.dispatch({
        type: "sessions/loaded",
        sessions: [{ sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", status: "group" }],
    });
    store.dispatch({ type: "sessions/selected", sessionId: "group:g1" });

    await controller.createSession({ title: "Canary" });

    assert.equal(calls.createSession[0].groupId, "g1");
    assert.deepEqual(calls.placeSessionsInGroup, [[["new1"], "g1"]]);
});

test("create follow-up placement is skipped when the server already placed the session", async () => {
    const { controller, store, calls } = makePlacementController({
        groups: [{ groupId: "g1", title: "G1", memberCount: 0 }],
        createdSessions: [{ sessionId: "new1", viewerGroupId: "g1" }],
    });

    store.dispatch({
        type: "sessions/loaded",
        sessions: [{ sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", status: "group" }],
    });
    store.dispatch({ type: "sessions/selected", sessionId: "group:g1" });

    await controller.createSession({ title: "Canary" });

    assert.equal(calls.createSession[0].groupId, "g1");
    assert.deepEqual(calls.placeSessionsInGroup, []);
});
