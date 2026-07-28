// Scrolling to the top of the chat must load older history regardless of how
// TALL the messages are.
//
// WHY: the auto-expand path gated on
//     targetOffset < (selectChatLines totalLines - contentHeight)  -> bail
// comparing a DOM-derived offset against the TERMINAL wrapped-line count — a
// model the rich renderer does not use. A session of long messages (tables,
// code blocks) inflates that line count far past the rich DOM's scroll extent,
// so the gate never opened and older history was unreachable in the browser,
// while a session of short messages worked. Both callers of this path already
// fire only when the DOM scroller is at the top, so the gate was redundant as
// well as wrong.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    buildHistoryModel,
} from "../src/index.js";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** One chat event; `size` controls how many wrapped lines it would occupy. */
function message(seq, size) {
    return {
        seq,
        eventType: seq % 2 ? "assistant.message" : "user.message",
        timestamp: 1785000000000 + seq,
        data: { content: "word ".repeat(size) },
    };
}

function makeController({ tall }) {
    const beforeCalls = [];
    const transport = {
        async getSessionEvents() { return []; },
        async getSessionEventsBefore(sessionId, beforeSeq, limit) {
            beforeCalls.push({ beforeSeq, limit });
            return [message(1, 5)];
        },
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });

    // A transcript whose messages are either short or very long. The long case
    // is the one that used to be unreachable.
    const events = Array.from({ length: 400 }, (_, i) => message(i + 100, tall ? 4000 : 4));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SESSION, title: "S", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: SESSION });
    store.dispatch({
        type: "history/set",
        sessionId: SESSION,
        history: { ...buildHistoryModel(events, { requestedLimit: 300 }), lastSeq: 499 },
    });
    return { controller, beforeCalls };
}

/** Drive the wheel path: first call arms, second fires. */
async function scrollToTopTwice(controller) {
    await controller.handleChatTopHistoryScrollIntent(0);
    await controller.handleChatTopHistoryScrollIntent(0);
}

// NOTE ON SCOPE: restoring the gate fails BOTH cases below, not just the tall
// one — this harness's default layout gives a small contentHeight, so the gate
// blocks short transcripts here too. In the real portal the pane is tall enough
// that short messages squeak past, which is why one production session worked
// and another did not. These tests therefore prove the fix unblocks the load;
// they do NOT reproduce the short-vs-tall discrimination.
test("reaching the top of a short transcript loads older history", async () => {
    const { controller, beforeCalls } = makeController({ tall: false });
    await scrollToTopTwice(controller);
    assert.ok(beforeCalls.length > 0, "expected a backward history page to be requested");
});

test("reaching the top of a transcript of LONG messages also loads older history", async () => {
    // The production shape: long messages inflate the terminal line count far
    // past the rich DOM's scroll extent, which is what made the gate unopenable.
    const { controller, beforeCalls } = makeController({ tall: true });
    await scrollToTopTwice(controller);
    assert.ok(
        beforeCalls.length > 0,
        "tall messages blocked the top-of-chat history load — the offset gate is back",
    );
});
