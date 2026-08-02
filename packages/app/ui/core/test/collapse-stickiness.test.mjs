/**
 * Expansion state is sticky — including for parent/sub-agent rows, whose
 * children arrive lazily.
 *
 * The old rule kept a collapse flag only while the row was "collapsible",
 * meaning a folder or a parent with at least one LOADED child. A parent is
 * routinely not collapsible yet at the moment the profile is applied, so its
 * flag was pruned before its children ever arrived and the expansion never
 * survived a reload.
 *
 * Run: node --test test/collapse-stickiness.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const PARENT = { sessionId: "parent", title: "parent", createdAt: 100, updatedAt: 100 };
const CHILD = { sessionId: "kid", title: "child", parentSessionId: "parent", createdAt: 200, updatedAt: 200 };
const GROUP = { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", createdAt: 10, updatedAt: 10 };

const collapsed = (state) => [...state.sessions.collapsedIds].sort();

test("a parent's collapse survives being applied BEFORE its children load", () => {
    let state = createInitialState({ mode: "web" });
    // Only the parent is loaded — no children yet, so it is not "collapsible".
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT] });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { collapsedSessionIds: ["parent"] },
    });
    assert.ok(collapsed(state).includes("parent"), "collapse flag was pruned before children arrived");

    // Children arrive later; the flag must still be there.
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT, CHILD] });
    assert.ok(collapsed(state).includes("parent"), "collapse flag lost when children arrived");
    const visible = state.sessions.flat.map((e) => e.sessionId);
    assert.deepEqual(visible, ["parent"], "collapsed parent should hide its child");
});

test("a folder's collapse survives a listing that does not include it", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [GROUP, PARENT] });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { collapsedSessionIds: ["group:g1"] },
    });
    assert.ok(collapsed(state).includes("group:g1"));

    // A filtered/paged listing that omits the folder must not forget it.
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT] });
    assert.ok(collapsed(state).includes("group:g1"), "flag dropped for a row missing from one listing");

    // It comes back exactly as the user left it.
    state = appReducer(state, { type: "sessions/loaded", sessions: [GROUP, PARENT] });
    assert.ok(collapsed(state).includes("group:g1"), "flag did not survive the row returning");
});

test("the row you are looking at is never hidden inside a collapsed ancestor", () => {
    // The answer to "what if something disappears under you": whatever else
    // is collapsed, the active session's ancestors are force-expanded.
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT, CHILD] });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { collapsedSessionIds: ["parent"], activeSessionId: "kid" },
    });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT, CHILD] });

    const visible = state.sessions.flat.map((e) => e.sessionId);
    assert.ok(visible.includes("kid"), `active session hidden by a collapsed ancestor: ${visible}`);
});

test("collapse state round-trips through profile settings", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [GROUP, PARENT, CHILD] });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { collapsedSessionIds: ["group:g1", "parent"] },
    });
    assert.deepEqual(collapsed(state), ["group:g1", "parent"]);
});

test("a folder left EXPANDED comes back expanded, not re-collapsed", () => {
    // The reported failure, in reducer form: on a fresh load byId is empty, so
    // every folder looks "not seen before" and the default-collapse rule fired
    // over the profile that had just been restored.
    let state = createInitialState({ mode: "web" });
    // Profile says: only some OTHER folder is collapsed — g1 is expanded.
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { collapsedSessionIds: ["group:other"] },
    });
    // Then the folder listing arrives, as it does at startup.
    state = appReducer(state, {
        type: "sessions/groupsLoaded",
        groups: [{ sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1" }],
    });
    assert.ok(
        !state.sessions.collapsedIds.has("group:g1"),
        "an expanded folder was force-collapsed by the listing",
    );
});

test("with no stored preference, a newly seen folder still starts collapsed", () => {
    // The original behaviour must survive for first-time users: folders should
    // not spill their members into the list before anyone has an opinion.
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [GROUP, PARENT, CHILD] });
    assert.ok(state.sessions.collapsedIds.has("group:g1"), "first-seen folder should default to collapsed");
    assert.ok(state.sessions.collapsedIds.has("parent"), "first-seen parent should default to collapsed");
});

test("a folder created WHILE the app is open still starts collapsed", () => {
    // The baseline exists here, so the folder is genuinely new and the
    // default must still apply even for a user with explicit preferences.
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [PARENT] });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { collapsedSessionIds: [] },
    });
    // A FIRST groups listing establishes the baseline — everything in it is
    // pre-existing as far as the user is concerned.
    state = appReducer(state, { type: "sessions/groupsLoaded", groups: [] });
    // The folder appears in a LATER listing, so it is genuinely new.
    state = appReducer(state, {
        type: "sessions/groupsLoaded",
        groups: [{ sessionId: "group:new", groupId: "new", isGroup: true, title: "New" }],
    });
    assert.ok(state.sessions.collapsedIds.has("group:new"), "a folder arriving mid-session should start collapsed");
});

/**
 * THE RATCHET TEST.
 *
 * The reported failure was not a single wrong read: one refresh looked fine
 * and the NEXT collapsed everything. That shape means a load cycle writes
 * back something more collapsed than it read, so each reload compounds the
 * last one's corruption.
 *
 * So the property to hold is idempotence: running the whole load cycle over
 * its own saved output must converge. A single-pass assertion cannot catch
 * this — the first pass is the one that looks correct.
 */
function loadCycle(storedCollapsed, { groupsFirst = false } = {}) {
    const SESSIONS = [GROUP, PARENT, CHILD];
    const GROUPS = [{ sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1" }];
    let state = createInitialState({ mode: "web" });
    // The portal restores the profile and loads listings; the relative order
    // is a race in practice, so both orders must converge to the same place.
    if (groupsFirst) {
        state = appReducer(state, { type: "sessions/groupsLoaded", groups: GROUPS });
        state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: storedCollapsed } });
        state = appReducer(state, { type: "sessions/loaded", sessions: SESSIONS });
    } else {
        state = appReducer(state, { type: "profileSettings/apply", settings: { collapsedSessionIds: storedCollapsed } });
        state = appReducer(state, { type: "sessions/loaded", sessions: SESSIONS });
        state = appReducer(state, { type: "sessions/groupsLoaded", groups: GROUPS });
    }
    // What the save effect would persist.
    return [...state.sessions.collapsedIds].sort();
}

test("everything expanded stays expanded across repeated reloads", () => {
    let stored = [];
    for (let reload = 1; reload <= 4; reload += 1) {
        stored = loadCycle(stored);
        assert.deepEqual(stored, [], `reload ${reload} collapsed rows the user had left open: ${JSON.stringify(stored)}`);
    }
});

test("a partial choice is preserved exactly, reload after reload", () => {
    // Parent collapsed, folder open — the mix a real user ends up with.
    let stored = ["parent"];
    for (let reload = 1; reload <= 4; reload += 1) {
        stored = loadCycle(stored);
        assert.deepEqual(stored, ["parent"], `reload ${reload} drifted: ${JSON.stringify(stored)}`);
    }
});

test("convergence does not depend on whether groups or the profile land first", () => {
    let stored = [];
    for (let reload = 1; reload <= 3; reload += 1) {
        stored = loadCycle(stored, { groupsFirst: true });
        assert.deepEqual(stored, [], `groups-first reload ${reload} collapsed the tree: ${JSON.stringify(stored)}`);
    }
});
