// The session "Lifecycle" menu (formerly "Terminate") surfaces Regenerate
// alongside the terminal dispositions. These cover the shared ui-core wiring
// that both the portal and the TUI drive: the picker advertises regenerate for
// an eligible single session, the pick routes through the confirm modal, and
// confirming reaches transport.regenerateSession — the surface no operator-path
// test exercises.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

function makeController(transportOverrides = {}) {
    const sessions = Array.isArray(transportOverrides.sessions) ? [...transportOverrides.sessions] : [];
    const calls = { regenerateSession: [], cancelSession: [] };
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((s) => s.sessionId === sessionId) || null,
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        regenerateSession: async (sessionId, options = {}) => {
            calls.regenerateSession.push({ sessionId, options });
        },
        cancelSession: async (sessionId) => {
            calls.cancelSession.push(sessionId);
        },
        listCreatableAgents: async () => [],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        ...transportOverrides,
    };
    delete transport.sessions;
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, transport, calls, store };
}

async function seedActive(controller, store, session) {
    await controller.refreshSessions();
    store.dispatch({ type: "sessions/selected", sessionId: session.sessionId });
}

test("Lifecycle picker offers Regenerate for an eligible single session", async () => {
    const session = { sessionId: "s1", title: "Worker", status: "idle" };
    const { controller, store } = makeController({ sessions: [session] });
    await seedActive(controller, store, session);

    await controller.openTerminatePickerModal();

    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "terminatePicker");
    assert.equal(modal.canRegenerate, true, "regenerate is offered when the transport supports it");
    assert.match(modal.title, /^Lifecycle \(/, "picker is titled Lifecycle, not Terminate");
});

test("Picking Regenerate confirms then calls transport.regenerateSession", async () => {
    const session = { sessionId: "s1", title: "Worker", status: "idle" };
    const { controller, calls, store } = makeController({ sessions: [session] });
    await seedActive(controller, store, session);

    await controller.openTerminatePickerModal();
    await controller.pickTerminateAction("regenerate");

    const confirm = store.getState().ui.modal;
    assert.equal(confirm?.type, "confirm", "regenerate routes through a confirm modal");
    assert.equal(confirm.action, "regenerateSession");
    assert.equal(calls.regenerateSession.length, 0, "nothing fires before the user confirms");

    await controller.confirmModal();

    assert.equal(calls.regenerateSession.length, 1, "confirming triggers regeneration");
    assert.equal(calls.regenerateSession[0].sessionId, "s1");
    assert.equal(store.getState().ui.modal, null, "modal closes after confirm");
});

test("Regenerate is withheld when the deployment lacks the transport method", async () => {
    const session = { sessionId: "s1", title: "Worker", status: "idle" };
    const { controller, store } = makeController({ sessions: [session], regenerateSession: undefined });
    await seedActive(controller, store, session);

    await controller.openTerminatePickerModal();

    assert.equal(store.getState().ui.modal.canRegenerate, false, "older deployments do not advertise regenerate");
});

test("Service sessions (⚗ machinery) never offer or accept regenerate", async () => {
    const session = { sessionId: "svc1", title: "Regen Distiller — abc e0→e1", status: "running", serviceKind: "regen-distiller", serviceOf: "s9" };
    const { controller, calls, store } = makeController({ sessions: [session] });
    await seedActive(controller, store, session);

    await controller.openTerminatePickerModal();
    assert.equal(store.getState().ui.modal.canRegenerate, false, "picker hides regenerate for service sessions");

    store.dispatch({ type: "ui/modal", modal: null });
    await controller.regenerateActiveSession();
    assert.equal(store.getState().ui.modal, null, "no confirm modal opens");
    assert.equal(calls.regenerateSession.length, 0, "nothing reaches the transport");
});

test("Confirmed regenerate forwards instructions and distill mode", async () => {
    const session = { sessionId: "s1", title: "Worker", status: "idle" };
    const { controller, calls, store } = makeController({ sessions: [session] });
    await seedActive(controller, store, session);

    await controller.regenerateActiveSession();
    controller.updateConfirmExtras({ instructions: "keep every SQL snippet", distillMode: "llm" });
    await controller.confirmModal();

    assert.equal(calls.regenerateSession.length, 1);
    const [{ sessionId, options }] = [{ sessionId: calls.regenerateSession[0].sessionId, options: calls.regenerateSession[0].options }];
    assert.equal(sessionId, "s1");
    assert.equal(options.force, true, "operator confirm forces past soft rate limits");
    assert.equal(options.instructions, "keep every SQL snippet");
    assert.equal(options.distillMode, undefined, "llm is the default — only deterministic is sent explicitly");
});
