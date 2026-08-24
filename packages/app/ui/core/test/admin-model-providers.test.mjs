import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmUiController } from "../src/controller.js";
import { appReducer } from "../src/reducer.js";
import { selectAdminConsole, selectAdminProviderCreateModal } from "../src/selectors.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";

function loadedAdminState() {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, {
        type: "admin/profile/loaded",
        profile: {
            provider: "entra",
            subject: "admin-1",
            email: "admin@example.com",
            displayName: "Admin",
            isAdmin: true,
        },
    });
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{
            sessionId: "system-sweeper",
            title: "Sweeper",
            agentId: "sweeper",
            isSystem: true,
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
        }],
    });
    return appReducer(state, {
        type: "admin/modelProviders/loaded",
        providers: [
            { name: "shared-a", typeId: "github-copilot", class: "shared", mine: false, usableByMe: true, systemEligible: true },
            { name: "mine-a", typeId: "github-copilot", class: "personal", usableByMe: true, systemUseEnabled: true, systemEligible: true },
            { name: "mine-b", typeId: "github-copilot", class: "personal", usableByMe: true, systemUseEnabled: false, systemEligible: false },
            { name: "other-a", typeId: "github-copilot", class: "personal", mine: false, usableByMe: false, systemUseEnabled: true, systemEligible: true },
        ],
        models: [
            { providerId: "shared-a", name: "model-s", qualifiedName: "shared-a:model-s" },
            { providerId: "mine-a", name: "model-a", qualifiedName: "mine-a:model-a" },
            { providerId: "mine-b", name: "model-b", qualifiedName: "mine-b:model-b" },
            { providerId: "other-a", name: "model-o", qualifiedName: "other-a:model-o" },
        ],
        defaults: {
            userSession: { configured: { provider: "mine-b", model: "mine-b:model-b", reasoning: null, context: null }, effective: { model: "mine-b:model-b", source: "user_default" } },
            clusterSession: { configured: { provider: "shared-a", model: "shared-a:model-s", reasoning: null, context: null }, effective: { model: "shared-a:model-s", source: "cluster_default" } },
            system: { configured: { provider: "mine-a", model: "mine-a:model-a", reasoning: null, context: null }, effective: { model: "mine-a:model-a", source: "system_default" } },
            systemOverrides: [{ agentId: "sweeper", provider: "shared-a", model: "shared-a:model-s", reasoning: null, context: null }],
        },
    });
}

test("Admin Console exposes provider/default sections with scope-safe picker choices", () => {
    const view = selectAdminConsole(loadedAdminState());
    const providers = view.modelProviders;

    assert.deepEqual(providers.myProviders.map((row) => row.name), ["mine-a", "mine-b"]);
    assert.equal(providers.page, "mine");
    assert.deepEqual(providers.userChoices.map((row) => row.qualifiedName), [
        "shared-a:model-s",
        "mine-a:model-a",
        "mine-b:model-b",
    ]);
    assert.deepEqual(providers.clusterChoices.map((row) => row.qualifiedName), ["shared-a:model-s"]);
    assert.deepEqual(providers.systemChoices.map((row) => row.qualifiedName), [
        "shared-a:model-s",
        "mine-a:model-a",
    ]);
    assert.equal(providers.mySessionDefault.configured.model, "mine-b:model-b");
    assert.equal(providers.clusterSessionDefault.configured.model, "shared-a:model-s");
    assert.equal(providers.systemSessionDefault.configured.model, "mine-a:model-a");
    assert.equal(providers.systemAgentOverrides[0].agentId, "sweeper");
    assert.equal(providers.systemAgentRoutes[0].title, "Sweeper Agent");
    assert.equal(JSON.stringify(providers).includes("other-a:model-o"), false);
    assert.equal(JSON.stringify(providers).includes("credentials"), false);
    assert.equal(JSON.stringify(providers).includes("displayName"), false);
});

