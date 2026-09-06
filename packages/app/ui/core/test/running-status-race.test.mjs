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
    createStore,
    PilotSwarmUiController,
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

// Observed live (2026-07-21, local portal): the turn completed and the server
// row read idle at statusVersion 5, but client-side event merges had inflated
// the held session's updatedAt past the idle write's timestamp — every idle
// poll compared as stale and "Working.." stuck until a terminal status. The
// server's monotonic statusVersion must outrank the wall-clock heuristic.
test("a newer statusVersion lands idle even when updatedAt compares as stale", () => {
    let state = withSession({ status: "running", statusVersion: 4, updatedAt: T0 + 10_000 });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "s1", title: "T", status: "idle", statusVersion: 5, updatedAt: T0 + 2_000 }],
    });
    assert.equal(statusOf(state), "idle", "higher statusVersion is authoritative");
});

test("a same-or-lower statusVersion is held regardless of a newer updatedAt", () => {
    let state = withSession({ status: "running", statusVersion: 5, updatedAt: T0 });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "s1", title: "T", status: "waiting", statusVersion: 5, updatedAt: T0 + 60_000 }],
    });
    assert.equal(statusOf(state), "running", "equal statusVersion is provably stale");
});

test("without statusVersions the timestamp fallback still applies", () => {
    let state = withSession({ status: "running", updatedAt: T0 + 5_000 });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "s1", title: "T", status: "idle", updatedAt: T0 + 5_000 }],
    });
    assert.equal(statusOf(state), "running", "same-timestamp downgrade held when no versions");
});

// Reverse race reported on mobile: idle v6 -> stale running v5 -> idle v6.
// Test both network paths and observe the actual footer/Stop selectors.
for (const actionType of ["sessions/loaded", "sessions/merged"]) {
    function apply(state, session) {
        const row = { sessionId: "s1", title: "T", ...session };
        return appReducer(state, actionType === "sessions/loaded"
            ? { type: actionType, sessions: [row] }
            : { type: actionType, session: row });
    }
    test(`${actionType}: older running cannot revive idle, even with a newer timestamp`, () => {
        let state = withSession({ status: "idle", statusVersion: 6, updatedAt: T0 });
        for (const session of [
            { status: "running", statusVersion: 5, updatedAt: T0 + 5000 },
            { status: "idle", statusVersion: 6, updatedAt: T0 },
            { status: "running", statusVersion: 6, updatedAt: T0 + 9000 },
        ]) {
            state = apply(state, session);
            assert.equal(statusOf(state), "idle");
            assert.equal(state.sessions.byId.s1.statusVersion, 6);
            assert.equal(canStopSessionTurn(state.sessions.byId.s1), false);
            assert.equal(selectLiveActivityLines(state, { spinnerFrame: "*", now: T0 + 6000 }).length, 0);
        }
    });

    test(`${actionType}: a rejected update must not lower the version or change run controls`, () => {
        const question = { question: "Proceed?" };
        const pause = { reason: "limit", scope: "model" };
        let state = withSession({ status: "input_required", statusVersion: 8, updatedAt: T0,
            pendingQuestion: question, waitReason: "Your answer", pauseState: pause });
        state = apply(state, { status: "idle", statusVersion: 5, updatedAt: T0 - 500,
            pendingQuestion: null, pauseState: null, waitReason: null });
        state = apply(state, { status: "running", statusVersion: 7, updatedAt: T0 + 500 });
        assert.equal(statusOf(state), "input_required");
        assert.equal(state.sessions.byId.s1.statusVersion, 8);
        assert.equal(state.sessions.byId.s1.updatedAt, T0);
        assert.deepEqual(state.sessions.byId.s1.pendingQuestion, question);
        assert.deepEqual(state.sessions.byId.s1.pauseState, pause);
        assert.equal(state.sessions.byId.s1.waitReason, "Your answer");
    });

    test(`${actionType}: genuine new turns and completion outrank timestamps`, () => {
        let state = withSession({ status: "idle", statusVersion: 6, updatedAt: T0 + 9000 });
        state = apply(state, { status: "running", statusVersion: 7, updatedAt: T0 });
        assert.equal(statusOf(state), "running");
        assert.equal(canStopSessionTurn(state.sessions.byId.s1), true);
        for (const terminal of ["completed", "failed", "cancelled", "error"]) {
            const older = apply(state, { status: terminal, statusVersion: 6, updatedAt: T0 + 9999 });
            assert.equal(statusOf(older), "running", "old terminal belongs to a previous turn");
            const equal = apply(state, { status: terminal, statusVersion: 7, updatedAt: T0 });
            assert.equal(statusOf(equal), terminal, "terminal orchestration state can precede a new custom-status write");
            const next = apply(state, { status: terminal, statusVersion: 8, updatedAt: T0 - 100 });
            assert.equal(statusOf(next), terminal);
            assert.equal(canStopSessionTurn(next.sessions.byId.s1), false);
        }
    });
}

