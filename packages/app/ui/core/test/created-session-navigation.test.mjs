import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore, selectSessionRows } from "../src/index.js";

function setup() {
    const store = createStore(appReducer, createInitialState());
    const old = { sessionId: "old", title: "Previous session", status: "idle" };
    const fresh = { sessionId: "fresh", title: "New session", status: "idle" };
    const subscriptions = [];
    const transport = {
        listSessions: async () => [old], // The new row is outside the current catalog page.
        getSession: async id => id === "fresh" ? fresh : old,
        getSessionEvents: async () => [],
        createSession: async () => ({ sessionId: "fresh" }),
        createSessionForAgent: async () => ({ sessionId: "fresh" }),
        subscribeSession: id => { subscriptions.push(id); return () => {}; },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    controller.scheduleSessionsRefresh = () => {};
    store.dispatch({ type: "sessions/loaded", sessions: [old] });
    return { store, controller, transport, subscriptions };
}

for (const named of [false, true]) {
    test(`creation reveals the new session despite catalog lag, filters and a previous link (named: ${named})`, async () => {
        const { store, controller } = setup();
        store.dispatch({ type: "ui/sequenceExpandedTurns", turns: [8] });
        store.dispatch({ type: "ui/sequenceSelectedTurn", turn: 8 });
        controller.setPrompt("keep my draft");
        store.dispatch({ type: "sessions/filterQuery", query: "Previous" });
        controller.setNavigationIntent("old");
        const created = named ? await controller.createSessionForAgent("test-agent") : await controller.createSession();
        assert.equal(created.sessionId, "fresh");
        await controller.refreshSessions();
        assert.equal(store.getState().sessions.activeSessionId, "fresh");
        assert.equal(store.getState().sessions.filterQuery, "Previous", "creation must not erase the user's filter");
        assert.equal(store.getState().sessions.filterExceptionId, "fresh");
        assert.ok(selectSessionRows(store.getState()).some(row => row.sessionId === "fresh"));
        assert.equal(store.getState().ui.revealedCreatedSessionId, "fresh");
        assert.deepEqual(store.getState().ui.sequenceExpandedTurns, []);
        assert.equal(store.getState().ui.sequenceSelectedTurn, null);
        assert.equal(store.getState().ui.prompt, "");
        await controller.loadSession("old");
        assert.equal(store.getState().ui.prompt, "keep my draft");
        controller.detachActiveSession();
    });
}

test("a delayed previous session load cannot steal the new session's subscription", async () => {
    const { store, controller, transport } = setup();
    let release;
    transport.getSessionEvents = id => id === "old" ? new Promise(resolve => { release = resolve; }) : Promise.resolve([]);
    const oldLoad = controller.loadSession("old");
    await controller.createSession();
    release([]);
    await oldLoad;
    assert.equal(store.getState().sessions.activeSessionId, "fresh");
    assert.equal(controller.activeSessionSubscriptionId, "fresh");
    controller.detachActiveSession();
});

test("an in-flight catalog read cannot replace the newly created selection", async () => {
    const { store, controller, transport } = setup();
    let release;
    transport.listSessions = () => new Promise(resolve => { release = resolve; });
    const oldRefresh = controller.refreshSessions();
    await controller.createSession();
    release([{ sessionId: "old", title: "Stale title", status: "idle" }]);
    await oldRefresh;
    assert.equal(store.getState().sessions.activeSessionId, "fresh");
    assert.equal(controller.activeSessionSubscriptionId, "fresh");
    assert.equal(store.getState().sessions.byId.old.title, "Previous session", "the superseded snapshot must not apply");
    controller.detachActiveSession();
});

test("navigating away while the created session loads keeps the user's later selection", async () => {
    const { store, controller, transport } = setup();
    let release;
    let started;
    const loading = new Promise(resolve => { started = resolve; });
    transport.getSessionEvents = id => id === "fresh" ? new Promise(resolve => { release = resolve; started(); }) : Promise.resolve([]);
    const creation = controller.createSession();
    await loading;
    await controller.loadSession("old");
    release([]);
    await creation;
    assert.equal(store.getState().sessions.activeSessionId, "old");
    assert.equal(controller.activeSessionSubscriptionId, "old");
    controller.detachActiveSession();
});

test("a failed follow-up read does not report a successful creation as failed", async () => {
    const { store, controller, transport } = setup();
    transport.getSessionEvents = async () => { throw new Error("temporary read failure"); };
    assert.equal((await controller.createSession()).sessionId, "fresh");
    assert.equal(store.getState().sessions.activeSessionId, "fresh");
    assert.match(store.getState().ui.statusText, /Created session fresh; could not load it yet/);
});

test("failed creation leaves the current session and draft alone", async () => {
    const { store, controller, transport } = setup();
    controller.setPrompt("unsent draft");
    transport.createSession = async () => { throw new Error("create denied"); };
    assert.equal(await controller.createSession(), null);
    assert.equal(store.getState().sessions.activeSessionId, "old");
    assert.equal(store.getState().ui.prompt, "unsent draft");
});
