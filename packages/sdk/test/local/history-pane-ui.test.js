import { describe, it } from "vitest";
import { NodeSdkTransport } from "../../../cli/src/node-sdk-transport.js";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { buildHistoryModel } from "../../../ui-core/src/history.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { selectChatLines, selectChatPaneChrome, selectFileBrowserItems } from "../../../ui-core/src/selectors.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

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
        transport,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function seedSession(store, sessionId = "session-12345678") {
    store.dispatch({
        type: "sessions/loaded",
        sessions: [{
            sessionId,
            title: "History Test",
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }],
    });
    return sessionId;
}

function flattenChatLines(lines = []) {
    return (lines || []).map((line) => Array.isArray(line)
        ? line.map((run) => run?.text || "").join("")
        : String(line?.text || ""))
        .join("\n");
}

function buildLogEntries(count, start = 0) {
    return Array.from({ length: count }, (_, index) => ({
        time: `00:${String((start + index) % 60).padStart(2, "0")}:00`,
        level: "info",
        message: `Log entry ${start + index} ${"x".repeat(96)}`,
        prettyMessage: `Log entry ${start + index} ${"x".repeat(96)}`,
        rawLine: `Log entry ${start + index} ${"x".repeat(96)}`,
    }));
}

function buildActivityItems(count, start = 0) {
    return Array.from({ length: count }, (_, index) => ({
        text: `[00:${String((start + index) % 60).padStart(2, "0")}:00] activity ${start + index} ${"y".repeat(72)}`,
        line: [{ text: `[00:${String((start + index) % 60).padStart(2, "0")}:00] activity ${start + index} ${"y".repeat(72)}`, color: "white" }],
    }));
}

