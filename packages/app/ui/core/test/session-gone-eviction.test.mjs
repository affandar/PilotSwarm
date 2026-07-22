// Deleting a session (locally or from another client) used to leave its panes
// bound forever: sessions/loaded deliberately resurrects the ACTIVE session
// even when the server no longer lists it, and the per-session data loops
// (detail sync, events catch-up, orchestration stats) treated 404 as transient
// and retried on every refresh tick — an endless 404 console stream until
// reload (observed on waldemort-chk, 2026-07-22).
//
// A 404/NOT_FOUND on those loops is now TERMINAL: the controller evicts the
// session via sessions/gone, which drops the row, clears the active latch,
// and thereby stops every render/interval-driven refetch.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer as reducer, createInitialState } from "../src/index.js";

function stateWithSessions(sessions, activeSessionId) {
    let state = createInitialState();
    state = reducer(state, { type: "sessions/loaded", sessions });
    if (activeSessionId) {
        state = {
            ...state,
            sessions: { ...state.sessions, activeSessionId },
        };
    }
    return state;
}

const ROWS = [
    { sessionId: "s-alive", title: "alive", status: "idle" },
    { sessionId: "s-doomed", title: "doomed", status: "idle" },
];

test("sessions/gone drops the row and clears the active latch", () => {
    const before = stateWithSessions(ROWS, "s-doomed");
    const after = reducer(before, { type: "sessions/gone", sessionId: "s-doomed" });
    assert.equal(after.sessions.byId["s-doomed"], undefined);
    assert.equal(after.sessions.activeSessionId, null);
    assert.ok(after.sessions.byId["s-alive"]);
});

test("sessions/gone leaves an unrelated active session alone", () => {
    const before = stateWithSessions(ROWS, "s-alive");
    const after = reducer(before, { type: "sessions/gone", sessionId: "s-doomed" });
    assert.equal(after.sessions.byId["s-doomed"], undefined);
    assert.equal(after.sessions.activeSessionId, "s-alive");
});

test("sessions/gone is a no-op for unknown ids", () => {
    const before = stateWithSessions(ROWS, "s-alive");
    const after = reducer(before, { type: "sessions/gone", sessionId: "s-never-existed" });
    assert.equal(after, before);
});

test("evicted session stays gone through the next sessions/loaded (no resurrection)", () => {
    // The sessions/loaded carve-out resurrects the ACTIVE session when absent
    // from the list. After eviction the latch is cleared, so a refresh that no
    // longer lists the deleted session must not bring it back.
    const before = stateWithSessions(ROWS, "s-doomed");
    const evicted = reducer(before, { type: "sessions/gone", sessionId: "s-doomed" });
    const refreshed = reducer(evicted, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "s-alive", title: "alive", status: "idle" }],
    });
    assert.equal(refreshed.sessions.byId["s-doomed"], undefined);
});
