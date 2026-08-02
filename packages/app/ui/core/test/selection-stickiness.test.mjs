/**
 * The last selected session/group is restored on reload, whatever order the
 * listings and the profile arrive in — and there is a predictable fallback
 * when the stored selection is gone.
 *
 * The failure this pins: the folder listing routinely lands BEFORE the
 * sessions listing, so a restored selection named a session that had not
 * been delivered yet. It was judged "not visible", replaced by the default,
 * and the default was then saved over the user's real choice.
 *
 * Run: node --test test/selection-stickiness.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const ROOT = { sessionId: "root", title: "PilotSwarm", isSystem: true, createdAt: 1, updatedAt: 1 };
const GROUP = { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "Folder", createdAt: 10, updatedAt: 10 };
const S1 = { sessionId: "s1", title: "one", createdAt: 100, updatedAt: 100 };

const GROUP_ROWS = [{ sessionId: "group:g1", groupId: "g1", isGroup: true, title: "Folder" }];

/** One page-load cycle, with the three arrivals in a given order. */
function loadCycle(storedActive, order) {
    let state = createInitialState({ mode: "web" });
    const steps = {
        profile: () => {
            state = appReducer(state, {
                type: "profileSettings/apply",
                settings: { activeSessionId: storedActive, collapsedSessionIds: [] },
            });
        },
        sessions: () => {
            state = appReducer(state, { type: "sessions/loaded", sessions: [ROOT, GROUP, S1] });
        },
        groups: () => {
            state = appReducer(state, { type: "sessions/groupsLoaded", groups: GROUP_ROWS });
        },
    };
    for (const step of order) steps[step]();
    return state.sessions.activeSessionId;
}

const ORDERS = [
    ["profile", "sessions", "groups"],
    ["sessions", "profile", "groups"],
    ["sessions", "groups", "profile"],
    // The one that failed: folders first, profile restored, sessions last.
    ["groups", "profile", "sessions"],
];

test("a stored session selection is restored in every arrival order", () => {
    for (const order of ORDERS) {
        assert.equal(loadCycle("s1", order), "s1", `lost the selection with order ${order.join(" → ")}`);
    }
});

test("a stored FOLDER selection is restored too", () => {
    for (const order of ORDERS) {
        assert.equal(loadCycle("group:g1", order), "group:g1", `lost the folder selection with order ${order.join(" → ")}`);
    }
});

test("a selection that no longer exists falls back to the system root", () => {
    for (const order of ORDERS) {
        assert.equal(
            loadCycle("deleted-session-id", order),
            "root",
            `wrong fallback with order ${order.join(" → ")}`,
        );
    }
});

test("with nothing stored, the default is the system root once it is loaded", () => {
    // Every order where the sessions listing (which carries the root) lands
    // before or with the profile settles on the root.
    for (const order of ORDERS.filter((o) => o.indexOf("sessions") < o.indexOf("profile"))) {
        assert.equal(loadCycle(null, order), "root", `wrong default with order ${order.join(" → ")}`);
    }
});

test("a default picked before the root loads is not yanked away afterwards", () => {
    // Pre-existing, and deliberate: with the folder listing first and nothing
    // stored, the only selectable row is a folder, so that is chosen. When the
    // root arrives the folder is still a perfectly valid selection, and
    // stealing it would move the user's cursor for them. Documented rather
    // than "fixed" — the stored-selection paths above are what the user
    // actually experiences, and they all restore exactly.
    assert.equal(loadCycle(null, ["groups", "profile", "sessions"]), "group:g1");
});

test("the restored selection is stable across repeated reloads", () => {
    // The same idempotence property the collapse state needs: a load cycle
    // must not persist something other than what it restored.
    let stored = "s1";
    for (let reload = 1; reload <= 4; reload += 1) {
        stored = loadCycle(stored, ["groups", "profile", "sessions"]);
        assert.equal(stored, "s1", `reload ${reload} drifted to ${stored}`);
    }
});
