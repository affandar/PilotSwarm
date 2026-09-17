import test from "node:test";
import assert from "node:assert/strict";
import {
    appReducer, createInitialState, createStore, PilotSwarmUiController,
    formatCronTimestampForClient, selectChatPaneChrome, selectLiveActivityLines,
    selectSessionRows, selectSessionSignalWait, selectSessionStatusSummary,
} from "../src/index.js";
import { visibleWaitReason, waitReasonLabel } from "../../react/src/web-app.js";

const T = Date.parse("2026-09-16T09:00:00.000Z");
const DEADLINE = "2026-09-16T09:30:00.000Z";
const WAIT = { waitId: "wait-1", names: ["approval", "build-ready"], reason: "Review the result", startedAt: new Date(T).toISOString() };
const TIMED_WAIT = { ...WAIT, deadline: DEADLINE };
const INDEFINITE_TEXT = "Waiting for signal: approval, build-ready · no deadline";
const TIMED_TEXT = `Waiting for signal: approval, build-ready · until ${formatCronTimestampForClient(DEADLINE)}`;
const BUDGET_REASON = "Provider personal reached its daily token limit";
const row = (extra = {}) => ({
    sessionId: "s1", title: "Signal review", status: "waiting", statusVersion: 10,
    createdAt: T, updatedAt: T, waitReason: "Waiting for signal: approval, build-ready",
    signalWait: WAIT, waitStartedAt: T, ...extra,
});
const flatten = (runs) => (runs || []).map(run => run.text || "").join("");
function stateWith(session, mode = "local") {
    let state = appReducer(createInitialState({ mode }), { type: "sessions/loaded", sessions: [session] });
    return appReducer(state, { type: "sessions/selected", sessionId: "s1" });
}

test("indefinite signal waits have exact shared text, not a zero-second timer", () => {
    const session = row({ waitSeconds: 0 });
    assert.deepEqual(selectSessionSignalWait(session), {
        interrupted: false, color: "yellow", text: INDEFINITE_TEXT,
        badge: "[signal: approval, build-ready · no deadline]",
    });
    assert.equal(visibleWaitReason(session, "waiting"), INDEFINITE_TEXT);
    assert.equal(waitReasonLabel(session), "Signal");
    for (const mode of ["local", "remote", "web"]) {
        const state = stateWith(session, mode);
        const view = selectSessionRows(state)[0];
        assert.equal(view.runs.find(run => run.role === "status").text, "~ ");
        assert.ok(flatten(view.titleRuns).includes("[signal: approval, build-ready · no deadline]"));
        assert.ok(flatten(view.detailRuns).includes(INDEFINITE_TEXT));
        assert.equal(flatten(selectChatPaneChrome(state).titleRight), `waiting · ${INDEFINITE_TEXT}`);
        assert.equal(selectSessionStatusSummary(state.sessions.byId.s1).status, "waiting");
        assert.equal(selectLiveActivityLines(state).length, 0, "parked waits are not Working");
        assert.doesNotMatch(flatten(view.runs), /0s|idle|until/);
    }
});

test("timed waits show the local absolute deadline, not a reset countdown", () => {
    for (const waitSeconds of [1800, 1, 0, undefined]) {
        const session = row({ signalWait: TIMED_WAIT, waitSeconds });
        assert.equal(selectSessionSignalWait(session).text, TIMED_TEXT);
        assert.equal(selectSessionSignalWait(session).badge,
            `[signal: approval, build-ready · until ${formatCronTimestampForClient(DEADLINE)}]`);
        assert.equal(visibleWaitReason(session, "waiting"), TIMED_TEXT);
    }
});

test("pending signal metadata keeps a dormant row waiting even with idle CMS or active children/cron", () => {
    for (const status of ["waiting", "idle", "unknown"]) {
        const state = appReducer(createInitialState(), { type: "sessions/loaded", sessions: [
            row({ status, cronActive: true, cronInterval: 60 }),
            { sessionId: "child", parentSessionId: "s1", status: "running" },
        ] });
        assert.equal(state.sessions.byId.s1.activeChildCount, 1);
        assert.equal(state.sessions.byId.s1.rowVisualStatus, "waiting");
        assert.equal(selectSessionStatusSummary(state.sessions.byId.s1).status, "waiting");
    }
});

test("an interrupted wait names the saved deadline while the turn remains running", () => {
    const session = row({ status: "running", signalWait: TIMED_WAIT, signalWaitInterrupted: true });
    const state = stateWith(session);
    const expected = `Signal wait interrupted: approval, build-ready · until ${formatCronTimestampForClient(DEADLINE)}`;
    assert.equal(selectSessionStatusSummary(state.sessions.byId.s1).status, "running");
    assert.equal(selectSessionSignalWait(session).text, expected);
    assert.equal(visibleWaitReason(session, "running"), expected);
    assert.equal(visibleWaitReason(session, "waiting"), expected, "also explicit during the row's visual hold");
    assert.ok(flatten(selectChatPaneChrome(state).titleRight).includes(`running · ${expected}`));
    assert.equal(selectLiveActivityLines(state, { spinnerFrame: "*", now: T + 1000 }).length, 1);
    assert.equal(selectSessionSignalWait({ ...session, signalWaitInterrupted: false }), null,
        "running without an interruption must not claim an active wait");
});

