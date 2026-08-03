/**
 * A pin is sticky — it survives a listing that does not contain the row.
 *
 * The old rule dropped a pin whenever the pinned session was absent from the
 * incoming listing. Absent has many causes — not loaded yet, filtered out, on
 * another page, slower to arrive — and none of them is the user unpinning.
 * Worse, `pinnedIds` is a dependency of the profile-save effect, so the
 * emptied list was written straight back to the server as the user's
 * preference: the pin did not survive a restart, and the destroyed preference
 * propagated to every other device, so a pin set on the desktop never reached
 * the phone.
 *
 * This is the same rule, and the same reasoning, as collapse-stickiness.
 *
 * Run: node --test test/pin-stickiness.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const PINNED = { sessionId: "pinned", title: "pinned", createdAt: 100, updatedAt: 100 };
const OTHER = { sessionId: "other", title: "other", createdAt: 200, updatedAt: 200 };

const pins = (state) => [...state.sessions.pinnedIds];

const restored = (sessions = []) => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { pinnedSessionIds: ["pinned"] },
    });
    if (sessions.length) {
        state = appReducer(state, { type: "sessions/loaded", sessions });
    }
    return state;
};

test("a restored pin survives a listing that does not include the row", () => {
    // The regression: one listing without the pinned row silently unpinned it,
    // and the save effect then persisted that as the user's choice.
    const state = restored([OTHER]);
    assert.deepEqual(pins(state), ["pinned"], "pin dropped by a listing that lacked the row");
});

test("a pin survives an EMPTY listing", () => {
    // An early/empty listing on page load is the common real-world trigger.
    const state = restored([]);
    const after = appReducer(state, { type: "sessions/loaded", sessions: [] });
    assert.deepEqual(pins(after), ["pinned"]);
});

test("a pin dropped once does not come back — so it must never be dropped", () => {
    // Proves the ratchet: before the fix the pin was gone for good, because
    // nothing re-adds a pin when the row reappears.
    let state = restored([OTHER]);
    state = appReducer(state, { type: "sessions/loaded", sessions: [PINNED, OTHER] });
    assert.deepEqual(pins(state), ["pinned"], "pin must still be present once the row returns");
});

test("the pin still applies to the tree once the row arrives", () => {
    let state = restored([OTHER]);
    state = appReducer(state, { type: "sessions/loaded", sessions: [OTHER, PINNED] });
    const order = state.sessions.flat.map((e) => e.sessionId);
    assert.equal(order[0], "pinned", `pinned row should sort first, got ${order.join(", ")}`);
});

// ── the drops that ARE real signals ──────────────────────────────
//
// Keeping absent rows must not turn the pin into something that can never be
// released. A row that is present and demonstrably no longer pinnable still
// loses its pin.

test("a session moved into a group loses its pin", () => {
    let state = restored([PINNED]);
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ ...PINNED, groupId: "g1" }],
    });
    assert.deepEqual(pins(state), []);
});

test("a session that becomes a child loses its pin", () => {
    let state = restored([PINNED]);
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ ...PINNED, parentSessionId: "p1" }],
    });
    assert.deepEqual(pins(state), []);
});

test("a system row loses its pin", () => {
    let state = restored([PINNED]);
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ ...PINNED, isSystem: true }],
    });
    assert.deepEqual(pins(state), []);
});

test("a pin is not duplicated by repeated listings", () => {
    let state = restored([PINNED]);
    state = appReducer(state, { type: "sessions/loaded", sessions: [PINNED] });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PINNED] });
    assert.deepEqual(pins(state), ["pinned"]);
});
