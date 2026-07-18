// Session capabilities UI (capability-profiles Phases 3/4).
//
// The create chain gains an optional Capabilities step after the agent
// picker: pre-checked to the chosen agent's catalog profile, with the
// user's CHANGES becoming an enable/disable override delta threaded into
// createSession/createSessionForAgent as `capabilities`. An untouched
// picker yields NO override, and without a published catalog the step is
// skipped entirely (current behavior). The Manage-session Capabilities tab
// commits staged deltas via configureSession (applies next turn).
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    applyCapabilityOverrideToChecked,
    buildCapabilityBaseline,
    buildCapabilityOverrideDelta,
    buildCapabilityToolGroups,
    createInitialState,
    createStore,
} from "../src/index.js";

const CATALOG = {
    mcpServers: [
        { name: "github", isDefault: true },
        { name: "jira", isDefault: false },
    ],
    skills: [
        { name: "deploy", description: "Deploy the service" },
        { name: "review" },
    ],
    tools: [
        { name: "store_fact", group: "facts" },
        { name: "read_facts", group: "facts" },
        { name: "write_artifact", group: "artifacts" },
        { name: "lonely_tool" },
    ],
    agentDefaults: {
        alpha: { mcpServers: ["github"], skills: null, tools: [] },
    },
};

function makeController(transportOverrides = {}) {
    const sessions = Array.isArray(transportOverrides.sessions) ? [...transportOverrides.sessions] : [];
    const calls = { createSession: [], createSessionForAgent: [], configureSession: [] };
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
        configureSession: async (sessionId, capabilities) => {
            calls.configureSession.push({ sessionId, capabilities });
            return { appliesOn: "next_turn" };
        },
        getSessionCapabilities: async () => null,
        getCapabilityCatalog: () => CATALOG,
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha Agent" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        ...transportOverrides,
    };
    delete transport.sessions;
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, transport, calls, store };
}

function modalItemIndex(store, id) {
    const modal = store.getState().ui.modal;
    const index = (modal?.items || []).findIndex((item) => item.id === id);
    assert.ok(index >= 0, `modal item ${id} exists`);
    return index;
}

async function confirmAgentPickerFor(controller, store, agentId) {
    await controller.openSessionAgentPicker({});
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionAgentPicker");
    const index = modal.items.findIndex((item) => item.id === agentId);
    assert.ok(index >= 0, `agent picker offers ${agentId}`);
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: index } });
    await controller.confirmModal();
}

test("agent picker confirm opens the capability picker pre-checked to the agent profile", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");

    assert.equal(calls.createSessionForAgent.length, 0, "create waits for the capability step");
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "capabilityPicker");
    assert.equal(modal.agentName, "alpha");
    // Agent-granted MCP pre-checked, ungranted not; skills unrestricted →
    // all checked; tools unrestricted → all checked.
    assert.equal(modal.checked.mcpServers.github, true);
    assert.equal(modal.checked.mcpServers.jira, false);
    assert.equal(modal.checked.skills.deploy, true);
    assert.equal(modal.checked.skills.review, true);
    assert.equal(modal.checked.tools.store_fact, true);
    // Groups render collapsed: group rows present, member tool rows absent.
    assert.ok(modal.items.some((item) => item.id === "group:facts"));
    assert.ok(!modal.items.some((item) => item.id === "tool:store_fact"));
    assert.ok(modal.items.some((item) => item.id === "tool:lonely_tool"), "ungrouped tools render as plain rows");
});

test("untouched capability picker creates with NO override (skip affordance)", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    await controller.confirmModal();

    assert.equal(calls.createSessionForAgent.length, 1);
    assert.equal(calls.createSessionForAgent[0].agentName, "alpha");
    assert.ok(!("capabilities" in calls.createSessionForAgent[0].options), "no delta → no override");
    assert.equal(store.getState().ui.modal, null);
});

test("toggling off an agent-granted MCP server yields a disable delta", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "mcp:github"));
    await controller.confirmModal();

    assert.equal(calls.createSessionForAgent.length, 1);
    assert.deepEqual(calls.createSessionForAgent[0].options.capabilities, {
        mcpServers: { disable: ["github"] },
    });
});

test("group toggle stores the group NAME; individual tool toggle stores the tool name", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    // Whole-group toggle off → the delta names the group.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:facts"));
    await controller.confirmModal();
    assert.deepEqual(calls.createSessionForAgent[0].options.capabilities, {
        tools: { disable: ["facts"] },
    });

    // A single member toggled via the expanded group → the tool name.
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:facts"));
    assert.ok(modalItemIndex(store, "tool:store_fact") >= 0, "expanded group exposes member rows");
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:store_fact"));
    await controller.confirmModal();
    assert.deepEqual(calls.createSessionForAgent[1].options.capabilities, {
        tools: { disable: ["store_fact"] },
    });
});

test("tri-state group toggle checks all members from a partial state", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    controller.setCapabilityPickerGroupExpanded(true, modalItemIndex(store, "group:facts"));
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "tool:store_fact"));
    // Partial (1/2 checked) → group toggle re-checks everything → no delta.
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:facts"));
    await controller.confirmModal();
    assert.ok(!("capabilities" in calls.createSessionForAgent[0].options));
});