test("Admin Console controller uses canonical provider/default APIs without retaining credentials", async () => {
    const calls = [];
    const providers = [
        { name: "shared-a", typeId: "github-copilot", class: "shared", usableByMe: true, systemEligible: true },
        { name: "mine-a", typeId: "github-copilot", class: "personal", usableByMe: true, systemUseEnabled: true, systemEligible: true },
    ];
    const defaults = {
        userSession: { configured: null, effective: null },
        clusterSession: { configured: null, effective: null },
        system: { configured: null, effective: null },
        systemOverrides: [],
    };
    const transport = {
        listProviders: async () => ({ providers }),
        listModels: async () => [{ providerId: "github-copilot", modelName: "gpt-5.4", qualifiedName: "github-copilot:gpt-5.4" }],
        getModelDefaults: async () => defaults,
        createMyProvider: async (input) => { calls.push(["createMyProvider", input]); return { name: input.name }; },
        setProviderSystemUse: async (input) => { calls.push(["setProviderSystemUse", input]); return input; },
        setModelDefault: async (input) => { calls.push(["setModelDefault", input]); return input; },
        setSystemModelDefault: async (input) => { calls.push(["setSystemModelDefault", input]); return { configured: input }; },
        setSystemSessionModel: async (input) => { calls.push(["setSystemSessionModel", input]); return input; },
        clearSystemSessionModel: async (agentId) => { calls.push(["clearSystemSessionModel", agentId]); return { agentId, cleared: true }; },
        deleteProvider: async (name) => { calls.push(["deleteProvider", name]); return { name }; },
        deleteMyProvider: async (name) => { calls.push(["deleteMyProvider", name]); return { name }; },
    };
    const store = createStore(appReducer, loadedAdminState());
    const controller = new PilotSwarmUiController({ store, transport });
    const choice = selectAdminConsole(store.getState()).modelProviders.systemChoices[1];

    await controller.createAdminProvider({
        name: "mine-new",
        type: "github-copilot",
        credentials: { githubToken: "secret-token" },
    });
    await controller.setAdminProviderSystemUse("mine-a", true);
    await controller.setAdminModelDefault("user", choice);
    await controller.setAdminModelDefault("cluster", null);
    await controller.setAdminSystemModelDefault(choice, { restartDisposition: "terminate" });
    await controller.setAdminSystemAgentModel("sweeper", choice);
    await controller.clearAdminSystemAgentModel("sweeper");

    assert.deepEqual(calls[0], ["createMyProvider", {
        name: "mine-new",
        type: "github-copilot",
        credentials: { githubToken: "secret-token" },
        baseUrl: null,
    }]);
    assert.deepEqual(calls[1], ["setProviderSystemUse", { provider: "mine-a", enabled: true }]);
    assert.deepEqual(calls[2], ["setModelDefault", {
        scope: "user", provider: "mine-a", model: "mine-a:model-a", reasoningEffort: null, contextTier: null,
    }]);
    assert.deepEqual(calls[3], ["setModelDefault", {
        scope: "cluster", provider: null, model: null, reasoningEffort: null, contextTier: null,
    }]);
    assert.deepEqual(calls[4][1].restartExisting, { disposition: "terminate" });
    assert.equal(Object.hasOwn(calls[5][1], "restartExisting"), false);
    assert.deepEqual(calls[6], ["clearSystemSessionModel", "sweeper"]);
    controller.setAdminModelProviderSelection({ focus: "providers", providerName: "shared-a" });
    controller.requestDeleteSelectedAdminProvider();
    assert.equal(store.getState().ui.modal.action, "deleteAdminProvider");
    await controller.confirmModal();
    assert.deepEqual(calls[7], ["deleteProvider", "shared-a"]);
    assert.equal(JSON.stringify(store.getState()).includes("secret-token"), false);
});

