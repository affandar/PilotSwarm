/**
 * Selecting a session must not move the session list.
 *
 * The active row still receives keyboard focus after a restored listing loads,
 * but focus always uses preventScroll and no selection path may call a DOM
 * scrolling API. This keeps the list exactly where the user left it while live
 * session refreshes and external navigation continue to change the selection.
 *
 * This is a source-shape test because server rendering never runs effects and
 * has no layout to inspect.
 *
 * Run: node --test test/active-row-reveal.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
    fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)),
    "utf8",
);

// The single effect that focuses the active session row without moving it.
const effect = (() => {
    const start = source.indexOf("const activeButton = sessionButtonRefs.current.get(viewState.activeSessionId)");
    assert.notEqual(start, -1, "active-row reveal effect not found — did it get renamed?");
    const depsEnd = source.indexOf("]);", start);
    assert.notEqual(depsEnd, -1);
    return source.slice(source.lastIndexOf("React.useEffect", start), depsEnd + 3);
})();

test("the reveal re-runs when the session listing changes", () => {
    // Without this the restored selection is never revealed: the first run
    // happens before any row exists.
    assert.match(effect, /viewState\.sessionsFlat/);
});

test("the reveal is still armed by session, focus and modal changes", () => {
    for (const dep of ["viewState.activeSessionId", "viewState.focused", "viewState.modalOpen"]) {
        assert.ok(effect.includes(dep), `${dep} dropped from the reveal effect`);
    }
});

test("selection never changes the session list scroll position", () => {
    const guardIndex = effect.indexOf("revealedRowKeyRef.current === activeRowRevealKey");
    assert.notEqual(guardIndex, -1, "reveal guard missing");
    assert.match(effect, /revealedRowKeyRef\.current = activeRowRevealKey/);
    assert.doesNotMatch(effect, /scrollIntoView\s*\(/);
    assert.doesNotMatch(effect, /\.scrollTo\s*\(/);
    assert.doesNotMatch(effect, /\.scrollTop\s*=/);
    assert.match(effect, /focus\(\{ preventScroll: true \}\)/);
});

test("a missing row leaves the arming unconsumed so it can retry", () => {
    // If the early return for an absent button sat after the key was recorded,
    // the reload case would burn its one reveal on the empty list.
    const missingRowReturn = effect.indexOf("if (!activeButton) return;");
    const keyConsumed = effect.indexOf("revealedRowKeyRef.current = activeRowRevealKey");
    assert.notEqual(missingRowReturn, -1);
    assert.ok(missingRowReturn < keyConsumed);
});

test("the arming key covers session, focus and modal state", () => {
    const key = source.match(/const activeRowRevealKey = [^\n]+/)?.[0] || "";
    assert.match(key, /viewState\.activeSessionId/);
    assert.match(key, /viewState\.focused/);
    assert.match(key, /viewState\.modalOpen/);
});

test("focus is taken ONCE per arming, never on a plain list refresh", () => {
    // This assertion used to be the opposite, and it pinned a real bug. The
    // effect is woken by every list refresh (~4×/sec while a session streams).
    // Moving DOM focus on each of those ripped it out of the Manage and
    // Copy-link dialogs — which are local React state, not `ui.modal`, so
    // `modalOpen` is false while they are open — and the rest of what the user
    // typed ran as global shortcuts (d = complete, D = delete).
    const focusIndex = effect.indexOf("focus({ preventScroll: true })");
    const guardIndex = effect.indexOf("revealedRowKeyRef.current === activeRowRevealKey");
    assert.notEqual(focusIndex, -1);
    assert.ok(guardIndex < focusIndex, "the arming guard must short-circuit BEFORE focus moves");
});

test("focus is never taken from something the user is typing into", () => {
    assert.match(effect, /tagName === "INPUT"/);
    assert.match(effect, /tagName === "TEXTAREA"/);
    assert.match(effect, /isContentEditable/);
    const typingGuard = effect.indexOf("isTypingTarget");
    const focusCall = effect.indexOf("focus({ preventScroll: true })");
    assert.ok(typingGuard < focusCall);
});

test("leaving the pane or opening a modal DISARMS, so returning re-reveals", () => {
    // The key is a function of (session, focus, modal). Without an explicit
    // reset, closing a modal restores the key the ref already holds, the guard
    // matches, and the row is never brought back into view on the way out —
    // exactly the transitions the old deps array existed to serve.
    const earlyReturn = effect.slice(0, effect.indexOf("const activeButton"));
    assert.match(earlyReturn, /revealedRowKeyRef\.current = null/);
});
