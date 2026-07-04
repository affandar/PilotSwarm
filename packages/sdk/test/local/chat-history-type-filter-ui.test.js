/**
 * Chat history pull type-filter (ui-core adoption of migration 0025).
 *
 * The chat-driven pull (scroll/swipe at the top of the transcript) pages
 * backward with the renderable message types as a server-side filter, so a
 * noise-dominated session loads transcript pages instead of raw event pages.
 * The explicit expand command stays unfiltered (raw stream, feeds activity).
 */

import { describe, it } from "vitest";
import { PilotSwarmUiController } from "../../../app/ui/core/src/controller.js";
import { buildHistoryModel, CHAT_HISTORY_EVENT_TYPES } from "../../../app/ui/core/src/history.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const SESSION_ID = "s-filter-pull";

function createController(transportOverrides = {}) {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    return {
        store,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function noiseEvent(seq) {
    return {
        sessionId: SESSION_ID,
        seq,
        eventType: "tool.noise",
        data: { index: seq },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000).toISOString(),
    };
}

function chatEvent(seq, eventType, content) {
    return {
        sessionId: SESSION_ID,
        seq,
        eventType,
        data: { content },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000).toISOString(),
    };
}

/**
 * Seed the store with a splash-screen-shaped history window: recent raw
 * events that contain zero chat messages, with older history available.
 */
function seedNoiseOnlyWindow(store) {
    const noise = [1001, 1002, 1003, 1004, 1005].map(noiseEvent);
    store.dispatch({ type: "sessions/selected", sessionId: SESSION_ID });
    store.dispatch({
        type: "history/set",
        sessionId: SESSION_ID,
        history: {
            ...buildHistoryModel(noise, { requestedLimit: 300 }),
            hasOlderEvents: true,
        },
    });
}

describe("chat history pull type filter", () => {
    it("auto-expansion pull requests only renderable message types", async () => {
        const olderChat = [];
        for (let i = 0; i < 10; i += 1) {
            olderChat.push(chatEvent(101 + i * 2, i % 2 === 0 ? "user.message" : "assistant.message", `message ${i}`));
        }
        const pageRequests = [];
        const { controller, store } = createController({
            getSessionEventsBefore: async (sessionId, beforeSeq, limit, eventTypes) => {
                pageRequests.push({ sessionId, beforeSeq, limit, eventTypes });
                return olderChat;
            },
        });
        seedNoiseOnlyWindow(store);

        await controller.maybeAutoExpandActiveHistory(0);

        assertEqual(pageRequests.length, 1, "Pull should fetch exactly one filtered page");
        assertEqual(pageRequests[0].sessionId, SESSION_ID, "Pull should target the active session");
        assertEqual(pageRequests[0].beforeSeq, 1001, "Cursor should be the oldest loaded seq");
        assert(
            JSON.stringify(pageRequests[0].eventTypes) === JSON.stringify(CHAT_HISTORY_EVENT_TYPES),
            `Pull should pass the chat types filter; got ${JSON.stringify(pageRequests[0].eventTypes)}`,
        );

        const history = store.getState().history.bySessionId.get(SESSION_ID);
        assertEqual(history.chat.length, 10, "All fetched chat messages should land in the transcript");
        assertEqual(history.hasOlderEvents, false, "A short filtered page means the transcript is complete");
    });

    it("splash-only sessions bypass the scroll-position gate", async () => {
        const pageRequests = [];
        const { controller, store } = createController({
            getSessionEventsBefore: async (sessionId, beforeSeq, limit, eventTypes) => {
                pageRequests.push({ sessionId, beforeSeq, limit, eventTypes });
                return [chatEvent(500, "assistant.message", "found you")];
            },
        });
        seedNoiseOnlyWindow(store);
        // Tall splash art: rendered lines far exceed the viewport, which used
        // to swallow the one-gesture pull intent (targetOffset < maxOffset).
        controller.getActiveChatRenderMetrics = () => ({ contentWidth: 40, contentHeight: 10, totalLines: 500 });

        await controller.maybeAutoExpandActiveHistory(1);

        assertEqual(pageRequests.length, 1, "Splash-only pull should fetch despite the tall splash metrics");
        const history = store.getState().history.bySessionId.get(SESSION_ID);
        assertEqual(history.chat.length, 1, "Fetched chat message should replace the empty transcript");
    });

    it("keeps the scroll-position gate when real chat messages exist", async () => {
        const pageRequests = [];
        const { controller, store } = createController({
            getSessionEventsBefore: async (...args) => {
                pageRequests.push(args);
                return [];
            },
        });
        store.dispatch({ type: "sessions/selected", sessionId: SESSION_ID });
        store.dispatch({
            type: "history/set",
            sessionId: SESSION_ID,
            history: {
                ...buildHistoryModel(
                    [chatEvent(1001, "user.message", "hi"), chatEvent(1002, "assistant.message", "hello")],
                    { requestedLimit: 300 },
                ),
                hasOlderEvents: true,
            },
        });
        controller.getActiveChatRenderMetrics = () => ({ contentWidth: 40, contentHeight: 10, totalLines: 500 });

        await controller.maybeAutoExpandActiveHistory(1);

        assertEqual(pageRequests.length, 0, "Mid-scroll pull with real chat should stay gated");
    });

    it("explicit expansion stays unfiltered", async () => {
        const pageRequests = [];
        const { controller, store } = createController({
            getSessionEventsBefore: async (sessionId, beforeSeq, limit, eventTypes) => {
                pageRequests.push({ sessionId, beforeSeq, limit, eventTypes });
                return [chatEvent(500, "user.message", "hello"), noiseEvent(501)];
            },
        });
        seedNoiseOnlyWindow(store);

        await controller.expandSessionHistory(SESSION_ID, {});

        assertEqual(pageRequests.length, 1, "Expand should fetch one page");
        assertEqual(pageRequests[0].eventTypes, undefined, "Explicit expand should not filter (raw stream)");
    });
});
