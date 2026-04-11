import { describe, it } from "vitest";
import { UI_COMMANDS } from "../../../ui-core/src/commands.js";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";

function createController(transportOverrides = {}) {
    const calls = [];
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        cancelSession: async (sessionId) => {
            calls.push({ type: "cancel", sessionId });
        },
        completeSession: async (sessionId, reason) => {
            calls.push({ type: "complete", sessionId, reason });
        },
        deleteSession: async (sessionId) => {
            calls.push({ type: "delete", sessionId });
        },
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    return {
        store,
        calls,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function seedSession(store, sessionId = "session-12345678") {
    store.dispatch({
        type: "sessions/loaded",
        sessions: [{
            sessionId,
            title: "Confirm Modal Test",
            status: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }],
    });
    return sessionId;
}

describe("session confirm modal behavior", () => {
    it("opens a confirm modal for cancel, done, and delete instead of executing immediately", async () => {
        const cases = [
            [UI_COMMANDS.CANCEL_SESSION, "cancelSession", "Cancel Session"],
            [UI_COMMANDS.DONE_SESSION, "completeSession", "Complete Session"],
            [UI_COMMANDS.DELETE_SESSION, "deleteSession", "Delete Session"],
        ];

        for (const [command, action, title] of cases) {
            const { controller, store, calls } = createController();
            seedSession(store);

            await controller.handleCommand(command);

            const modal = store.getState().ui.modal;
            assertNotNull(modal, `${action} should open a confirm modal`);
            assertEqual(modal.type, "confirm", `${action} modal type`);
            assertEqual(modal.action, action, `${action} modal action`);
            assertEqual(modal.title, title, `${action} modal title`);
            assertEqual(calls.length, 0, `${action} should not execute before confirmation`);
        }
    });

    it("only executes the requested session action after the confirm modal is accepted", async () => {
        const sessionId = "session-12345678";
        const cases = [
            [UI_COMMANDS.CANCEL_SESSION, "cancel"],
            [UI_COMMANDS.DONE_SESSION, "complete"],
            [UI_COMMANDS.DELETE_SESSION, "delete"],
        ];

        for (const [command, expectedType] of cases) {
            const { controller, store, calls } = createController();
            seedSession(store, sessionId);

            await controller.handleCommand(command);
            await controller.confirmModal();

            assertEqual(store.getState().ui.modal, null, `${expectedType} modal should close after confirmation`);
            assertEqual(calls.length, 1, `${expectedType} should execute exactly once after confirmation`);
            assertEqual(calls[0].type, expectedType, `${expectedType} transport action type`);
            assertEqual(calls[0].sessionId, sessionId, `${expectedType} transport action session id`);
        }
    });
});
