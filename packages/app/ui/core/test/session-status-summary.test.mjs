/**
 * The session-detail box shows "Updated: <time> (<status>)", and the status
 * must not flap.
 *
 * Reported live from waldemort-chk: a session with a parked turn flipped
 * between "idle" and "waiting" for no visible reason. The detail box was
 * printing `session.status` RAW, and two writers disagree mid-turn — the 4s
 * catalog poll carries the CMS row state, the post-event detail sync carries
 * the live orchestration customStatus. Whichever landed last won, so the box
 * alternated at poll cadence.
 *
 * The list row never had this problem, because it reads the DEBOUNCED status
 * (mergeSessionRowVisualStatus holds a change for 5s for exactly this reason)
 * and because a cron session's idle/waiting/unknown all fold into one steady
 * derived state. Reading raw opted the box out of both mechanisms that exist
 * to prevent this.
 *
 * Run: node --test test/session-status-summary.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectSessionStatusSummary } from "../src/selectors.js";

const NOW = Date.now();
const session = (status, extra = {}) => ({
    sessionId: "s1",
    title: "s1",
    status,
    createdAt: NOW - 600_000,
    updatedAt: NOW - 125_000,
    ...extra,
});

function loaded(first) {
    return appReducer(createInitialState({ mode: "web" }), { type: "sessions/loaded", sessions: [first] });
}
const merge = (state, next) => appReducer(state, { type: "sessions/merged", session: next });
const summaryOf = (state) => selectSessionStatusSummary(state.sessions.byId.s1);

test("a parked turn does not flip when the two writers disagree", () => {
    let state = loaded(session("waiting"));
    assert.equal(summaryOf(state).status, "waiting");

    // The catalog poll says idle while the detail sync still says waiting.
    state = merge(state, session("idle"));
    assert.equal(state.sessions.byId.s1.status, "idle", "the raw field really did change");
    assert.equal(summaryOf(state).status, "waiting", "but the displayed status holds");
});

test("a cron session reads as one steady state, whichever writer wins", () => {
    // For a scheduled session, idle and waiting are the same thing — "dormant,
    // will fire again" — so the derivation folds them together and there is
    // nothing left to flap between.
    let state = loaded(session("waiting", { cronActive: true }));
    for (const raw of ["idle", "waiting", "unknown", "idle"]) {
        state = merge(state, session(raw, { cronActive: true }));
        assert.equal(summaryOf(state).status, "waiting", `raw=${raw} must still display as waiting`);
    }
});

test("a real transition is QUEUED, not dropped", () => {
    // The point is to suppress flapping, not to freeze the row. The hold is 5s
    // and applies to every change, including into `running` — so within the
    // window the display still reads the old value while the new one sits as
    // the candidate. Asserting an immediate flip here would be asserting a
    // contract the debounce does not offer; what matters is that the
    // transition is recorded rather than swallowed.
    let state = loaded(session("idle"));
    state = merge(state, session("running"));
    assert.equal(state.sessions.byId.s1.rowVisualStatusCandidate, "running");
    assert.equal(summaryOf(state).status, "idle", "still holding, by design");
});

test("the box and the list row never disagree", () => {
    // Both read the same accessor now. If they ever diverge again, the box is
    // back to reading raw and the flap is back with it.
    let state = loaded(session("waiting"));
    state = merge(state, session("idle"));
    const row = state.sessions.byId.s1;
    assert.equal(summaryOf(state).status, row.rowVisualStatus === "cron_waiting" ? "waiting" : row.rowVisualStatus);
});

test("the summary carries a relative time and the timestamp behind it", () => {
    const summary = summaryOf(loaded(session("idle")));
    assert.match(summary.relative, /^\d+m ago$/, "125s ago reads in whole minutes");
    assert.equal(summary.timestampMs, NOW - 125_000);
});

test("the timestamp falls back when updatedAt is absent", () => {
    // Same fallback chain the list row sorts by, so the box and the list can
    // never disagree about when a session last moved.
    const noUpdate = { sessionId: "s1", title: "s1", status: "idle", createdAt: NOW - 300_000 };
    assert.equal(summaryOf(loaded(noUpdate)).timestampMs, NOW - 300_000);

    const summaryOnly = { sessionId: "s1", title: "s1", status: "idle", summaryUpdatedAt: NOW - 60_000, createdAt: NOW - 300_000 };
    assert.equal(summaryOf(loaded(summaryOnly)).timestampMs, NOW - 60_000, "summaryUpdatedAt outranks createdAt");
});

test("a session with no timestamps at all renders a dash, not a bogus date", () => {
    const bare = { sessionId: "s1", title: "s1", status: "idle" };
    const summary = summaryOf(loaded(bare));
    assert.equal(summary.timestampMs, null);
    assert.equal(summary.relative, "—");
});

test("no session yields no summary rather than a placeholder row", () => {
    assert.equal(selectSessionStatusSummary(null), null);
    assert.equal(selectSessionStatusSummary(undefined), null);
});

test("awaiting-children still reads as such in the box", () => {
    // The box shares the row's derivation, so the states the row gained are
    // visible here too rather than collapsing back to a bare "idle".
    let state = appReducer(createInitialState({ mode: "web" }), {
        type: "sessions/loaded",
        sessions: [
            session("idle"),
            { sessionId: "child", title: "child", status: "running", parentSessionId: "s1", createdAt: NOW, updatedAt: NOW },
        ],
    });
    assert.match(summaryOf(state).status, /waiting on 1/);
});
