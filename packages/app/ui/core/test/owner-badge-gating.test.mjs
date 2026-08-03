/**
 * The owner chip appears only when the list holds more than one distinct HUMAN
 * owner.
 *
 * The bug this pins: sessions a system agent spawns on a user's behalf carry
 * the first-class System principal ({provider:"system", subject:"system"}) but
 * are deliberately NOT flagged isSystem, so they stay deletable. Gating on the
 * flag alone let "System" count as a second person, and a single-user
 * deployment ended up with an owner chip on every row.
 *
 * Run: node --test test/owner-badge-gating.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    appReducer,
    createInitialState,
    defaultOwnerFilterForPrincipal,
    selectSessionRows,
} from "../src/index.js";

const ADA = { provider: "entra", subject: "e867", email: "ada@example.com", displayName: "Ada Lovelace" };
const GRACE = { provider: "entra", subject: "aee3", email: "grace@example.com", displayName: "Grace Hopper" };
const SYSTEM_USER = { provider: "system", subject: "system", displayName: "System" };

function loadedState(sessions, ownerFilter = { all: true, includeSystem: true, includeUnowned: true, includeMe: true, includeShared: true, ownerKeys: [] }) {
    let state = createInitialState();
    state = appReducer(state, { type: "auth/context", principal: ADA, authorization: { role: "user" } });
    state = appReducer(state, { type: "sessions/ownerFilter", filter: ownerFilter });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

/** Owner chip per rendered row, keyed by session id. */
function badgesById(state) {
    const out = new Map();
    for (const row of selectSessionRows(state)) {
        if (!row?.sessionId) continue;
        out.set(row.sessionId, row.ownerBadge || null);
    }
    return out;
}

test("one human owner: no chips, even alongside system-spawned sessions", () => {
    const badges = badgesById(loadedState([
        { sessionId: "mine-1", title: "Mine 1", status: "idle", owner: ADA },
        { sessionId: "mine-2", title: "Mine 2", status: "idle", owner: ADA },
        // Spawned BY a system agent on the user's behalf: System-owned, and
        // deliberately NOT isSystem so it stays deletable.
        { sessionId: "system-spawned", title: "System Child", status: "idle", owner: SYSTEM_USER },
        // A real system agent.
        { sessionId: "sweeper", title: "Sweeper", status: "idle", isSystem: true },
    ]));

    assert.equal(badges.get("mine-1"), null, "a single-owner list must not decorate");
    assert.equal(badges.get("mine-2"), null);
    assert.equal(badges.get("system-spawned"), null, "System is not a second person");
});

test("two humans: chips appear, and tell the two apart", () => {
    const badges = badgesById(loadedState([
        { sessionId: "mine", title: "Mine", status: "idle", owner: ADA },
        { sessionId: "theirs", title: "Theirs", status: "idle", owner: GRACE },
        { sessionId: "system-spawned", title: "System Child", status: "idle", owner: SYSTEM_USER },
    ]));

    assert.ok(badges.get("mine"), "a multi-owner list must decorate");
    assert.ok(badges.get("theirs"));
    assert.equal(badges.get("mine").initials, "AL");
    assert.equal(badges.get("theirs").initials, "GH");
    // Deliberately NOT asserted: that the two hues differ. The palette is eight
    // buckets, so any two people collide about one time in eight — an
    // assertion that happens to pass for one pair of names and fails for the
    // next. Initials carry the distinction; hue only has to be STABLE, which
    // is what makes the same person the same colour everywhere.
    assert.equal(typeof badges.get("mine").hue, "number");
    assert.equal(
        badges.get("mine").hue,
        badgesById(loadedState([{ sessionId: "mine", title: "Mine", status: "idle", owner: ADA },
            { sessionId: "theirs", title: "Theirs", status: "idle", owner: GRACE }])).get("mine").hue,
        "the same owner must get the same hue every time",
    );
});