describe("history pane UI behavior", () => {
    it("loads execution history once per selected session until the user refreshes", async () => {
        let historyFetchCount = 0;
        const { controller, store } = createController({
            getExecutionHistory: async () => {
                historyFetchCount += 1;
                return [{
                    eventId: historyFetchCount,
                    kind: "ExecutionStarted",
                    timestampMs: Date.now(),
                    data: "{}",
                }];
            },
        });
        seedSession(store);

        await controller.ensureInspectorData("history");
        await controller.ensureInspectorData("history");

        assertEqual(historyFetchCount, 1, "history tab should not auto-refresh once data is loaded");
    });

    it("keeps history navigation responsive after jumping to the bottom", () => {
        const { controller, store } = createController();
        const sessionId = seedSession(store);
        store.dispatch({ type: "ui/focus", focusRegion: "inspector" });
        store.dispatch({ type: "ui/inspectorTab", inspectorTab: "history" });
        store.dispatch({
            type: "executionHistory/loaded",
            sessionId,
            fetchedAt: Date.now(),
            events: Array.from({ length: 64 }, (_, index) => ({
                eventId: index + 1,
                kind: index % 2 === 0 ? "ExecutionStarted" : "TaskCompleted",
                timestampMs: Date.now() + index,
                data: JSON.stringify({
                    index,
                    message: "x".repeat(96),
                }),
            })),
        });

        controller.scrollCurrentPaneToBottom();
        const bottomOffset = store.getState().ui.scroll.inspector;
        assert(bottomOffset > 0, "history pane should have a positive bottom scroll offset");

        controller.scrollCurrentPane(1);
        assertEqual(
            store.getState().ui.scroll.inspector,
            bottomOffset - 1,
            "k/up should move back up immediately after jumping to the bottom",
        );

        controller.scrollCurrentPane(10);
        assertEqual(
            store.getState().ui.scroll.inspector,
            Math.max(0, bottomOffset - 11),
            "ctrl-u/page-up should continue moving upward from the bottom edge",
        );
    });

    it("keeps inspector logs sticky when follow-bottom is disabled and reenables follow at the bottom", () => {
        const { controller, store } = createController();
        seedSession(store);
        store.dispatch({ type: "ui/focus", focusRegion: "inspector" });
        store.dispatch({ type: "ui/inspectorTab", inspectorTab: "logs" });
        store.dispatch({ type: "logs/config", available: true, availabilityReason: "" });
        store.dispatch({ type: "logs/tailing", tailing: true });
        store.dispatch({ type: "logs/set", entries: buildLogEntries(80) });

        const maxOffset = controller.getPaneMaxScrollOffset("inspector");
        assert(maxOffset > 0, "log pane should have a positive scroll range");

        controller.scrollCurrentPane(1);
        let state = store.getState();
        assertEqual(state.ui.followBottom.inspector, false, "scrolling up should disable inspector follow-bottom mode");
        const frozenOffset = state.ui.scroll.inspector;
        assert(frozenOffset > 0, "inspector should preserve a positive top offset after scrolling away from the bottom");

        store.dispatch({ type: "logs/append", entries: buildLogEntries(5, 80) });
        state = store.getState();
        assertEqual(state.ui.scroll.inspector, frozenOffset, "new logs should not rewrite the preserved inspector offset while follow-bottom is disabled");

        controller.scrollCurrentPaneToBottom();
        state = store.getState();
        assertEqual(state.ui.followBottom.inspector, true, "jumping to the bottom should reenable inspector follow-bottom mode");
        assertEqual(state.ui.scroll.inspector, 0, "follow-bottom mode should store zero distance from the bottom");
    });

    it("keeps activity sticky when follow-bottom is disabled and reenables follow at the bottom", () => {
        const { controller, store } = createController();
        const sessionId = seedSession(store);
        store.dispatch({
            type: "history/set",
            sessionId,
            history: {
                chat: [],
                activity: buildActivityItems(80),
                events: [],
                loadedEventLimit: 200,
            },
        });
        store.dispatch({ type: "ui/focus", focusRegion: "activity" });

        const maxOffset = controller.getPaneMaxScrollOffset("activity");
        assert(maxOffset > 0, "activity pane should have a positive scroll range");

        controller.scrollCurrentPane(1);
        let state = store.getState();
        assertEqual(state.ui.followBottom.activity, false, "scrolling up should disable activity follow-bottom mode");
        const frozenOffset = state.ui.scroll.activity;
        assert(frozenOffset > 0, "activity should preserve a positive top offset after scrolling away from the bottom");

        store.dispatch({
            type: "history/set",
            sessionId,
            history: {
                chat: [],
                activity: buildActivityItems(85),
                events: [],
                loadedEventLimit: 200,
            },
        });
        state = store.getState();
        assertEqual(state.ui.scroll.activity, frozenOffset, "new activity lines should not rewrite the preserved offset while follow-bottom is disabled");

        controller.scrollCurrentPaneToBottom();
        state = store.getState();
        assertEqual(state.ui.followBottom.activity, true, "jumping to the bottom should reenable activity follow-bottom mode");
        assertEqual(state.ui.scroll.activity, 0, "activity follow-bottom mode should store zero distance from the bottom");
    });

    it("uses the viewport atBottom signal to disable sticky follow for wrapped activity panes", () => {
        const { controller, store } = createController();
        const sessionId = seedSession(store);
        store.dispatch({
            type: "history/set",
            sessionId,
            history: {
                chat: [],
                activity: buildActivityItems(80),
                events: [],
                loadedEventLimit: 200,
            },
        });
        store.dispatch({ type: "ui/focus", focusRegion: "activity" });

        const maxOffset = controller.getPaneMaxScrollOffset("activity");
        assert(maxOffset > 0, "activity pane should have a positive scroll range");

        controller.updatePaneScrollFromViewport("activity", maxOffset, { atBottom: false });

        const state = store.getState();
        assertEqual(state.ui.followBottom.activity, false, "a viewport-level not-at-bottom signal should disable follow mode even when the shared max offset estimate says the pane is at the bottom");
        assertEqual(state.ui.scroll.activity, maxOffset, "once follow mode is disabled, the preserved activity offset should stay top-relative");
    });

    it("exports execution history into the session artifact store", async () => {
        const uploaded = [];
        const fakeTransport = {
            mgmt: {
                getExecutionHistory: async () => [{
                    eventId: 1,
                    kind: "ExecutionStarted",
                    timestampMs: 1_710_000_000_000,
                    data: "{\"step\":\"start\"}",
                }],
                getOrchestrationStats: async () => ({ historyEventCount: 1, orchestrationVersion: "1.0.43" }),
                getSession: async () => ({ title: "History Test", agentId: "tester", model: "gpt-test" }),
            },
            artifactStore: {
                uploadArtifact: async (sessionId, filename, content, contentType) => {
                    uploaded.push({ sessionId, filename, content, contentType });
                    return filename;
                },
            },
        };

        const result = await NodeSdkTransport.prototype.exportExecutionHistory.call(fakeTransport, "session-12345678");

        assertEqual(uploaded.length, 1, "history export should write exactly one artifact");
        assertEqual(uploaded[0].sessionId, "session-12345678", "artifact should belong to the exported session");
        assertEqual(uploaded[0].contentType, "application/json", "history export should be stored as json");
        assertIncludes(uploaded[0].content, "\"eventCount\": 1", "artifact payload should include the event count");
        assertIncludes(uploaded[0].content, "\"orchestrationVersion\": \"1.0.43\"", "artifact payload should include orchestration version when present");
        assertIncludes(result.artifactLink, "artifact://session-12345678/", "export should return an artifact link");
    });

    it("refreshes the files browser selection after exporting history", async () => {
        const sessionId = "session-12345678";
        const filename = "execution-history-session--1.json";
        const { controller, store } = createController({
            exportExecutionHistory: async () => ({
                sessionId,
                filename,
                artifactLink: `artifact://${sessionId}/${filename}`,
            }),
            listArtifacts: async () => [filename],
            downloadArtifact: async () => "{\"history\":true}",
        });
        seedSession(store, sessionId);

        await controller.exportExecutionHistory();

        const filesState = store.getState().files.bySessionId[sessionId];
        assertEqual(filesState.selectedFilename, filename, "exported history should become the selected file");
        assertEqual(store.getState().files.selectedArtifactId, `${sessionId}/${filename}`, "global files selection should follow the new history artifact");
        assertIncludes(filesState.previews[filename].content, "\"history\": true", "exported history should be previewable in the files pane");
    });

    it("renders buffered child-update system prompts as activity instead of chat", () => {
        const createdAt = new Date("2026-04-08T03:00:00.000Z");
        const history = buildHistoryModel([
            {
                seq: 1,
                sessionId: "session-12345678",
                eventType: "system.message",
                data: {
                    content:
                        "Buffered child updates arrived while your recurring schedule was waiting for the next wake-up " +
                        "(\"monitor stress test\"). Review the updates and continue your task now.",
                },
                createdAt,
            },
            {
                seq: 2,
                sessionId: "session-12345678",
                eventType: "assistant.message",
                data: { content: "Latest steady-state sample recorded." },
                createdAt,
            },
        ]);

        assertEqual(
            history.chat.some((message) => message.text.includes("Buffered child updates arrived")),
            false,
            "internal child-update prompts should not appear in chat",
        );
        assertEqual(
            history.activity.some((item) => item.text.includes("Buffered child updates arrived")),
            true,
            "internal child-update prompts should still appear in activity",
        );
        assertEqual(history.chat.some((message) => message.text.includes("Latest steady-state sample recorded.")), true);
    });

    it("routes rehydration notices out of chat and into activity", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "idle",
            title: "Rehydration Test",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "system.message",
                data: {
                    content:
                        "The session was dehydrated and has been rehydrated on a new worker. " +
                        "The LLM conversation history is preserved.",
                },
                createdAt: new Date("2026-04-08T09:15:06.000Z"),
            },
        ]));

        const lines = selectChatLines(state, 120);
        const text = flattenChatLines(lines);
        const history = state.history.bySessionId.get(sessionId);

        assertEqual(text.includes("Session rehydrated on a new worker."), false, "rehydration should not stay visible in chat");
        assertEqual(
            history.activity.some((item) => item.text.includes("[rehydrated]")),
            true,
            "rehydration should stay visible in activity",
        );
    });

    it("keeps mixed rehydration reminders out of chat while preserving them in activity", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "idle",
            title: "Facts Manager",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "system.message",
                data: {
                    content: [
                        "The session was dehydrated and has been rehydrated on a new worker. The LLM conversation history is preserved.",
                        "",
                        "There is an active recurring schedule every 60 seconds for \"facts-manager curation cycle\".",
                        "It remains active automatically after this turn completes, so do NOT call wait() just to keep the recurring loop alive.",
                    ].join("\n"),
                },
                createdAt: new Date("2026-04-08T09:15:06.000Z"),
            },
        ]));

        const lines = selectChatLines(state, 120);
        const text = flattenChatLines(lines);
        const history = state.history.bySessionId.get(sessionId);

        assertEqual(text.includes("Session rehydrated on a new worker."), false, "rehydration summary should not appear in chat");
        assertEqual(text.includes("active recurring schedule every 60 seconds"), false, "internal recurring schedule reminders should stay out of chat");
        assertEqual(
            history.activity.some((item) => item.text.includes("facts-manager curation cycle")),
            true,
            "the mixed reminder should remain inspectable in activity",
        );
    });

    it("collapses trailing multiline [SYSTEM: ...] wrappers appended to user-visible text", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "idle",
            title: "Wrapped System Prompt",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "user.message",
                data: {
                    content: [
                        "hey there",
                        "",
                        "[SYSTEM: The session was dehydrated and has been rehydrated on a new worker. The LLM conversation history is preserved.",
                        "There is an active recurring schedule every 180 seconds for \"Refresh HN and Reddit trend summaries\".",
                        "Buffered child updates arrived during the last 30 seconds:",
                        "• Agent 22c8cd06 completed",
                        "]",
                    ].join("\n"),
                },
                createdAt: new Date("2026-04-10T07:03:45.000Z"),
            },
        ]));

        const lines = selectChatLines(state, 120);
        const text = flattenChatLines(lines);
        const history = state.history.bySessionId.get(sessionId);

        assertIncludes(text, "You: hey there", "the visible user text should remain in chat");
        assertEqual(text.includes("Session rehydrated on a new worker."), false, "rehydration notice should be removed from the chat pane");
        assertEqual(text.includes("active recurring schedule every 180 seconds"), false, "wrapped internal reminders should stay out of chat");
        assertEqual(
            history.activity.some((item) => item.text.includes("active recurring schedule every 180 seconds")),
            true,
            "wrapped internal reminders should remain inspectable in activity",
        );
        assertEqual(text.includes("[SYSTEM:"), false, "raw wrapped system prompts should not leak into chat");
    });

    it("deduplicates replayed user messages after a rehydration notice is routed out of chat", () => {
        const history = buildHistoryModel([
            {
                seq: 1,
                sessionId: "session-12345678",
                eventType: "user.message",
                data: { content: "yea sweep at <=450 VU." },
                createdAt: new Date("2026-04-10T15:43:37.000Z"),
            },
            {
                seq: 2,
                sessionId: "session-12345678",
                eventType: "system.message",
                data: {
                    content: "The session was dehydrated and has been rehydrated on a new worker.",
                },
                createdAt: new Date("2026-04-10T15:43:43.000Z"),
            },
            {
                seq: 3,
                sessionId: "session-12345678",
                eventType: "user.message",
                data: { content: "yea sweep at <=450 VU." },
                createdAt: new Date("2026-04-10T15:43:43.000Z"),
            },
        ]);

        assertEqual(history.chat.length, 1, "replayed user messages should collapse into one visible chat line");
        assertEqual(
            history.activity.some((item) => item.text.includes("[rehydrated]")),
            true,
            "the rehydration event should still be visible in activity",
        );
    });

    it("shows a chat-header Thinking status while a response is still pending", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "running",
            title: "Reasoning Test",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "user.message",
                data: { content: "diagnose the worker stall" },
                createdAt: new Date("2026-04-10T08:00:00.000Z"),
            },
            {
                seq: 2,
                sessionId,
                eventType: "assistant.reasoning",
                data: { content: "Checking the latest hydration and CPU signals first." },
                createdAt: new Date("2026-04-10T08:00:02.000Z"),
            },
        ]));

        const lines = selectChatLines(state, 120);
        const text = flattenChatLines(lines);
        const chrome = selectChatPaneChrome(state);
        const titleRight = (chrome.titleRight || []).map((run) => run.text).join("");

        assertEqual(text.includes("Thinking"), false, "pending turns should no longer inject an inline Thinking card into chat");
        assertIncludes(text, "You: diagnose the worker stall", "the visible chat transcript should remain the user/assistant conversation only");
        assertIncludes(titleRight, "Thinking", "the chat header should show a Thinking status while the assistant response is pending");
    });

    it("preserves underscores inside bare URLs in chat rendering", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "idle",
            title: "Underscore Links",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "assistant.message",
                data: {
                    content: "Use https://example.com/releases/train_payload_v2/report_file.md for the full report.",
                },
                createdAt: new Date("2026-04-21T11:05:00.000Z"),
            },
        ]));

        const text = flattenChatLines(selectChatLines(state, 120));
        assertIncludes(text, "https://example.com/releases/train_payload_v2/report_file.md", "chat rendering should preserve underscores inside bare URLs");
    });

    it("clears the chat-header Thinking status once the final assistant response arrives", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "idle",
            title: "Reasoning Complete",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "user.message",
                data: { content: "diagnose the worker stall" },
                createdAt: new Date("2026-04-10T08:00:00.000Z"),
            },
            {
                seq: 2,
                sessionId,
                eventType: "assistant.reasoning",
                data: { content: "Checking the latest hydration and CPU signals first." },
                createdAt: new Date("2026-04-10T08:00:02.000Z"),
            },
            {
                seq: 3,
                sessionId,
                eventType: "assistant.message",
                data: { content: "The stall is coming from blob-storage I/O during hydration." },
                createdAt: new Date("2026-04-10T08:00:05.000Z"),
            },
        ]));

        const lines = selectChatLines(state, 120);
        const text = flattenChatLines(lines);
        const chrome = selectChatPaneChrome(state);

        assertEqual(text.includes("Thinking"), false, "the chat transcript should not contain an inline Thinking card once the assistant responds");
        assertEqual((chrome.titleRight || []).length, 0, "the chat header should clear the Thinking status once the assistant responds");
        assertIncludes(text, "Agent: The stall is coming from blob-storage I/O during hydration.", "the final assistant message should replace the pending Thinking state");
    });

    it("keeps consecutive agent lines tight while preserving spacing between speaker changes", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "idle",
            title: "Speaker Spacing",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "assistant.message",
                data: { content: "First agent update." },
                createdAt: new Date("2026-04-10T07:00:00.000Z"),
            },
            {
                seq: 2,
                sessionId,
                eventType: "assistant.message",
                data: { content: "Second agent update." },
                createdAt: new Date("2026-04-10T07:00:05.000Z"),
            },
            {
                seq: 3,
                sessionId,
                eventType: "user.message",
                data: { content: "User follow-up." },
                createdAt: new Date("2026-04-10T07:00:10.000Z"),
            },
        ]));

        const lines = selectChatLines(state, 120);
        const flattened = lines.map((line) => Array.isArray(line)
            ? line.map((run) => run?.text || "").join("")
            : String(line?.text || ""));
        const firstAgentIndex = flattened.findIndex((line) => line.includes("Agent: First agent update."));
        const secondAgentIndex = flattened.findIndex((line) => line.includes("Agent: Second agent update."));
        const userIndex = flattened.findIndex((line) => line.includes("You: User follow-up."));

        assertEqual(secondAgentIndex, firstAgentIndex + 1, "consecutive agent updates should not get an extra blank spacer");
        assertEqual(flattened[userIndex - 1].trim(), "", "speaker changes should still leave a small spacer");
    });

    it("renders user prefixes and body text with the shared yellow tint", () => {
        const sessionId = "session-12345678";
        const state = createInitialState({ mode: "local" });
        state.sessions.byId[sessionId] = {
            sessionId,
            status: "idle",
            title: "User Tint",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.sessions.activeSessionId = sessionId;
        state.history.bySessionId.set(sessionId, buildHistoryModel([
            {
                seq: 1,
                sessionId,
                eventType: "user.message",
                data: { content: "Track these flights." },
                createdAt: new Date("2026-04-10T11:30:24.000Z"),
            },
        ]));

        const lines = selectChatLines(state, 120);
        const userLine = lines.find((line) => Array.isArray(line) && line.some((run) => String(run?.text || "").includes("You:")));

        assertEqual(Boolean(userLine), true, "expected a rendered user line");
        const labelRun = userLine.find((run) => String(run?.text || "") === "You: ");
        const bodyRun = userLine.find((run) => String(run?.text || "").includes("Track these flights."));

        assertEqual(labelRun?.color, "#ffec99", "user label should use the brighter yellow tint");
        assertEqual(bodyRun?.color, "#ffd866", "user body should use the shared yellow tint");
    });

    it("shows child-session artifacts in the selected session tree and still offers all-sessions scope", async () => {
        const parentSessionId = "session-parent1234";
        const childSessionId = "session-child5678";
        const siblingSessionId = "session-sibling90ab";
        const requestedSessionIds = [];
        const { controller, store } = createController({
            listArtifacts: async (sessionId) => {
                requestedSessionIds.push(sessionId);
                if (sessionId === parentSessionId) return ["brief.md"];
                if (sessionId === childSessionId) return ["child-notes.md"];
                if (sessionId === siblingSessionId) return ["sibling.md"];
                return [];
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: parentSessionId,
                    title: "Root",
                    status: "idle",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
                {
                    sessionId: childSessionId,
                    parentSessionId,
                    title: "Child",
                    status: "idle",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
                {
                    sessionId: siblingSessionId,
                    title: "Sibling",
                    status: "idle",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
        });
        store.dispatch({ type: "sessions/selected", sessionId: parentSessionId });

        await controller.ensureFilesForScope("selectedSession");

        const items = selectFileBrowserItems(store.getState());
        assertEqual(requestedSessionIds.includes(parentSessionId), true, "parent artifacts should be loaded");
        assertEqual(requestedSessionIds.includes(childSessionId), true, "child artifacts should be loaded in session-tree scope");
        assertEqual(requestedSessionIds.includes(siblingSessionId), false, "unrelated sessions should not be loaded in session-tree scope");
        assertEqual(items.some((item) => item.id === `${parentSessionId}/brief.md`), true, "parent artifact should be listed");
        assertEqual(items.some((item) => item.id === `${childSessionId}/child-notes.md`), true, "child artifact should be listed");
        assertEqual(items.some((item) => item.id === `${siblingSessionId}/sibling.md`), false, "sibling artifact should not be listed");
        assertEqual(items.some((item) => item.label === `[${childSessionId.slice(0, 8)}] child-notes.md`), true, "child artifacts should be labeled with their session id inside the parent tree");

        controller.openFilesFilter();
        const scopeOptions = store.getState().ui.modal?.items?.[0]?.options || [];
        assertEqual(scopeOptions.some((option) => option.id === "allSessions"), true, "files filter should still offer all-sessions scope");
    });
});
