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

test("the cache notices a sender change (the header is derived from it)", () => {
    // Found by adversarial review: the header reads message.sender and
    // createdAt, and the chips read message.attachments — none of which were
    // originally compared, so an in-place change to any of them served a stale
    // block.
    const m = { id: "s1:1", role: "user", text: "hi", sender: { kind: "user", subject: "a" } };
    const state = stateWith([m]);
    const before = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];

    m.sender = { kind: "user", subject: "b" };
    const after = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    assert.notEqual(after, before, "a stale block survived a sender change");
});

test("the cache notices an attachments change", () => {
    const m = { id: "s1:1", role: "user", text: "look", attachments: [] };
    const state = stateWith([m]);
    const before = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    assert.equal(before.attachments, null);

    m.attachments = [{ filename: "shot.png" }];
    const after = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    assert.ok(after.attachments, "a stale block hid a newly attached image");
    assert.equal(after.attachments.attachments.length, 1);
});

test("the cache still hits when createdAt is NaN", () => {
    // Found by adversarial review, and it had already bitten: comparing fields
    // with === meant a message whose timestamp did not parse (createdAt = NaN)
    // could never match itself, because NaN !== NaN. The cache went completely
    // dead — silently, because every other test still passed. Effectiveness has
    // to be asserted, not assumed.
    const m = { id: "s1:1", role: "assistant", text: "hi", createdAt: NaN };
    const state = stateWith([m]);

    const first = selectChatBlocks(state, 100, { tableMode: "sentinel" })[0];
    const second = selectChatBlocks(state, 40, { tableMode: "sentinel" })[0];
    assert.equal(second, first, "cache missed on a NaN timestamp — every width step rebuilds");
});

test("the cache hits across a width change for a realistic transcript", () => {
    // A blunt effectiveness check: nothing above would fail if the cache were
    // removed entirely except the identity assertions, so keep one that is
    // explicitly about hit rate.
    const messages = Array.from({ length: 50 }, (_, i) => message(`m${i}`, `body ${i}`));
    const state = stateWith(messages);

    const a = selectChatBlocks(state, 200, { tableMode: "sentinel" });
    const b = selectChatBlocks(state, 60, { tableMode: "sentinel" });
    const hits = a.filter((block, i) => block === b[i]).length;
    assert.equal(hits, messages.length, `only ${hits}/${messages.length} blocks were reused across a width change`);
});
