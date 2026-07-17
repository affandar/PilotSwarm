import { describe, it } from "vitest";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";
import { FOCUS_REGIONS, UI_COMMANDS } from "../../../app/ui/core/src/commands.js";
import { PilotSwarmUiController } from "../../../app/ui/core/src/controller.js";
import { buildHistoryModel } from "../../../app/ui/core/src/history.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import {
    selectActiveChat,
    selectActivityPane,
    selectChatLines,
    selectChatPaneChrome,
    selectOutboxOverlayLines,
    selectInspector,
    selectModelPickerModal,
    selectReasoningEffortPickerModal,
    selectSessionOwnerFilterModal,
    selectSessionRows,
    selectStatusBar,
    selectVisibleSessionRows,
} from "../../../app/ui/core/src/selectors.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";
import { assert, assertEqual, assertIncludes, assertThrows } from "../helpers/assertions.js";

function createController(transportOverrides = {}, { branding = null, sessionOwnerFilter = null } = {}) {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local", branding, sessionOwnerFilter }));
    return {
        store,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function linesText(lines) {
    return (lines || []).map((line) => {
        if (typeof line === "string") return line;
        if (Array.isArray(line)) return line.map((run) => run?.text || "").join("");
        if (Array.isArray(line?.runs)) return line.runs.map((run) => run?.text || "").join("");
        return String(line?.text || "");
    }).join("\n");
}

describe("session refresh UI recovery", () => {
    it("loads sessions through bounded pages when the transport supports paging", async () => {
        const calls = [];
        const { controller, store } = createController({
            listSessions: async () => {
                throw new Error("broad listSessions should not be used when paging is available");
            },
            listSessionsPage: async (opts) => {
                calls.push(opts);
                if (!opts?.cursor) {
                    return {
                        sessions: [{ sessionId: "page-one", title: "Page One", status: "idle", createdAt: 1, updatedAt: 2 }],
                        hasMore: true,
                        nextCursor: { updatedAt: 2, sessionId: "page-one" },
                    };
                }
                return {
                    sessions: [{ sessionId: "page-two", title: "Page Two", status: "idle", createdAt: 3, updatedAt: 4 }],
                    hasMore: false,
                };
            },
        });

        await controller.refreshSessions();

        assertEqual(calls.length, 2, "refresh should follow nextCursor while more pages exist");
        assertEqual(calls[0].limit, 200, "refresh should request bounded max-size pages");
        assertEqual(calls[1].cursor.sessionId, "page-one", "refresh should pass the prior page cursor");
        const sessionIds = Object.keys(store.getState().sessions.byId);
        assert(sessionIds.includes("page-one"), "first page session should be loaded");
        assert(sessionIds.includes("page-two"), "second page session should be loaded");
    });

    it("caps paged session refresh after five pages", async () => {
        let calls = 0;
        const { controller, store } = createController({
            listSessionsPage: async (opts) => {
                calls += 1;
                const id = `page-${calls}`;
                return {
                    sessions: [{ sessionId: id, title: id, status: "idle", createdAt: calls, updatedAt: calls }],
                    hasMore: true,
                    nextCursor: { updatedAt: calls, sessionId: id },
                };
            },
        });

        await controller.refreshSessions();

        assertEqual(calls, 5, "refresh should stop after the configured page cap");
        assertEqual(Object.keys(store.getState().sessions.byId).length, 5, "refresh should load only capped pages");
    });

    it("keeps the active session visible when it falls outside the paged window", async () => {
        const { controller, store } = createController({
            listSessionsPage: async () => ({
                sessions: [{ sessionId: "newest", title: "Newest", status: "idle", createdAt: 10, updatedAt: 11 }],
                hasMore: false,
            }),
            getSession: async (sessionId) => ({
                sessionId,
                title: "Active Outside Page",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }),
        });
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{ sessionId: "active-old", title: "Old Active", status: "running", createdAt: 1, updatedAt: 2 }],
        });

        await controller.refreshSessions();

        const sessions = store.getState().sessions.byId;
        assert(sessions.newest, "paged session should be loaded");
        assert(sessions["active-old"], "active session outside paged window should be preserved");
    });

    it("falls back to broad listSessions when paged reads are unavailable", async () => {
        let broadCalls = 0;
        const { controller, store } = createController({
            listSessions: async () => {
                broadCalls += 1;
                return [{ sessionId: "legacy", title: "Legacy", status: "idle", createdAt: 1, updatedAt: 2 }];
            },
        });

        await controller.refreshSessions();

        assertEqual(broadCalls, 1, "legacy transports should still use listSessions");
        assert(store.getState().sessions.byId.legacy, "legacy broad session should be loaded");
    });

    it("clears the stale session refresh failed banner after a later successful refresh", async () => {
        const { controller, store } = createController();

        store.dispatch({
            type: "connection/error",
            error: "temporary listSessions failure",
            statusText: "Session refresh failed",
        });

        await controller.refreshSessions();

        const state = store.getState();
        assertEqual(state.connection.connected, true, "refresh success should restore connected state");
        assertEqual(state.connection.error, null, "refresh success should clear the connection error");
        assertEqual(state.ui.statusText, "Connected", "refresh success should clear the stale refresh failure banner");
    });

    it("preserves unrelated status text while clearing the recovered connection error", async () => {
        const { controller, store } = createController();

        store.dispatch({ type: "ui/status", text: "Prompt sent" });
        store.dispatch({
            type: "connection/error",
            error: "temporary listSessions failure",
            statusText: "Prompt sent",
        });

        await controller.refreshSessions();

        const state = store.getState();
        assertEqual(state.connection.connected, true, "refresh success should restore connected state");
        assertEqual(state.connection.error, null, "refresh success should clear the connection error");
        assertEqual(state.ui.statusText, "Prompt sent", "refresh success should not overwrite unrelated status text");
    });

    it("prefers the main PilotSwarm system session as the default active selection", async () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "system-root",
                    title: "PilotSwarm Agent",
                    isSystem: true,
                    agentId: "pilotswarm",
                    status: "idle",
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "user-session",
                    title: "Stress Test",
                    isSystem: false,
                    status: "running",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });

        assertEqual(
            store.getState().sessions.activeSessionId,
            "system-root",
            "initial selection should prefer the PilotSwarm root",
        );
    });

    it("selects the main PilotSwarm system session when only system sessions are present", async () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "system-root",
                title: "PilotSwarm Agent",
                isSystem: true,
                agentId: "pilotswarm",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
            }],
        });

        assertEqual(
            store.getState().sessions.activeSessionId,
            "system-root",
            "initial selection should use the PilotSwarm root when only system sessions exist",
        );
    });

    it("rebrands legacy PilotSwarm root sessions with the active app title", async () => {
        const { store } = createController({}, {
            branding: {
                title: "Waldemort",
                splash: "{bold}{cyan-fg}Waldemort{/cyan-fg}{/bold}",
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "system-root",
                    title: "PilotSwarm",
                    isSystem: true,
                    status: "idle",
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "system-child",
                    title: "Sweeper Agent",
                    isSystem: true,
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "system-root" });

        const rows = selectVisibleSessionRows(store.getState(), 8);
        const rootRow = rows[0]?.runs?.map((run) => run.text).join("") || "";
        assert(rootRow.startsWith("⚙ Waldemort"), "system session row should use one visible space after the gear marker");
        assertIncludes(rootRow, "Waldemort", "legacy root row should use the current branding title");
        assert(!rootRow.includes("PilotSwarm"), "legacy root row should not leak the old PilotSwarm title");

        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");
        assert(chromeTitle.startsWith("⚙ Waldemort"), "system chat chrome should use one visible space after the gear marker");
        assertIncludes(chromeTitle, "Waldemort", "chat chrome should use the branded system title");
        assert(!chromeTitle.includes("PilotSwarm"), "chat chrome should not leak the old PilotSwarm title");

        const splash = selectActiveChat(store.getState());
        assertEqual(splash[0]?.id, "splash:Waldemort", "empty system-session splash should use the branded root title");
    });

    it("shows a sending status in the chat header without appending a synthetic chat bubble", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "send-session",
                title: "Send Session",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({
            type: "history/set",
            sessionId: "send-session",
            history: {
                chat: [{
                    id: "optimistic:send",
                    role: "user",
                    text: "Please investigate this",
                    time: "",
                    createdAt: 3,
                    optimistic: true,
                }],
                activity: [],
                events: [],
            },
        });

        const chat = selectActiveChat(store.getState());
        assertEqual(chat.length, 1, "optimistic sends should keep the visible chat transcript unchanged");
        assertEqual(chat[0]?.role, "user", "the visible chat transcript should only contain the optimistic user message");

        const chrome = selectChatPaneChrome(store.getState());
        const chromeTitle = chrome.title.map((run) => run.text).join("");
        const chromeRight = (chrome.titleRight || []).map((run) => run.text).join("");
        assertEqual(chromeTitle.includes("[sending]"), false, "chat chrome should no longer append the live status to the main title text");
        assertIncludes(chromeRight, "Sending", "chat chrome should show a sending status on the right side while the optimistic turn is in flight");
    });

    it("keeps recoverable transport warnings stable across running detail refreshes", async () => {
        const errorText = "Activity `runTurn` JS execution failed: GenericFailure, Error: Connection is closed. (Live Copilot connection lost; retry 1/3 in 15s.)";
        const detailResponses = [
            {
                sessionId: "retry-session",
                title: "Retry Session",
                status: "running",
                orchestrationStatus: "Running",
                updatedAt: 2,
            },
            {
                sessionId: "retry-session",
                title: "Retry Session",
                status: "idle",
                orchestrationStatus: "Running",
                updatedAt: 3,
            },
        ];
        const { controller, store } = createController({
            getSession: async () => detailResponses.shift(),
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "retry-session",
                title: "Retry Session",
                status: "error",
                orchestrationStatus: "Running",
                error: errorText,
                createdAt: 1,
                updatedAt: 1,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "retry-session" });

        const beforeWarning = selectActiveChat(store.getState()).find((message) => message.cardTitle === "Warning");
        assert(beforeWarning, "recoverable transport error should render as a warning card");
        assertIncludes(beforeWarning?.text, "Connection is closed", "warning should include the transport error");

        await controller.syncSessionDetail("retry-session");

        const duringRetrySession = store.getState().sessions.byId["retry-session"];
        assertEqual(duringRetrySession.status, "running", "detail refresh should still accept the live running status");
        assertEqual(duringRetrySession.error, errorText, "recoverable transport warning should survive running refreshes");
        const duringRetryWarning = selectActiveChat(store.getState()).find((message) => message.cardTitle === "Warning");
        assert(duringRetryWarning, "warning should not disappear while retry is still running");
        assertEqual(duringRetryWarning?.id, beforeWarning?.id, "warning card id should stay stable while the same retry warning is active");

        await controller.syncSessionDetail("retry-session");

        const afterRecoverySession = store.getState().sessions.byId["retry-session"];
        assertEqual(afterRecoverySession.error, null, "non-running refresh should clear the stale recoverable warning");
        assertEqual(
            selectActiveChat(store.getState()).some((message) => message.cardTitle === "Warning"),
            false,
            "warning card should disappear after the retry cycle recovers",
        );
    });

    it("shows agent-prefixed session titles with the uniquifier first", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "8a01cdad-1111-2222-3333-444444444444",
                title: "Mad-Eye Moody - R2D Train Watcher: M61 Conductor",
                agentId: "mad-eye-moody",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "8a01cdad-1111-2222-3333-444444444444" });

        const rowText = selectSessionRows(store.getState())[0]?.text || "";
        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");

        assertIncludes(rowText, "M61 Conductor · R2D Train Watcher · Mad-Eye Moody", "session row should show the uniquifier before type and agent name");
        assert(!rowText.includes("Mad-Eye Moody - R2D Train Watcher"), "session row should not keep the agent-first title shape");
        assertIncludes(chromeTitle, "M61 Conductor · R2D Train Watcher · Mad-Eye Moody", "chat header should show the uniquifier before type and agent name");
        assertIncludes(chromeTitle, "[8a01cdad]", "chat header should still keep the session id metadata");
    });

    it("normalizes existing agent-suffixed typed session titles", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "8a01cdad-1111-2222-3333-444444444444",
                title: "R2D Train Watcher: M61 Conductor · Mad-Eye Moody",
                agentId: "mad-eye-moody",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "8a01cdad-1111-2222-3333-444444444444" });

        const rowText = selectSessionRows(store.getState())[0]?.text || "";
        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");

        assertIncludes(rowText, "M61 Conductor · R2D Train Watcher · Mad-Eye Moody", "session row should normalize the previous suffix display shape");
        assert(!rowText.includes("R2D Train Watcher: M61 Conductor · Mad-Eye Moody"), "session row should not keep the previous type-first display shape");
        assertIncludes(chromeTitle, "M61 Conductor · R2D Train Watcher · Mad-Eye Moody", "chat header should normalize the previous suffix display shape");
    });

    it("shows wall-clock cron schedules with a client-local cron badge", () => {
        const { store } = createController();
        const nextFire = Date.UTC(2026, 4, 20, 2, 7, 0);
        const expected = new Date(nextFire).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZoneName: "short",
        }).replace(/,\s*/g, " ").replace(/\s+/g, " ").trim();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "cron-at-session",
                title: "Changed daily summary time",
                status: "cron_waiting",
                cronActive: true,
                cronKind: "wall-clock",
                cronNextFireAt: nextFire,
                cronTimezone: "America/Los_Angeles",
                createdAt: 1,
                updatedAt: 2,
            }],
        });

        const row = selectSessionRows(store.getState())[0] || {};
        const mainText = row.text || "";
        const detailText = (row.detailRuns || []).map((run) => run.text).join("");
        // Collapsed rows carry a compact ⏱ glyph; the full wall-clock cadence
        // rides in the detail line revealed when the row is expanded.
        assertIncludes(mainText, "⏱", "scheduled cron rows should show the compact clock glyph on the main line");
        assertIncludes(detailText, `[cron ${expected}]`, "the cron detail should use the unified cron badge with client-local time");
        assert(!`${mainText} ${detailText}`.includes("cron_at"), "wall-clock cron rows should not expose the internal cron_at tool name");
    });

    it("keeps the waiting icon stable when a same-age detail refresh reports idle", async () => {
        let detailStatus = {
            sessionId: "timer-joke-session",
            title: "Joke sender",
            status: "idle",
            createdAt: 1,
            updatedAt: 100,
        };
        const { controller, store } = createController({
            getSession: async () => detailStatus,
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "timer-joke-session",
                title: "Joke sender",
                status: "waiting",
                waitReason: "deliver joke later",
                createdAt: 1,
                updatedAt: 100,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "timer-joke-session" });
        store.dispatch({ type: "ui/chatViewMode", mode: "summary" });

        await controller.syncSessionDetail("timer-joke-session");
        let rowText = selectSessionRows(store.getState())[0]?.text || "";
        let summaryText = linesText(selectChatLines(store.getState(), 120));
        assertIncludes(rowText, "~ Joke sender", "same-age idle detail should not clear the visible wait icon");
        assertIncludes(summaryText, "Status: waiting", "same-age idle detail should not flicker the summary status to idle");

        const originalNow = Date.now;
        let nowMs = 1_000;
        Date.now = () => nowMs;
        try {
            detailStatus = {
                ...detailStatus,
                updatedAt: 200,
            };
            await controller.syncSessionDetail("timer-joke-session");
            rowText = selectSessionRows(store.getState())[0]?.text || "";
            summaryText = linesText(selectChatLines(store.getState(), 120));
            assertIncludes(rowText, "~ Joke sender", "newer idle detail should keep the wait icon for the 5s anti-flicker hold");
            assertIncludes(summaryText, "Status: idle", "newer idle detail should clear the summary waiting status immediately");

            nowMs += 5_000;
            await controller.syncSessionDetail("timer-joke-session");
            rowText = selectSessionRows(store.getState())[0]?.text || "";
            assert(!rowText.includes("~ Joke sender"), "newer idle detail should clear the wait icon after the 5s hold");
        } finally {
            Date.now = originalNow;
        }
    });

    it("routes an answer typed the instant a question arrives to sendAnswer, not the outbox queue", async () => {
        const sendAnswerCalls = [];
        const sendMessageCalls = [];
        const { controller, store } = createController({
            // The slower customStatus detail-sync has not caught up yet: it would
            // still report the pre-question running status with no pendingQuestion.
            getSession: async () => ({ sessionId: "q-session", status: "running", createdAt: 1, updatedAt: 100 }),
            sendAnswer: async (sessionId, answer) => { sendAnswerCalls.push({ sessionId, answer }); },
            sendMessage: async (sessionId, text, opts) => { sendMessageCalls.push({ sessionId, text, opts }); },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{ sessionId: "q-session", title: "Q", status: "running", createdAt: 1, updatedAt: 100 }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "q-session" });

        // The question arrives on the live event stream (ahead of the detail-sync).
        controller.mergeSessionEvent("q-session", {
            seq: 5,
            eventType: "session.input_required_started",
            createdAt: 200,
            data: { question: "Which recovery path?", choices: ["a", "b"], allowFreeform: false },
        });

        // Fix part 1: pendingQuestion is available synchronously, from the event.
        assertEqual(
            store.getState().sessions.byId["q-session"].pendingQuestion?.question,
            "Which recovery path?",
            "input_required_started event sets pendingQuestion immediately",
        );

        // The user answers right away — before any detail-sync runs.
        controller.setPrompt("run the repo-cache cleanup and retry", 0);
        await controller.sendPrompt();

        assertEqual(sendAnswerCalls.length, 1, "answer took the direct sendAnswer path");
        assertEqual(sendAnswerCalls[0].answer, "run the repo-cache cleanup and retry", "answer text delivered as the answer");
        assertEqual(sendMessageCalls.length, 0, "answer was NOT misrouted into the outbox queue");
    });

    it("keeps a freshly-shown pending question when a stale same-age detail-sync races it", async () => {
        let detail = { sessionId: "q2-session", status: "running", createdAt: 1, updatedAt: 100 };
        const { controller, store } = createController({
            getSession: async () => detail,
        });
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{ sessionId: "q2-session", title: "Q2", status: "running", createdAt: 1, updatedAt: 100 }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "q2-session" });

        controller.mergeSessionEvent("q2-session", {
            seq: 3,
            eventType: "session.input_required_started",
            createdAt: 150,
            data: { question: "Pick one", choices: ["x"], allowFreeform: false },
        });
        assertEqual(store.getState().sessions.byId["q2-session"].pendingQuestion?.question, "Pick one", "question shown from the event");

        // Fix part 2: a same-age (stale/in-flight) detail-sync that raced the event
        // still reports "running" with no pendingQuestion — it must not wipe it.
        await controller.syncSessionDetail("q2-session");
        assertEqual(
            store.getState().sessions.byId["q2-session"].pendingQuestion?.question,
            "Pick one",
            "stale same-age detail-sync must not clear the pending question",
        );

        // A genuinely newer detail-sync that reports the session moved past the
        // question does clear it.
        detail = { sessionId: "q2-session", status: "idle", createdAt: 1, updatedAt: 300 };
        await controller.syncSessionDetail("q2-session");
        assertEqual(
            store.getState().sessions.byId["q2-session"].pendingQuestion ?? null,
            null,
            "a newer detail-sync past input_required clears the pending question",
        );
    });

    it("keeps cron row metadata stable when a same-age detail refresh omits cron fields", async () => {
        let detailStatus = {
            sessionId: "cron-joke-session",
            title: "Joke cron",
            status: "idle",
            cronActive: false,
            createdAt: 1,
            updatedAt: 100,
        };
        const { controller, store } = createController({
            getSession: async () => detailStatus,
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "cron-joke-session",
                title: "Joke cron",
                status: "idle",
                cronActive: true,
                cronKind: "interval",
                cronInterval: 300,
                cronReason: "tell another joke",
                createdAt: 1,
                updatedAt: 100,
            }],
        });

        await controller.syncSessionDetail("cron-joke-session");
        let row = selectSessionRows(store.getState())[0] || {};
        let rowText = row.text || "";
        let detailText = (row.detailRuns || []).map((run) => run.text).join("");
        assertIncludes(rowText, "~ Joke cron", "same-age detail should keep the cron wait icon");
        assertIncludes(detailText, "[cron 5m 0s]", "same-age detail should keep the cron badge");

        const originalNow = Date.now;
        let nowMs = 1_000;
        Date.now = () => nowMs;
        try {
            detailStatus = {
                ...detailStatus,
                updatedAt: 200,
            };
            await controller.syncSessionDetail("cron-joke-session");
            row = selectSessionRows(store.getState())[0] || {};
            rowText = row.text || "";
            detailText = (row.detailRuns || []).map((run) => run.text).join("");
            assertIncludes(rowText, "~ Joke cron", "newer non-cron detail should keep the cron wait icon for the 5s anti-flicker hold");
            assert(!detailText.includes("[cron 5m 0s]"), "newer non-cron detail should clear the cron badge immediately");

            nowMs += 5_000;
            await controller.syncSessionDetail("cron-joke-session");
            rowText = selectSessionRows(store.getState())[0]?.text || "";
            assert(!rowText.includes("~ Joke cron"), "newer non-cron detail should clear the cron wait icon after the 5s hold");
        } finally {
            Date.now = originalNow;
        }
    });

    it("does not split normal colon titles when no agent prefix is present", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "5174729a-1111-2222-3333-444444444444",
                title: "R2D Train Watcher: M61 Conductor",
                agentId: "mad-eye-moody",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "5174729a-1111-2222-3333-444444444444" });

        const rowText = selectSessionRows(store.getState())[0]?.text || "";
        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");

        assertIncludes(rowText, "R2D Train Watcher: M61 Conductor", "session row should keep a normal colon title intact");
        assert(!rowText.includes("M61 Conductor · R2D Train Watcher"), "session row should not treat normal colon text as an agent prefix");
        assertIncludes(chromeTitle, "R2D Train Watcher: M61 Conductor", "chat header should keep a normal colon title intact");
        assert(!chromeTitle.includes("M61 Conductor · R2D Train Watcher"), "chat header should not reorder normal colon text");
    });

    it("keeps the chat header to title + short id (model/effort live in stats and the session list)", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "reason-title-session",
                title: "Reasoning Session",
                status: "running",
                model: "github-copilot:gpt-5.5",
                reasoningEffort: "xhigh",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "reason-title-session" });

        // Since the portal sessions/themes refresh, the chat header no longer
        // carries the model label; model:effort is shown in session stats
        // (covered below) and on the session list row.
        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");
        assertIncludes(chromeTitle, "Reasoning Session", "chat header should show the session title");
        assertIncludes(chromeTitle, "[reason-t]", "chat header should show the short session id");
        assert(!chromeTitle.includes("gpt-5.5"), "chat header should not carry the model label");
    });

    it("shows reasoning effort next to the model in session stats", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "reason-stats-session",
                title: "Reasoning Stats Session",
                status: "idle",
                model: "github-copilot:gpt-5.5",
                reasoningEffort: "xhigh",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "reason-stats-session" });
        store.dispatch({
            type: "sessionStats/loaded",
            sessionId: "reason-stats-session",
            summary: {
                sessionId: "reason-stats-session",
                agentId: null,
                model: "github-copilot:gpt-5.5",
                parentSessionId: null,
                snapshotSizeBytes: 0,
                dehydrationCount: 0,
                hydrationCount: 0,
                lossyHandoffCount: 0,
                tokensInput: 1,
                tokensOutput: 1,
                tokensCacheRead: 0,
                tokensCacheWrite: 0,
                cacheHitRatio: 0,
                createdAt: 1,
                updatedAt: 2,
            },
        });
        store.dispatch({ type: "ui/inspectorTab", inspectorTab: "stats" });

        const statsText = selectInspector(store.getState(), { width: 80 }).lines
            .map((line) => {
                if (typeof line === "string") return line;
                const runs = Array.isArray(line) ? line : line.runs || [];
                return runs.map((run) => run.text).join("");
            })
            .join("\n");
        assertIncludes(statsText, "gpt-5.5:xhigh", "session stats should append reasoning effort to the model label");
    });

    it("renders session summary as plain structured chat-pane content", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "summary-session",
                title: "Summary Session",
                status: "running",
                shortSummary: "A compact summary.",
                summaryUpdatedAt: 2000,
                summaryState: {
                    intent: "Inspect structured summaries",
                    summary: "Collected structured state for display.",
                    state: {
                        status: "complete",
                        progress: ["Collected evidence", "Prepared report"],
                        result: { verdict: "pass" },
                    },
                    blockers: ["None"],
                    openQuestions: [],
                    nextActions: ["Ship it"],
                },
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "summary-session" });
        store.dispatch({ type: "ui/chatViewMode", mode: "summary" });

        const chat = selectActiveChat(store.getState());
        assertEqual(chat.length, 1, "summary mode should render one summary message");
        assertEqual(chat[0]?.noChrome, true, "summary should render without card chrome");
        assertEqual(Boolean(chat[0]?.cardTitle), false, "summary should not be a message card");

        const rendered = linesText(selectChatLines(store.getState(), 80));
        assertIncludes(rendered, "Summary Session", "summary pane should include the session title");
        assertIncludes(rendered, "State", "summary pane should include the structured state section");
        assertIncludes(rendered, "Collected evidence", "summary pane should render array state items as readable bullets");
        assertIncludes(rendered, "verdict", "summary pane should render object state keys");
        assertEqual(rendered.includes("Session Summary"), false, "summary pane should not render a card title");

        const chrome = selectChatPaneChrome(store.getState());
        // titleRight mirrors the session-row meta (status·model·context) even in
        // summary mode; only the transient live-progress label must be
        // suppressed — animateTitleRight (below) verifies no live progress runs.
        const summaryTitleRightText = (chrome.titleRight || []).map((run) => run?.text || "").join("");
        assertEqual(/thinking|working|sending/i.test(summaryTitleRightText), false, "summary mode should suppress transient live-progress labels");
        assertEqual(chrome.animateTitleRight, false, "summary mode should not animate the chat title");
    });

    it("renders summary from the reduced native TUI chat selector state", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "native-summary-session",
                title: "Native Summary Session",
                status: "idle",
                shortSummary: "Native summary text.",
                summaryUpdatedAt: 2000,
                summaryState: {
                    intent: "Verify native selector",
                    summary: "Native summary text.",
                    state: { status: "complete" },
                },
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "native-summary-session" });
        store.dispatch({ type: "ui/chatViewMode", mode: "summary" });
        store.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.CHAT });

        const rootState = store.getState();
        const reducedNativeState = {
            branding: rootState.branding,
            connection: rootState.connection,
            ui: { chatViewMode: rootState.ui.chatViewMode },
            sessions: {
                activeSessionId: rootState.sessions.activeSessionId,
                byId: {
                    [rootState.sessions.activeSessionId]: rootState.sessions.byId[rootState.sessions.activeSessionId],
                },
            },
            history: { bySessionId: new Map() },
        };

        const rendered = linesText(selectChatLines(reducedNativeState, 80));
        assertIncludes(rendered, "Native Summary Session", "native reduced state should render the summary view title");
        assertIncludes(rendered, "Native summary text.", "native reduced state should render summary content");
        assertEqual(rendered.includes("Start interacting with this session"), false, "native summary view should not fall back to transcript/splash content");

        const status = selectStatusBar(rootState);
        assertIncludes(status.right, "s transcript", "chat status hint should advertise toggling back from summary first");
    });

    it("renders group details as plain markdown tables instead of a system card", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "group:group-1",
                    groupId: "group-1",
                    title: "Release Group",
                    isGroup: true,
                    memberCount: 1,
                    runningCount: 0,
                    waitingCount: 0,
                    completedCount: 1,
                    failedCount: 0,
                    cancelledCount: 0,
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "member-session",
                    groupId: "group-1",
                    title: "Member Session",
                    status: "completed",
                    shortSummary: "Done",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "group:group-1" });

        const chat = selectActiveChat(store.getState());
        assertEqual(chat.length, 1, "group view should render one details message");
        assertEqual(chat[0]?.noChrome, true, "group details should render without card chrome");
        assertEqual(Boolean(chat[0]?.cardTitle), false, "group details should not be a system card");
        assertIncludes(chat[0]?.text || "", "| Metric | Count |", "group details should be backed by a metric markdown table");
        assertIncludes(chat[0]?.text || "", "| Session | Status | Summary |", "group details should be backed by a members markdown table");

        const rendered = linesText(selectChatLines(store.getState(), 80));
        assertIncludes(rendered, "Metric", "group details should include a metric table");
        assertIncludes(rendered, "Session", "group details should include a members table");
        assertIncludes(rendered, "Member Session", "group details should include member rows");
        assertEqual(rendered.includes("Session Group"), false, "group details should not render a system-card title");
    });

    it("disables inspector and activity panes for selected groups", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "group:group-1",
                    groupId: "group-1",
                    title: "Release Group",
                    isGroup: true,
                    memberCount: 1,
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "member-session",
                    groupId: "group-1",
                    title: "Member Session",
                    status: "running",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "group:group-1" });
        store.dispatch({ type: "ui/inspectorTab", tab: "sequence" });

        const inspector = selectInspector(store.getState(), { width: 80 });
        const activity = selectActivityPane(store.getState());
        const inspectorText = linesText(inspector.lines);
        const activityText = linesText(activity.lines);

        assertEqual(inspector.disabled, true, "group inspector should be disabled");
        assertEqual(activity.disabled, true, "group activity pane should be disabled");
        assertIncludes(inspectorText, "Select a session to see details.", "group inspector should ask for a session selection");
        assertIncludes(activityText, "Select a session to see details.", "group activity pane should ask for a session selection");
        assertEqual(inspectorText.includes("No events yet"), false, "group inspector should not show sequence empty-state text");
        assertEqual(activityText.includes("No activity yet"), false, "group activity pane should not show session activity empty-state text");
    });

    it("merges multiple concurrent sends into a single durable enqueue", async () => {
        const sentPrompts = [];
        const { controller, store } = createController({
            sendMessage: async (_sessionId, prompt, options) => {
                sentPrompts.push({ prompt, options });
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "merge-session",
                title: "Merge Session",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "merge-session" });

        // Two sends fired in the same synchronous tick (no await between)
        // should merge into a single durable enqueue. This models the realistic
        // merge case: a paste, a click, or rapid keypresses.
        controller.setPrompt("first request", 13);
        const p1 = controller.sendPrompt();
        controller.setPrompt("second request", 14);
        const p2 = controller.sendPrompt();
        await Promise.all([p1, p2]);

        assertEqual(sentPrompts.length, 1, "concurrent sends should merge into a single durable enqueue");
        assertIncludes(sentPrompts[0].prompt, "first request", "merged enqueue should include the first message");
        assertIncludes(sentPrompts[0].prompt, "second request", "merged enqueue should include the second message");
        assertEqual(
            Array.isArray(sentPrompts[0].options?.clientMessageIds) && sentPrompts[0].options.clientMessageIds.length,
            2,
            "merged enqueue should carry the clientMessageIds of both contributing pending items",
        );

        const outbox = store.getState().outbox.bySessionId["merge-session"] || [];
        assertEqual(outbox.length, 1, "after dispatch, the merged item should be the single outbox entry");
        assertEqual(outbox[0]?.phase, "queued", "the merged item should be in queued phase after a successful enqueue");
        assertEqual(outbox[0]?.clientMessageIds?.length, 2, "the merged outbox item should preserve all contributing clientMessageIds");

        const chat = selectActiveChat(store.getState());
        assertEqual(
            chat.some((message) => message.pendingPhase === "queued"),
            false,
            "queued outbox items should stay out of the scrollback until accepted",
        );
        const overlayText = selectOutboxOverlayLines(store.getState(), 120)
            .map((line) => Array.isArray(line) ? line.map((run) => run?.text || "").join("") : String(line?.text || ""))
            .join("\n");
        assertIncludes(overlayText, "queued prompts", "outbox overlay should include a visual divider");
        assertIncludes(overlayText, "first request", "outbox overlay should show the first queued prompt");
        assertIncludes(overlayText, "second request", "outbox overlay should show the second queued prompt");
    });

    it("sequential awaited sends each produce their own durable enqueue", async () => {
        const sentPrompts = [];
        const { controller, store } = createController({
            sendMessage: async (_sessionId, prompt) => {
                sentPrompts.push(prompt);
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "seq-session",
                title: "Sequential",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "seq-session" });

        controller.setPrompt("first request", 13);
        await controller.sendPrompt();
        controller.setPrompt("second request", 14);
        await controller.sendPrompt();

        assertEqual(sentPrompts.length, 2, "sequential awaited sends should each enqueue independently");
        assertEqual(sentPrompts[0], "first request", "first awaited send should match the first prompt");
        assertEqual(sentPrompts[1], "second request", "second awaited send should match the second prompt");
    });

    it("recalls and cancels pending outbox items at the prompt boundary", () => {
        const { controller, store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "queue-session",
                title: "Queue Session",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "queue-session" });

        const first = controller.buildOutboxItem("first pending", "pending");
        const second = controller.buildOutboxItem("second pending", "pending");
        controller.setSessionOutboxItems("queue-session", [first, second]);
        controller.setPrompt("live draft", 0);

        controller.movePromptCursorVertical(-1);

        let state = store.getState();
        assertEqual(state.ui.promptEdit?.sessionId, "queue-session", "moving up at the prompt boundary should enter pending-prompt editing");
        assertEqual(state.ui.promptEdit?.itemId, second.id, "moving up should recall the most recent pending prompt first");
        assertEqual(state.ui.prompt, "second pending", "the prompt editor should load the recalled pending prompt text");

        const cancelled = controller.cancelSelectedPendingPrompt();
        assertEqual(cancelled, true, "cancelling the selected pending prompt should succeed");

        state = store.getState();
        const remaining = state.outbox.bySessionId["queue-session"] || [];
        assertEqual(remaining.length, 1, "cancelling should remove the selected pending prompt from the outbox");
        assertEqual(remaining[0]?.id, first.id, "the older pending prompt should remain after cancellation");
        assertEqual(state.ui.promptEdit, null, "after cancelling, editing should return to the new prompt");
        assertEqual(state.ui.prompt, "live draft", "after cancelling, the live draft should be restored");
    });

    it("recalls queued outbox items as read-only and deletes them through durable cancel", async () => {
        const cancelCalls = [];
        const { controller, store } = createController({
            cancelPendingMessage: async (sessionId, ids) => {
                cancelCalls.push({ sessionId, ids });
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "queued-recall-session",
                title: "Queued Recall",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "queued-recall-session" });

        const pending = controller.buildOutboxItem("still editable", "pending");
        const queued = controller.buildOutboxItem("already durable", "queued");
        controller.setSessionOutboxItems("queued-recall-session", [pending, queued]);
        controller.setPrompt("live draft", 0);

        controller.movePromptCursorVertical(-1);

        let state = store.getState();
        assertEqual(state.ui.promptEdit?.itemId, queued.id, "moving up should recall the most recent queued prompt first");
        assertEqual(state.ui.promptEdit?.phase, "queued", "queued recall should retain its phase");
        assertEqual(state.ui.prompt, "already durable", "the prompt editor should load the queued prompt text");

        controller.setPrompt("edited queued text", 16);
        state = store.getState();
        const outboxBeforeDelete = state.outbox.bySessionId["queued-recall-session"] || [];
        assertEqual(outboxBeforeDelete.find((item) => item.id === queued.id)?.text, "already durable", "queued prompt text should not be editable");

        const deleted = await controller.cancelSelectedOutboxPrompt();
        assertEqual(deleted, true, "deleting the selected queued prompt should succeed");

        state = store.getState();
        const remaining = state.outbox.bySessionId["queued-recall-session"] || [];
        assertEqual(cancelCalls.length, 1, "queued delete should send one durable cancel tombstone");
        assertEqual(cancelCalls[0].ids.includes(queued.clientMessageIds[0]), true, "durable cancel should carry the queued clientMessageId");
        assertEqual(remaining.length, 2, "deleting should keep the queued prompt visible until the runtime confirms the outcome");
        assertEqual(remaining.find((item) => item.id === queued.id)?.phase, "cancelling", "the deleted queued prompt should move to cancelling");
        assertEqual(state.ui.promptEdit, null, "after deleting, selection should return to the new prompt");
        assertEqual(state.ui.prompt, "live draft", "after deleting, the live draft should be restored");
    });

    it("acknowledges a queued outbox item by clientMessageId when the durable user.message arrives", async () => {
        const { controller, store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "ack-session",
                title: "Ack Session",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "ack-session" });

        const queued = controller.buildOutboxItem("durable prompt", "queued");
        controller.setSessionOutboxItems("ack-session", [queued]);

        // Simulate the durable user.message that the orchestration writes once
        // it consumes the prompt, including the clientMessageId end-to-end.
        controller.mergeSessionEvent("ack-session", {
            seq: 1,
            sessionId: "ack-session",
            eventType: "user.message",
            data: {
                content: "durable prompt",
                clientMessageIds: queued.clientMessageIds,
            },
            createdAt: new Date("2026-04-23T15:00:00.000Z"),
        });

        const outbox = store.getState().outbox.bySessionId["ack-session"] || [];
        assertEqual(outbox.length, 0, "the acknowledged queued item should be removed from the outbox");
    });

    it("acknowledges a pending outbox item when user.message arrives before enqueue promotion", async () => {
        const { controller, store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "pending-ack-session",
                title: "Pending Ack Session",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "pending-ack-session" });

        const pending = controller.buildOutboxItem("fast ack prompt", "pending");
        controller.setSessionOutboxItems("pending-ack-session", [pending]);

        controller.mergeSessionEvent("pending-ack-session", {
            seq: 1,
            sessionId: "pending-ack-session",
            eventType: "user.message",
            data: {
                content: "fast ack prompt",
                clientMessageIds: pending.clientMessageIds,
            },
            createdAt: new Date("2026-04-23T15:00:00.000Z"),
        });

        const outbox = store.getState().outbox.bySessionId["pending-ack-session"] || [];
        assertEqual(outbox.length, 0, "durable user.message should remove a still-pending optimistic outbox item");
    });

    it("removes a cancelling outbox item when the runtime confirms cancellation", async () => {
        const { controller, store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "cancel-ack-session",
                title: "Cancel Ack Session",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "cancel-ack-session" });

        const cancelling = controller.buildOutboxItem("cancel me", "cancelling");
        const queued = controller.buildOutboxItem("keep me", "queued");
        controller.setSessionOutboxItems("cancel-ack-session", [cancelling, queued]);

        controller.mergeSessionEvent("cancel-ack-session", {
            seq: 1,
            sessionId: "cancel-ack-session",
            eventType: "pending_messages.cancelled",
            data: {
                clientMessageIds: cancelling.clientMessageIds,
            },
            createdAt: new Date("2026-04-23T15:00:00.000Z"),
        });

        const outbox = store.getState().outbox.bySessionId["cancel-ack-session"] || [];
        assertEqual(outbox.length, 1, "runtime cancellation confirmation should remove only the cancelling item");
        assertEqual(outbox[0]?.id, queued.id, "unrelated queued item should remain visible");
    });

    it("shows a working status in the chat header while the session is running", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "working-session",
                title: "Working Session",
                status: "running",
                createdAt: 1,
                updatedAt: 20,
            }],
        });
        store.dispatch({
            type: "history/set",
            sessionId: "working-session",
            history: {
                chat: [{
                    id: "user:1",
                    role: "user",
                    text: "Give me the status",
                    time: "",
                    createdAt: 2,
                }],
                activity: [{
                    id: "working-session:activity:1",
                    eventType: "report_intent",
                    seq: 5,
                    createdAt: 10,
                    text: "[10:43:43] [report_intent] Moody is collecting the evidence bundle for 18 items",
                    line: [{ text: "[10:43:43] [report_intent] Moody is collecting the evidence bundle for 18 items", color: "white" }],
                }],
                events: [],
            },
        });

        const chat = selectActiveChat(store.getState());
        assertEqual(chat.length, 1, "running sessions should keep the visible chat transcript unchanged while work is in flight");
        assertEqual(chat[0]?.role, "user", "running sessions should still show the last visible user message in chat");

        const chrome = selectChatPaneChrome(store.getState());
        const chromeTitle = chrome.title.map((run) => run.text).join("");
        const chromeRight = (chrome.titleRight || []).map((run) => run.text).join("");
        assertEqual(chromeTitle.includes("[working]"), false, "chat chrome should no longer append the live status to the main title text");
        assertIncludes(chromeRight, "Working", "chat chrome should show a working status on the right side while recent activity is still in flight");
    });

    it("renders owner initials and unowned markers only in session-list titles", () => {
        const { store } = createController();

        store.dispatch({
            type: "auth/context",
            principal: {
                provider: "test",
                subject: "user-1",
                email: "affan@example.com",
                displayName: "Affan Dar",
            },
        });
        // Owner chips surface only in a genuine multi-user context (more than
        // one distinct human owner); a second owner turns decoration on.
        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "owned-session",
                    title: "Owned Work",
                    status: "idle",
                    createdAt: 1,
                    updatedAt: 2,
                    owner: {
                        provider: "test",
                        subject: "user-1",
                        email: "affan@example.com",
                        displayName: "Affan Dar",
                    },
                },
                {
                    sessionId: "other-owned-session",
                    title: "Other Work",
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 4,
                    owner: {
                        provider: "test",
                        subject: "user-2",
                        email: "bianca@example.com",
                        displayName: "Bianca Kim",
                    },
                },
                {
                    sessionId: "legacy-session",
                    title: "Legacy Work",
                    status: "idle",
                    createdAt: 5,
                    updatedAt: 6,
                },
            ],
        });

        const rows = selectVisibleSessionRows(store.getState(), 8);
        const renderedRows = rows.map((row) => row.runs.map((run) => run.text).join(""));
        assert(renderedRows.some((row) => row.includes("[ad] Owned Work")), "owned row should include the bracketed owner badge");
        assert(renderedRows.some((row) => row.includes("[?] Legacy Work")), "unowned row should include the [?] owner marker");

        store.dispatch({ type: "sessions/selected", sessionId: "owned-session" });
        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");
        assert(!chromeTitle.includes("[ad]"), "chat header should not include the owner prefix");
    });

    it("renders owner prefixes in the session list without auth context when owner metadata exists", () => {
        const { store } = createController();

        // Two distinct owners in the metadata alone (no auth principal) is a
        // multi-user context, so owner chips render off the metadata.
        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "owned-session",
                    title: "Owned Work",
                    status: "idle",
                    createdAt: 1,
                    updatedAt: 2,
                    owner: {
                        provider: "test",
                        subject: "user-1",
                        email: "affan@example.com",
                        displayName: "Affan Dar",
                    },
                },
                {
                    sessionId: "other-owned-session",
                    title: "Other Work",
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 4,
                    owner: {
                        provider: "test",
                        subject: "user-2",
                        email: "bianca@example.com",
                        displayName: "Bianca Kim",
                    },
                },
                {
                    sessionId: "legacy-session",
                    title: "Legacy Work",
                    status: "idle",
                    createdAt: 5,
                    updatedAt: 6,
                },
            ],
        });

        const renderedRows = selectVisibleSessionRows(store.getState(), 8)
            .map((row) => row.runs.map((run) => run.text).join(""));
        assert(renderedRows.some((row) => row.includes("[ad] Owned Work")), "owner metadata alone should enable owner initials in the session list");
        assert(renderedRows.some((row) => row.includes("[?] Legacy Work")), "owner metadata should also mark unowned rows in the session list");
    });

    it("renders group rows and idle rows without reintroducing status dots", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "group:group-1",
                    groupId: "group-1",
                    title: "Release Group",
                    isGroup: true,
                    memberCount: 1,
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "owned-session",
                    title: "Owned Work",
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 4,
                    owner: {
                        provider: "test",
                        subject: "user-1",
                        email: "affan@example.com",
                        displayName: "Affan Dar",
                    },
                },
                {
                    sessionId: "idle-session",
                    title: "Idle Work",
                    status: "idle",
                    createdAt: 5,
                    updatedAt: 6,
                },
            ],
        });

        const renderedRows = selectVisibleSessionRows(store.getState(), 8)
            .map((row) => row.runs.map((run) => run.text).join(""));
        const groupRow = renderedRows.find((row) => row.includes("Release Group")) || "";
        const idleRow = renderedRows.find((row) => row.includes("Idle Work")) || "";
        assertIncludes(groupRow, "🗂  Release Group", "group row should show the group badge");
        // Single-owner list → owner decoration stays off, so no owner chip on
        // any row (group rows never carry one regardless).
        assertEqual(groupRow.includes(" · Release Group"), false, "single-owner list should not decorate group rows with an owner chip");
        assertEqual(idleRow.includes(". Idle Work"), false, "idle rows should not render a dot status glyph");
    });

    it("orders pinned groups, pinned sessions, and unpinned groups in the shared session tree", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "loose-a",
                    title: "Loose A",
                    status: "idle",
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    sessionId: "group:unpinned",
                    groupId: "unpinned",
                    title: "Unpinned Group",
                    isGroup: true,
                    memberCount: 0,
                    createdAt: 2,
                    updatedAt: 2,
                },
                {
                    sessionId: "pinned-session",
                    title: "Pinned Session",
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 3,
                },
                {
                    sessionId: "group:pinned",
                    groupId: "pinned",
                    title: "Pinned Group",
                    isGroup: true,
                    memberCount: 0,
                    createdAt: 4,
                    updatedAt: 4,
                },
                {
                    sessionId: "loose-b",
                    title: "Loose B",
                    status: "idle",
                    createdAt: 5,
                    updatedAt: 5,
                },
                {
                    sessionId: "system-session",
                    title: "PilotSwarm",
                    status: "idle",
                    isSystem: true,
                    createdAt: 6,
                    updatedAt: 6,
                },
            ],
        });
        store.dispatch({ type: "sessions/pinToggle", sessionId: "pinned-session" });
        store.dispatch({ type: "sessions/pinToggle", sessionId: "group:pinned" });

        const rows = selectSessionRows(store.getState()).map((row) => row.sessionId);
        assertEqual(
            JSON.stringify(rows),
            JSON.stringify(["system-session", "group:pinned", "pinned-session", "group:unpinned", "loose-b", "loose-a"]),
            "session tree should rank system, pinned groups, pinned sessions, unpinned groups, then timestamp-seeded remaining sessions",
        );
    });

    it("removes stale group rows and clears group membership on full refresh", async () => {
        const { controller, store } = createController({
            listSessions: async () => [{
                sessionId: "moved-session",
                title: "Moved Session",
                status: "idle",
                createdAt: 3,
                updatedAt: 4,
            }],
            listSessionGroups: async () => [],
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                {
                    sessionId: "group:old-group",
                    groupId: "old-group",
                    title: "Old Group",
                    isGroup: true,
                    memberCount: 1,
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "moved-session",
                    title: "Moved Session",
                    status: "idle",
                    groupId: "old-group",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "group:old-group" });

        await controller.refreshSessions();

        const state = store.getState();
        assertEqual(state.sessions.byId["group:old-group"], undefined, "missing group rows should not survive full refresh");
        assertEqual(state.sessions.byId["moved-session"].groupId, null, "full refresh should clear stale groupId values");
        assertEqual(state.sessions.activeSessionId, "moved-session", "selection should move from removed group to visible session");
        const renderedRows = selectVisibleSessionRows(state, 8).map((row) => row.runs.map((run) => run.text).join(""));
        assertEqual(renderedRows.some((row) => row.includes("Old Group")), false, "removed group should disappear from visible rows");
        assertEqual(renderedRows.some((row) => row.startsWith("└")), false, "ungrouped session should no longer render as a group child");
    });

    it("uses live member counts for group summaries", async () => {
        const { controller, store } = createController({
            listSessions: async () => [
                { sessionId: "session-a", title: "Session A", status: "idle", groupId: "group-1", createdAt: 1, updatedAt: 2 },
                { sessionId: "session-b", title: "Session B", status: "idle", groupId: "group-1", createdAt: 3, updatedAt: 4 },
            ],
            listSessionGroups: async () => [{
                groupId: "group-1",
                title: "Release Group",
                description: "1 grouped session",
                memberCount: 2,
                runningCount: 2,
                waitingCount: 0,
                completedCount: 0,
                failedCount: 0,
                cancelledCount: 0,
                createdAt: 1,
                updatedAt: 2,
            }],
        });

        await controller.refreshSessions();

        const group = store.getState().sessions.byId["group:group-1"];
        assertEqual(group.shortSummary, "2 grouped sessions", "group summary should use the latest aggregate count");
    });

    it("advertises Ctrl+G move-to-group in sessions-pane status hints", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [
                { sessionId: "session-a", title: "Session A", status: "idle", createdAt: 1, updatedAt: 2 },
                { sessionId: "session-b", title: "Session B", status: "idle", createdAt: 3, updatedAt: 4 },
            ],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "session-a" });
        store.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.SESSIONS });

        let status = selectStatusBar(store.getState());
        assertIncludes(status.right, "ctrl-g move group", "sessions status hint should advertise move-to-group");

        store.dispatch({ type: "sessions/selectSet", sessionIds: ["session-a", "session-b"] });
        status = selectStatusBar(store.getState());
        assertIncludes(status.right, "ctrl-g group", "select-mode status hint should advertise moving selected sessions");
        assertIncludes(status.right, "D hard delete", "select-mode status hint should advertise bulk hard delete");
    });

    it("defaults session owner filtering to system, me, and shared and exposes unowned as a separate entry", async () => {
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        const otherOwner = {
            provider: "test",
            subject: "other",
            email: "other@example.com",
            displayName: "Other User",
        };
        const { controller, store } = createController({
            getAuthContext: () => ({
                principal: owner,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            }),
            listSessions: async () => [
                {
                    sessionId: "system-session",
                    title: "System",
                    isSystem: true,
                    status: "idle",
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "mine-session",
                    title: "Mine",
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 4,
                    owner,
                },
                {
                    sessionId: "other-session",
                    title: "Other",
                    status: "idle",
                    createdAt: 5,
                    updatedAt: 6,
                    owner: otherOwner,
                },
                {
                    sessionId: "unowned-session",
                    title: "Unowned",
                    status: "idle",
                    createdAt: 7,
                    updatedAt: 8,
                },
            ],
        });

        try {
            await controller.start();

            const defaultRows = selectSessionRows(store.getState()).map((row) => row.sessionId);
            assert(defaultRows.includes("system-session"), "default filter should include system sessions");
            assert(defaultRows.includes("mine-session"), "default filter should include current user's sessions");
            assert(defaultRows.includes("other-session"), "default filter should include foreign shared sessions");
            assert(!defaultRows.includes("unowned-session"), "default filter should exclude unowned sessions");

            controller.openSessionOwnerFilter();
            const modal = selectSessionOwnerFilterModal(store.getState());
            const modalText = modal.rows.map((row) => row.map((run) => run.text).join("")).join("\n");
            assertIncludes(modalText, "Unowned", "filter modal should expose an explicit unowned entry");
            assert(modal.rows[0]?.some((run) => run?.backgroundColor === "activeHighlightBackground"), "selected filter row should carry the shared active highlight background");

            const detailsText = modal.detailsLines.map((row) => row.map((run) => run.text).join("")).join("\n");
            assertIncludes(detailsText, "Space", "filter modal help should advertise Space for toggling");
            assertEqual(detailsText.includes("Enter"), false, "filter modal help should no longer advertise Enter");

            const unownedIndex = store.getState().ui.modal.items.findIndex((item) => item.kind === "unowned");
            controller.toggleSessionOwnerFilter(unownedIndex);

            const expandedRows = selectSessionRows(store.getState()).map((row) => row.sessionId);
            assert(expandedRows.includes("unowned-session"), "toggling unowned should include unowned sessions");
        } finally {
            await controller.stop();
        }
    });

    it("includes owned session groups in session owner filtering", async () => {
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        const otherOwner = {
            provider: "test",
            subject: "other",
            email: "other@example.com",
            displayName: "Other User",
        };
        const { controller, store } = createController({
            getAuthContext: () => ({
                principal: owner,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            }),
            listSessions: async () => [
                {
                    sessionId: "legacy-member",
                    title: "Legacy Member",
                    status: "idle",
                    viewerGroupId: "legacy-group",
                    owner,
                    createdAt: 7,
                    updatedAt: 8,
                },
            ],
            listSessionGroups: async () => [
                { groupId: "mine-group", title: "Mine Group", owner, memberCount: 0, createdAt: 1, updatedAt: 2 },
                { groupId: "other-group", title: "Other Group", owner: otherOwner, memberCount: 0, createdAt: 3, updatedAt: 4 },
                { groupId: "unowned-group", title: "Unowned Group", memberCount: 0, createdAt: 5, updatedAt: 6 },
                { groupId: "legacy-group", title: "Legacy Group", memberCount: 1, createdAt: 7, updatedAt: 8 },
            ],
        });

        try {
            await controller.start();

            const rows = selectSessionRows(store.getState()).map((row) => row.sessionId);
            assert(rows.includes("group:mine-group"), "default owner filter should include current user's groups");
            assert(rows.includes("group:legacy-group"), "default owner filter should include groups with current-user members");
            assert(rows.includes("group:other-group"), "default owner filter now surfaces foreign-owned groups via includeShared");
            assert(!rows.includes("group:unowned-group"), "default owner filter should exclude unowned groups");

            const rowText = selectSessionRows(store.getState())
                .filter((row) => row.sessionId === "group:mine-group" || row.sessionId === "group:legacy-group")
                .map((row) => row.text)
                .join("\n");
            // Group rows render by title in the dense list (member count + age
            // in the meta column); they no longer carry an owner-initials chip.
            assertIncludes(rowText, "Mine Group", "the current user's owned group should render in the list");
            assertIncludes(rowText, "Legacy Group", "a group with current-user members should render in the list");

            controller.openSessionOwnerFilter();
            const modalText = selectSessionOwnerFilterModal(store.getState()).rows
                .map((row) => row.map((run) => run.text).join(""))
                .join("\n");
            assertIncludes(modalText, "Other User", "filter modal should discover owners from group rows");
        } finally {
            await controller.stop();
        }
    });

    it("renders unowned spawned children under a visible parent when their direct owner would be filtered out", async () => {
        // Repro: a system parent (e.g. Facts Manager) spawns a non-system
        // child whose CMS owner is NULL. The owner filter has
        // includeUnowned=false so the child would be hidden directly, but
        // its parent passes includeSystem=true. The child must still
        // render (otherwise the tree silently drops it and the parent
        // shows a [+1] hidden-descendant badge instead — which was the
        // reported bug).
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        const { controller, store } = createController({
            getAuthContext: () => ({
                principal: owner,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            }),
            listSessions: async () => [
                {
                    sessionId: "facts-manager",
                    title: "Facts Manager",
                    isSystem: true,
                    status: "idle",
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    sessionId: "spawned-sherlock",
                    title: "HDB Engineer",
                    parentSessionId: "facts-manager",
                    status: "running",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });

        try {
            await controller.start();
            // Newly-discovered parents are auto-collapsed on first refresh,
            // which would hide the child from the flat list before the
            // owner filter even runs. Expand it to mirror the user's view.
            store.dispatch({ type: "sessions/expand", sessionId: "facts-manager" });
            const rows = selectSessionRows(store.getState()).map((row) => row.sessionId);
            assert(rows.includes("facts-manager"), "system parent should be visible");
            assert(rows.includes("spawned-sherlock"), "unowned child of a visible system parent should also be visible");
        } finally {
            await controller.stop();
        }
    });

    it("applies user profile settings to theme pins filters and layout", () => {
        const { store } = createController();

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "profile-pin-session",
                title: "Pinned From Profile",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({
            type: "profileSettings/apply",
            settings: {
                themeId: "dracula",
                sessionOwnerFilter: {
                    all: false,
                    includeSystem: true,
                    includeUnowned: true,
                    includeMe: false,
                    ownerKeys: ["test:owner"],
                },
                layoutAdjustments: {
                    paneAdjust: 3,
                    sessionPaneAdjust: -2,
                    activityPaneAdjust: 4,
                },
                pinnedSessionIds: ["profile-pin-session"],
            },
        });

        const state = store.getState();
        assertEqual(state.ui.themeId, "dracula", "profile settings should hydrate the theme");
        assertEqual(state.ui.layout.paneAdjust, 3, "profile settings should hydrate the pane split");
        assertEqual(state.ui.layout.sessionPaneAdjust, -2, "profile settings should hydrate the session/chat split");
        assertEqual(state.ui.layout.activityPaneAdjust, 4, "profile settings should hydrate the activity split");
        assertEqual(state.sessions.ownerFilter.includeUnowned, true, "profile settings should hydrate the session owner filter");
        assertEqual(state.sessions.pinnedIds.includes("profile-pin-session"), true, "profile settings should hydrate pinned session ids");
        const rows = selectSessionRows(state);
        assertIncludes(rows[0]?.text || "", "Pinned From Profile", "pinned session should remain visible after hydration");
    });

    it("opens the model picker even when the current user has no per-user GitHub Copilot key", async () => {
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        const { controller, store } = createController({
            getAuthContext: () => ({
                principal: owner,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            }),
            listModels: async () => [
                { qualifiedName: "github-copilot:gpt-5.5", providerId: "github-copilot", providerType: "github", modelName: "gpt-5.5" },
                { qualifiedName: "azure-openai:gpt-5.4-mini", providerId: "azure-openai", providerType: "openai", modelName: "gpt-5.4-mini" },
            ],
            getModelsByProvider: () => [
                {
                    providerId: "github-copilot",
                    type: "github",
                    models: [{ qualifiedName: "github-copilot:gpt-5.5", providerId: "github-copilot", providerType: "github", modelName: "gpt-5.5" }],
                },
                {
                    providerId: "azure-openai",
                    type: "openai",
                    models: [{ qualifiedName: "azure-openai:gpt-5.4-mini", providerId: "azure-openai", providerType: "openai", modelName: "gpt-5.4-mini" }],
                },
            ],
            getCurrentUserProfile: async () => ({
                provider: owner.provider,
                subject: owner.subject,
                email: owner.email,
                displayName: owner.displayName,
                profileSettings: {},
                githubCopilotKeySet: false,
            }),
        });

        try {
            await controller.start();
            await controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER);
            assertEqual(store.getState().admin.visible, false, "Model picker should not redirect to Admin just because the per-user key is unset");
            assertEqual(store.getState().ui.modal?.type, "modelPicker", "Model picker should still open");
            const modelIds = store.getState().ui.modal.items.map((item) => item.qualifiedName).join("\n");
            assertIncludes(modelIds, "github-copilot:gpt-5.5", "GitHub models should still be visible");
            assertIncludes(modelIds, "azure-openai:gpt-5.4-mini", "Non-GitHub models should still be visible");
        } finally {
            await controller.stop();
        }
    });

    it("lets the user choose reasoning effort after model selection", async () => {
        let created = false;
        let createOptions = null;
        const { controller, store } = createController({
            listSessions: async () => created
                ? [{ sessionId: "reasoning-session", status: "idle", createdAt: 1, updatedAt: 2 }]
                : [],
            listModels: async () => [
                {
                    qualifiedName: "github-copilot:gpt-5.5",
                    providerId: "github-copilot",
                    providerType: "github",
                    modelName: "gpt-5.5",
                    supportedReasoningEfforts: ["medium", "xhigh"],
                    defaultReasoningEffort: "medium",
                },
            ],
            getModelsByProvider: () => [
                {
                    providerId: "github-copilot",
                    type: "github",
                    models: [
                        {
                            qualifiedName: "github-copilot:gpt-5.5",
                            providerId: "github-copilot",
                            providerType: "github",
                            modelName: "gpt-5.5",
                            supportedReasoningEfforts: ["medium", "xhigh"],
                            defaultReasoningEffort: "medium",
                        },
                    ],
                },
            ],
            createSession: async (options) => {
                createOptions = options;
                created = true;
                return { sessionId: "reasoning-session" };
            },
            getSession: async () => ({ sessionId: "reasoning-session", status: "idle", createdAt: 1, updatedAt: 2 }),
        });

        try {
            await controller.start();
            await controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER);
            const modelPicker = selectModelPickerModal(store.getState());
            assertIncludes(
                JSON.stringify(modelPicker.detailsLines),
                "Default reasoning: medium",
                "model details should show the configured default reasoning effort",
            );

            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "reasoningEffortPicker", "model selection should open reasoning picker");
            const reasoningPicker = selectReasoningEffortPickerModal(store.getState());
            assertIncludes(JSON.stringify(reasoningPicker.rows), "xhigh", "reasoning picker should expose xhigh");

            store.dispatch({ type: "ui/modalSelection", index: 1 });
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);

            assertEqual(createOptions?.model, "github-copilot:gpt-5.5", "created session should use selected model");
            assertEqual(createOptions?.reasoningEffort, "xhigh", "created session should use selected reasoning effort");
            assertEqual(store.getState().sessions.activeSessionId, "reasoning-session");
        } finally {
            await controller.stop();
        }
    });

    it("uses the model default reasoning effort when accepted", async () => {
        let created = false;
        let createOptions = null;
        const { controller, store } = createController({
            listSessions: async () => created
                ? [{ sessionId: "default-reasoning-session", status: "idle", createdAt: 1, updatedAt: 2 }]
                : [],
            listModels: async () => [
                {
                    qualifiedName: "github-copilot:gpt-5.5",
                    providerId: "github-copilot",
                    providerType: "github",
                    modelName: "gpt-5.5",
                    supportedReasoningEfforts: ["medium", "xhigh"],
                    defaultReasoningEffort: "medium",
                },
            ],
            getModelsByProvider: () => [
                {
                    providerId: "github-copilot",
                    type: "github",
                    models: [
                        {
                            qualifiedName: "github-copilot:gpt-5.5",
                            providerId: "github-copilot",
                            providerType: "github",
                            modelName: "gpt-5.5",
                            supportedReasoningEfforts: ["medium", "xhigh"],
                            defaultReasoningEffort: "medium",
                        },
                    ],
                },
            ],
            createSession: async (options) => {
                createOptions = options;
                created = true;
                return { sessionId: "default-reasoning-session" };
            },
            getSession: async () => ({ sessionId: "default-reasoning-session", status: "idle", createdAt: 1, updatedAt: 2 }),
        });

        try {
            await controller.start();
            await controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER);
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "reasoningEffortPicker", "model selection should open reasoning picker");
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);

            assertEqual(createOptions?.model, "github-copilot:gpt-5.5", "created session should use selected model");
            assertEqual(createOptions?.reasoningEffort, "medium", "created session should use the selected default reasoning effort");
            assertEqual(store.getState().sessions.activeSessionId, "default-reasoning-session");
        } finally {
            await controller.stop();
        }
    });

    it("allows UX session creation without a per-user key when the selected provider can create", async () => {
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        let createCalls = 0;
        let created = false;
        const { controller, store } = createController({
            getAuthContext: () => ({
                principal: owner,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            }),
            listSessions: async () => created
                ? [{ sessionId: "created-session", status: "idle", createdAt: 1, updatedAt: 2 }]
                : [],
            getCurrentUserProfile: async () => ({
                provider: owner.provider,
                subject: owner.subject,
                email: owner.email,
                displayName: owner.displayName,
                profileSettings: {},
                githubCopilotKeySet: false,
            }),
            createSession: async () => {
                createCalls += 1;
                created = true;
                return { sessionId: "created-session" };
            },
            getSession: async () => ({ sessionId: "created-session", status: "idle", createdAt: 1, updatedAt: 2 }),
        });

        try {
            await controller.start();
            await controller.createSession({ model: "azure-openai:gpt-5.4-mini" });
            assertEqual(createCalls, 1, "Non-GitHub session creation should proceed without a per-user GitHub key");
            assertEqual(store.getState().sessions.activeSessionId, "created-session");
            assertEqual(store.getState().admin.visible, false, "Successful non-GitHub create should not open Admin");
        } finally {
            await controller.stop();
        }
    });

    it("surfaces GitHub provider create failures without redirecting to Admin", async () => {
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        let createCalls = 0;
        const { controller, store } = createController({
            getAuthContext: () => ({
                principal: owner,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            }),
            getCurrentUserProfile: async () => ({
                provider: owner.provider,
                subject: owner.subject,
                email: owner.email,
                displayName: owner.displayName,
                profileSettings: {},
                githubCopilotKeySet: false,
            }),
            createSession: async () => {
                createCalls += 1;
                throw new Error("GitHub Copilot key not configured");
            },
        });

        try {
            await controller.start();
            const created = await controller.createSession({ model: "github-copilot:gpt-5.5" });
            assertEqual(created, null, "failed GitHub session creation should return null to the UI layer");
            assertEqual(createCalls, 1, "GitHub model creation should be attempted and fail at create time");
            assertEqual(store.getState().admin.visible, false, "GitHub create failure should not force Admin open");
            assertIncludes(store.getState().ui.statusText, "GitHub Copilot key not configured", "status should show the provider-specific failure");
        } finally {
            await controller.stop();
        }
    });

    it("transport only rejects GitHub provider models when no env or per-user key exists", async () => {
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        const fakeTransport = {
            currentUser: owner,
            mgmt: {
                getDefaultModel: () => "azure-openai:gpt-5.4-mini",
                getModelCredentialStatus: (model) => model?.startsWith("github-copilot:")
                    ? { qualifiedName: model, providerType: "github", credentialAvailable: false }
                    : { qualifiedName: model, providerType: "openai", credentialAvailable: true },
                getUserProfile: async () => ({ ...owner, githubCopilotKeySet: false }),
            },
        };

        await assertThrows(
            () => NodeSdkTransport.prototype.assertSessionModelCreatable.call(fakeTransport, { model: "github-copilot:gpt-5.5", owner }),
            /GitHub Copilot key not configured/,
            "GitHub model without env or user key should fail at create time",
        );

        const azureModel = await NodeSdkTransport.prototype.assertSessionModelCreatable.call(fakeTransport, {
            model: "azure-openai:gpt-5.4-mini",
            owner,
        });
        assertEqual(azureModel, "azure-openai:gpt-5.4-mini", "non-GitHub provider should remain creatable");

        fakeTransport.mgmt.getModelCredentialStatus = (model) => ({ qualifiedName: model, providerType: "github", credentialAvailable: true });
        const githubWithEnv = await NodeSdkTransport.prototype.assertSessionModelCreatable.call(fakeTransport, {
            model: "github-copilot:gpt-5.5",
            owner,
        });
        assertEqual(githubWithEnv, "github-copilot:gpt-5.5", "GitHub provider should be creatable when env credential is available");

        fakeTransport.mgmt.getModelCredentialStatus = (model) => ({ qualifiedName: model, providerType: "github", credentialAvailable: false });
        fakeTransport.mgmt.getUserProfile = async () => ({ ...owner, githubCopilotKeySet: true });
        const githubWithUserKey = await NodeSdkTransport.prototype.assertSessionModelCreatable.call(fakeTransport, {
            model: "github-copilot:gpt-5.5",
            owner,
        });
        assertEqual(githubWithUserKey, "github-copilot:gpt-5.5", "GitHub provider should be creatable when the user key is set");
    });

    it("preserves a restored owner filter across startup when auth is enabled", async () => {
        const owner = {
            provider: "test",
            subject: "me",
            email: "me@example.com",
            displayName: "Me User",
        };
        const { controller, store } = createController({
            getAuthContext: () => ({
                principal: owner,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            }),
            listSessions: async () => [],
        }, {
            sessionOwnerFilter: {
                all: true,
                includeSystem: false,
                includeUnowned: false,
                includeMe: false,
                ownerKeys: [],
            },
        });

        try {
            await controller.start();

            const filter = store.getState().sessions.ownerFilter;
            assertEqual(filter.all, true, "startup should preserve an explicit restored All filter");
            assertEqual(filter.includeSystem, false, "startup should not overwrite restored filter selections");
            assertEqual(filter.includeMe, false, "startup should not force the auth-based default when a filter was restored");
        } finally {
            await controller.stop();
        }
    });

    it("cycles stats sub-tabs through session, fleet, and users with user resource totals", () => {
        const { controller, store } = createController();
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "stats-session",
                title: "Stats Session",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "stats-session" });
        store.dispatch({
            type: "fleetStats/loaded",
            data: { totals: { sessionCount: 1 }, byAgent: [], windowStart: null, earliestSessionCreatedAt: null },
            userStats: {
                windowStart: null,
                earliestSessionCreatedAt: null,
                totals: {
                    sessionCount: 2,
                    totalTokensInput: 3000,
                    totalTokensOutput: 750,
                    totalTokensCacheRead: 1500,
                    totalTokensCacheWrite: 200,
                    totalSnapshotSizeBytes: 4096,
                    totalOrchestrationHistorySizeBytes: 8192,
                    cacheHitRatio: 0.5,
                },
                users: [{
                    ownerKind: "user",
                    owner: {
                        provider: "test",
                        subject: "owner",
                        email: "owner@example.com",
                        displayName: "Owner User",
                    },
                    sessionIds: ["stats-session"],
                    sessionCount: 1,
                    totalTokensInput: 3000,
                    totalTokensOutput: 750,
                    totalTokensCacheRead: 1500,
                    totalTokensCacheWrite: 200,
                    totalSnapshotSizeBytes: 4096,
                    totalOrchestrationHistorySizeBytes: 8192,
                    cacheHitRatio: 0.5,
                    byModel: [{
                        model: "model-a",
                        sessionIds: ["stats-session"],
                        sessionCount: 1,
                        totalTokensInput: 3000,
                        totalTokensOutput: 750,
                        totalTokensCacheRead: 1500,
                        totalTokensCacheWrite: 200,
                        totalSnapshotSizeBytes: 4096,
                        totalOrchestrationHistorySizeBytes: 8192,
                        cacheHitRatio: 0.5,
                    }],
                }],
            },
            skillUsage: null,
            sharedFactsStats: null,
        });

        store.dispatch({ type: "ui/inspectorTab", inspectorTab: "stats" });
        controller.toggleStatsView();
        assertEqual(store.getState().ui.statsViewMode, "fleet", "first stats toggle should switch to fleet");
        controller.toggleStatsView();
        assertEqual(store.getState().ui.statsViewMode, "users", "second stats toggle should switch to users");

        const inspector = selectInspector(store.getState(), { width: 72 });
        const text = linesText(inspector.lines);
        assertIncludes(text, "[users]", "users stats sub-tab should be selected");
        assertIncludes(text, "OWNER USER <OWNER@EXAMPLE.COM>", "users stats should render owner identity");
        assertIncludes(text, "model-a", "users stats should render model breakdown");
        assertIncludes(text, "Orch Size", "users stats should include orchestration size");
        assertIncludes(text, "Snapshots", "users stats should include snapshot size");
    });

    it("keeps existing users stats visible while a refresh is in flight", () => {
        const { store } = createController();
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "stats-session",
                title: "Stats Session",
                status: "idle",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "stats-session" });
        store.dispatch({
            type: "fleetStats/loaded",
            data: { totals: { sessionCount: 1 }, byAgent: [], windowStart: null, earliestSessionCreatedAt: null },
            userStats: {
                windowStart: null,
                earliestSessionCreatedAt: null,
                totals: {
                    sessionCount: 1,
                    totalTokensInput: 120,
                    totalTokensOutput: 30,
                    totalTokensCacheRead: 60,
                    totalTokensCacheWrite: 10,
                    totalSnapshotSizeBytes: 1024,
                    totalOrchestrationHistorySizeBytes: 2048,
                    cacheHitRatio: 0.5,
                },
                users: [{
                    ownerKind: "user",
                    owner: {
                        provider: "test",
                        subject: "owner",
                        email: "owner@example.com",
                        displayName: "Owner User",
                    },
                    sessionIds: ["stats-session"],
                    sessionCount: 1,
                    totalTokensInput: 120,
                    totalTokensOutput: 30,
                    totalTokensCacheRead: 60,
                    totalTokensCacheWrite: 10,
                    totalSnapshotSizeBytes: 1024,
                    totalOrchestrationHistorySizeBytes: 2048,
                    cacheHitRatio: 0.5,
                    byModel: [],
                }],
            },
            skillUsage: null,
            sharedFactsStats: null,
        });
        store.dispatch({ type: "ui/inspectorTab", inspectorTab: "stats" });
        store.dispatch({ type: "ui/statsViewMode", statsViewMode: "users" });
        store.dispatch({ type: "fleetStats/loading" });

        const inspector = selectInspector(store.getState(), { width: 72 });
        const text = linesText(inspector.lines);
        assertIncludes(text, "OWNER USER <OWNER@EXAMPLE.COM>", "users stats should stay visible while a refresh is in flight");
        assertIncludes(text, "Orch Size", "users stats cards should remain rendered while loading");
        assertEqual(text.includes("Loading user stats..."), false, "refreshing users stats should not blank the pane");
    });

    it("keeps existing session stats visible while a refresh is in flight", () => {
        const { store } = createController();
        const createdAt = new Date("2026-04-09T10:00:00.000Z");
        const updatedAt = new Date("2026-04-09T10:05:30.000Z");
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "stats-session",
                title: "Stats Session",
                status: "idle",
                createdAt,
                updatedAt,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "stats-session" });
        store.dispatch({
            type: "sessionStats/loaded",
            sessionId: "stats-session",
            summary: {
                agentId: "watcher",
                model: "gpt-5.4",
                tokensInput: 120,
                tokensOutput: 30,
                tokensCacheRead: 60,
                tokensCacheWrite: 10,
                cacheHitRatio: 0.5,
                snapshotSizeBytes: 1024,
                dehydrationCount: 1,
                hydrationCount: 2,
                lossyHandoffCount: 0,
                lastDehydratedAt: null,
                lastHydratedAt: null,
            },
            treeStats: null,
            skillUsage: null,
            treeSkillUsage: null,
            factsStats: null,
            treeFactsStats: null,
        });
        store.dispatch({ type: "ui/inspectorTab", inspectorTab: "stats" });
        store.dispatch({ type: "ui/statsViewMode", statsViewMode: "session" });
        store.dispatch({ type: "sessionStats/loading", sessionId: "stats-session" });

        const inspector = selectInspector(store.getState(), { width: 72 });
        const text = linesText(inspector.lines);
        assertIncludes(text, "watcher", "session stats should stay visible while a refresh is in flight");
        assertIncludes(text, "Created", "session stats should include created time");
        assertIncludes(text, "Updated", "session stats should include updated time");
        assertIncludes(text, createdAt.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }), "session stats should format created time in client timezone");
        assertIncludes(text, updatedAt.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }), "session stats should format updated time in client timezone");
        assertIncludes(text, "TOKENS", "session stats cards should remain rendered while loading");
        assertEqual(text.includes("Loading session stats..."), false, "refreshing session stats should not blank the pane");
    });

    it("renders sub-agent responses as one expandable system notice line", () => {
        const { store } = createController();
        const sessionId = "sub-agent-response-session";
        const createdAt = new Date("2026-04-09T10:00:00.000Z");
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId,
                title: "Sub-agent Response Session",
                status: "idle",
                createdAt,
                updatedAt: createdAt,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId });
        store.dispatch({
            type: "history/set",
            sessionId,
            history: buildHistoryModel([{
                seq: 1,
                sessionId,
                eventType: "user.message",
                data: {
                    content:
                        "Sub-agent completed. Review the result and continue.\n" +
                        "  - Agent session-12345678-90ab-cdef-1234-567890abcdef\n" +
                        "    Task: \"Review PR 2069239\"\n" +
                        "    Status: completed\n" +
                        "    Result: Remove or downgrade recommendation item 4.",
                },
                createdAt,
            }]),
        });

        const lines = selectChatLines(store.getState(), 120);
        const notice = lines.find((line) => line?.kind === "systemNotice");
        assert(notice, "sub-agent response should render as a system notice line");
        assertIncludes(notice.text, "Sub-agent Response", "sub-agent response summary should name the notice");
        assertIncludes(notice.text, "completed", "sub-agent response summary should include status");
        assertIncludes(notice.body, "Review PR 2069239", "sub-agent response detail should preserve the task");
        assertIncludes(notice.body, "Remove or downgrade recommendation item 4", "sub-agent response detail should preserve the result");
        assertEqual(linesText(lines).includes("Remove or downgrade recommendation item 4"), false, "sub-agent response result should not be plastered into the main chat transcript");
    });

    it("keeps an answered pending question visible until durable history catches up", async () => {
        const sessionId = "answered-question-session";
        const pendingQuestion = {
            question: "Proceed with review pr 2069239?",
            choices: ["Go", "Cancel"],
            allowFreeform: true,
        };
        const sendAnswerCalls = [];
        let resolveAnswer;
        const answerAccepted = new Promise((resolve) => {
            resolveAnswer = resolve;
        });
        const { controller, store } = createController({
            sendAnswer: async (sentSessionId, answer) => {
                sendAnswerCalls.push({ sentSessionId, answer });
                await answerAccepted;
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId,
                title: "Answered Question Session",
                status: "input_required",
                createdAt: 1,
                updatedAt: 2,
                pendingQuestion,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId });
        controller.setPrompt("Go");

        const sendPromise = controller.sendPrompt();

        assertEqual(sendAnswerCalls.length, 1, "answer should be sent through sendAnswer");
        let session = store.getState().sessions.byId[sessionId];
        assertEqual(session.pendingQuestion, null, "answer should clear the local pending question while sending");
        assertEqual(session.answeredPendingQuestion.question, pendingQuestion.question, "answered marker should be visible immediately");
        assertEqual(session.answeredPendingQuestion.answer, "Go", "answered marker should carry the submitted answer");
        assertEqual(session.answeredPendingQuestion.pendingPhase, "pending", "in-flight answer should render as pending");
        let chatText = linesText(selectActiveChat(store.getState()));
        assertIncludes(chatText, pendingQuestion.question, "question should stay visible while answer submission is in flight");
        assertIncludes(chatText, "Go", "submitted answer should stay visible while answer submission is in flight");

        resolveAnswer();
        await sendPromise;

        session = store.getState().sessions.byId[sessionId];
        assertEqual(session.pendingQuestion, null, "answer should keep the local pending question cleared after acceptance");
        assertEqual(session.answeredPendingQuestion.pendingPhase, "queued", "accepted answer should render as queued until durable history arrives");
        chatText = linesText(selectActiveChat(store.getState()));
        assertIncludes(chatText, pendingQuestion.question, "question should stay visible after acceptance and before history sync");
        assertIncludes(chatText, "Go", "submitted answer should stay visible after acceptance and before history sync");

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId,
                title: "Answered Question Session",
                status: "input_required",
                createdAt: 1,
                updatedAt: 3,
                pendingQuestion,
            }],
        });

        session = store.getState().sessions.byId[sessionId];
        assertEqual(session.pendingQuestion, null, "stale refresh should not restore the answered question");
        assertEqual(session.answeredPendingQuestion.question, pendingQuestion.question, "answered question marker should be retained for stale-refresh suppression");
        chatText = linesText(selectActiveChat(store.getState()));
        assertIncludes(chatText, pendingQuestion.question, "stale refresh should not hide the submitted question/answer exchange");
        assertIncludes(chatText, "Go", "stale refresh should not hide the submitted answer");

        store.dispatch({
            type: "history/set",
            sessionId,
            history: buildHistoryModel([{
                seq: 1,
                sessionId,
                eventType: "user.message",
                data: {
                    content: `The user was asked: "${pendingQuestion.question}"\nThe user responded: "Go"`,
                },
                createdAt: new Date("2026-05-07T12:00:00.000Z"),
            }]),
        });

        const messagesWithQuestion = selectActiveChat(store.getState()).filter((message) => String(message?.text || "").includes(pendingQuestion.question));
        assertEqual(messagesWithQuestion.length, 1, "durable history should replace the optimistic answered question instead of duplicating it");
        assertEqual(messagesWithQuestion[0].optimistic, undefined, "remaining answered question should be the durable transcript message");
    });

    it("incrementally refreshes active chat from CMS when live subscription misses events", async () => {
        const sessionId = "session-active";
        const createdAt = new Date("2026-04-09T10:00:00.000Z");
        const afterSeqsSeen = [];
        const { controller, store } = createController({
            listSessions: async () => [{
                sessionId,
                title: "Active Session",
                status: "idle",
                createdAt,
                updatedAt: createdAt,
            }],
            getSession: async () => ({
                sessionId,
                title: "Active Session",
                status: "idle",
                createdAt,
                updatedAt: createdAt,
            }),
            getSessionEvents: async (_sessionId, afterSeq) => {
                afterSeqsSeen.push(afterSeq);
                return afterSeq === 1
                    ? [{
                        seq: 2,
                        sessionId,
                        eventType: "assistant.message",
                        data: { content: "The response arrived in CMS." },
                        createdAt,
                    }]
                    : [];
            },
        });

        store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId, title: "Active Session", status: "idle", createdAt, updatedAt: createdAt }] });
        store.dispatch({ type: "sessions/selected", sessionId });
        store.dispatch({
            type: "history/set",
            sessionId,
            history: {
                ...buildHistoryModel([{
                    seq: 1,
                    sessionId,
                    eventType: "user.message",
                    data: { content: "hello" },
                    createdAt,
                }]),
                lastSeq: 1,
            },
        });

        await controller.refreshSessions();

        assertEqual(
            afterSeqsSeen.includes(1),
            true,
            "active refresh should poll CMS after the latest loaded event",
        );
        assertEqual(
            selectActiveChat(store.getState()).some((message) => message.text === "The response arrived in CMS."),
            true,
            "active chat should include CMS events even when the subscription callback never fired",
        );
    });

    it("loads older CMS chat pages only after a second upward scroll at the top", async () => {
        const sessionId = "history-session";
        const createdAt = new Date("2026-04-09T10:00:00.000Z");
        const makeEvent = (seq, content) => ({
            seq,
            sessionId,
            eventType: "user.message",
            data: { content },
            createdAt,
        });
        const getBeforeCalls = [];
        const makeRange = (startSeq, count, label) => Array.from({ length: count }, (_, index) => {
            const seq = startSeq + index;
            return makeEvent(seq, `${label} ${seq}`);
        });
        const { controller, store } = createController({
            getSessionEventsBefore: async (_sessionId, beforeSeq, limit) => {
                getBeforeCalls.push({ beforeSeq, limit });
                if (beforeSeq === 1000) return makeRange(700, limit, "older page 1");
                if (beforeSeq === 700) return makeRange(400, limit, "older page 2");
                if (beforeSeq === 400) return makeRange(100, limit, "older page 3");
                return [];
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId,
                title: "History Session",
                status: "idle",
                createdAt,
                updatedAt: createdAt,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId });
        store.dispatch({ type: "ui/focus", focusRegion: FOCUS_REGIONS.CHAT });
        controller.setViewport({ width: 80, height: 18 });
        store.dispatch({
            type: "history/set",
            sessionId,
            history: {
                ...buildHistoryModel(Array.from({ length: 20 }, (_, index) => makeEvent(index + 1000, `recent ${index + 1000}`)), {
                    requestedLimit: 20,
                }),
                hasOlderEvents: true,
            },
        });

        const maxOffset = controller.getPaneMaxScrollOffset("chat");
        assertEqual(maxOffset > 0, true, "fixture should have enough chat to scroll");

        await controller.handleCommand(UI_COMMANDS.SCROLL_TOP);
        assertEqual(getBeforeCalls.length, 0, "jumping to the top should pause without loading older CMS events");

        await controller.handleCommand(UI_COMMANDS.SCROLL_UP);
        await (controller.sessionHistoryExpansionLoads.get(sessionId) || Promise.resolve());
        assertEqual(getBeforeCalls.length, 3, "pressing up again at the top should load a few older CMS pages");

        const chatText = linesText(selectActiveChat(store.getState()));
        assertIncludes(chatText, "older page 1 700", "older chat should be prepended from CMS");
        assertIncludes(chatText, "older page 3 399", "automatic top expansion should include multiple pages");
    });

    it("cancels a queued (durable) outbox item locally and through the transport", async () => {
        const cancelCalls = [];
        const { controller, store } = createController({
            cancelPendingMessage: async (sessionId, ids) => {
                cancelCalls.push({ sessionId, ids });
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "cancel-session",
                title: "Cancel Session",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "cancel-session" });

        const queued = controller.buildOutboxItem("durable prompt", "queued");
        controller.setSessionOutboxItems("cancel-session", [queued]);

        const ok = await controller.cancelOutboxItem("cancel-session", queued.id);
        assertEqual(ok, true, "cancelOutboxItem should succeed for a queued item");

        assertEqual(cancelCalls.length, 1, "queued cancel should call transport.cancelPendingMessage");
        assertEqual(cancelCalls[0].sessionId, "cancel-session", "transport cancel should target the right session");
        assertEqual(
            Array.isArray(cancelCalls[0].ids) && cancelCalls[0].ids.includes(queued.clientMessageIds[0]),
            true,
            "transport cancel should carry the queued item's clientMessageIds",
        );

        const outbox = store.getState().outbox.bySessionId["cancel-session"] || [];
        assertEqual(outbox.length, 1, "cancelled queued item should remain visible until runtime confirmation");
        assertEqual(outbox[0]?.phase, "cancelling", "cancelled queued item should enter cancelling phase");
    });

    it("restores the outbox item if the durable cancel transport call fails", async () => {
        const { controller, store } = createController({
            cancelPendingMessage: async () => {
                throw new Error("transport offline");
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "fail-session",
                title: "Fail Session",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "fail-session" });

        const queued = controller.buildOutboxItem("undeliverable cancel", "queued");
        controller.setSessionOutboxItems("fail-session", [queued]);

        const ok = await controller.cancelOutboxItem("fail-session", queued.id);
        assertEqual(ok, false, "failed transport cancel should report failure");

        const outbox = store.getState().outbox.bySessionId["fail-session"] || [];
        assertEqual(outbox.length, 1, "failed cancel should restore the queued outbox item");
        assertEqual(outbox[0]?.id, queued.id, "the restored item should be the same queued item");
    });

    it("cancelLatestQueuedOutbox cancels the most recent queued item", async () => {
        const cancelCalls = [];
        const { controller, store } = createController({
            cancelPendingMessage: async (sessionId, ids) => {
                cancelCalls.push({ sessionId, ids });
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "latest-session",
                title: "Latest Session",
                status: "running",
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "latest-session" });

        const a = controller.buildOutboxItem("first queued", "queued");
        const b = controller.buildOutboxItem("second queued", "queued");
        controller.setSessionOutboxItems("latest-session", [a, b]);

        const ok = await controller.cancelLatestQueuedOutbox("latest-session");
        assertEqual(ok, true, "cancelLatestQueuedOutbox should succeed when queued items exist");

        assertEqual(cancelCalls.length, 1, "should call transport once");
        assertEqual(
            cancelCalls[0].ids.includes(b.clientMessageIds[0]),
            true,
            "should cancel the most recent queued item",
        );

        const outbox = store.getState().outbox.bySessionId["latest-session"] || [];
        assertEqual(outbox.length, 2, "the cancelling queued item should remain visible until runtime confirmation");
        assertEqual(outbox.find((item) => item.id === a.id)?.phase, "queued", "the older queued item should remain queued");
        assertEqual(outbox.find((item) => item.id === b.id)?.phase, "cancelling", "the latest queued item should enter cancelling phase");
    });

    it("cancelOutboxItem on a pending item removes it locally and sends best-effort durable cancel", async () => {
        const cancelCalls = [];
        const { controller, store } = createController({
            cancelPendingMessage: async (sessionId, ids) => {
                cancelCalls.push({ sessionId, ids });
            },
        });

        store.dispatch({
            type: "sessions/loaded",
            sessions: [{ sessionId: "local-session", title: "Local", status: "idle", createdAt: 1, updatedAt: 2 }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "local-session" });

        const pending = controller.buildOutboxItem("not yet durable", "pending");
        controller.setSessionOutboxItems("local-session", [pending]);

        const ok = await controller.cancelOutboxItem("local-session", pending.id);
        assertEqual(ok, true, "cancel of a pending item should succeed locally");
        assertEqual(cancelCalls.length, 1, "pending cancel should send a durable tombstone to cover enqueue races");
        assertEqual(cancelCalls[0].sessionId, "local-session", "pending cancel should target the session");
        assertEqual(
            cancelCalls[0].ids.includes(pending.clientMessageIds[0]),
            true,
            "pending cancel should include the original client message id",
        );

        const outbox = store.getState().outbox.bySessionId["local-session"] || [];
        assertEqual(outbox.length, 0, "the pending item should be removed from the outbox");
    });
});
