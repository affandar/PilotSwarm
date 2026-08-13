/**
 * Mobile follow-focus must not open Diagnostics when the user asked for the
 * workspace.
 *
 * The phone's top-right "Main" (sessions) button switches the mobile pane AND
 * calls setFocus("chat") to focus the chat within the workspace. But a phone
 * layout has no chat/sessions focus slot, so normalizeFocusRegion rewrites
 * those workspace regions to the first focusable pane — the inspector. The
 * React follow-focus effect then read that normalized "inspector" as "the user
 * wants Diagnostics" and yanked them into the diagnostics pane the instant they
 * tapped Main.
 *
 * The fix: ui/focus records the RAW requested region alongside the normalized
 * one, and the follow-focus effect gates on the raw intent. This pins that
 * contract at the reducer level (the effect's gate is asserted as a predicate).
 *
 * Run: node --test test/unit/mobile-focus-follow.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { normalizeFocusRegion } from "../src/layout.js";
import { FOCUS_REGIONS } from "../src/commands.js";

// A phone renders as a single left-hidden column: its focus order is
// [inspector, activity, prompt], so any workspace region normalizes to
// inspector. This is the exact layout the bug needed.
const MOBILE_LAYOUT = { leftHidden: true };

// The predicate the mobile follow-focus effect uses (web-app.js): switch the
// pane to a diagnostics view only when the focus GENUINELY targets it.
function followFocusOpensDiagnostics(ui) {
    const isDiag = ui.focusRegion === "inspector" || ui.focusRegion === "activity";
    const requestedDiag = ui.requestedFocusRegion === "inspector" || ui.requestedFocusRegion === "activity";
    return isDiag && requestedDiag;
}

// setFocus's normalize-then-dispatch, reproduced so the test exercises the
// same values the controller produces.
function dispatchFocus(store, rawRegion, layout) {
    store.dispatch({
        type: "ui/focus",
        focusRegion: normalizeFocusRegion(rawRegion, layout),
        requestedFocusRegion: rawRegion,
    });
}

test("normalizeFocusRegion sends workspace regions to inspector on a phone", () => {
    assert.equal(normalizeFocusRegion(FOCUS_REGIONS.SESSIONS, MOBILE_LAYOUT), FOCUS_REGIONS.INSPECTOR);
    assert.equal(normalizeFocusRegion(FOCUS_REGIONS.CHAT, MOBILE_LAYOUT), FOCUS_REGIONS.INSPECTOR);
    // Real inspector/activity intent survives unchanged.
    assert.equal(normalizeFocusRegion(FOCUS_REGIONS.INSPECTOR, MOBILE_LAYOUT), FOCUS_REGIONS.INSPECTOR);
    assert.equal(normalizeFocusRegion(FOCUS_REGIONS.ACTIVITY, MOBILE_LAYOUT), FOCUS_REGIONS.ACTIVITY);
});

test("ui/focus preserves the raw requested region beside the normalized one", () => {
    const store = createStore(appReducer, createInitialState());
    dispatchFocus(store, FOCUS_REGIONS.CHAT, MOBILE_LAYOUT);
    const ui = store.getState().ui;
    assert.equal(ui.focusRegion, FOCUS_REGIONS.INSPECTOR, "chat normalizes to inspector on a phone");
    assert.equal(ui.requestedFocusRegion, FOCUS_REGIONS.CHAT, "the raw request is kept");
});

test("the Main/sessions button does NOT open Diagnostics (the reported bug)", () => {
    const store = createStore(appReducer, createInitialState());
    // Tapping Main focuses the chat within the workspace.
    dispatchFocus(store, FOCUS_REGIONS.CHAT, MOBILE_LAYOUT);
    assert.equal(followFocusOpensDiagnostics(store.getState().ui), false,
        "a workspace focus that normalized to inspector must NOT switch to diagnostics");

    // The sessions region (session list reclaiming focus) is the same story.
    dispatchFocus(store, FOCUS_REGIONS.SESSIONS, MOBILE_LAYOUT);
    assert.equal(followFocusOpensDiagnostics(store.getState().ui), false,
        "sessions focus normalized to inspector must NOT switch to diagnostics");
});

test("a genuine inspector/activity focus STILL opens Diagnostics (keyboard nav)", () => {
    const store = createStore(appReducer, createInitialState());
    dispatchFocus(store, FOCUS_REGIONS.INSPECTOR, MOBILE_LAYOUT);
    assert.equal(followFocusOpensDiagnostics(store.getState().ui), true,
        "an inspector focus the caller actually asked for switches the pane");

    dispatchFocus(store, FOCUS_REGIONS.ACTIVITY, MOBILE_LAYOUT);
    assert.equal(followFocusOpensDiagnostics(store.getState().ui), true,
        "an activity focus the caller actually asked for switches the pane");
});
