import { describe, it } from "vitest";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { buildHistoryModel } from "../../../ui-core/src/history.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import {
    selectActiveChat,
    selectChatPaneChrome,
    selectInspector,
    selectSessionOwnerFilterModal,
    selectSessionRows,
    selectVisibleSessionRows,
} from "../../../ui-core/src/selectors.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

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

    it("prefers a non-system session as the default active selection", async () => {
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
            "user-session",
            "initial selection should prefer a non-system session over the PilotSwarm root",
        );
    });

    it("keeps the active selection empty when only system sessions are present", async () => {
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
            null,
            "initial selection should stay empty when only system sessions exist",
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
        assertIncludes(rootRow, "Waldemort", "legacy root row should use the current branding title");
        assert(!rootRow.includes("PilotSwarm"), "legacy root row should not leak the old PilotSwarm title");

        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");
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
        assert(
            chat.some((message) => message.pendingPhase === "queued"),
            "chat should render the merged outbox item with the queued (\u2713) phase",
        );
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
                    sessionId: "legacy-session",
                    title: "Legacy Work",
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });

        const rows = selectVisibleSessionRows(store.getState(), 8);
        const renderedRows = rows.map((row) => row.runs.map((run) => run.text).join(""));
        assert(renderedRows.some((row) => row.includes("(ad) Owned Work")), "owned row should include owner initials");
        assert(renderedRows.some((row) => row.includes("(?) Legacy Work")), "unowned row should include the (?) marker");

        store.dispatch({ type: "sessions/selected", sessionId: "owned-session" });
        const chromeTitle = selectChatPaneChrome(store.getState()).title.map((run) => run.text).join("");
        assert(!chromeTitle.includes("(ad)"), "chat header should not include the owner prefix");
    });

    it("renders owner prefixes in the session list without auth context when owner metadata exists", () => {
        const { store } = createController();

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
                    sessionId: "legacy-session",
                    title: "Legacy Work",
                    status: "idle",
                    createdAt: 3,
                    updatedAt: 4,
                },
            ],
        });

        const renderedRows = selectVisibleSessionRows(store.getState(), 8)
            .map((row) => row.runs.map((run) => run.text).join(""));
        assert(renderedRows.some((row) => row.includes("(ad) Owned Work")), "owner metadata alone should enable owner initials in the session list");
        assert(renderedRows.some((row) => row.includes("(?) Legacy Work")), "owner metadata should also mark unowned rows in the session list");
    });

    it("defaults session owner filtering to system plus me and exposes unowned as a separate entry", async () => {
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
            assert(!defaultRows.includes("other-session"), "default filter should exclude other users");
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
        assertIncludes(text, "TOKENS", "session stats cards should remain rendered while loading");
        assertEqual(text.includes("Loading session stats..."), false, "refreshing session stats should not blank the pane");
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
