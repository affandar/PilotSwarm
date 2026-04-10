import { describe, it } from "vitest";
import { NodeSdkTransport } from "../../../cli/src/node-sdk-transport.js";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { buildHistoryModel } from "../../../ui-core/src/history.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { selectChatLines } from "../../../ui-core/src/selectors.js";
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
                getOrchestrationStats: async () => ({ historyEventCount: 1 }),
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

    it("collapses rehydration notices into a dimmed expandable system summary line", () => {
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
        const systemNotice = lines.find((line) => !Array.isArray(line) && line?.kind === "systemNotice");

        assertEqual(Boolean(systemNotice), true, "rehydration should render as a collapsed system notice");
        assertIncludes(text, "System: Session rehydrated on a new worker.", "rehydration summary should stay visible in chat");
        assertEqual(text.includes("SYSTEM"), false, "rehydration should not be rendered as a boxed system card");
    });

    it("collapses mixed rehydration and recurring-schedule notices into a single system summary", () => {
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
        const systemNotice = lines.find((line) => !Array.isArray(line) && line?.kind === "systemNotice");

        assertEqual(Boolean(systemNotice), true, "mixed notices should collapse to a single system summary");
        assertIncludes(text, "System: Session rehydrated on a new worker.", "summary should use the compact rehydration phrasing");
        assertIncludes(systemNotice?.body || "", "active recurring schedule every 60 seconds", "expanded notice body should preserve the full reminder text");
    });
});
