// selectChatLines is memoized on the IDENTITY of everything it reads.
//
// WHY IT NEEDED CACHING: it wraps the whole transcript to terminal lines and
// runs from scrollPane / scrollPaneTo / the visual-offset helpers — every
// scroll action — usually just to answer "how many lines are there".
// Measured 1.6ms at 300 messages, 5.1ms at 1500, per scroll.
//
// WHY IDENTITY, NOT FIELDS: selectActiveChat is NOT a pure function of the chat
// array. It appends a pending-question message, an answered-question message
// and a session-error message, and branches on branding.
// A cache keyed on `chat` alone would keep showing the old transcript when a
// question arrives. These tests pin each of those invalidations.
import test from "node:test";
import assert from "node:assert/strict";
import { selectChatLines } from "../src/index.js";

const SESSION_ID = "s1";

// `sessionObject` lets a test hold the session IDENTITY fixed while varying one
// other input. Without that, every state has a fresh session object, the cache
// misses on session identity alone, and a test meant to prove (say) that `chat`
// is compared would pass even if it were not. Two of these did exactly that
// until mutation testing caught it.
function makeState({ chat, session = {}, sessionObject = null, branding = null, principal = null }) {
    const sessionValue = sessionObject || { sessionId: SESSION_ID, owner: null, ...session };
    return {
        sessions: {
            activeSessionId: SESSION_ID,
            byId: { [SESSION_ID]: sessionValue },
        },
        history: { bySessionId: new Map([[SESSION_ID, { chat, activity: [], events: [] }]]) },
        ui: {},
        branding,
        auth: { principal },
    };
}

// One shared session identity, for the tests that must vary something else.
const STABLE_SESSION = { sessionId: SESSION_ID, owner: null };

const CHAT = [
    { id: "m1", role: "user", text: "first question" },
    { id: "m2", role: "assistant", text: "an answer" },
];

test("repeated calls with the same inputs reuse the result", () => {
    const state = makeState({ chat: CHAT });
    const a = selectChatLines(state, 100);
    const b = selectChatLines(state, 100);
    assert.equal(b, a, "identical inputs recomputed the whole transcript");
});

test("a width change is not served from cache", () => {
    const state = makeState({ chat: CHAT });
    const wide = selectChatLines(state, 200);
    const narrow = selectChatLines(state, 30);
    assert.notEqual(narrow, wide, "a different width reused lines wrapped for another width");
});

test("a new pending question invalidates", () => {
    // The regression this cache could easily have caused: the question is
    // appended by selectActiveChat, not present in `chat`.
    const before = selectChatLines(makeState({ chat: CHAT }), 100);
    const after = selectChatLines(
        makeState({ chat: CHAT, session: { pendingQuestion: { question: "Proceed?" } } }),
        100,
    );
    assert.notEqual(after, before, "a pending question did not invalidate the cached transcript");
    const text = JSON.stringify(after);
    assert.match(text, /Proceed\?/, "the pending question never reached the transcript");
});

test("a session error invalidates", () => {
    const before = selectChatLines(makeState({ chat: CHAT }), 100);
    const after = selectChatLines(makeState({ chat: CHAT, session: { error: "boom" } }), 100);
    assert.notEqual(after, before, "a session error did not invalidate the cached transcript");
});

test("appending to the chat invalidates, with the session identity unchanged", () => {
    // Session held fixed so this can only pass if `chat` itself is compared.
    const before = selectChatLines(makeState({ chat: CHAT, sessionObject: STABLE_SESSION }), 100);
    const grown = [...CHAT, { id: "m3", role: "user", text: "another" }];
    const after = selectChatLines(makeState({ chat: grown, sessionObject: STABLE_SESSION }), 100);
    assert.notEqual(after, before, "a new message did not invalidate");
    assert.ok(JSON.stringify(after).includes("another"));
});

test("the memo is bounded and still serves the most recent widths", () => {
    const state = makeState({ chat: CHAT });
    const first = selectChatLines(state, 100);
    // Sweep more widths than the memo holds, as a drag would.
    for (let w = 101; w < 120; w += 1) selectChatLines(state, w);
    // The oldest entry must have been evicted rather than growing without bound.
    const again = selectChatLines(state, 100);
    assert.notEqual(again, first, "the memo grew unbounded instead of evicting");
    // ...but a just-used width is still cached.
    assert.equal(selectChatLines(state, 100), again);
});

// ── Group sessions ───────────────────────────────────────────────────────────
// Both of these were found by adversarial review AFTER the memo shipped, and
// both produced visibly wrong output.

const GROUP_ID = "group:g1";

function groupState({ groupRow, members, byId = null }) {
    const map = byId || { [GROUP_ID]: groupRow, ...members };
    return {
        sessions: { activeSessionId: GROUP_ID, byId: map },
        history: { bySessionId: new Map() },
        ui: {},
        branding: null,
        auth: { principal: null },
    };
}

test("renaming a group member invalidates, even though the group row is untouched", () => {
    // For a group, selectActiveChat ignores the group's own history and builds a
    // Members table from every OTHER session in byId. The group row's own
    // counters do not move on a rename, and the reducer preserves an unchanged
    // session object's identity — so keying on the group row alone froze the
    // table on the old titles.
    const groupRow = { sessionId: GROUP_ID, isGroup: true, groupId: "g1", title: "My Group", memberCount: 1 };
    const before = selectChatLines(groupState({
        groupRow,
        members: { m1: { sessionId: "m1", groupId: "g1", title: "Old title", status: "running" } },
    }), 120);
    // Same group row OBJECT, renamed member, fresh byId — exactly what a poll does.
    const after = selectChatLines(groupState({
        groupRow,
        members: { m1: { sessionId: "m1", groupId: "g1", title: "New title", status: "running" } },
    }), 120);

    assert.notEqual(after, before, "a member rename was served from the memo");
    assert.match(JSON.stringify(after), /New title/, "the renamed member never reached the members table");
});

test("two callers passing different byId shapes do not share a memo entry", () => {
    // The memo is module-level. The TUI's chat pane passes a synthetic byId
    // holding only the active session; the controller's scroll math passes the
    // real one. Every other key field can match, so without byId in the key one
    // caller's transcript was served to the other.
    const groupRow = { sessionId: GROUP_ID, isGroup: true, groupId: "g1", title: "My Group", memberCount: 1 };
    const members = { m1: { sessionId: "m1", groupId: "g1", title: "Member One", status: "running" } };

    const full = selectChatLines(groupState({ groupRow, members }), 120);
    // Synthetic single-session state, same group row identity, same width.
    const synthetic = selectChatLines(groupState({ groupRow, members: {}, byId: { [GROUP_ID]: groupRow } }), 120);

    assert.notEqual(synthetic, full, "a synthetic single-session state reused the full state's transcript");
    assert.match(JSON.stringify(full), /Member One/, "the full state should list the member");
    assert.doesNotMatch(JSON.stringify(synthetic), /Member One/, "the synthetic state has no member data to list");
});
