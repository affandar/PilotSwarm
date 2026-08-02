// selectChatBlocks — the message-level view behind the portal's rich
// (desktop-style) chat renderer. Plain user/assistant prose comes through as
// { kind: "message" } blocks carrying raw markdown + header facts; everything
// with terminal-era special handling (system cards, dividers, splash) stays
// pre-rendered as { kind: "lines" } through the same builders selectChatLines
// uses. The TUI never calls this selector.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, buildHistoryModel, createInitialState, decodeHtmlEntitiesForDisplay, getTheme, selectChatBlocks, selectChatLines } from "../src/index.js";

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

test("plain user/assistant prose becomes message blocks with raw markdown", () => {
    const model = buildHistoryModel([
        evt(1, "user.message", { content: "run the **tests** please" }),
        evt(2, "assistant.message", { content: "## Results\n\nAll `103` passed." }),
    ], {});
    const blocks = selectChatBlocks(renderState(model), 80, { tableMode: "sentinel" });

    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].kind, "message");
    assert.equal(blocks[0].role, "user");
    assert.match(blocks[0].text, /run the \*\*tests\*\* please/);
    assert.equal(blocks[0].header.roleLabel, "You");
    assert.ok(blocks[0].header.time, "user message header carries a timestamp");

    assert.equal(blocks[1].kind, "message");
    assert.equal(blocks[1].role, "assistant");
    assert.match(blocks[1].text, /## Results/, "markdown reaches the renderer unrendered");
    assert.equal(blocks[1].header.roleLabel, "Agent");
});

test("epoch dividers and system-notice messages stay on the line path", () => {
    const model = buildHistoryModel([
        evt(1, "user.message", { content: "before" }),
        evt(2, "session.epoch_committed", { fromEpoch: 0, toEpoch: 1, turnsArchived: 2 }),
        // Prose with an embedded [SYSTEM: …] segment — buildChatMessageLines
        // owns the split, so the whole message stays on the line path.
        evt(3, "user.message", { content: "resuming now\n[SYSTEM: sub-agent finished]" }),
    ], {});
    const blocks = selectChatBlocks(renderState(model), 80, { tableMode: "sentinel" });

    const kinds = blocks.map((block) => block.kind);
    // buildHistoryModel strips [SYSTEM: …] segments before chat, so the third
    // message reaches the selector as plain prose and rich-renders; the
    // classifier's system-segment guard covers selector-injected messages
    // (pending questions, error cards) that never pass through history.
    assert.deepEqual(kinds, ["message", "lines", "message"]);
    assert.equal(blocks[1].variant, "divider");
    const dividerText = blocks[1].lines.flat().map((run) => run.text || "").join("");
    assert.match(dividerText, /context regenerated/);
    assert.equal(blocks[2].text, "resuming now");
});

// "rich" is a THEME property now (theme.richChat on workspace-dark-rich),
// not a chatViewMode. The mode path must REJECT it everywhere, and stored
// profiles that still say "rich" quietly land on the transcript.
test("rich is a theme property, not a chatViewMode", () => {
    const initial = createInitialState({});
    assert.equal(initial.ui.chatViewMode, "transcript");

    const afterRich = appReducer(initial, { type: "ui/chatViewMode", mode: "rich" });
    assert.equal(afterRich.ui.chatViewMode, "transcript", "reducer rejects the retired mode");

    const summary = appReducer(initial, { type: "ui/chatViewMode", mode: "summary" });
    assert.equal(summary.ui.chatViewMode, "summary", "summary/transcript still toggle");

    // Persisted "rich" from an old profile degrades to transcript on boot.
    assert.equal(createInitialState({ chatViewMode: "rich" }).ui.chatViewMode, "transcript");
    assert.equal(createInitialState({ chatViewMode: "summary" }).ui.chatViewMode, "summary");

    // The rich transcript rides the dedicated theme's flag.
    assert.equal(getTheme("workspace-dark-rich")?.richChat, true, "rich theme carries the flag");
    assert.equal(getTheme("workspace-dark")?.richChat, false, "plain workspace stays terminal-style");
});