test("filtering an owner OUT of the list also takes them out of the tally", () => {
    // "me + System" is one human. The chip would say nothing on every row.
    const state = loadedState(
        [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ADA },
            { sessionId: "theirs", title: "Theirs", status: "idle", owner: GRACE },
            { sessionId: "sys-child", title: "System Child", status: "idle", owner: SYSTEM_USER },
            { sessionId: "sweeper", title: "Sweeper", status: "idle", isSystem: true },
        ],
        { all: false, includeSystem: true, includeUnowned: false, includeMe: true, includeShared: false, ownerKeys: [] },
    );

    const badges = badgesById(state);
    assert.equal(badges.has("theirs"), false, "Grace's row is filtered out");
    assert.ok(badges.size > 0, "Ada's rows still render");
    for (const [id, badge] of badges) assert.equal(badge, null, `${id} should carry no chip`);
});

test("a filter that admits both owners does decorate", () => {
    // Same fixture, shared included — Grace is back in the list, so the chip
    // has something to say again.
    const state = loadedState(
        [
            { sessionId: "mine", title: "Mine", status: "idle", owner: ADA },
            { sessionId: "theirs", title: "Theirs", status: "idle", owner: GRACE },
        ],
        { all: false, includeSystem: true, includeUnowned: false, includeMe: true, includeShared: true, ownerKeys: [] },
    );

    const badges = badgesById(state);
    assert.ok(badges.get("mine"), "two admitted owners must decorate");
    assert.ok(badges.get("theirs"));
});

test("collapsing a folder hides rows but does NOT drop them from the tally", () => {
    // The other half of the rule: collapse is not filtering. A chip that
    // appeared on expand and vanished on collapse would be worse than none.
    let state = loadedState([
        { sessionId: "grp", title: "Folder", isGroup: true, groupId: "g1" },
        { sessionId: "mine", title: "Mine", status: "idle", owner: ADA },
        { sessionId: "theirs", title: "Theirs", status: "idle", owner: GRACE, groupId: "g1" },
    ]);
    const expanded = badgesById(state);
    assert.ok(expanded.get("mine"), "two owners: decorated while expanded");

    state = appReducer(state, { type: "sessions/collapse", sessionId: "grp" });
    const collapsed = badgesById(state);
    assert.ok(collapsed.get("mine"), "still decorated once the folder is collapsed");
});

test("narrowing the filter to a single owner does not by itself decorate", () => {
    // Previously ANY non-empty ownerKeys forced chips on, so filtering to just
    // yourself tagged every row with a pointless "you are you" chip.
    const state = loadedState(
        [
            { sessionId: "mine-1", title: "Mine 1", status: "idle", owner: ADA },
            { sessionId: "mine-2", title: "Mine 2", status: "idle", owner: ADA },
        ],
        { all: false, includeSystem: false, includeUnowned: false, includeMe: false, includeShared: false, ownerKeys: [`entra${ADA.subject}`] },
    );

    const badges = badgesById(state);
    assert.ok(badges.size > 0, "the filter should still surface Ada's own rows");
    for (const badge of badges.values()) assert.equal(badge, null);
});

test("unowned sessions are not a second owner", () => {
    const badges = badgesById(loadedState([
        { sessionId: "mine", title: "Mine", status: "idle", owner: ADA },
        { sessionId: "orphan", title: "Orphan", status: "idle" },
        { sessionId: "orphan-2", title: "Orphan 2", status: "idle", owner: { provider: "", subject: "" } },
    ]));

    for (const badge of badges.values()) assert.equal(badge, null);
});

test("the default signed-in filter alone does not decorate", () => {
    // defaultOwnerFilterForPrincipal sets all:false + includeShared:true; those
    // used to be read as "explicit multi-user context".
    const badges = badgesById(loadedState(
        [{ sessionId: "mine", title: "Mine", status: "idle", owner: ADA }],
        defaultOwnerFilterForPrincipal(ADA),
    ));

    for (const badge of badges.values()) assert.equal(badge, null);
});
