// Session state is written from several concurrent sources (list poll, live
// events, per-session detail fetch). A detail fetch issued before a turn began
// can land after it began, still reporting the pre-turn "idle". Left alone it
// clobbers a live "running" until the next update corrects it — which flickered
// every consumer gated on status === "running": the live-activity strip and the
// composer's Stop button.
import test from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState,
    appReducer,
    canStopSessionTurn,
    selectLiveActivityLines,
} from "../src/index.js";

const T0 = 1_700_000_000_000;

function withSession(session) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T", ...session }] });
    return appReducer(state, { type: "sessions/selected", sessionId: "s1" });
}

function statusOf(state) {
    return state.sessions.byId.s1.status;
}

test("a STALE idle update cannot clobber a live running status", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    assert.equal(statusOf(state), "running");

    // Detail sync that raced the turn start: older timestamp, pre-turn status.
    state = appReducer(state, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "idle", updatedAt: T0 + 1_000 },
    });
    assert.equal(statusOf(state), "running", "stale idle must not win");
});

test("an EQUAL-timestamp idle update cannot clobber running either", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    state = appReducer(state, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "idle", updatedAt: T0 + 5_000 },
    });
    assert.equal(statusOf(state), "running");
});

test("a genuinely NEWER idle update still ends the turn immediately", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    state = appReducer(state, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "idle", updatedAt: T0 + 9_000 },
    });
    assert.equal(statusOf(state), "idle", "the guard must not strand a finished turn as running");
});

test("terminal statuses are never held back, even when stale", () => {
    for (const terminal of ["completed", "failed", "cancelled"]) {
        let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
        state = appReducer(state, {
            type: "sessions/merged",
            session: { sessionId: "s1", status: terminal, updatedAt: T0 + 1_000 },
        });
        assert.equal(statusOf(state), terminal, `${terminal} must land even from a stale update`);
    }
});

// Captured live on waldemortchk (?psdebug=status). The list poll reported
// "waiting" for a session the server and orchestration both had at "running",
// carrying an IDENTICAL updatedAt, and an event merge restored "running" 105ms
// later. An earlier guard missed this by only rejecting idle-like statuses.
test("a same-timestamp 'waiting' from the list poll cannot clobber a live run", () => {
    let state = withSession({ status: "running", updatedAt: 1784505807140 });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "s1", title: "T", status: "waiting", updatedAt: 1784505807140 }],
    });
    assert.equal(statusOf(state), "running", "equal-timestamp waiting must not win");
});

test("a genuinely newer 'waiting' (a real durable wait) still lands", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    state = appReducer(state, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "waiting", updatedAt: T0 + 9_000 },
    });
    assert.equal(statusOf(state), "waiting");
});

test("input_required is held back when stale, and lands when newer", () => {
    let stale = withSession({ status: "running", updatedAt: T0 + 5_000 });
    stale = appReducer(stale, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "input_required", updatedAt: T0 + 1_000 },
    });
    assert.equal(statusOf(stale), "running");

    let fresh = withSession({ status: "running", updatedAt: T0 + 5_000 });
    fresh = appReducer(fresh, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "input_required", updatedAt: T0 + 9_000 },
    });
    assert.equal(statusOf(fresh), "input_required", "a real question must reach the user");
});

test("an update carrying no timestamp is treated as newer (cannot be proven stale)", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    state = appReducer(state, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "idle" },
    });
    assert.equal(statusOf(state), "idle");
});

test("the stale race no longer flickers the Stop button or the live strip", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    state = appReducer(state, {
        type: "history/set",
        sessionId: "s1",
        history: {
            chat: [{ id: "u1", role: "user", text: "go", createdAt: T0 }],
            events: [],
            activity: [{ seq: 1, eventType: "assistant.reasoning", text: "[assistant.reasoning] x", createdAt: T0 + 1_000 }],
        },
    });
    assert.equal(canStopSessionTurn(state.sessions.byId.s1), true);
    assert.equal(selectLiveActivityLines(state, { spinnerFrame: "*", now: T0 + 6_000 }).length, 1);

    state = appReducer(state, {
        type: "sessions/merged",
        session: { sessionId: "s1", status: "idle", updatedAt: T0 + 1_000 },
    });
    assert.equal(canStopSessionTurn(state.sessions.byId.s1), true, "Stop button must not drop out");
    assert.equal(
        selectLiveActivityLines(state, { spinnerFrame: "*", now: T0 + 6_000 }).length, 1,
        "live-activity strip must not unmount",
    );
});

test("the same stale-update guard applies on the sessions/loaded poll path", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "s1", title: "T", status: "idle", updatedAt: T0 + 1_000 }],
    });
    assert.equal(statusOf(state), "running", "the list poll races the same way and needs the same guard");
});