test("absent and invalid counters cannot erase the known version; unversioned live events still land", () => {
    for (const statusVersion of [undefined, null, "", 0, -1, NaN, false, 1.5]) {
        let state = withSession({ status: "idle", statusVersion: 6, updatedAt: T0 });
        state = appReducer(state, { type: "sessions/merged", session: {
            sessionId: "s1", status: "running", statusVersion,
        } });
        assert.equal(statusOf(state), "running", String(statusVersion));
        assert.equal(state.sessions.byId.s1.statusVersion, 6);
        state = appReducer(state, { type: "sessions/merged", session: {
            sessionId: "s1", status: "idle", statusVersion: 7, updatedAt: T0 - 5000,
        } });
        assert.equal(statusOf(state), "idle", "the next server version must still finish the turn");
    }
});

test("legacy stale running is rejected without blocking a new turn", () => {
    let state = withSession({ status: "idle", updatedAt: T0 });
    state = appReducer(state, { type: "sessions/merged", session: {
        sessionId: "s1", status: "running", updatedAt: T0 - 1000,
    } });
    assert.equal(statusOf(state), "idle");
    assert.equal(state.sessions.byId.s1.updatedAt, T0);
    state = appReducer(state, { type: "sessions/merged", session: {
        sessionId: "s1", status: "running", updatedAt: T0 + 1000,
    } });
    assert.equal(statusOf(state), "running");
});

test("detail sync keeps unchanged version metadata on a conflicting status patch", async () => {
    const store = createStore(appReducer, withSession({ status: "idle", statusVersion: 6, updatedAt: T0 }));
    let detail = { sessionId: "s1", status: "running", statusVersion: 6, updatedAt: T0 };
    const controller = new PilotSwarmUiController({ store, transport: { getSession: async () => detail } });
    await controller.syncSessionDetail("s1");
    assert.equal(statusOf(store.getState()), "idle");
    detail = { ...detail, statusVersion: 7 };
    await controller.syncSessionDetail("s1");
    assert.equal(statusOf(store.getState()), "running");
    detail = { ...detail, status: "idle", statusVersion: 8 };
    await controller.syncSessionDetail("s1");
    assert.equal(statusOf(store.getState()), "idle");
});

test("status reconciliation preserves per-session outbox items and unrelated metadata", () => {
    let state = withSession({ status: "running", statusVersion: 7, updatedAt: T0 });
    const items = [{ id: "q1", sessionId: "s1", text: "Next task", phase: "queued" }];
    state = appReducer(state, { type: "outbox/setSessionItems", sessionId: "s1", items });
    const outbox = state.outbox;
    state = appReducer(state, { type: "sessions/merged", session: {
        sessionId: "s1", title: "Renamed", status: "idle", statusVersion: 6,
    } });
    assert.equal(state.outbox, outbox);
    assert.equal(state.sessions.byId.s1.title, "Renamed");
    assert.equal(canStopSessionTurn(state.sessions.byId.s1), true);
});


test("an unversioned start at the same timestamp still enables Stop", () => {
    let state = withSession({ status: "idle", updatedAt: T0 });
    state = appReducer(state, { type: "sessions/merged", session: {
        sessionId: "s1", status: "running", updatedAt: T0,
    } });
    assert.equal(canStopSessionTurn(state.sessions.byId.s1), true);
});


for (const [name, initial, expected] of [
    ["durable wait", { status: "waiting", waitReason: "Budget cap" }, { waitReason: null }],
    ["input question", { status: "input_required", pendingQuestion: { question: "Proceed?" } }, { pendingQuestion: null }],
    ["cron wait", { status: "waiting", cronActive: true, cronReason: "Later", cronInterval: 60 },
        { cronActive: false, cronReason: null, cronInterval: null }],
]) {
    test(`detail sync ends ${name} on a newer version with an older timestamp`, async () => {
        const store = createStore(appReducer, withSession({ ...initial, statusVersion: 6, updatedAt: T0 + 2000 }));
        const detail = { sessionId: "s1", status: "idle", statusVersion: 7, updatedAt: T0 + 1000, cronActive: false };
        const controller = new PilotSwarmUiController({ store, transport: { getSession: async () => detail } });
        await controller.syncSessionDetail("s1");
        for (const [key, value] of Object.entries({ status: "idle", statusVersion: 7, ...expected })) {
            assert.deepEqual(store.getState().sessions.byId.s1[key], value, key);
        }
        // Repeated list/detail reads cannot cement a rewritten waiting v7.
        store.dispatch({ type: "sessions/loaded", sessions: [detail] });
        await controller.syncSessionDetail("s1");
        assert.equal(statusOf(store.getState()), "idle");
    });
}

test("a same-version duplicate cannot lower the timestamp and admit a stale legacy start", () => {
    let state = withSession({ status: "idle", statusVersion: 6, updatedAt: T0 + 2000 });
    state = appReducer(state, { type: "sessions/merged", session: {
        sessionId: "s1", status: "idle", statusVersion: 6, updatedAt: T0,
    } });
    assert.equal(state.sessions.byId.s1.updatedAt, T0 + 2000);
    state = appReducer(state, { type: "sessions/merged", session: {
        sessionId: "s1", status: "running", updatedAt: T0 + 1000,
    } });
    assert.equal(statusOf(state), "idle");
});
