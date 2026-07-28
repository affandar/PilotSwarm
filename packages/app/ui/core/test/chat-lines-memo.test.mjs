// selectChatLines is memoized on the IDENTITY of everything it reads.
//
// WHY IT NEEDED CACHING: it wraps the whole transcript to terminal lines and
// runs from scrollPane / scrollPaneTo / the visual-offset helpers — every
// scroll action — usually just to answer "how many lines are there".
// Measured 1.6ms at 300 messages, 5.1ms at 1500, per scroll.
//
// WHY IDENTITY, NOT FIELDS: selectActiveChat is NOT a pure function of the chat
// array. It appends a pending-question message, an answered-question message
// and a session-error message, and branches on ui.chatViewMode and branding.
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
function makeState({ chat, session = {}, sessionObject = null, branding = null, viewMode = null, principal = null }) {
    const sessionValue = sessionObject || { sessionId: SESSION_ID, owner: null, ...session };
    return {
        sessions: {
            activeSessionId: SESSION_ID,
            byId: { [SESSION_ID]: sessionValue },
        },
        history: { bySessionId: new Map([[SESSION_ID, { chat, activity: [], events: [] }]]) },
        ui: viewMode ? { chatViewMode: viewMode } : {},
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

test("switching chat view mode invalidates, with the session identity unchanged", () => {
    const before = selectChatLines(makeState({ chat: CHAT, sessionObject: STABLE_SESSION }), 100);
    const after = selectChatLines(
        makeState({ chat: CHAT, sessionObject: STABLE_SESSION, viewMode: "summary" }),
        100,
    );
    assert.notEqual(after, before, "the summary view served the transcript's cached lines");
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