test("legacy timers, cron and input keep their previous status/reason semantics", () => {
    for (const session of [
        { status: "waiting", waitSeconds: 60, waitReason: "Taking a break" },
        { status: "waiting", cronActive: true, cronInterval: 60, waitReason: "Check the build" },
        { status: "input_required", pendingQuestion: { question: "Which artifact?" }, waitReason: "Which artifact?" },
    ]) {
        assert.equal(selectSessionSignalWait(session), null);
        assert.equal(visibleWaitReason(session, session.status), session.waitReason);
        assert.equal(waitReasonLabel(session), session.cronActive ? "On wake" : "Waiting");
    }
    const question = row({ status: "input_required", signalWaitInterrupted: true, waitReason: "Which artifact?" });
    assert.equal(selectSessionSignalWait(question), null);
    assert.equal(visibleWaitReason(question, "input_required"), "Which artifact?");
    for (const status of ["completed", "cancelled", "terminated", "failed", "error"]) {
        assert.equal(selectSessionSignalWait(row({ status, signalWaitInterrupted: true })), null);
    }
    assert.equal(selectSessionSignalWait(row({ isGroup: true })), null);
});

test("an interrupted signal wait does not replace the current provider-budget wait", () => {
    for (const signalWait of [WAIT, TIMED_WAIT]) {
        for (const pauseState of [undefined, { kind: "limit", period: "day", provider: "personal" }]) {
            const state = stateWith(row({
                signalWait, signalWaitInterrupted: true, pauseState,
                waitReason: BUDGET_REASON, waitSeconds: 60,
            }));
            const session = state.sessions.byId.s1;
            assert.equal(selectSessionSignalWait(session), null);
            assert.equal(session.rowVisualStatus, pauseState ? "budget_paused" : "waiting");
            assert.equal(session.waitSeconds, 60);
            assert.deepEqual(session.signalWait, signalWait, "retain the suspended wait for resumption");
            assert.equal(waitReasonLabel(session), "Waiting");
            if (!pauseState) assert.equal(visibleWaitReason(session, "waiting"), BUDGET_REASON);
            const view = selectSessionRows(state)[0];
            if (pauseState) assert.equal(view.pause.kind, "limit");
            assert.doesNotMatch(flatten([
                ...view.runs, ...view.detailRuns, ...selectChatPaneChrome(state).titleRight,
            ]), /\[signal|Waiting for signal:|Signal wait interrupted:|no deadline/);
        }
    }
});

for (const path of ["list", "detail"]) {
    function harness(initial = row()) {
        const store = createStore(appReducer, stateWith(initial));
        let snapshot;
        const controller = new PilotSwarmUiController({ store, transport: {
            getSession: async () => snapshot,
        } });
        return {
            current: () => store.getState().sessions.byId.s1,
            async apply(next) {
                snapshot = { sessionId: "s1", ...next };
                if (path === "list") store.dispatch({ type: "sessions/loaded", sessions: [snapshot] });
                else await controller.syncSessionDetail("s1");
            },
        };
    }

    test(`${path}: stale snapshots cannot erase the wait; interruption/resume preserve the same wait`, async () => {
        const h = harness(row({ signalWait: TIMED_WAIT, waitSeconds: 1800 }));
        for (const stale of [
            { status: "idle", statusVersion: 9, updatedAt: T + 50_000 },
            { status: "waiting", statusVersion: 10, updatedAt: T, signalWait: null, signalWaitInterrupted: false },
        ]) {
            await h.apply(stale);
            assert.deepEqual(h.current().signalWait, TIMED_WAIT);
            assert.equal(selectSessionStatusSummary(h.current()).status, "waiting");
        }
        await h.apply({ status: "running", statusVersion: 11, updatedAt: T - 1,
            signalWait: TIMED_WAIT, signalWaitInterrupted: true });
        assert.equal(h.current().status, "running", "server version outranks clock skew");
        assert.equal(h.current().signalWaitInterrupted, true);
        assert.deepEqual(h.current().signalWait, TIMED_WAIT);
        await h.apply({ status: "waiting", statusVersion: 12, updatedAt: T + 1,
            signalWait: TIMED_WAIT, signalWaitInterrupted: false, waitSeconds: 20 });
        assert.deepEqual(h.current().signalWait, TIMED_WAIT);
        assert.equal(h.current().signalWaitInterrupted, false);
        assert.equal(h.current().waitSeconds, 20);
        assert.equal(selectSessionSignalWait(h.current()).text, TIMED_TEXT);
    });

    test(`${path}: wake and replacement waits clear omitted fields and stale reads cannot resurrect them`, async () => {
        const h = harness(row({ signalWait: TIMED_WAIT, waitSeconds: 1800 }));
        await h.apply({ status: "waiting", statusVersion: 11, updatedAt: T + 1,
            signalWait: { ...WAIT, waitId: "wait-2" }, waitStartedAt: T + 1 });
        assert.equal(h.current().waitSeconds, null, "indefinite wait clears the old countdown");
        assert.equal(h.current().signalWait.deadline, undefined);
        await h.apply({ status: "running", statusVersion: 12, updatedAt: T + 2 });
        assert.equal(h.current().signalWait, null);
        assert.equal(h.current().signalWaitInterrupted, false);
        assert.equal(h.current().waitSeconds, null);
        assert.equal(h.current().waitStartedAt, null);
        await h.apply({ status: "waiting", statusVersion: 11, updatedAt: T + 100, signalWait: WAIT });
        assert.equal(h.current().signalWait, null);
        assert.equal(h.current().status, "running");
        await h.apply({ status: "waiting", statusVersion: 13, updatedAt: T + 3,
            waitReason: "Ordinary timer", waitSeconds: 60, waitStartedAt: T + 3 });
        assert.equal(selectSessionSignalWait(h.current()), null);
        assert.equal(h.current().waitSeconds, 60);
        await h.apply({ status: "waiting", statusVersion: 13, updatedAt: T + 3, waitSeconds: 59 });
        assert.equal(h.current().waitSeconds, 59, "a former signal wait must not freeze ordinary timers");
    });

    test(`${path}: a budget wait during interruption retains its own timer until the signal wait resumes`, async () => {
        const h = harness(row({ status: "running", signalWaitInterrupted: true }));
        await h.apply({
            status: "waiting", statusVersion: 11, updatedAt: T + 1,
            signalWait: WAIT, signalWaitInterrupted: true,
            waitReason: BUDGET_REASON, waitSeconds: 60, waitStartedAt: T + 1,
        });
        assert.equal(h.current().waitReason, BUDGET_REASON);
        assert.equal(h.current().waitSeconds, 60);
        assert.equal(h.current().waitStartedAt, T + 1);
        assert.equal(selectSessionSignalWait(h.current()), null);
        assert.deepEqual(h.current().signalWait, WAIT);
        await h.apply({
            status: "waiting", statusVersion: 11, updatedAt: T + 1,
            signalWait: WAIT, signalWaitInterrupted: true,
            waitReason: BUDGET_REASON, waitSeconds: 59, waitStartedAt: T + 1,
        });
        assert.equal(h.current().waitSeconds, 59, "the provider wait's remaining time can refresh at the same status version");
        await h.apply({
            status: "waiting", statusVersion: 12, updatedAt: T + 2,
            signalWait: WAIT, signalWaitInterrupted: false,
            waitReason: "Waiting for signal: approval, build-ready", waitStartedAt: T,
        });
        assert.equal(h.current().waitSeconds, null, "re-arming an indefinite signal wait clears the budget timer");
        assert.equal(selectSessionSignalWait(h.current()).text, INDEFINITE_TEXT);
    });

    test(`${path}: terminal snapshots retire a wait at the same server version`, async () => {
        for (const status of ["completed", "cancelled", "failed"]) {
            const h = harness();
            await h.apply({ status, statusVersion: 10, updatedAt: T });
            assert.equal(h.current().signalWait, null);
            assert.equal(selectSessionSignalWait(h.current()), null);
        }
    });
}

test("timestamp-only detail snapshots retain a stale wait and allow a newer wake", async () => {
    const store = createStore(appReducer, stateWith(row({ statusVersion: undefined })));
    let snapshot = { sessionId: "s1", status: "idle", updatedAt: T };
    const controller = new PilotSwarmUiController({ store, transport: { getSession: async () => snapshot } });
    await controller.syncSessionDetail("s1");
    assert.deepEqual(store.getState().sessions.byId.s1.signalWait, WAIT);
    snapshot = { ...snapshot, status: "running", updatedAt: T + 1 };
    await controller.syncSessionDetail("s1");
    assert.equal(store.getState().sessions.byId.s1.signalWait, null);
});

test("partial event/UI patches do not treat omission as cancellation", () => {
    let state = stateWith(row());
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s1", title: "Renamed" } });
    assert.deepEqual(state.sessions.byId.s1.signalWait, WAIT);
    state = appReducer(state, { type: "sessions/merged", session: {
        sessionId: "s1", status: "running", statusVersion: 9, updatedAt: T + 99,
        signalWait: null, signalWaitInterrupted: true, waitStartedAt: null, waitSeconds: 0,
    } });
    assert.deepEqual(state.sessions.byId.s1.signalWait, WAIT);
    assert.equal(state.sessions.byId.s1.waitStartedAt, T);
});
