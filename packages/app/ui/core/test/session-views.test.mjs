// Per-session desktop views: how a person set up the workspace for ONE
// session (columns open, right-side sizes) comes back when they return to it.
//
// The rules pinned here:
//   - no stored view → the default workspace: sessions + chat, no columns,
//     even sizes — even if the previous session had the canvas open
//   - a toggle or a resize while a session is active is recorded for it
//   - the profile poll re-applies the active session's view, so a global
//     desktopPanes/layoutAdjustments never overrides a per-session choice
//   - a phone neither applies nor records; it carries the map through
//   - remote entries merge in, except sessions this tab changed itself
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState, normalizeStoredSessionViews, SESSION_VIEWS_MAX } from "../src/state.js";

const SESSIONS = [
    { sessionId: "a", title: "A", status: "idle" },
    { sessionId: "b", title: "B", status: "idle" },
    { sessionId: "c", title: "C", status: "idle" },
];

function desktopStore({ sessionViews = {} } = {}) {
    const st = createStore(appReducer, createInitialState());
    st.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    st.dispatch({ type: "sessions/loaded", sessions: SESSIONS });
    st.dispatch({ type: "sessions/selected", sessionId: "a" });
    st.dispatch({ type: "profileSettings/apply", settings: { sessionViews } });
    return st;
}

const B_VIEW = { desktop: { canvasOpen: true, diagnosticsOpen: true, zen: false, layout: { canvasPaneAdjust: 120, diagnosticsSplitAdjust: -40 }, at: 5 } };

test("switching to a session applies its stored view; an unknown session gets the default", () => {
    const st = desktopStore({ sessionViews: { b: B_VIEW } });
    st.dispatch({ type: "sessions/selected", sessionId: "b" });
    let ui = st.getState().ui;
    assert.equal(ui.canvasOpen, true);
    assert.equal(ui.diagnosticsOpen, true);
    assert.equal(ui.layout.canvasPaneAdjust, 120);
    assert.equal(ui.layout.diagnosticsSplitAdjust, -40);

    st.dispatch({ type: "sessions/selected", sessionId: "c" });
    ui = st.getState().ui;
    assert.equal(ui.canvasOpen, false, "a session with no stored view opens with no columns");
    assert.equal(ui.diagnosticsOpen, false);
    assert.equal(ui.layout.canvasPaneAdjust, 0, "and even sizes");
    assert.equal(ui.layout.diagnosticsSplitAdjust, 0);
});

test("a toggle or a resize while a session is active is recorded for that session, and comes back", () => {
    const st = desktopStore();
    st.dispatch({ type: "ui/canvasOpen", open: true });
    st.dispatch({ type: "ui/canvasPaneAdjust", canvasPaneAdjust: 80 });
    const recorded = st.getState().ui.sessionViews.a.desktop;
    assert.equal(recorded.canvasOpen, true);
    assert.equal(recorded.layout.canvasPaneAdjust, 80);
    assert.ok(recorded.at > 0);

    st.dispatch({ type: "sessions/selected", sessionId: "b" });
    assert.equal(st.getState().ui.canvasOpen, false, "b has no view: default");
    st.dispatch({ type: "sessions/selected", sessionId: "a" });
    assert.equal(st.getState().ui.canvasOpen, true, "a's canvas came back");
    assert.equal(st.getState().ui.layout.canvasPaneAdjust, 80);
});

test("the profile poll cannot override the active session's view with the global columns", () => {
    const st = desktopStore({ sessionViews: { a: { desktop: { canvasOpen: false, diagnosticsOpen: false, zen: false, layout: {}, at: 1 } } } });
    assert.equal(st.getState().ui.canvasOpen, false);
    st.dispatch({ type: "profileSettings/apply", settings: { desktopPanes: { canvasOpen: true, diagnosticsOpen: true, zen: false }, sessionViews: { a: { desktop: { canvasOpen: false, diagnosticsOpen: false, zen: false, layout: {}, at: 1 } } } } });
    assert.equal(st.getState().ui.canvasOpen, false, "the per-session view won over the global desktopPanes");
    assert.equal(st.getState().ui.diagnosticsOpen, false);
});