test("generic sessions start unchecked-neutral and emit enable deltas only", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "__generic__");

    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "capabilityPicker");
    assert.equal(modal.agentName, null);
    assert.equal(modal.checked.mcpServers.github, false);
    assert.equal(modal.checked.skills.deploy, false);
    assert.equal(modal.checked.tools.store_fact, false);

    controller.toggleCapabilityPickerItem(modalItemIndex(store, "skill:review"));
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "group:facts"));
    await controller.confirmModal();

    assert.equal(calls.createSession.length, 1);
    assert.deepEqual(calls.createSession[0].capabilities, {
        skills: { enable: ["review"] },
        tools: { enable: ["facts"] },
    });
});

test("the create chain threads model AND capabilities into createSessionForAgent", async () => {
    const model = { qualifiedName: "openai:gpt-test", providerId: "openai", modelName: "gpt-test" };
    const { controller, store, calls } = makeController({
        listModels: async () => [model],
        getDefaultModel: () => "openai:gpt-test",
        getModelsByProvider: () => [{ providerId: "openai", type: "openai", models: [model] }],
    });

    await controller.openModelPicker();
    await controller.confirmModal();
    const agentModal = store.getState().ui.modal;
    assert.equal(agentModal?.type, "sessionAgentPicker");
    const alphaIndex = agentModal.items.findIndex((item) => item.id === "alpha");
    store.dispatch({ type: "ui/modal", modal: { ...agentModal, selectedIndex: alphaIndex } });
    await controller.confirmModal();

    assert.equal(store.getState().ui.modal?.type, "capabilityPicker");
    controller.toggleCapabilityPickerItem(modalItemIndex(store, "mcp:jira"));
    await controller.confirmModal();

    assert.equal(calls.createSessionForAgent.length, 1);
    assert.equal(calls.createSessionForAgent[0].agentName, "alpha");
    assert.equal(calls.createSessionForAgent[0].options.model, "openai:gpt-test");
    assert.deepEqual(calls.createSessionForAgent[0].options.capabilities, {
        mcpServers: { enable: ["jira"] },
    });
});

test("the capability step is skipped entirely when no catalog is published", async () => {
    for (const catalog of [null, { mcpServers: [], skills: [], tools: [], agentDefaults: {} }]) {
        const { controller, store, calls } = makeController({
            getCapabilityCatalog: () => catalog,
        });
        await confirmAgentPickerFor(controller, store, "alpha");
        assert.equal(store.getState().ui.modal, null, "no capability modal without a catalog");
        assert.equal(calls.createSessionForAgent.length, 1, "creates immediately (current behavior)");
        assert.ok(!("capabilities" in calls.createSessionForAgent[0].options));
    }
});

test("an async getCapabilityCatalog (direct transport) still opens the picker", async () => {
    const { controller, store } = makeController({
        getCapabilityCatalog: async () => CATALOG,
    });
    await confirmAgentPickerFor(controller, store, "alpha");
    assert.equal(store.getState().ui.modal?.type, "capabilityPicker");
});

test("Esc cancels the whole flow without creating", async () => {
    const { controller, store, calls } = makeController();
    await confirmAgentPickerFor(controller, store, "alpha");
    assert.equal(store.getState().ui.modal?.type, "capabilityPicker");
    controller.closeModal();
    assert.equal(store.getState().ui.modal, null);
    assert.equal(calls.createSessionForAgent.length, 0);
});

test("Manage-tab Apply calls configureSession with the staged delta, null clears", async () => {
    const { controller, store, calls } = makeController();
    const delta = { mcpServers: { disable: ["github"] } };
    const result = await controller.configureSessionCapabilities("a1", delta);
    assert.deepEqual(calls.configureSession, [{ sessionId: "a1", capabilities: delta }]);
    assert.deepEqual(result, { appliesOn: "next_turn" });
    assert.equal(store.getState().ui.statusText, "Capabilities apply on the next turn");

    await controller.configureSessionCapabilities("a1", null);
    assert.deepEqual(calls.configureSession[1], { sessionId: "a1", capabilities: null });
});

test("loadSessionCapabilities returns the catalog and the stored override", async () => {
    const override = { skills: { disable: ["deploy"] } };
    const { controller } = makeController({
        getSessionCapabilities: async (sessionId) => (sessionId === "a1" ? override : null),
    });
    const view = await controller.loadSessionCapabilities("a1");
    assert.equal(view.catalog, CATALOG);
    assert.deepEqual(view.override, override);
});

test("effective checks = agent defaults + stored override applied (Manage tab)", () => {
    const { members } = buildCapabilityToolGroups(CATALOG);
    const baseline = buildCapabilityBaseline(CATALOG, "alpha");
    const effective = applyCapabilityOverrideToChecked(baseline, {
        mcpServers: { enable: ["jira"], disable: ["github"] },
        tools: { disable: ["facts"], enable: ["store_fact"] },
    }, members);
    assert.equal(effective.mcpServers.jira, true);
    assert.equal(effective.mcpServers.github, false);
    // Group disable expands to members; the individual enable refines it.
    assert.equal(effective.tools.read_facts, false);
    assert.equal(effective.tools.store_fact, true);
    assert.equal(effective.tools.write_artifact, true, "untouched axis entries keep the baseline");

    // Round-trip: staging no further changes reproduces the same override
    // deltas relative to the agent baseline.
    const delta = buildCapabilityOverrideDelta(baseline, effective, members);
    assert.deepEqual(delta, {
        mcpServers: { enable: ["jira"], disable: ["github"] },
        tools: { disable: ["read_facts"] },
    });
});
