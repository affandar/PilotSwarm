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
        restartSystemSession: async (agentIdOrSessionId, options) => {
            calls.push({ type: "restartSystem", agentIdOrSessionId, options });
        },
        createSessionGroup: async (input) => {
            calls.push({ type: "createGroup", input });
            return { groupId: "group-1234", title: input.title };
        },
        listSessionGroups: async () => [
            { groupId: "existing-group", title: "Existing Group", memberCount: 2 },
        ],
        assignSessionsToGroup: async (groupId, sessionIds) => {
            calls.push({ type: "assignGroup", groupId, sessionIds });
        },
        moveSessionsToGroup: async (groupId, sessionIds) => {
            calls.push({ type: "moveGroup", groupId, sessionIds });
        },
        updateSessionGroup: async (groupId, patch) => {
            calls.push({ type: "updateGroup", groupId, patch });
            return { groupId, ...patch };
        },
        deleteSessionGroup: async (groupId) => {
            calls.push({ type: "deleteGroup", groupId });
        },
        renameSession: async (sessionId, title) => {
            calls.push({ type: "rename", sessionId, title });
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

function seedSystemSession(store, sessionId = "system-session-1234") {
    store.dispatch({
        type: "sessions/loaded",
        sessions: [{
            sessionId,
            title: "Sweeper Agent",
            status: "running",
            isSystem: true,
            agentId: "sweeper",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }],
    });
    store.dispatch({ type: "sessions/selected", sessionId });
    return sessionId;
}

function seedBulkSelection(store, sessions) {
    store.dispatch({
        type: "sessions/loaded",
        sessions,
    });
    store.dispatch({ type: "sessions/selectMode", enabled: true });
    store.dispatch({ type: "sessions/selectSet", sessionIds: sessions.map((session) => session.sessionId) });
    store.dispatch({ type: "sessions/selected", sessionId: sessions[0].sessionId });
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

    it("maps system-session actions to restart dispositions after confirmation", async () => {
        const cases = [
            [UI_COMMANDS.CANCEL_SESSION, "terminate", "Terminate & Restart System Session"],
            [UI_COMMANDS.DONE_SESSION, "complete", "Complete & Restart System Session"],
            [UI_COMMANDS.DELETE_SESSION, "hard_delete", "Hard Delete & Restart System Session"],
        ];

        for (const [command, disposition, title] of cases) {
            const { controller, store, calls } = createController();
            seedSystemSession(store);

            await controller.handleCommand(command);

            const modal = store.getState().ui.modal;
            assertNotNull(modal, `${disposition} should open a restart confirm modal`);
            assertEqual(modal.type, "confirm", `${disposition} modal type`);
            assertEqual(modal.title, title, `${disposition} modal title`);
            assertEqual(calls.length, 0, `${disposition} should not execute before confirmation`);

            await controller.confirmModal();

            assertEqual(calls.length, 1, `${disposition} should execute exactly once after confirmation`);
            assertEqual(calls[0].type, "restartSystem", `${disposition} transport action type`);
            assertEqual(calls[0].agentIdOrSessionId, "sweeper", `${disposition} should target the system agent id`);
            assertEqual(calls[0].options.disposition, disposition, `${disposition} restart disposition`);
        }
    });

    it("opens the restart disposition picker for system sessions", async () => {
        const { controller, store, calls } = createController();
        seedSystemSession(store);

        await controller.handleCommand(UI_COMMANDS.OPEN_TERMINATE_PICKER);

        let modal = store.getState().ui.modal;
        assertNotNull(modal, "system restart should open a picker");
        assertEqual(modal.type, "terminatePicker", "system restart picker modal type");
        assertEqual(modal.title, "Restart System Session", "system restart picker title");
        assertEqual(modal.systemRestart, true, "system restart picker flag");
        assertEqual(calls.length, 0, "restart picker should not execute before a disposition is chosen");

        await controller.pickTerminateAction("delete");
        modal = store.getState().ui.modal;
        assertNotNull(modal, "hard delete disposition should open confirmation");
        assertEqual(modal.type, "confirm", "hard delete confirmation modal type");
        assertEqual(modal.title, "Hard Delete & Restart System Session", "hard delete confirmation title");
        assertEqual(calls.length, 0, "hard delete restart should not execute before confirmation");

        await controller.confirmModal();

        assertEqual(calls.length, 1, "hard delete restart should execute after confirmation");
        assertEqual(calls[0].type, "restartSystem", "hard delete restart transport action");
        assertEqual(calls[0].agentIdOrSessionId, "sweeper", "hard delete restart target");
        assertEqual(calls[0].options.disposition, "hard_delete", "hard delete restart disposition");
    });

    it("opens a bulk disposition picker with complete cancel and hard delete options", async () => {
        const cases = [
            ["complete", "Complete Sessions", "complete"],
            ["cancel", "Cancel Sessions", "cancel"],
            ["delete", "Hard Delete Sessions", "delete"],
        ];

        for (const [action, title, expectedType] of cases) {
            const { controller, store, calls } = createController();
            seedBulkSelection(store, [
                { sessionId: "bulk-a", title: "Bulk A", status: "idle", createdAt: 1, updatedAt: 2 },
                { sessionId: "bulk-b", title: "Bulk B", status: "idle", createdAt: 3, updatedAt: 4 },
                { sessionId: "bulk-c", title: "Bulk C", status: "idle", createdAt: 5, updatedAt: 6 },
            ]);

            await controller.handleCommand(UI_COMMANDS.OPEN_TERMINATE_PICKER);

            let modal = store.getState().ui.modal;
            assertNotNull(modal, "bulk terminate should open a picker");
            assertEqual(modal.type, "terminatePicker", "bulk terminate picker modal type");
            assertEqual(modal.bulkCount, 3, "bulk terminate picker count");

            await controller.pickTerminateAction(action);
            modal = store.getState().ui.modal;
            assertNotNull(modal, `${action} should open bulk confirmation`);
            assertEqual(modal.type, "confirm", `${action} confirmation modal type`);
            assertEqual(modal.title, title, `${action} confirmation title`);

            await controller.confirmModal();

            assertEqual(calls.length, 3, `${action} should execute for all selected sessions`);
            assertEqual(calls.every((call) => call.type === expectedType), true, `${action} transport action type`);
        }
    });

    it("moves the active session into a named new group", async () => {
        const sessionId = "session-12345678";
        const { controller, store, calls } = createController();
        seedSession(store, sessionId);

        await controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP);
        let modal = store.getState().ui.modal;
        assertNotNull(modal, "move-to-group should open a picker");
        assertEqual(modal.type, "sessionGroupPicker", "move-to-group modal type");
        assertEqual(modal.items[0].label, "[No Group]", "picker should include no-group option");
        assertEqual(modal.items[1].label, "[New Group]", "picker should include new-group option");

        await controller.confirmModal();
        modal = store.getState().ui.modal;
        assertNotNull(modal, "new group option should ask for a name");
        assertEqual(modal.type, "sessionGroupName", "new group name modal type");
        controller.setSessionGroupNameValue("Release Group");
        await controller.confirmModal();

        assertEqual(calls.length, 2, "new group move should call create + move");
        assertEqual(calls[0].type, "createGroup", "first grouping call");
        assertEqual(calls[0].input.title, "Release Group", "new group title");
        assertEqual(calls[1].type, "moveGroup", "second grouping call");
        assertEqual(calls[1].groupId, "group-1234", "assigned group id");
        assertEqual(calls[1].sessionIds.length, 1, "assigned session count");
        assertEqual(calls[1].sessionIds[0], sessionId, "assigned session id");
    });

    it("moves bulk selected sessions into a new group", async () => {
        const owner = { provider: "test", subject: "owner-a", email: "a@example.com", displayName: "Owner A" };
        const { controller, store, calls } = createController();
        seedBulkSelection(store, [
            { sessionId: "bulk-a", title: "Bulk A", status: "idle", owner, createdAt: 1, updatedAt: 2 },
            { sessionId: "bulk-b", title: "Bulk B", status: "idle", owner, createdAt: 3, updatedAt: 4 },
            { sessionId: "bulk-c", title: "Bulk C", status: "idle", owner, createdAt: 5, updatedAt: 6 },
        ]);

        await controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP);

        let modal = store.getState().ui.modal;
        assertNotNull(modal, "bulk move-to-group should open picker");
        assertEqual(modal.type, "sessionGroupPicker", "bulk move-to-group modal type");
        assertEqual(modal.sessionIds.length, 3, "bulk move should carry selected sessions");

        const newGroupIndex = modal.items.findIndex((item) => item.kind === "newGroup");
        store.dispatch({ type: "ui/modalSelection", index: newGroupIndex });
        await controller.confirmModal();
        modal = store.getState().ui.modal;
        assertNotNull(modal, "bulk new group should ask for a name");
        assertEqual(modal.type, "sessionGroupName", "bulk new group name modal type");

        controller.setSessionGroupNameValue("Bulk Group");
        await controller.confirmModal();

        assertEqual(calls.length, 2, "bulk group move should call create + move");
        assertEqual(calls[0].type, "createGroup", "bulk group first call");
        assertEqual(calls[0].input.sessionIds.length, 3, "bulk group create input should include selected ids");
        assertEqual(calls[1].type, "moveGroup", "bulk group second call");
        assertEqual(calls[1].sessionIds.length, 3, "bulk move should move every selected session");
    });

    it("moves sessions only to groups with the same owner", async () => {
        const ownerA = { provider: "test", subject: "owner-a", email: "a@example.com", displayName: "Owner A" };
        const ownerB = { provider: "test", subject: "owner-b", email: "b@example.com", displayName: "Owner B" };
        const { controller, store, calls } = createController({
            listSessionGroups: async () => [
                { groupId: "group-a", title: "Owner A Group", owner: ownerA, memberCount: 1 },
                { groupId: "group-b", title: "Owner B Group", owner: ownerB, memberCount: 1 },
            ],
        });
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "session-a",
                title: "Session A",
                status: "idle",
                owner: ownerA,
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "session-a" });

        await controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP);

        let modal = store.getState().ui.modal;
        assertNotNull(modal, "move-to-group should open a picker");
        assertEqual(modal.items.some((item) => item.groupId === "group-a"), true, "same-owner group should be offered");
        assertEqual(modal.items.some((item) => item.groupId === "group-b"), false, "different-owner group should be hidden");

        const newGroupIndex = modal.items.findIndex((item) => item.kind === "newGroup");
        store.dispatch({ type: "ui/modalSelection", index: newGroupIndex });
        await controller.confirmModal();
        modal = store.getState().ui.modal;
        assertNotNull(modal, "new group option should ask for a name");
        assertEqual(modal.owner?.subject, ownerA.subject, "new group modal should carry selected owner");

        controller.setSessionGroupNameValue("Owner A New Group");
        await controller.confirmModal();

        assertEqual(calls[0].type, "createGroup", "new group should be created first");
        assertEqual(calls[0].input.owner.subject, ownerA.subject, "created group should use selected session owner");
        assertEqual(calls[0].input.sessionIds[0], "session-a", "created group input should include selected session ids for server-side owner derivation");
    });

    it("ungroups the active session through the no-group picker option", async () => {
        const sessionId = "session-12345678";
        const { controller, store, calls } = createController();
        seedSession(store, sessionId);

        await controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP);
        store.dispatch({ type: "ui/modalSelection", index: 0 });
        await controller.confirmModal();

        assertEqual(calls.length, 1, "ungroup should make one move call");
        assertEqual(calls[0].type, "moveGroup", "ungroup should call moveSessionsToGroup");
        assertEqual(calls[0].groupId, null, "ungroup should pass null group id");
        assertEqual(calls[0].sessionIds[0], sessionId, "ungroup should pass session id");
    });

    it("renames a selected group through the session-group API", async () => {
        const { controller, store, calls } = createController();
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "group:group-1234",
                groupId: "group-1234",
                title: "Old Group",
                status: "group",
                isGroup: true,
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "group:group-1234" });

        await controller.handleCommand(UI_COMMANDS.OPEN_RENAME_SESSION);
        controller.setRenameSessionValue("Renamed Group");
        await controller.confirmRenameSessionModal();

        assertEqual(calls.length, 1, "group rename should make one transport call");
        assertEqual(calls[0].type, "updateGroup", "group rename should call updateSessionGroup");
        assertEqual(calls[0].groupId, "group-1234", "group rename should pass the group id");
        assertEqual(calls[0].patch.title, "Renamed Group", "group rename should pass the requested title");
    });

    it("treats group rows as containers for session actions", async () => {
        const { controller, store, calls } = createController();
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "group:group-1234",
                groupId: "group-1234",
                title: "Container Group",
                status: "group",
                isGroup: true,
                memberCount: 2,
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "group:group-1234" });

        await controller.handleCommand(UI_COMMANDS.CANCEL_SESSION);
        await controller.handleCommand(UI_COMMANDS.DONE_SESSION);
        await controller.handleCommand(UI_COMMANDS.DELETE_SESSION);

        assertEqual(calls.length, 0, "group cancel/done/delete should not act on member sessions");
        const modal = store.getState().ui.modal;
        assertNotNull(modal, "non-empty group delete should open an error dialog");
        assertEqual(modal.type, "confirm", "non-empty group error modal type");
        assertEqual(modal.alert, true, "non-empty group error should be alert-style");
        assertEqual(modal.title, "Group Not Empty", "non-empty group error title");
    });

    it("deletes an empty group only after confirmation", async () => {
        const { controller, store, calls } = createController();
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{
                sessionId: "group:group-1234",
                groupId: "group-1234",
                title: "Empty Group",
                status: "group",
                isGroup: true,
                memberCount: 0,
                createdAt: 1,
                updatedAt: 2,
            }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "group:group-1234" });

        await controller.handleCommand(UI_COMMANDS.DELETE_SESSION);
        assertNotNull(store.getState().ui.modal, "empty group delete should open a confirm modal");
        await controller.confirmModal();

        assertEqual(calls.length, 1, "empty group delete should make one transport call");
        assertEqual(calls[0].type, "deleteGroup", "empty group delete should call deleteSessionGroup");
        assertEqual(calls[0].groupId, "group-1234", "empty group delete should pass the group id");
    });
});
