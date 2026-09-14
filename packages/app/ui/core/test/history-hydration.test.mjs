import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function message(seq, content = `event ${seq}`) {
    return {
        seq,
        eventType: seq % 2 === 0 ? "assistant.message" : "user.message",
        createdAt: new Date(1_780_000_000_000 + seq).toISOString(),
        data: { content },
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

function setup(transportOverrides = {}) {
    const store = createStore(appReducer, createInitialState());
    const sessions = [A, B].map((sessionId) => ({ sessionId, title: sessionId, status: "running" }));
    const transport = {
        async getSessionEvents() { return []; },
        async getSession() { return null; },
        subscribeSession() { return () => {}; },
        ...transportOverrides,
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions });
    store.dispatch({ type: "sessions/selected", sessionId: A });
    return { controller, store, transport };
}

function seedLiveTail(controller, sessionId = A) {
    for (const seq of [248, 249, 250]) controller.mergeSessionEvent(sessionId, message(seq));
}

test("live-tail history remains explicitly unhydrated", () => {
    const { controller, store } = setup();
    seedLiveTail(controller);
    const history = store.getState().history.bySessionId.get(A);
    assert.equal(history.bulkHydrated, false);
    assert.equal(history.hasOlderEvents, false);
    assert.deepEqual(history.events.map((event) => event.seq), [248, 249, 250]);
});

test("first sync bulk-hydrates a live tail back to the initial prompt", async () => {
    const calls = [];
    const { controller, store } = setup({
        async getSessionEvents(_sessionId, afterSeq, limit) {
            calls.push({ afterSeq, limit });
            return Array.from({ length: 250 }, (_, index) => message(
                index + 1,
                index === 0 ? "initial prompt" : undefined,
            ));
        },
    });
    seedLiveTail(controller);

    await controller.syncSessionEvents(A);

    const history = store.getState().history.bySessionId.get(A);
    assert.deepEqual(calls, [{ afterSeq: undefined, limit: 300 }]);
    assert.equal(history.bulkHydrated, true);
    assert.equal(history.events[0].seq, 1);
    assert.equal(history.events[0].data.content, "initial prompt");
});

test("subsequent sync is forward-only and duplicate events are ignored", async () => {
    const calls = [];
    const { controller, store } = setup({
        async getSessionEvents(_sessionId, afterSeq, limit) {
            calls.push({ afterSeq, limit });
            if (afterSeq == null) return [message(1, "initial prompt"), message(2)];
            return [message(2, "duplicate"), message(3, "new")];
        },
    });
    await controller.ensureSessionHistory(A, { force: true });
    await controller.syncSessionEvents(A);

    const history = store.getState().history.bySessionId.get(A);
    assert.deepEqual(calls, [
        { afterSeq: undefined, limit: 300 },
        { afterSeq: 2, limit: 200 },
    ]);
    assert.deepEqual(history.events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(history.events.find((event) => event.seq === 2).data.content, "event 2");
});

test("concurrent syncs coalesce the initial bulk hydrate", async () => {
    const gate = deferred();
    let calls = 0;
    const { controller } = setup({
        async getSessionEvents() {
            calls += 1;
            return gate.promise;
        },
    });
    seedLiveTail(controller);

    const first = controller.syncSessionEvents(A);
    const second = controller.syncSessionEvents(A);
    assert.equal(calls, 1);
    gate.resolve([message(1, "initial prompt"), message(250)]);
    await Promise.all([first, second]);
    assert.equal(calls, 1);
});

test("live events arriving during bulk hydration are merged once", async () => {
    const gate = deferred();
    const { controller, store } = setup({
        async getSessionEvents() { return gate.promise; },
    });
    seedLiveTail(controller);
    const pending = controller.syncSessionEvents(A);
    controller.mergeSessionEvent(A, message(251, "live during fetch"));
    gate.resolve([message(1, "initial prompt"), message(250), message(251, "durable duplicate")]);
    await pending;

    const history = store.getState().history.bySessionId.get(A);
    assert.deepEqual(history.events.map((event) => event.seq), [1, 248, 249, 250, 251]);
    assert.equal(history.events.find((event) => event.seq === 251).data.content, "live during fetch");
});

test("switching sessions while hydration is pending cannot attach the stale session", async () => {
    const gate = deferred();
    const attached = [];
    const { controller, store } = setup({
        async getSessionEvents(sessionId) {
            return sessionId === A ? gate.promise : [message(1, "B prompt")];
        },
        async getSession(sessionId) { return { sessionId, status: "running" }; },
        subscribeSession(sessionId) {
            attached.push(sessionId);
            return () => {};
        },
    });

    const openingA = controller.loadSession(A);
    await controller.loadSession(B);
    gate.resolve([message(1, "A prompt")]);
    await openingA;

    assert.equal(store.getState().sessions.activeSessionId, B);
    assert.deepEqual(attached, [B]);
    controller.detachActiveSession();
});

test("switching sessions cancels the old live subscription during hydration", async () => {
    const gate = deferred();
    const attached = [];
    const unsubscribed = [];
    const { controller, store } = setup({
        async getSessionEvents(sessionId) {
            return sessionId === A ? gate.promise : [message(1, "B prompt")];
        },
        async getSession(sessionId) { return { sessionId, status: "running" }; },
        subscribeSession(sessionId) {
            attached.push(sessionId);
            return () => { unsubscribed.push(sessionId); };
        },
    });

    controller.attachActiveSession(A);
    const pendingHydration = controller.sessionHistoryLoads.get(A);
    await controller.loadSession(B);
    gate.resolve([message(1, "A prompt")]);
    await pendingHydration;

    assert.equal(store.getState().sessions.activeSessionId, B);
    assert.deepEqual(attached, [A, B]);
    assert.deepEqual(unsubscribed, [A]);
    controller.detachActiveSession();
});

test("a full initial page exposes backward history loading", async () => {
    const events = Array.from({ length: 300 }, (_, index) => message(index + 201));
    const { controller, store } = setup({
        async getSessionEvents() { return events; },
    });

    await controller.ensureSessionHistory(A, { force: true });

    const history = store.getState().history.bySessionId.get(A);
    assert.equal(history.bulkHydrated, true);
    assert.equal(history.hasOlderEvents, true);
    assert.equal(history.events[0].seq, 201);
});
