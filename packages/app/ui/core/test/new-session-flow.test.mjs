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
    const calls = { createSession: [], createSessionForAgent: [], setSessionModel: [] };
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
        subscribeSession: () => () => {},
        createSession: async (options = {}) => {
            calls.createSession.push(options);
            const session = { sessionId: `s${calls.createSession.length}`, title: "Session", status: "idle" };
            sessions.push(session);
            return session;
        },
        createSessionForAgent: async (agentName, options = {}) => {
            calls.createSessionForAgent.push({ agentName, options });
            const session = { sessionId: `a${calls.createSessionForAgent.length}`, agentId: agentName, title: agentName, status: "idle" };
            sessions.push(session);
            return session;
        },
        setSessionModel: async (sessionId, options = {}) => {
            calls.setSessionModel.push({ sessionId, options });
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

test("New fast-starts a generic session when generic sessions are allowed", async () => {
    const { controller, calls, store } = makeController({
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
    });

    await controller.openNewSessionFlow();

    assert.equal(calls.createSession.length, 1);
    assert.deepEqual(calls.createSession[0], {});
    assert.equal(store.getState().ui.modal, null);
    assert.equal(store.getState().sessions.activeSessionId, "s1");
});

test("New falls back to the model picker when generic sessions are disabled", async () => {
    const { controller, calls, store } = makeController({
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: false } }),
        listModels: async () => [{ qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" }],
        getDefaultModel: () => "openai:gpt-test",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [{ qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" }] }],
    });

    await controller.openNewSessionFlow();

    assert.equal(calls.createSession.length, 0);
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "modelPicker");
    assert.equal(modal.items[0].id, "openai:gpt-test");
});

test("New falls back to the agent picker when generic sessions are disabled and no model picker exists", async () => {
    const { controller, calls, store } = makeController({
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: false } }),
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha" }],
    });

    await controller.openNewSessionFlow();

    assert.equal(calls.createSession.length, 0);
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionAgentPicker");
    // The picker opens fully collapsed; the catalog is what this test is about.
    assert.deepEqual(modal.catalog.map((item) => item.agentName), ["alpha"]);
});

test("New fast-start inherits the active group", async () => {
    const { controller, calls, store } = makeController({
        sessions: [
            { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "Group" },
            { sessionId: "member-1", groupId: "g1", title: "Member" },
        ],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
    });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "group:g1", groupId: "g1", isGroup: true, title: "Group" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "group:g1" });

    await controller.openNewSessionFlow();

    assert.equal(calls.createSession.length, 1);
    assert.equal(calls.createSession[0].groupId, "g1");
});

test("New+Model opens the agent picker after model selection instead of fast-creating generic", async () => {
    const { controller, calls, store } = makeController({
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha Agent", description: "Agent alpha" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        listModels: async () => [{ qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" }],
        getDefaultModel: () => "openai:gpt-test",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [{ qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" }] }],
    });

    await controller.openModelPicker();
    await controller.confirmModal();

    assert.equal(calls.createSession.length, 0);
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionAgentPicker");
    assert.equal(modal.sessionOptions.model, "openai:gpt-test");
    // Generic leads the flat list: it is the most common pick, and it used to
    // sit below every specialist the deployment shipped.
    assert.equal(modal.items[0].kind, "generic");
    assert.ok(modal.items.some((item) => item.agentName === "alpha"), "agents are listed directly, no section to open");

    const opened = store.getState().ui.modal;
    store.dispatch({ type: "ui/modal", modal: { ...opened, selectedIndex: opened.items.findIndex((item) => item.agentName === "alpha") } });
    await controller.confirmModal();
    assert.equal(calls.createSessionForAgent.length, 1);
    assert.equal(calls.createSessionForAgent[0].agentName, "alpha");
    assert.equal(calls.createSessionForAgent[0].options.model, "openai:gpt-test");
});

test("New+Model with reasoning effort opens the agent picker with model and effort", async () => {
    const { controller, calls, store } = makeController({
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha Agent" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        listModels: async () => [{
            qualifiedName: "openai:gpt-reasoning",
            providerId: "openai",
            modelName: "gpt-reasoning",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high",
        }],
        getDefaultModel: () => "openai:gpt-reasoning",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [{
            qualifiedName: "openai:gpt-reasoning",
            providerId: "openai",
            modelName: "gpt-reasoning",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high",
        }] }],
    });

    await controller.openModelPicker();
    await controller.confirmModal();
    assert.equal(store.getState().ui.modal?.type, "reasoningEffortPicker");
    await controller.confirmModal();

    assert.equal(calls.createSession.length, 0);
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionAgentPicker");
    assert.equal(modal.sessionOptions.model, "openai:gpt-reasoning");
    assert.equal(modal.sessionOptions.reasoningEffort, "high");

    const opened = store.getState().ui.modal;
    store.dispatch({ type: "ui/modal", modal: { ...opened, selectedIndex: opened.items.findIndex((item) => item.agentName === "alpha") } });
    await controller.confirmModal();
    assert.equal(calls.createSessionForAgent.length, 1);
    assert.equal(calls.createSessionForAgent[0].agentName, "alpha");
    assert.equal(calls.createSessionForAgent[0].options.model, "openai:gpt-reasoning");
    assert.equal(calls.createSessionForAgent[0].options.reasoningEffort, "high");
});