test("a column opened before the profile is read survives the read", () => {
    // The e2e diagnostics-split spec caught this: the toggle landed before
    // the first profile poll answered, and the read's apply shut the column.
    const st = createStore(appReducer, createInitialState());
    st.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    st.dispatch({ type: "sessions/loaded", sessions: SESSIONS });
    st.dispatch({ type: "sessions/selected", sessionId: "a" });
    st.dispatch({ type: "ui/diagnosticsOpen", open: true });
    st.dispatch({ type: "ui/diagnosticsSplitAdjust", diagnosticsSplitAdjust: 30 });
    assert.equal(st.getState().ui.sessionViews.a.desktop.diagnosticsOpen, true, "recorded even before the read");
    st.dispatch({ type: "profileSettings/apply", settings: { sessionViews: { a: { desktop: { canvasOpen: true, diagnosticsOpen: false, zen: false, layout: {}, at: 1 } } } } });
    assert.equal(st.getState().ui.diagnosticsOpen, true, "the local toggle won the merge");
    assert.equal(st.getState().ui.layout.diagnosticsSplitAdjust, 30);
    assert.equal(st.getState().ui.canvasOpen, false, "the stale remote view did not apply over it");
    // But a session switch before the read applies nothing.
    const st2 = createStore(appReducer, createInitialState());
    st2.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    st2.dispatch({ type: "sessions/loaded", sessions: SESSIONS });
    st2.dispatch({ type: "sessions/selected", sessionId: "a" });
    st2.dispatch({ type: "ui/canvasOpen", open: true });
    st2.dispatch({ type: "sessions/selected", sessionId: "b" });
    assert.equal(st2.getState().ui.canvasOpen, true, "no apply on switch before the read");
});

test("a phone neither applies nor records, but keeps the stored map to write back", () => {
    const st = createStore(appReducer, createInitialState());
    st.dispatch({ type: "ui/sessionViewDevice", device: "mobile" });
    st.dispatch({ type: "sessions/loaded", sessions: SESSIONS });
    st.dispatch({ type: "sessions/selected", sessionId: "a" });
    st.dispatch({ type: "profileSettings/apply", settings: { sessionViews: { b: B_VIEW } } });
    st.dispatch({ type: "sessions/selected", sessionId: "b" });
    assert.equal(st.getState().ui.canvasOpen, false, "the phone layout is untouched");
    st.dispatch({ type: "ui/canvasOpen", open: true });
    assert.equal(st.getState().ui.sessionViews.a, undefined, "nothing recorded on a phone");
    assert.deepEqual(Object.keys(st.getState().ui.sessionViews), ["b"], "the desktop's views ride along");
});

test("a remote profile merges in by newest record: a fresh local edit survives, an older one yields", () => {
    const st = desktopStore();
    st.dispatch({ type: "ui/diagnosticsOpen", open: true }); // records "a" at Date.now()
    st.dispatch({ type: "profileSettings/apply", settings: { sessionViews: {
        a: { desktop: { canvasOpen: true, diagnosticsOpen: false, zen: false, layout: {}, at: 2 } },
        c: { desktop: { canvasOpen: true, diagnosticsOpen: false, zen: false, layout: {}, at: 3 } },
    } } });
    let views = st.getState().ui.sessionViews;
    assert.equal(views.a.desktop.diagnosticsOpen, true, "local edit to a is newer than the stored one: kept");
    assert.equal(views.a.desktop.canvasOpen, false);
    assert.equal(views.c.desktop.canvasOpen, true, "remote c adopted");
    assert.equal(st.getState().ui.diagnosticsOpen, true, "the active session's view was re-applied from the merged map");

    // Another desktop edits "a" LATER: its record wins and is applied here.
    const later = Date.now() + 60_000;
    st.dispatch({ type: "profileSettings/apply", settings: { sessionViews: {
        a: { desktop: { canvasOpen: true, diagnosticsOpen: false, zen: false, layout: {}, at: later } },
    } } });
    views = st.getState().ui.sessionViews;
    assert.equal(views.a.desktop.canvasOpen, true, "the newer remote record replaced the local one");
    assert.equal(st.getState().ui.canvasOpen, true);
    assert.equal(st.getState().ui.diagnosticsOpen, false);
});

test("stored views are whitelisted, bounded, and newest-first", () => {
    const many = {};
    for (let i = 0; i < SESSION_VIEWS_MAX + 20; i += 1) many[`s${i}`] = { desktop: { canvasOpen: true, at: i + 1, junk: 1 }, bogus: { canvasOpen: true } };
    const out = normalizeStoredSessionViews(many);
    assert.equal(Object.keys(out).length, SESSION_VIEWS_MAX);
    assert.equal(out.s0, undefined, "the oldest entries fall off");
    assert.ok(out[`s${SESSION_VIEWS_MAX + 19}`]);
    assert.deepEqual(Object.keys(out[`s${SESSION_VIEWS_MAX + 19}`]), ["desktop"], "unknown device slots dropped");
    assert.equal(out[`s${SESSION_VIEWS_MAX + 19}`].desktop.junk, undefined);
    assert.equal(normalizeStoredSessionViews({ x: { desktop: { canvasOpen: false, zen: true } } }).x.desktop.zen, false, "zen needs the canvas");
});
