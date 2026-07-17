import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    createInitialState,
    createStore,
    defaultOwnerFilterForPrincipal,
    selectSessionOwnerFilterModal,
} from "pilotswarm/ui-core";

const ALICE = { provider: "github", subject: "alice", displayName: "Alice" };
const BOB = { provider: "github", subject: "bob", displayName: "Bob" };

function makeController({ sessions = [], groups = [] } = {}) {
    const calls = { placeSessionsInGroup: [] };
    const transport = {
        listSessions: async () => sessions.map((session) => ({ ...session })),
        listSessionGroups: async () => groups.map((group) => ({ ...group })),
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        placeSessionsInGroup: async (sessionIds, groupId) => {
            calls.placeSessionsInGroup.push([sessionIds, groupId]);
            return sessionIds.map((rootSessionId) => ({ rootSessionId, placed: true, reason: null }));
        },
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, calls };
}

test("TUI move-picker key flow places a mixed-owner selection via placeSessionsInGroup(sessionIds, groupId)", async () => {
    const { controller, store, calls } = makeController({
        sessions: [
            { sessionId: "s1", title: "Mine", status: "idle", owner: ALICE },
            { sessionId: "s2", title: "Shared", status: "idle", owner: BOB },
        ],
        groups: [{ groupId: "g1", title: "G1", memberCount: 0 }],
    });

    await controller.refreshSessions();
    store.dispatch({ type: "sessions/selectSet", sessionIds: ["s1", "s2"] });

    // Ctrl+G opens the picker; a multi-session selection starts on [New Group].
    await controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP);
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionGroupPicker");
    assert.deepEqual(modal.items.map((item) => item.kind), ["noGroup", "newGroup", "group"]);
    assert.equal(modal.selectedIndex, 1);

    // Down (j) to the group row, then Enter confirms the move.
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);

    assert.deepEqual(calls.placeSessionsInGroup, [[["s1", "s2"], "g1"]]);
    assert.equal(store.getState().ui.modal, null);
    assert.equal(store.getState().sessions.activeSessionId, "group:g1");
});

test("TUI session filter renders Shared with me checked and space toggles it", async () => {
    const { controller, store } = makeController({
        sessions: [
            { sessionId: "s1", title: "Mine", status: "idle", owner: ALICE },
            { sessionId: "s2", title: "Shared", status: "idle", owner: BOB },
        ],
    });
    store.dispatch({ type: "auth/context", principal: ALICE, authorization: { role: "user" } });
    store.dispatch({ type: "sessions/ownerFilter", filter: defaultOwnerFilterForPrincipal(ALICE) });
    await controller.refreshSessions();

    controller.openSessionOwnerFilter();
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionOwnerFilter");
    const sharedIndex = modal.items.findIndex((item) => item.id === "shared");
    assert.ok(sharedIndex > 0, "Shared with me appears as a first-class filter item");
    assert.equal(modal.items[sharedIndex].kind, "shared");

    const rowText = (state) => selectSessionOwnerFilterModal(state)
        .rows[sharedIndex].map((run) => run.text).join("");
    assert.equal(rowText(store.getState()), "[x] Shared with me");

    // Move the highlight to the row, then space (MODAL_CONFIRM) toggles it.
    store.dispatch({ type: "ui/modalSelection", index: sharedIndex });
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(store.getState().sessions.ownerFilter.includeShared, false);
    assert.match(rowText(store.getState()), /^\[ \] Shared with me/);

    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(store.getState().sessions.ownerFilter.includeShared, true);
});
