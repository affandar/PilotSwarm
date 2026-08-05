/**
 * The Mobile toggle — one step up the size ramp, everywhere at once.
 *
 * It is a PREFERENCE, not a viewport query. A phone in portrait is the obvious
 * case, but a wall display, a shared screen, or anyone who simply wants larger
 * hit targets wants the same thing, and none of those are detectable from the
 * viewport. So it persists in the profile and roams with the user.
 *
 * The scale moves type and hit targets TOGETHER. Bigger buttons around
 * unchanged 11px labels reads as broken rather than as a mobile mode, so the
 * test below refuses a change that moves only one of them.
 *
 * Run: node --test test/touch-scale.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../../../web/src/index.css");
const webApp = read("../../react/src/web-app.js");

test("the scale is off by default and toggles", () => {
    let state = createInitialState({ mode: "web" });
    assert.equal(state.ui.touchScale, false);

    state = appReducer(state, { type: "ui/touchScale", enabled: true });
    assert.equal(state.ui.touchScale, true);

    state = appReducer(state, { type: "ui/touchScale", enabled: false });
    assert.equal(state.ui.touchScale, false);
});

test("toggling to the value it already has is a no-op", () => {
    // The profile-save effect keys off state identity; a needless new object
    // would write the profile back on every render.
    const state = appReducer(createInitialState({ mode: "web" }), { type: "ui/touchScale", enabled: true });
    assert.equal(appReducer(state, { type: "ui/touchScale", enabled: true }), state);
});

test("the preference survives a profile round-trip", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "profileSettings/apply", settings: { touchScale: true } });
    assert.equal(state.ui.touchScale, true);

    // A profile that says nothing about it must not reset it — the poll runs
    // every few seconds and would otherwise clobber a fresh local toggle.
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "doom" } });
    assert.equal(state.ui.touchScale, true);
});

test("a non-boolean stored value is ignored rather than coerced", () => {
    let state = appReducer(createInitialState({ mode: "web" }), { type: "ui/touchScale", enabled: true });
    state = appReducer(state, { type: "profileSettings/apply", settings: { touchScale: "yes" } });
    assert.equal(state.ui.touchScale, true, "a corrupt profile must not silently flip a display preference");
});

test("the scale moves type AND hit targets, not just one", () => {
    const block = css.slice(css.indexOf(':root[data-ps-touch="1"] {'));
    const scaled = block.slice(0, block.indexOf("}"));
    for (const token of ["--ps-font-size-base", "--ps-font-size-dense", "--ps-control-min-height", "--ps-control-padding"]) {
        assert.ok(scaled.includes(token), `${token} must move with the scale`);
    }
    assert.match(scaled, /--ps-control-min-height: 44px/, "44px is the documented comfortable hit target");
});

test("controls read the scaled tokens rather than hardcoding their size", () => {
    const controlRule = css.slice(css.indexOf(".ps-toolbar-button,"), css.indexOf(':root[data-ps-touch="1"]'));
    assert.match(controlRule, /padding: var\(--ps-control-padding/);
    assert.match(controlRule, /min-height: var\(--ps-control-min-height/);
    assert.match(controlRule, /font-size: var\(--ps-control-font-size/);
});

test("the opt-in outranks the phone step-down", () => {
    // The narrow-viewport media query sets the same three variables at :root
    // (0,1,0). The attribute selector is (0,2,0), so it wins on specificity
    // regardless of source order — otherwise a phone, the exact device this
    // exists for, would fall back to the small ramp.
    assert.ok(
        css.indexOf(':root[data-ps-touch="1"]') < css.indexOf("@media (max-width: 920px)"),
        "if this ordering ever changes, confirm the specificity argument still holds",
    );
    assert.match(css, /:root\[data-ps-touch="1"\]/);
});

test("the toggle is wired to the DOM attribute the stylesheet keys off", () => {
    assert.match(webApp, /document\.documentElement\.dataset\.psTouch = "1"/);
    assert.match(webApp, /delete document\.documentElement\.dataset\.psTouch/);
    assert.match(webApp, /type: "ui\/touchScale", enabled: event\.target\.checked/);
});
