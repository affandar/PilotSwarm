// Keyboard takeover decision (phone): while the on-screen keyboard is up and
// the composer summoned it, the workspace chrome folds away so the transcript
// keeps the visual viewport. The decision is deliberately state-driven — it
// must engage only for a real keyboard-sized shrink WITH composer focus, and
// disengage the moment the viewport height comes back, because iOS can
// swipe-dismiss the keyboard without ever blurring the input. History: the
// removed composer "expand mode" earned its deletion by getting stuck; this
// contract is what keeps the takeover un-stickable.
import test from "node:test";
import assert from "node:assert/strict";

const { evaluateKeyboardTakeover } = await import("../../react/src/web-app.js");

const PHONE = { width: 390, height: 844 };

function seed() {
    return evaluateKeyboardTakeover(null, PHONE.width, PHONE.height, false).baseline;
}

test("keyboard-sized shrink with composer focus engages the takeover", () => {
    const baseline = seed();
    const next = evaluateKeyboardTakeover(baseline, 390, 480, true);
    assert.equal(next.takeover, true);
    assert.equal(next.baseline.height, 844, "baseline must keep the tall height");
});

test("shrink without composer focus does not engage (modal inputs, blur)", () => {
    const baseline = seed();
    assert.equal(evaluateKeyboardTakeover(baseline, 390, 480, false).takeover, false);
});

test("composer focus without a real shrink does not engage (hardware keyboard)", () => {
    const baseline = seed();
    assert.equal(evaluateKeyboardTakeover(baseline, 390, 844, true).takeover, false);
});

test("small viewport churn (URL bar) stays under the threshold", () => {
    const baseline = seed();
    assert.equal(evaluateKeyboardTakeover(baseline, 390, 844 - 100, true).takeover, false);
});

test("height restore releases the takeover even while focus persists", () => {
    let state = evaluateKeyboardTakeover(seed(), 390, 480, true);
    assert.equal(state.takeover, true);
    // iOS swipe-dismiss: keyboard gone, input still focused.
    state = evaluateKeyboardTakeover(state.baseline, 390, 844, true);
    assert.equal(state.takeover, false);
});

test("rotation resets the baseline instead of reading landscape as a keyboard", () => {
    const portrait = seed();
    // 390x844 → landscape 844x390: height dropped 454px but the width changed,
    // so this is a rotation, not a keyboard.
    const next = evaluateKeyboardTakeover(portrait, 844, 390, true);
    assert.equal(next.takeover, false);
    assert.deepEqual(next.baseline, { width: 844, height: 390 });
});

test("baseline grows to the tallest height seen at the current width", () => {
    // Android resizes-content: the app can BOOT with the keyboard already up.
    // The first keyboard dismissal teaches the true height; the next keyboard
    // then reads as a shrink.
    let state = evaluateKeyboardTakeover(null, 390, 480, true);
    assert.equal(state.takeover, false, "no shrink measurable yet at boot");
    state = evaluateKeyboardTakeover(state.baseline, 390, 844, false);
    assert.equal(state.baseline.height, 844);
    state = evaluateKeyboardTakeover(state.baseline, 390, 480, true);
    assert.equal(state.takeover, true);
});
