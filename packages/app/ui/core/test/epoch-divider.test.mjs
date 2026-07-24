// Session-regeneration surfaces in the transcript: buildHistoryModel turns a
// session.epoch_committed event into an inline epoch divider, and selectChatLines
// renders it as a magenta rule carrying the epoch and archived-turn count.
// Shared ui-core selectors, so this covers both the portal and the TUI.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel, appendEventToHistory, selectChatLines } from "../src/index.js";

function evt(seq, eventType, data) {
    return { sessionId: "s1", seq, eventType, data, createdAt: 1_700_000_000_000 + seq * 1000 };
}

function renderState(history) {
    return {
        sessions: { activeSessionId: "s1", byId: { s1: { sessionId: "s1" } } },
        history: { bySessionId: new Map([["s1", history]]) },
        auth: {},
        ui: {},
        branding: {},
    };
}

function renderText(history) {
    return selectChatLines(renderState(history), 80).map((row) => (
        Array.isArray(row) ? row.map((seg) => seg.text).join("") : row.text
    )).join("\n");
}

test("epoch_committed becomes an inline divider between old and new turns", () => {
    const model = buildHistoryModel([
        evt(1, "user.message", { content: "old-epoch question" }),
        evt(2, "assistant.message", { content: "old-epoch answer" }),
        evt(3, "session.epoch_committed", { fromEpoch: 0, toEpoch: 1, turnsArchived: 2 }),
        evt(4, "user.message", { content: "new-epoch question" }),
    ], {});

    const divider = model.chat.find((m) => m.kind === "epoch-divider");
    assert.ok(divider, "a divider chat item is produced");
    assert.equal(divider.epoch, 1);
    assert.equal(divider.turnsArchived, 2);

    // Ordering: divider sits after the old-epoch turns, before the new one.
    const kinds = model.chat.map((m) => m.kind === "epoch-divider" ? "DIV" : m.text);
    assert.deepEqual(kinds, ["old-epoch question", "old-epoch answer", "DIV", "new-epoch question"]);

    const text = renderText(model);
    assert.match(text, /context regenerated/);
    assert.match(text, /epoch 1/);
    assert.match(text, /2 turns archived/);
});

test("live append renders the divider incrementally", () => {
    let h = buildHistoryModel([evt(1, "user.message", { content: "before" })], {});
    h = appendEventToHistory(h, evt(2, "session.epoch_committed", { toEpoch: 3, turnsArchived: 1 }));

    const divider = h.chat.find((m) => m.kind === "epoch-divider");
    assert.ok(divider, "divider appended live");
    assert.equal(divider.epoch, 3);

    const text = renderText(h);
    assert.match(text, /epoch 3/);
    assert.match(text, /1 turn archived/, "singular turn label");
});

test("epoch_committed is included in the chat-history paging filter", async () => {
    const { CHAT_HISTORY_EVENT_TYPES } = await import("../src/history.js");
    assert.ok(
        CHAT_HISTORY_EVENT_TYPES.includes("session.epoch_committed"),
        "backward chat paging must fetch epoch boundaries or old dividers vanish",
    );
    assert.ok(
        CHAT_HISTORY_EVENT_TYPES.includes("session.regenerate_refused"),
        "refusals must page too, or the correction to the optimistic ack vanishes",
    );
});

test("regenerate_refused renders an inline notice with a friendly reason", () => {
    const model = buildHistoryModel([
        evt(1, "user.message", { content: "regenerate yourself" }),
        evt(2, "session.regenerate_refused", { reason: "cooldown", source: "tool" }),
    ], {});

    const notice = model.chat.find((m) => m.kind === "regen-refused");
    assert.ok(notice, "a refusal notice item is produced");
    assert.equal(notice.reason, "cooldown");

    const text = renderText(model);
    assert.match(text, /regeneration refused/);
    assert.match(text, /on cooldown \(once per 6h\)/, "cooldown maps to friendly text");
});

test("an unknown refusal reason degrades gracefully", () => {
    let h = buildHistoryModel([evt(1, "user.message", { content: "go" })], {});
    h = appendEventToHistory(h, evt(2, "session.regenerate_refused", { reason: "some_new_gate" }));
    const text = renderText(h);
    assert.match(text, /regeneration refused · some new gate/, "underscores humanized, no crash");
});
