/**
 * Per-session memory: chat scroll offsets survive session switches, and the
 * expanded (pulled-in) history window survives re-entry via delta catch-up
 * instead of a full latest-window reload.
 */

import { describe, it } from "vitest";
import { PilotSwarmUiController } from "../../../app/ui/core/src/controller.js";
import { buildHistoryModel } from "../../../app/ui/core/src/history.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";
import { assert, assertEqual } from "../helpers/assertions.js";

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
    return { store, controller: new PilotSwarmUiController({ store, transport }) };
}

function chatEvent(sessionId, seq, eventType, content) {
    return {
        sessionId,
        seq,
        eventType,
        data: { content },
        createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    };
}

function seedExpandedHistory(store, sessionId) {
    const events = [];
    for (let i = 0; i < 6; i += 1) {
        events.push(chatEvent(sessionId, 900 + i * 10, i % 2 ? "assistant.message" : "user.message", `msg ${i}`));
    }
    store.dispatch({
        type: "history/set",
        sessionId,
        history: {
            ...buildHistoryModel(events, { requestedLimit: 300 }),
            lastSeq: 950,
            loadedEventLimit: 600,
            hasOlderEvents: true,
        },
    });
    return events;
}

describe("per-session memory", () => {
    it("remembers each session's chat scroll offset across switches", () => {
        const { store } = createController();
        store.dispatch({ type: "sessions/selected", sessionId: "A" });
        store.dispatch({ type: "ui/scroll", pane: "chat", offset: 7 });

        store.dispatch({ type: "sessions/selected", sessionId: "B" });
        assertEqual(store.getState().ui.scroll.chat, 0, "New session starts at latest");

        store.dispatch({ type: "sessions/selected", sessionId: "A" });
        assertEqual(store.getState().ui.scroll.chat, 7, "Returning restores the saved offset");
    });

    it("catches up with a delta fetch and keeps the pulled-in window", async () => {
        const calls = [];
        const { controller, store } = createController({
            getSessionEvents: async (sessionId, afterSeq, limit) => {
                calls.push({ afterSeq, limit });
                if (afterSeq === 950) {
                    return [
                        chatEvent(sessionId, 951, "assistant.message", "new one"),
                        chatEvent(sessionId, 952, "user.message", "new two"),
                    ];
                }
                return [];
            },
        });
        store.dispatch({ type: "sessions/selected", sessionId: "A" });
        seedExpandedHistory(store, "A");

        const history = await controller.ensureSessionHistory("A", { force: true });

        assertEqual(calls.length, 1, "One delta fetch only");
        assertEqual(calls[0].afterSeq, 950, "Delta fetch starts after lastSeq");
        assertEqual(history.chat.length, 8, "New messages append to the retained transcript");
        assertEqual(Number(history.events[0].seq), 900, "Older-history cursor is preserved");
        assertEqual(history.hasOlderEvents, true, "Pull availability is preserved");
        assertEqual(Number(history.lastSeq), 952, "lastSeq advances to the newest event");
    });

    it("returns the in-memory window untouched when nothing new arrived", async () => {
        const calls = [];
        const { controller, store } = createController({
            getSessionEvents: async (sessionId, afterSeq, limit) => {
                calls.push({ afterSeq, limit });
                return [];
            },
        });
        store.dispatch({ type: "sessions/selected", sessionId: "A" });
        seedExpandedHistory(store, "A");

        const history = await controller.ensureSessionHistory("A", { force: true });
        assertEqual(calls.length, 1, "Only the delta probe runs");
        assertEqual(history.chat.length, 6, "Transcript unchanged");
        assertEqual(store.getState().ui.scroll.chat, 0, "No scroll reset without new content");
    });

    it("falls back to a full reload when the delta hits the page clamp", async () => {
        const calls = [];
        const { controller, store } = createController({
            getSessionEvents: async (sessionId, afterSeq, limit) => {
                calls.push({ afterSeq, limit });
                if (afterSeq === 950) {
                    return Array.from({ length: 1000 }, (_, i) => chatEvent(sessionId, 951 + i, "tool.noise", `${i}`));
                }
                return [chatEvent(sessionId, 5000, "assistant.message", "fresh window")];
            },
        });
        store.dispatch({ type: "sessions/selected", sessionId: "A" });
        seedExpandedHistory(store, "A");

        const history = await controller.ensureSessionHistory("A", { force: true });
        assertEqual(calls.length, 2, "Clamped delta triggers the full reload");
        assertEqual(calls[1].afterSeq, undefined, "Reload fetches the latest window");
        assert(history.chat.some((m) => m.text.includes("fresh window")), "Reloaded window replaces the stale one");
    });
});