test("Switch Model applies the target model default reasoning effort", async () => {
    const session = { sessionId: "s-existing", title: "Existing", status: "idle", model: "openai:gpt-old", reasoningEffort: "low" };
    const model = {
        qualifiedName: "openai:gpt-reasoning",
        providerId: "openai",
        modelName: "gpt-reasoning",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
    };
    const { controller, calls, store } = makeController({
        sessions: [session],
        listModels: async () => [model],
        getDefaultModel: () => "openai:gpt-old",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [model] }],
    });
    store.dispatch({ type: "sessions/loaded", sessions: [session] });
    store.dispatch({ type: "sessions/selected", sessionId: session.sessionId });

    await controller.openSwitchModelPicker();
    assert.equal(store.getState().ui.modal?.type, "modelPicker");
    assert.equal(store.getState().ui.modal?.sessionOptions?.mode, "switchModel");
    await controller.confirmModal();
    assert.equal(store.getState().ui.modal?.type, "reasoningEffortPicker");
    await controller.confirmModal();

    assert.equal(calls.setSessionModel.length, 1);
    assert.equal(calls.setSessionModel[0].sessionId, session.sessionId);
    assert.equal(calls.setSessionModel[0].options.model, "openai:gpt-reasoning");
    assert.equal(calls.setSessionModel[0].options.reasoningEffort, "high");
    assert.equal(calls.setSessionModel[0].options.source, "ui");
});

test("Switch Model clears reasoning effort when the target model has no efforts", async () => {
    const session = { sessionId: "s-existing", title: "Existing", status: "idle", model: "openai:gpt-old", reasoningEffort: "high" };
    const model = { qualifiedName: "openai:gpt-simple", providerId: "openai", modelName: "gpt-simple" };
    const { controller, calls, store } = makeController({
        sessions: [session],
        listModels: async () => [model],
        getDefaultModel: () => "openai:gpt-old",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [model] }],
    });
    store.dispatch({ type: "sessions/loaded", sessions: [session] });
    store.dispatch({ type: "sessions/selected", sessionId: session.sessionId });

    await controller.openSwitchModelPicker();
    assert.equal(store.getState().ui.modal?.type, "modelPicker");
    await controller.confirmModal();

    assert.equal(calls.setSessionModel.length, 1);
    assert.equal(calls.setSessionModel[0].sessionId, session.sessionId);
    assert.equal(calls.setSessionModel[0].options.model, "openai:gpt-simple");
    assert.equal(calls.setSessionModel[0].options.reasoningEffort, null);
    assert.equal(calls.setSessionModel[0].options.source, "ui");
    assert.equal(store.getState().ui.modal, null);
});

// The agent step needs a network round trip before it can render. The flow used
// to close the current step FIRST and then await that fetch, so the dialog blinked
// off screen for the length of the round trip and came back as the agent list.
// The overlay must stay mounted across the whole chain: assert that ui.modal is
// never null while the agent list is still in flight.
test("the dialog never blanks between the model steps and the agent step", async () => {
    let releaseAgents;
    const agentsInFlight = new Promise((resolve) => { releaseAgents = resolve; });
    const model = { qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" };
    const { controller, store } = makeController({
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: false } }),
        listModels: async () => [model],
        getDefaultModel: () => "openai:gpt-test",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [model] }],
        listCreatableAgents: async () => {
            await agentsInFlight;
            return [{ name: "alpha", title: "Alpha" }];
        },
    });

    await controller.openNewSessionFlow();
    assert.equal(store.getState().ui.modal?.type, "modelPicker");

    // Confirm the model. The agent fetch is deliberately left hanging.
    const advanced = controller.confirmModal();
    await Promise.resolve();
    await Promise.resolve();

    const midFlight = store.getState().ui.modal;
    assert.notEqual(midFlight, null, "overlay must stay mounted while agents load");
    assert.ok(
        midFlight.type !== "sessionAgentPicker",
        "the agent picker cannot be up yet — its list has not resolved",
    );

    releaseAgents();
    await advanced;
    assert.equal(store.getState().ui.modal?.type, "sessionAgentPicker");
});

test("a failed agent fetch dismisses the flow instead of stranding it", async () => {
    const model = { qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" };
    const { controller, store } = makeController({
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: false } }),
        listModels: async () => [model],
        getDefaultModel: () => "openai:gpt-test",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [model] }],
        listCreatableAgents: async () => { throw new Error("boom"); },
    });

    await controller.openNewSessionFlow();
    await controller.confirmModal();

    assert.equal(store.getState().ui.modal, null, "a dead fetch must not leave a stuck dialog");
    assert.match(String(store.getState().ui.statusText || ""), /Could not load agents/);
});
