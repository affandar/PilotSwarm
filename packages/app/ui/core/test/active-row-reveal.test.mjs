/**
 * The selected row must come back into view when the list re-populates.
 *
 * On a page reload the active session id is restored from the profile BEFORE
 * the session listing arrives. The reveal effect therefore ran once against an
 * empty list (no button to scroll to), and its dependency array deliberately
 * excluded the listing — so when the rows finally arrived nothing re-ran, and a
 * selection far down a long list stayed off-screen with no indication of where
 * it was.
 *
 * The exclusion itself is correct and must stay: re-running scrollIntoView on
 * every 4s `sessions/loaded` would yank the list back to the active row while
 * the user is deliberately scrolled away browsing older sessions. So the fix is
 * not "add the listing to the deps" — it is "add the listing AND consume the
 * reveal exactly once per arming", where an arming is a change of session,
 * focus or modal state.
 *
 * This is a source-shape test. The effect needs a real DOM with layout to
 * exercise, which the render smoke test (server-rendered, effects never run)
 * cannot provide — so the three properties that make the fix correct are
 * pinned here instead of silently regressing.
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

// The single effect that focuses and scrolls the active session row.
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

test("scrollIntoView is consumed once per arming, not once per listing", () => {
    // The guard is what keeps the listing dependency from re-introducing the
    // "list yanks back while I am scrolling" behaviour.
    const guardIndex = effect.indexOf("revealedRowKeyRef.current === activeRowRevealKey");
    const scrollIndex = effect.indexOf("scrollIntoView");
    assert.notEqual(guardIndex, -1, "reveal guard missing");
    assert.notEqual(scrollIndex, -1, "scrollIntoView missing");
    assert.ok(guardIndex < scrollIndex, "the guard must short-circuit BEFORE scrollIntoView");
    assert.match(effect, /revealedRowKeyRef\.current = activeRowRevealKey/);
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
