// Rich chat blocks do not depend on the pane width, and are cached accordingly.
//
// WHY: dragging the splitter between the chat and the inspector changes
// `contentWidth`, which is a memo dependency of selectChatBlocks — so the whole
// loaded transcript was re-derived per width step. For rich message blocks that
// work is pure waste: the block carries raw markdown and the BROWSER wraps it;
// maxWidth is only consumed by the terminal line builders and the divider
// rules. Classifying a message as rich-renderable also scans its text, and that
// ran per message per step.
//
// These tests pin both halves: width must not change a message block, and the
// cache must still notice when the message itself changes.
import test from "node:test";
import assert from "node:assert/strict";
import { selectChatBlocks } from "../src/index.js";

function stateWith(messages) {
    return {
        sessions: { activeSessionId: "s1", byId: { s1: { sessionId: "s1", owner: null } } },
        history: { bySessionId: new Map([["s1", { chat: messages, activity: [], events: [] }]]) },
        auth: { principal: null },
    };
}

const message = (id, text, role = "assistant") => ({ id, role, text });

test("changing the pane width does not change a rich message block", () => {
    const messages = [message("m1", "**Hello**\n\nsome prose"), message("m2", "reply", "user")];
    const state = stateWith(messages);

    const wide = selectChatBlocks(state, 200, { tableMode: "sentinel" });
    const narrow = selectChatBlocks(state, 40, { tableMode: "sentinel" });

    assert.equal(wide.length, narrow.length);
    for (let i = 0; i < wide.length; i += 1) {
        assert.equal(wide[i].kind, "message");
        assert.equal(wide[i].text, narrow[i].text, "width altered a message block's text");
        // Same object: this is what makes a resize cheap, and what lets the
        // renderer skip the block entirely.
        assert.equal(wide[i], narrow[i], "width change rebuilt an identical block");
    }
});

test("the cache still notices when the message text changes", () => {
    const m = message("m1", "first");
    const state = stateWith([m]);

    const before = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    assert.match(before.text, /first/);

    // Mutating in place is the hostile case: same object identity, new content.
    m.text = "second";
    const after = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    assert.match(after.text, /second/, "a stale cached block survived a text change");
});

test("the cache notices a pending-phase change on the same message", () => {
    const m = { id: "m1", role: "assistant", text: "streaming", pendingPhase: "thinking" };
    const state = stateWith([m]);

    const before = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    assert.equal(before.pendingPhase, "thinking");

    m.pendingPhase = null;
    const after = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    assert.equal(after.pendingPhase, null, "a stale pendingPhase survived");
});

test("dividers are not swallowed by the message fast path", () => {
    // Dividers never enter the cache, so the fast path must never claim them —
    // and they DO depend on width.
    const divider = { kind: "epoch-divider", epoch: 1, turnsArchived: 12 };
    const state = stateWith([divider, message("m1", "after the divider")]);

    const blocks = selectChatBlocks(state, 120, { tableMode: "sentinel" });
    assert.equal(blocks[0].kind, "lines");
    assert.equal(blocks[0].variant, "divider");
    assert.equal(blocks[1].kind, "message");
});
