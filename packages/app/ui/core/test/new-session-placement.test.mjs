/**
 * A new session starts at the END of the session list and stays there.
 *
 * It did not. `applyActiveGroupDefault` inherited the group of whatever session
 * was SELECTED, so pressing New while reading a session inside a folder filed
 * the new session into that folder — buried mid-list, several rows above the
 * bottom, with nothing on screen explaining why. The folder a session happens
 * to live in is not a statement about where the next one belongs.
 *
 * Selecting the FOLDER ROW itself and pressing New is different: that is the
 * user pointing at the folder, and it still places the session there.
 *
 * The "and stays there" half is the sort's job (session-tree): an unplaced row
 * sorts after every manually placed one, and the stable order map pins arrival
 * position for the rest of the session. Both are pinned below.
 *
 * Run: node --test test/new-session-placement.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { PilotSwarmUiController } from "../src/controller.js";

const session = (sessionId, extra = {}) => ({
    sessionId,
    title: sessionId,
    createdAt: 100,
    updatedAt: 100,
    status: "idle",
    ...extra,
});

function makeController(sessions) {
    const created = [];
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const transport = {
        mode: "web",
        listSessions: async () => sessions,
        listSessionGroups: async () => [],
        createSession: async (options) => {
            created.push(options);
            return { sessionId: "new-session" };
        },
        placeSessionsInGroup: async () => {},
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        listCreatableAgents: async () => [],
        listModels: async () => [],
        getCapabilities: () => ({}),
    };
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, created };
}

const flatIds = (state) => state.sessions.flat.map((entry) => entry.sessionId);

test("New from a session inside a folder does not file the new session in that folder", () => {
    const { controller, store, created } = makeController([]);
    store.dispatch({ type: "sessions/groupsLoaded", groups: [
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "IcM Sessions" },
    ] });
    store.dispatch({ type: "sessions/loaded", sessions: [session("member", { groupId: "g1" })] });
    store.dispatch({ type: "sessions/selected", sessionId: "member" });

    const options = controller.applyActiveGroupDefault({});

    assert.equal(options.groupId, undefined);
    assert.equal(created.length, 0);
});

test("New with the folder row itself selected still places it in the folder", () => {
    // The one deliberate case. Removing it would leave no way to create a
    // session in a folder at all.
    const { controller, store } = makeController([]);
    store.dispatch({ type: "sessions/groupsLoaded", groups: [
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "IcM Sessions" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "group:g1" });

    assert.equal(controller.applyActiveGroupDefault({}).groupId, "g1");
});

test("an explicit groupId always wins, including an explicit null", () => {
    const { controller, store } = makeController([]);
    store.dispatch({ type: "sessions/groupsLoaded", groups: [
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "IcM Sessions" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "group:g1" });

    assert.equal(controller.applyActiveGroupDefault({ groupId: "g2" }).groupId, "g2");
    assert.equal(controller.applyActiveGroupDefault({ groupId: null }).groupId, null);
});

test("a new session lands at the very end of the list", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/groupsLoaded", groups: [
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "Folder" },
    ] });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("older", { createdAt: 100 }),
        session("member", { groupId: "g1", createdAt: 150 }),
    ] });

    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("older", { createdAt: 100 }),
        session("member", { groupId: "g1", createdAt: 150 }),
        session("fresh", { createdAt: 900, updatedAt: 900 }),
    ] });

    // Past the folder band too — folders sort above loose sessions, so "end of
    // the list" means below every folder and its members, not just below the
    // other loose rows.
    assert.equal(flatIds(state).at(-1), "fresh");
});

test("it stays at the end when an older session becomes the most recently active", () => {
    // Activity used to haul a session to the top. If it still did, the row the
    // user just created would be displaced by whatever they typed into next.
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("older", { createdAt: 100, updatedAt: 100 }),
        session("fresh", { createdAt: 900, updatedAt: 900 }),
    ] });
    assert.equal(flatIds(state).at(-1), "fresh");

    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("older", { createdAt: 100, updatedAt: 5000, status: "running" }),
        session("fresh", { createdAt: 900, updatedAt: 900 }),
    ] });

    assert.equal(flatIds(state).at(-1), "fresh");
});

test("it stays at the end after rows the user placed by hand", () => {
    // A manually ordered row has a finite rank; an unplaced one sorts at
    // Infinity. That is what keeps "new goes last" true on a reordered list.
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("a", { createdAt: 100 }),
        session("b", { createdAt: 200 }),
    ] });
    state = appReducer(state, { type: "sessions/reorder", sessionId: "b", beforeSessionId: "a" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("a", { createdAt: 100 }),
        session("b", { createdAt: 200 }),
        session("fresh", { createdAt: 900 }),
    ] });

    assert.deepEqual(flatIds(state), ["b", "a", "fresh"]);
});

test("moving it is what changes its place", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("a", { createdAt: 100 }),
        session("fresh", { createdAt: 900 }),
    ] });
    assert.equal(flatIds(state).at(-1), "fresh");

    state = appReducer(state, { type: "sessions/reorder", sessionId: "fresh", beforeSessionId: "a" });

    assert.deepEqual(flatIds(state), ["fresh", "a"]);
});
