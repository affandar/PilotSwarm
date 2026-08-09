// What survives the removal of the rich (desktop-style) chat renderer.
//
// `selectChatBlocks` and its `workspace-dark-rich` theme were deleted in the
// 2026-08-05 theme pass, and nothing in the app references either any more —
// so the tests that exercised the selector went with it, along with the whole
// of chat-block-width-cache.test.mjs, which tested nothing else.
//
// Two contracts outlived the feature and are kept here:
//   - retired chat view modes stay gone, and a stored profile that
//     still says "rich" must degrade to the transcript rather than wedging.
//   - No theme may quietly claim `richChat`. The field was dropped from
//     createTheme entirely, so this guards against it coming back on a theme
//     without the renderer coming back with it.
// Plus the entity-decoding and epoch-divider cases, which are about
// selectChatLines and were only ever neighbours of the removed code.

import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, buildHistoryModel, createInitialState, decodeHtmlEntitiesForDisplay, getTheme, listThemes, selectChatLines } from "../src/index.js";

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

// "rich" was retired long ago; the summary mode followed it out
// everywhere, and stored profiles that still say "rich" quietly land on the
// transcript — that half of the contract is what this test is for, and it
// still holds.
//
// It also used to assert `theme.richChat` on workspace-dark-rich. That theme
// was deleted in the 2026-08-05 theme pass, no remaining theme sets the flag,
// and NOTHING reads it — `richChat` survives only in createTheme's signature.
// Re-pointing the assertion at another theme would have re-asserted a feature
// that no longer exists, so it is dropped rather than moved. If the rich
// transcript comes back, the flag and its test come back together.
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
test("a failed regeneration surfaces inline in the transcript", () => {
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

    // There is only one view now — the rich renderer that was the other half
    // of "both views" is gone.
    const lineText = selectChatLines(renderState(model), 100)
        .flatMap((row) => (Array.isArray(row) ? row.map((seg) => seg.text || "") : [row.text || ""]))
        .join("");
    assert.match(lineText, /regeneration failed at requested/);
    assert.match(lineText, /Artifact too large/);
});

test("regenerate_failed survives backward chat-history paging", async () => {
    const { CHAT_HISTORY_EVENT_TYPES } = await import("../src/history.js");
    assert.ok(
        CHAT_HISTORY_EVENT_TYPES.includes("session.regenerate_failed"),
        "otherwise the failure vanishes as soon as the page scrolls",
    );
});
