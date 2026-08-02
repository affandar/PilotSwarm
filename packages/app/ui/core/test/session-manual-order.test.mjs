/**
 * Manual session ordering — the tree half.
 *
 * The user places rows where they want them and they stay there; anything
 * never placed sorts after everything placed, so a brand-new session arrives
 * at the END of its list rather than jumping to the top.
 *
 * One flat id list drives every level: top-level rows, folders, and the
 * sessions inside a folder are each sorted as siblings within their parent's
 * child list, so the same map governs all three without per-level state.
 *
 * Run: node --test test/session-manual-order.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionTree, buildManualOrderMap, isManuallyOrderableSession } from "../src/session-tree.js";

const ids = (flat) => flat.map((entry) => entry.sessionId);

/** Three top-level sessions, created oldest → newest. */
function topLevel() {
    return [
        { sessionId: "a", title: "alpha", createdAt: 1000 },
        { sessionId: "b", title: "bravo", createdAt: 2000 },
        { sessionId: "c", title: "charlie", createdAt: 3000 },
    ];
}

test("with no manual order, sessions run oldest → newest so new ones land last", () => {
    const flat = buildSessionTree(topLevel(), new Set(), [], null, null);
    assert.deepEqual(ids(flat), ["a", "b", "c"]);
});

test("activity does not reorder rows — real sessions carry updatedAt", () => {
    // The comparison that actually decides order for live sessions is the
    // summary timestamp, not createdAt: every real session has updatedAt, so
    // a createdAt-only rule would never be reached. A newly active session
    // must NOT climb over rows the user placed above it.
    const sessions = [
        { sessionId: "a", title: "alpha", createdAt: 1000, updatedAt: 1000 },
        { sessionId: "b", title: "bravo", createdAt: 2000, updatedAt: 2000 },
        // "c" is the oldest but just received a message.
        { sessionId: "c", title: "charlie", createdAt: 500, updatedAt: 9999 },
    ];
    const flat = buildSessionTree(sessions, new Set(), [], null, null);
    assert.deepEqual(ids(flat), ["a", "b", "c"], "an active session jumped position");
});

test("a manual order is honoured exactly", () => {
    const flat = buildSessionTree(topLevel(), new Set(), [], null, ["c", "a", "b"]);
    assert.deepEqual(ids(flat), ["c", "a", "b"]);
});

test("dragging one row to the top leaves the others in place beneath it", () => {
    // The canonical gesture: grab the newest, drop it first.
    const flat = buildSessionTree(topLevel(), new Set(), [], null, ["c", "a", "b"]);
    assert.equal(ids(flat)[0], "c");
});

test("a session absent from the manual order sorts AFTER every placed one", () => {
    const sessions = [...topLevel(), { sessionId: "new", title: "newest", createdAt: 4000 }];
    // "new" was never dragged, so it is not in the stored list.
    const flat = buildSessionTree(sessions, new Set(), [], null, ["c", "a", "b"]);
    assert.deepEqual(ids(flat), ["c", "a", "b", "new"]);
});

test("several unplaced sessions keep arrival order among themselves", () => {
    const sessions = [
        { sessionId: "placed", title: "placed", createdAt: 500 },
        { sessionId: "n2", title: "second new", createdAt: 3000 },
        { sessionId: "n1", title: "first new", createdAt: 2000 },
    ];
    const flat = buildSessionTree(sessions, new Set(), [], null, ["placed"]);
    assert.deepEqual(ids(flat), ["placed", "n1", "n2"]);
});

test("a stale id in the stored order does not disturb live rows", () => {
    // Deleted sessions linger in the profile list until it is next written.
    const flat = buildSessionTree(topLevel(), new Set(), [], null, ["ghost", "c", "gone", "a", "b"]);
    assert.deepEqual(ids(flat), ["c", "a", "b"]);
});

test("manual order applies inside a folder, and to the folders themselves", () => {
    const sessions = [
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", createdAt: 10 },
        { sessionId: "group:g2", groupId: "g2", isGroup: true, title: "G2", createdAt: 20 },
        { sessionId: "s1", title: "one", groupId: "g1", createdAt: 100 },
        { sessionId: "s2", title: "two", groupId: "g1", createdAt: 200 },
        { sessionId: "s3", title: "three", groupId: "g1", createdAt: 300 },
    ];
    // Folder g2 before g1, and inside g1 the members reversed.
    const flat = buildSessionTree(sessions, new Set(), [], null, ["group:g2", "group:g1", "s3", "s2", "s1"]);
    assert.deepEqual(ids(flat), ["group:g2", "group:g1", "s3", "s2", "s1"]);
});

