// A prompt whose turn was user-stopped mid-flight is delivered (durable
// user.message → normally "✓✓ sent") but the model may not have acted on it.
// The SDK records a session.turn_stopped event carrying the interrupted
// prompt's clientMessageIds; the client flags matching transcript messages
// and renders the amber ⊘ ("no parking") marker instead of ✓✓. Shared
// selectors, so this covers both the portal and the TUI.
import test from "node:test";
import assert from "node:assert/strict";
import { appendEventToHistory, selectChatLines } from "../src/index.js";

function evt(seq, eventType, data) {
    return { sessionId: "s1", seq, eventType, data, createdAt: 1_700_000_000_000 + seq * 1000 };
}
function freshHistory() {
    return { chat: [], activity: [], events: [], lastSeq: 0 };
}
function renderState(history) {
    return {
        sessions: { activeSessionId: "s1", byId: { s1: { sessionId: "s1" } } },
        history: { bySessionId: new Map([["s1", history]]) },
        ui: {},
        branding: {},
    };
}
function renderText(history) {
    return selectChatLines(renderState(history), 80).flat().map((r) => r.text).join("");
}

test("stop event after the prompt flags it and renders ⊘ (not ✓✓)", () => {
    let h = freshHistory();
    h = appendEventToHistory(h, evt(1, "user.message", { content: "remember 64 and wait 30s then joke", clientMessageIds: ["cid-1"] }));
    h = appendEventToHistory(h, evt(2, "session.turn_stopped", { turnIndex: 0, reason: "user_stopped", clientMessageIds: ["cid-1"] }));

    const msg = h.chat.find((m) => m.role === "user");
    assert.ok(msg, "user message present");
    assert.equal(msg.stopped, true, "message flagged stopped");

    const text = renderText(h);
    assert.match(text, /⊘/, "stopped marker rendered");
    assert.doesNotMatch(text, /✓✓/, "no sent double-check for a stopped prompt");
});

test("an un-stopped prompt keeps ✓✓ and shows no ⊘", () => {
    let h = freshHistory();
    h = appendEventToHistory(h, evt(1, "user.message", { content: "hello there", clientMessageIds: ["cid-2"] }));

    const msg = h.chat.find((m) => m.role === "user");
    assert.notEqual(msg?.stopped, true);

    const text = renderText(h);
    assert.match(text, /✓✓/, "sent double-check present");
    assert.doesNotMatch(text, /⊘/, "no stopped marker");
});

test("stop event before the prompt (bulk-load order) still flags it", () => {
    let h = freshHistory();
    h = appendEventToHistory(h, evt(1, "session.turn_stopped", { clientMessageIds: ["cid-3"] }));
    h = appendEventToHistory(h, evt(2, "user.message", { content: "wait then joke", clientMessageIds: ["cid-3"] }));

    const msg = h.chat.find((m) => m.role === "user");
    assert.equal(msg?.stopped, true, "prospective flag applied on bulk-load ordering");
});

test("only the prompt named in the stop event is flagged", () => {
    let h = freshHistory();
    h = appendEventToHistory(h, evt(1, "user.message", { content: "first message", clientMessageIds: ["cid-a"] }));
    h = appendEventToHistory(h, evt(2, "user.message", { content: "second message", clientMessageIds: ["cid-b"] }));
    h = appendEventToHistory(h, evt(3, "session.turn_stopped", { clientMessageIds: ["cid-b"] }));

    const [first, second] = h.chat.filter((m) => m.role === "user");
    assert.notEqual(first?.stopped, true, "unrelated prompt stays sent");
    assert.equal(second?.stopped, true, "the stopped prompt is flagged");
});
