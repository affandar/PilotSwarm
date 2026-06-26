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
    const calls = { createSession: [], createSessionForAgent: [] };
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
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
    assert.deepEqual(modal.items.map((item) => item.agentName), ["alpha"]);
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
    assert.deepEqual(modal.items.map((item) => item.kind === "generic" ? "generic" : item.agentName), ["generic", "alpha"]);

    await controller.confirmModal();
    assert.equal(calls.createSession.length, 1);
    assert.equal(calls.createSession[0].model, "openai:gpt-test");
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

    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: 1 } });
    await controller.confirmModal();
    assert.equal(calls.createSessionForAgent.length, 1);
    assert.equal(calls.createSessionForAgent[0].agentName, "alpha");
    assert.equal(calls.createSessionForAgent[0].options.model, "openai:gpt-reasoning");
    assert.equal(calls.createSessionForAgent[0].options.reasoningEffort, "high");
});
