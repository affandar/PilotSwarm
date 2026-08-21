// Opening a session that is (or was) actively streaming must still reach the
// ORIGINAL prompt and early events — not just the handful that arrived after
// the live subscription attached.
//
// WHY: a live/streaming session seeds its transcript purely from
// the event stream. mergeSessionEvent -> appendEventToHistory builds history
// from { chat:[], activity:[], lastSeq:0 }, so hasOlderEvents stays false and
// only the live tail is present. syncSessionEvents then saw existing.events was
// truthy and paged FORWARD from lastSeq (getSessionEvents afterSeq=lastSeq),
// never backfilling seq below the first live event. Result: the original prompt
// was unreachable — no "load older" button (hasOlderEvents:false) and no
// scroll-to-top auto-expand — until a manual full refresh.
//
// The fix marks bulk-window loads with bulkHydrated:true; a live-only seed is
// bulkHydrated:false, and syncSessionEvents forces a real bulk hydrate for it,
// which rebuilds via buildHistoryModel and reaches the head.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const TOTAL = 250; // full durable transcript: seq 1..250

function message(seq) {
    return {
        seq,
        eventType: seq === 1 ? "user.message" : (seq % 2 ? "assistant.message" : "user.message"),
        timestamp: 1785000000000 + seq,
        data: { content: seq === 1 ? "the original prompt" : `event ${seq}` },
    };
}

/**
 * Transport that records how history was requested.
 *  - full-window load  -> getSessionEvents(sessionId, undefined, limit)
 *  - forward catch-up  -> getSessionEvents(sessionId, afterSeq, limit)
 */
function makeTransport() {
    const calls = { full: 0, forward: 0 };
    return {
        calls,
        async getSessionEvents(_sessionId, afterSeq, limit) {
            if (afterSeq === undefined || afterSeq === null) {
                calls.full += 1;
                // The server returns the newest `limit` events; the whole
                // transcript fits so the head (seq 1) is included.
                return Array.from({ length: Math.min(TOTAL, limit) }, (_, i) => message(i + 1));
            }
            calls.forward += 1;
            return Array.from({ length: TOTAL - afterSeq }, (_, i) => message(afterSeq + 1 + i));
        },
        async getSessionEventsBefore() { return []; },
        subscribeSession() { return () => {}; },
    };
}

function seedLiveOnly(controller) {
    controller.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SESSION, title: "S", status: "running" }] });
    controller.dispatch({ type: "sessions/selected", sessionId: SESSION });
    // Live tail only: the subscription attached mid-stream, so we only ever saw
    // the last few events. The original prompt (seq 1) never arrived live.
    for (const seq of [248, 249, 250]) {
        controller.mergeSessionEvent(SESSION, message(seq));
    }
}

test("live-only seeded history is marked bulkHydrated:false and hides its head", () => {
    const transport = makeTransport();
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    seedLiveOnly(controller);

    const h = store.getState().history.bySessionId.get(SESSION);
    assert.equal(h.bulkHydrated, false, "a live-only seed must not claim to be bulk-hydrated");
    assert.equal(h.hasOlderEvents, false, "the live path cannot compute hasOlderEvents");
    assert.equal(h.events[0].seq, 248, "only the live tail is present — the head is missing");
});

test("syncSessionEvents backfills a live-only session to the original prompt", async () => {
    const transport = makeTransport();
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    seedLiveOnly(controller);

    await controller.syncSessionEvents(SESSION);

    const h = store.getState().history.bySessionId.get(SESSION);
    assert.equal(transport.calls.full, 1, "a live-only history must trigger a full bulk hydrate");
    assert.equal(transport.calls.forward, 0, "must NOT page forward from lastSeq — that never backfills the head");
    assert.equal(h.bulkHydrated, true, "after the bulk load the history is marked hydrated");
    assert.equal(h.events[0].seq, 1, "the original prompt (seq 1) is now reachable");
    assert.equal(h.events[0].data.content, "the original prompt");
});

test("attachActiveSession backfills the head for a mid-stream subscription", async () => {
    const transport = makeTransport();
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    seedLiveOnly(controller);

    controller.attachActiveSession(SESSION);
    // attach kicks syncSessionEvents off without awaiting; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const h = store.getState().history.bySessionId.get(SESSION);
    assert.equal(h.bulkHydrated, true, "attaching an active session must hydrate the head");
    assert.equal(h.events[0].seq, 1, "the original prompt is reachable after attach");
});

test("an already bulk-hydrated session keeps paging forward (no wasteful reload)", async () => {
    const transport = makeTransport();
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    controller.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SESSION, title: "S", status: "running" }] });
    controller.dispatch({ type: "sessions/selected", sessionId: SESSION });

    // Cold open path: a real bulk load establishes bulkHydrated:true.
    await controller.ensureSessionHistory(SESSION, { force: true });
    assert.equal(transport.calls.full, 1);
    const seeded = store.getState().history.bySessionId.get(SESSION);
    assert.equal(seeded.bulkHydrated, true);
    assert.equal(seeded.events[0].seq, 1);

    // A subsequent sync (reconnect/resubscribe) takes the cheap forward delta,
    // not another full window load.
    transport.calls.full = 0;
    await controller.syncSessionEvents(SESSION);
    assert.equal(transport.calls.full, 0, "a hydrated history must not re-run a full window load");
});
