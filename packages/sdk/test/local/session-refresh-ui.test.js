import { describe, it } from "vitest";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { assertEqual } from "../helpers/assertions.js";

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
});