test("empty chat yields no blocks and line/block parity holds for prose", () => {
    assert.deepEqual(selectChatBlocks(renderState(buildHistoryModel([], {})), 80), []);

    // Sanity: a transcript that renders in selectChatLines also renders in
    // blocks — nothing silently dropped by classification.
    const model = buildHistoryModel([
        evt(1, "user.message", { content: "hello" }),
        evt(2, "assistant.message", { content: "hi there" }),
    ], {});
    const lineText = selectChatLines(renderState(model), 80)
        .flatMap((row) => (Array.isArray(row) ? row.map((seg) => seg.text || "") : [row.text || ""]))
        .join("\n");
    assert.match(lineText, /hello/);
    assert.match(lineText, /hi there/);
    const blocks = selectChatBlocks(renderState(model), 80);
    assert.equal(blocks.filter((b) => b.kind === "message").length, 2);
});

// A title that arrived already HTML-escaped (an LLM summarizing escaped
// material) rendered its entities literally, e.g. "PostgreSQL &amp; MySQL".
// Titles are plain text at every render site, so they decode on read.
test("session titles decode HTML entities for display", () => {
    assert.equal(decodeHtmlEntitiesForDisplay("PostgreSQL &amp; MySQL"), "PostgreSQL & MySQL");
    assert.equal(decodeHtmlEntitiesForDisplay("a &lt;b&gt; c"), "a <b> c");
    assert.equal(decodeHtmlEntitiesForDisplay("Bob&#39;s &quot;run&quot;"), 'Bob\'s "run"');
    // Ampersand decodes LAST: a double-escaped "<" must not collapse to "<".
    assert.equal(decodeHtmlEntitiesForDisplay("&amp;lt;"), "&lt;");
    // Untouched when there is nothing to decode.
    assert.equal(decodeHtmlEntitiesForDisplay("plain title"), "plain title");
    assert.equal(decodeHtmlEntitiesForDisplay(""), "");
});

// A regeneration that is ACCEPTED and then fails downstream was invisible:
// the tool returns an optimistic ack on enqueue, so the agent reported
// success while the epoch never flipped. Observed live on chk — two attempts
// died on ARTIFACT_TOO_LARGE with nothing in the transcript.
test("a failed regeneration surfaces inline in both views", () => {
    const model = buildHistoryModel([
        evt(1, "user.message", { content: "regenerate please" }),
        evt(2, "session.regenerate_failed", {
            attemptId: "regenerate-123",
            stage: "requested",
            error: "Activity 'runRegenArchive' JS execution failed: Artifact too large: 1803885 bytes (max 1048576)",
        }),
    ], {});

    const item = model.chat.find((m) => m.kind === "regen-failed");
    assert.ok(item, "a regen-failed chat item is produced");
    assert.equal(item.stage, "requested");

    // Terminal view.
    const lineText = selectChatLines(renderState(model), 100)
        .flatMap((row) => (Array.isArray(row) ? row.map((seg) => seg.text || "") : [row.text || ""]))
        .join("");
    assert.match(lineText, /regeneration failed at requested/);
    assert.match(lineText, /Artifact too large/);

    // Rich view — routed down the line path, not rendered as a chat message.
    const blocks = selectChatBlocks(renderState(model), 100, { tableMode: "sentinel" });
    const failedBlock = blocks.find((b) => b.kind === "lines"
        && b.lines.flat().map((r) => r.text || "").join("").includes("regeneration failed"));
    assert.ok(failedBlock, "rich view renders the failure as a divider block");
});

test("regenerate_failed survives backward chat-history paging", async () => {
    const { CHAT_HISTORY_EVENT_TYPES } = await import("../src/history.js");
    assert.ok(
        CHAT_HISTORY_EVENT_TYPES.includes("session.regenerate_failed"),
        "otherwise the failure vanishes as soon as the page scrolls",
    );
});