test("manual order never lifts a row out of its folder", () => {
    const sessions = [
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", createdAt: 10 },
        { sessionId: "loose", title: "top level", createdAt: 20 },
        { sessionId: "inside", title: "member", groupId: "g1", createdAt: 30 },
    ];
    // Asking for the folder member first must not promote it above the folder:
    // containment outranks ordering.
    const flat = buildSessionTree(sessions, new Set(), [], null, ["inside", "loose", "group:g1"]);
    const order = ids(flat);
    assert.ok(order.indexOf("group:g1") < order.indexOf("inside"), `member escaped its folder: ${order}`);
});

test("manual order sorts WITHIN a band — folders still precede loose sessions", () => {
    const sessions = [
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", createdAt: 10 },
        { sessionId: "loose", title: "top level", createdAt: 20 },
    ];
    // rankSessionBand puts every folder (3) above every ungrouped session (4),
    // and manual order is compared only after the band. So asking for "loose"
    // first does NOT move it above the folder. If dragging a session above a
    // folder should be possible, the BAND is what has to change — not this
    // comparison.
    const flat = buildSessionTree(sessions, new Set(), [], null, ["loose", "group:g1"]);
    assert.deepEqual(ids(flat), ["group:g1", "loose"]);
});

test("pins still outrank manual order", () => {
    const sessions = topLevel();
    // "a" is pinned but placed last in the manual order — the pin band wins.
    const flat = buildSessionTree(sessions, new Set(), [], new Set(["a"]), ["c", "b", "a"]);
    assert.equal(ids(flat)[0], "a");
});

test("sub-agents are not movable — their place reflects the run, not a preference", () => {
    const sessions = [
        { sessionId: "parent", title: "parent", createdAt: 100 },
        { sessionId: "kid1", title: "first child", parentSessionId: "parent", createdAt: 200 },
        { sessionId: "kid2", title: "second child", parentSessionId: "parent", createdAt: 300 },
    ];
    // Even with both children named in the stored order, reversed.
    const flat = buildSessionTree(sessions, new Set(), [], null, ["kid2", "kid1"]);
    assert.deepEqual(ids(flat), ["parent", "kid1", "kid2"], "a sub-agent was reordered");
});

test("the system root cannot be moved", () => {
    const sessions = [
        { sessionId: "root", title: "PilotSwarm Agent", isSystem: true, createdAt: 1 },
        { sessionId: "a", title: "alpha", createdAt: 100 },
        { sessionId: "b", title: "bravo", createdAt: 200 },
    ];
    // Asking for the root last must not dislodge it: band 0 is the deployment's.
    const flat = buildSessionTree(sessions, new Set(), [], null, ["b", "a", "root"]);
    assert.equal(ids(flat)[0], "root");
    assert.deepEqual(ids(flat), ["root", "b", "a"]);
});

test("pinned sessions reorder among themselves, still above folders", () => {
    const sessions = [
        { sessionId: "root", title: "PilotSwarm Agent", isSystem: true, createdAt: 1 },
        { sessionId: "p1", title: "pinned one", createdAt: 100 },
        { sessionId: "p2", title: "pinned two", createdAt: 200 },
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "G1", createdAt: 300 },
        { sessionId: "loose", title: "loose", createdAt: 400 },
    ];
    const flat = buildSessionTree(sessions, new Set(), [], new Set(["p1", "p2"]), ["p2", "p1"]);
    // Band order holds: system → pinned → folders → loose sessions, and the
    // two pinned rows honour the requested placement within their band.
    assert.deepEqual(ids(flat), ["root", "p2", "p1", "group:g1", "loose"]);
});

test("isManuallyOrderableSession draws the line where the UI must", () => {
    assert.equal(isManuallyOrderableSession({ sessionId: "top" }), true);
    assert.equal(isManuallyOrderableSession({ sessionId: "group:g", isGroup: true }), true);
    assert.equal(isManuallyOrderableSession({ sessionId: "member", groupId: "g" }), true);
    assert.equal(isManuallyOrderableSession({ sessionId: "kid", parentSessionId: "p" }), false);
    assert.equal(isManuallyOrderableSession({ sessionId: "root", isSystem: true }), false);
    assert.equal(isManuallyOrderableSession(null), false);
});

test("buildManualOrderMap ignores duplicates and non-strings", () => {
    const map = buildManualOrderMap(["a", "b", "a", 7, null, "", "c"]);
    assert.deepEqual([...map.entries()], [["a", 0], ["b", 1], ["c", 6]]);
    assert.equal(buildManualOrderMap(null).size, 0);
    assert.equal(buildManualOrderMap("nope").size, 0);
});
