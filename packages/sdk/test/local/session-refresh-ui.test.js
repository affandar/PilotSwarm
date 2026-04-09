import { describe, it } from "vitest";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { selectActiveChat, selectChatPaneChrome, selectVisibleSessionRows } from "../../../ui-core/src/selectors.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

function createController(transportOverrides = {}, { branding = null } = {}) {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local", branding }));
    return {
        store,
        controller: new PilotSwarmUiController({ store, transport }),
    };
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
});
