import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    defaultOwnerFilterForPrincipal,
    selectSessionRows,
} from "../src/index.js";

const ME = { provider: "github", subject: "me", displayName: "Me", email: "me@example.com" };
const BOB = { provider: "github", subject: "bob", displayName: "Bob", email: "bob@example.com" };
const SYSTEM_USER = { provider: "system", subject: "system", displayName: "System" };

const FIXTURE_SESSIONS = [
    { sessionId: "mine", title: "Mine", status: "idle", owner: ME },
    { sessionId: "foreign", title: "Foreign", status: "idle", owner: BOB },
    { sessionId: "system-owned", title: "System Child", status: "idle", owner: SYSTEM_USER },
    { sessionId: "sys", title: "PilotSwarm", status: "idle", isSystem: true },
    { sessionId: "unowned", title: "Unowned", status: "idle" },
];

function loadedState(ownerFilter) {
    let state = createInitialState();
    state = appReducer(state, { type: "auth/context", principal: ME, authorization: { role: "user" } });
    state = appReducer(state, { type: "sessions/ownerFilter", filter: ownerFilter });
    state = appReducer(state, { type: "sessions/loaded", sessions: FIXTURE_SESSIONS });
    return state;
}

test("default owner filter for an authenticated principal includes me, system, and shared", () => {
    assert.deepEqual(defaultOwnerFilterForPrincipal(ME), {
        all: false,
        includeSystem: true,
        includeUnowned: false,
        includeMe: true,
        includeShared: true,
        ownerKeys: [],
    });
    assert.deepEqual(defaultOwnerFilterForPrincipal(null), {
        all: true,
        includeSystem: false,
        includeUnowned: false,
        includeMe: false,
        includeShared: false,
        ownerKeys: [],
    });
});

test("Shared-with-me bucket matches only non-system sessions with a foreign owner", () => {
    const state = loadedState({
        all: false,
        includeSystem: false,
        includeUnowned: false,
        includeMe: false,
        includeShared: true,
        ownerKeys: [],
    });
    const visibleIds = selectSessionRows(state).map((row) => row.sessionId);
    assert.deepEqual(visibleIds, ["foreign"]);
});

test("default authed filter shows mine, shared, and system sessions but not unowned", () => {
    const state = loadedState(defaultOwnerFilterForPrincipal(ME));
    const visibleIds = new Set(selectSessionRows(state).map((row) => row.sessionId));
    assert.equal(visibleIds.has("mine"), true);
    assert.equal(visibleIds.has("foreign"), true);
    assert.equal(visibleIds.has("sys"), true);
    assert.equal(visibleIds.has("system-owned"), true);
    assert.equal(visibleIds.has("unowned"), false);
});

test("Shared with me is a first-class filter item that toggles includeShared", () => {
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport: {} });
    store.dispatch({ type: "auth/context", principal: ME, authorization: { role: "user" } });
    store.dispatch({ type: "sessions/loaded", sessions: FIXTURE_SESSIONS });

    controller.openSessionOwnerFilter();
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionOwnerFilter");
    const itemIds = modal.items.map((item) => item.id);
    const sharedIndex = itemIds.indexOf("shared");
    assert.equal(sharedIndex, itemIds.indexOf("me") + 1);
    assert.equal(modal.items[sharedIndex].kind, "shared");
    assert.equal(modal.items[sharedIndex].label, "Shared with me");

    controller.toggleSessionOwnerFilter(sharedIndex);
    let filter = store.getState().sessions.ownerFilter;
    assert.equal(filter.all, false);
    assert.equal(filter.includeShared, true);

    controller.toggleSessionOwnerFilter(sharedIndex);
    filter = store.getState().sessions.ownerFilter;
    assert.equal(filter.includeShared, false);
    // Nothing selected anymore -> collapses back to All.
    assert.equal(filter.all, true);
});