test("Admin Console switches between separate My and Shared provider pages", () => {
    const store = createStore(appReducer, loadedAdminState());
    const controller = new PilotSwarmUiController({ store, transport: {} });

    controller.setAdminModelProviderPage("shared");
    let view = selectAdminConsole(store.getState());
    assert.equal(view.modelProviders.page, "shared");
    assert.equal(view.settingsTree.find((row) => row.id === "sharedProviders").selected, true);
    assert.equal(view.modelProviders.selection.providerName, "shared-a");

    controller.setAdminModelProviderPage("mine");
    view = selectAdminConsole(store.getState());
    assert.equal(view.modelProviders.page, "mine");
    assert.equal(view.settingsTree.find((row) => row.id === "myProviders").selected, true);
    assert.equal(view.modelProviders.selection.providerName, "mine-a");
});

test("native provider wizard masks and clears credential drafts before save and on cancel", async () => {
    let releaseCreate;
    let submitted = null;
    let sharedSubmitted = null;
    const transport = {
        listProviders: async () => ({ providers: [] }),
        listModels: async () => [
            { providerId: "github-copilot", modelName: "claude-sonnet-5" },
            { providerId: "azure-openai", modelName: "gpt-5.4" },
        ],
        getModelDefaults: async () => ({
            userSession: { configured: null, effective: null },
            clusterSession: { configured: null, effective: null },
            system: { configured: null, effective: null },
            systemOverrides: [],
        }),
        createMyProvider: async (input) => {
            submitted = input;
            await new Promise((resolve) => { releaseCreate = resolve; });
            return { name: input.name };
        },
        createProvider: async (input) => {
            sharedSubmitted = input;
            return { name: input.name };
        },
    };
    const store = createStore(appReducer, loadedAdminState());
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "admin/visibility", visible: true });
    await controller.refreshAdminModelProviders();

    controller.beginAdminCreateGithubProvider();
    assert.equal(selectAdminProviderCreateModal(store.getState()).title,
        "Add GitHub Copilot provider");
    controller.cycleAdminProviderCreateType();
    assert.equal(store.getState().admin.modelProviders.create.typeId, "azure-openai");
    controller.cycleAdminProviderCreateType();
    assert.equal(store.getState().admin.modelProviders.create.typeId, "github-copilot");
    controller.setAdminProviderCreateDraft("my-private-ghcp");
    controller.advanceAdminProviderCreate();
    controller.setAdminProviderCreateDraft("secret-draft");
    const modal = selectAdminProviderCreateModal(store.getState());
    assert.equal(modal.displayValue, "•".repeat("secret-draft".length));
    assert.equal(JSON.stringify(modal).includes("secret-draft"), false);

    const saving = controller.saveAdminProviderCreate();
    assert.equal(submitted.credentials.githubToken, "secret-draft");
    assert.equal(store.getState().admin.modelProviders.create.draft, "", "draft clears before the create request settles");
    assert.equal(JSON.stringify(store.getState()).includes("secret-draft"), false);
    releaseCreate();
    await saving;
    assert.equal(store.getState().admin.modelProviders.create.editing, false);

    controller.beginAdminCreateProvider({ shared: true });
    controller.setAdminProviderCreateDraft("shared-ghcp");
    controller.advanceAdminProviderCreate();
    controller.setAdminProviderCreateDraft("shared-secret");
    await controller.saveAdminProviderCreate();
    assert.equal(sharedSubmitted.shared, undefined);
    assert.equal(sharedSubmitted.name, "shared-ghcp");
    assert.equal(sharedSubmitted.credentials.githubToken, "shared-secret");
    assert.equal(JSON.stringify(store.getState()).includes("shared-secret"), false);

    controller.beginAdminCreateGithubProvider();
    controller.setAdminProviderCreateDraft("another-provider");
    controller.advanceAdminProviderCreate();
    controller.setAdminProviderCreateDraft("cancel-secret");
    controller.cancelAdminProviderCreate();
    assert.equal(JSON.stringify(store.getState()).includes("cancel-secret"), false);
});