// Per-session prompt drafts: a half-written composer message belongs to the
// session it was written in. `sessions/selected` stashes the outgoing draft
// (text + staged attachments) and restores the incoming one — the same shape
// as the per-session chat-scroll memory. Shared reducer, so this covers both
// the portal and the TUI.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

function stateWithPrompt(prompt, { activeSessionId = "s1", attachments = [], promptEdit = null } = {}) {
    const state = createInitialState({});
    return {
        ...state,
        sessions: { ...state.sessions, activeSessionId },
        ui: {
            ...state.ui,
            prompt,
            promptCursor: prompt.length,
            promptAttachments: attachments,
            promptEdit,
        },
    };
}

function select(state, sessionId) {
    return appReducer(state, { type: "sessions/selected", sessionId });
}

test("switching sessions stashes the outgoing draft and restores the incoming one", () => {
    let state = stateWithPrompt("half-written for s1", {
        attachments: [{ kind: "image", filename: "a.png" }],
    });

    state = select(state, "s2");
    assert.equal(state.ui.prompt, "", "s2 starts clean");
    assert.deepEqual(state.ui.promptAttachments, [], "attachments do not follow");
    assert.equal(state.ui.promptDraftBySession.s1.prompt, "half-written for s1");
    assert.equal(state.ui.promptDraftBySession.s1.attachments.length, 1);

    state = { ...state, ui: { ...state.ui, prompt: "draft for s2", promptCursor: 12 } };
    state = select(state, "s1");
    assert.equal(state.ui.prompt, "half-written for s1", "s1 draft restored");
    assert.equal(state.ui.promptCursor, "half-written for s1".length, "caret at end of restored draft");
    assert.equal(state.ui.promptAttachments.length, 1, "staged attachment restored with its draft");
    assert.equal(state.ui.promptDraftBySession.s2.prompt, "draft for s2");
    assert.equal(state.ui.promptDraftBySession.s1, undefined, "restored draft is consumed, not copied");
});

test("an empty draft leaves no stash entry behind", () => {
    let state = stateWithPrompt("");
    state = select(state, "s2");
    assert.equal(state.ui.promptDraftBySession.s1, undefined);
});

test("re-selecting the active session leaves the draft in place", () => {
    let state = stateWithPrompt("still typing");
    state = select(state, "s1");
    assert.equal(state.ui.prompt, "still typing");
});

test("editing a pending outbox message: the item's text is not stashed as a draft and the edit latch drops", () => {
    // While promptEdit is active the composer mirrors the outbox item; that
    // text must not become s1's draft, and the latch must not follow to s2.
    let state = stateWithPrompt("pending item text", {
        promptEdit: { sessionId: "s1", itemId: "item-1", phase: "pending" },
    });
    state = select(state, "s2");
    assert.equal(state.ui.promptDraftBySession.s1, undefined, "outbox text is not a draft");
    assert.equal(state.ui.promptEdit, null, "edit latch cleared on switch");
    assert.equal(state.ui.prompt, "", "s2 composer starts clean");
});

test("history/evict drops the evicted sessions' drafts", () => {
    let state = stateWithPrompt("draft for s1");
    state = select(state, "s2");
    assert.ok(state.ui.promptDraftBySession.s1);
    state = appReducer(state, { type: "history/evict", sessionIds: ["s1"] });
    assert.equal(state.ui.promptDraftBySession.s1, undefined);
});
