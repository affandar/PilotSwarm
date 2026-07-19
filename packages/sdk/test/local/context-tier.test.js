// Context-window tier (contextTier) — config parsing + new-session UI flow.
//
// The tier mirrors reasoningEffort: declared per-model in model_providers.json
// (supportedContextTiers / defaultContextTier), surfaced through listModels,
// picked in a dedicated step of the new-session flow, threaded through
// createSession options, and defaulted to "default" (the smaller window).
import { describe, it } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { UI_COMMANDS } from "../../../app/ui/core/src/commands.js";
import { PilotSwarmUiController } from "../../../app/ui/core/src/controller.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import { selectContextTierPickerModal } from "../../../app/ui/core/src/selectors.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

// ─── Registry parsing ────────────────────────────────────────────

describe("context tier config parsing", () => {
    const baseProvider = (models) => ({
        providers: [{ id: "github-copilot", type: "github", githubToken: "tok", models }],
    });

    it("normalizes supported tiers and keeps a valid default", () => {
        const registry = new ModelProviderRegistry(baseProvider([{
            name: "m1",
            supportedContextTiers: ["default", "long_context"],
            defaultContextTier: "long_context",
            contextWindowSizes: { default: 200_000, long_context: 936_000 },
        }]));
        const desc = registry.getDescriptor("github-copilot:m1");
        assertEqual(JSON.stringify(desc.supportedContextTiers), JSON.stringify(["default", "long_context"]));
        assertEqual(desc.defaultContextTier, "long_context", "explicit valid default preserved");
        assertEqual(JSON.stringify(desc.contextWindowSizes), JSON.stringify({ default: 200_000, long_context: 936_000 }));
    });

    it("falls back to the smaller window when the default is missing or invalid", () => {
        const registry = new ModelProviderRegistry(baseProvider([
            { name: "no-default", supportedContextTiers: ["default", "long_context"] },
            { name: "bad-default", supportedContextTiers: ["default", "long_context"], defaultContextTier: "huge" },
        ]));
        assertEqual(registry.getDescriptor("github-copilot:no-default").defaultContextTier, "default");
        assertEqual(registry.getDescriptor("github-copilot:bad-default").defaultContextTier, "default");
    });

    it("drops unknown tier values and omits fields on tier-less models", () => {
        const registry = new ModelProviderRegistry(baseProvider([
            { name: "mixed", supportedContextTiers: ["default", "gigantic", "long_context", "default"] },
            { name: "plain" },
        ]));
        const mixed = registry.getDescriptor("github-copilot:mixed");
        assertEqual(JSON.stringify(mixed.supportedContextTiers), JSON.stringify(["default", "long_context"]), "unknown + duplicate values dropped");
        const plain = registry.getDescriptor("github-copilot:plain");
        assertEqual(plain.supportedContextTiers, undefined, "tier-less model carries no supportedContextTiers");
        assertEqual(plain.defaultContextTier, undefined, "tier-less model carries no defaultContextTier");
    });
});

// ─── New-session UI flow ─────────────────────────────────────────

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

const TIERED_MODEL = {
    qualifiedName: "github-copilot:claude-opus-4.8",
    providerId: "github-copilot",
    providerType: "github",
    modelName: "claude-opus-4.8",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    supportedContextTiers: ["default", "long_context"],
    defaultContextTier: "default",
    contextWindowSizes: { default: 200_000, long_context: 936_000 },
};

describe("context tier new-session flow", () => {
    it("offers the tier picker after reasoning effort and threads the selection into createSession", async () => {
        let created = false;
        let createOptions = null;
        const { controller, store } = createController({
            listSessions: async () => created
                ? [{ sessionId: "tier-session", status: "idle", createdAt: 1, updatedAt: 2 }]
                : [],
            listModels: async () => [TIERED_MODEL],
            getModelsByProvider: () => [
                { providerId: "github-copilot", type: "github", models: [TIERED_MODEL] },
            ],
            createSession: async (options) => {
                createOptions = options;
                created = true;
                return { sessionId: "tier-session" };
            },
            getSession: async () => ({ sessionId: "tier-session", status: "idle", createdAt: 1, updatedAt: 2 }),
        });

        try {
            await controller.start();
            await controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER);
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "reasoningEffortPicker", "effort picker first");

            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "contextTierPicker", "tier picker follows effort picker");

            const tierModal = selectContextTierPickerModal(store.getState());
            assert(tierModal, "tier picker modal renders through its selector");
            assertIncludes(JSON.stringify(tierModal.rows), "Default (200K tokens)", "default window size shown");
            assertIncludes(JSON.stringify(tierModal.rows), "Long context (936K tokens", "long-context window size shown");
            assertIncludes(JSON.stringify(tierModal.detailsLines), "200K tokens", "selected window description includes its size");
            const preselected = store.getState().ui.modal.items[store.getState().ui.modal.selectedIndex];
            assertEqual(preselected.id, "default", "smaller window preselected by default");

            store.dispatch({ type: "ui/modalSelection", index: 1 });
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);

            assertEqual(createOptions?.model, "github-copilot:claude-opus-4.8");
            assertEqual(createOptions?.reasoningEffort, "medium");
            assertEqual(createOptions?.contextTier, "long_context", "selected tier threaded into createSession");
        } finally {
            await controller.stop();
        }
    });

    it("uses the default (smaller) tier when the preselection is accepted", async () => {
        let created = false;
        let createOptions = null;
        const { controller, store } = createController({
            listSessions: async () => created
                ? [{ sessionId: "tier-default-session", status: "idle", createdAt: 1, updatedAt: 2 }]
                : [],
            listModels: async () => [TIERED_MODEL],
            getModelsByProvider: () => [
                { providerId: "github-copilot", type: "github", models: [TIERED_MODEL] },
            ],
            createSession: async (options) => {
                createOptions = options;
                created = true;
                return { sessionId: "tier-default-session" };
            },
            getSession: async () => ({ sessionId: "tier-default-session", status: "idle", createdAt: 1, updatedAt: 2 }),
        });

        try {
            await controller.start();
            await controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER);
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "contextTierPicker");
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(createOptions?.contextTier, "default", "accepting the preselection keeps the smaller window");
        } finally {
            await controller.stop();
        }
    });

    it("skips the tier picker entirely for models without declared tiers", async () => {
        let created = false;
        let createOptions = null;
        const plainModel = {
            qualifiedName: "github-copilot:gpt-5.5",
            providerId: "github-copilot",
            providerType: "github",
            modelName: "gpt-5.5",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
        };
        const { controller, store } = createController({
            listSessions: async () => created
                ? [{ sessionId: "plain-session", status: "idle", createdAt: 1, updatedAt: 2 }]
                : [],
            listModels: async () => [plainModel],
            getModelsByProvider: () => [
                { providerId: "github-copilot", type: "github", models: [plainModel] },
            ],
            createSession: async (options) => {
                createOptions = options;
                created = true;
                return { sessionId: "plain-session" };
            },
            getSession: async () => ({ sessionId: "plain-session", status: "idle", createdAt: 1, updatedAt: 2 }),
        });

        try {
            await controller.start();
            await controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER);
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "reasoningEffortPicker");
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assert(created, "session created without a tier step");
            assertEqual(createOptions?.contextTier, undefined, "no contextTier sent for tier-less models");
        } finally {
            await controller.stop();
        }
    });
});

// ─── Switch-model flow ───────────────────────────────────────────

describe("context tier switch-model flow", () => {
    function switchController() {
        let setModelArgs = null;
        const { controller, store } = createController({
            listModels: async () => [TIERED_MODEL],
            getModelsByProvider: () => [
                { providerId: "github-copilot", type: "github", models: [TIERED_MODEL] },
            ],
            setSessionModel: async (sessionId, opts) => { setModelArgs = { sessionId, ...opts }; },
        });
        // An active session on a different model, ready to switch.
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{ sessionId: "switch-session", title: "S", status: "idle", model: "github-copilot:claude-sonnet-5", createdAt: 1, updatedAt: 2 }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "switch-session" });
        return { controller, store, getSetModelArgs: () => setModelArgs };
    }

    it("offers the tier picker after reasoning effort and threads the tier into the switch", async () => {
        const { controller, store, getSetModelArgs } = switchController();
        try {
            await controller.start();
            await controller.openSwitchModelPicker();
            assertEqual(store.getState().ui.modal?.type, "modelPicker", "switch opens the model picker");
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "reasoningEffortPicker", "effort picker first");
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "contextTierPicker", "switch flow now surfaces the tier picker");

            const tierModal = selectContextTierPickerModal(store.getState());
            assert(tierModal, "tier picker renders in switch mode");
            const preselected = store.getState().ui.modal.items[store.getState().ui.modal.selectedIndex];
            assertEqual(preselected.id, "default", "smaller window preselected");

            store.dispatch({ type: "ui/modalSelection", index: 1 });
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);

            const args = getSetModelArgs();
            assert(args, "setSessionModel was called");
            assertEqual(args.sessionId, "switch-session");
            assertEqual(args.model, "github-copilot:claude-opus-4.8", "switched to the picked model");
            assertEqual(args.reasoningEffort, "medium", "effort threaded into the switch");
            assertEqual(args.contextTier, "long_context", "selected tier threaded into the switch");
        } finally {
            await controller.stop();
        }
    });

    it("skips the tier picker and switches directly for tier-less models", async () => {
        const plainModel = {
            qualifiedName: "github-copilot:gpt-5.4",
            providerId: "github-copilot",
            providerType: "github",
            modelName: "gpt-5.4",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
        };
        let setModelArgs = null;
        const { controller, store } = createController({
            listModels: async () => [plainModel],
            getModelsByProvider: () => [{ providerId: "github-copilot", type: "github", models: [plainModel] }],
            setSessionModel: async (sessionId, opts) => { setModelArgs = { sessionId, ...opts }; },
        });
        store.dispatch({
            type: "sessions/loaded",
            sessions: [{ sessionId: "plain-switch", title: "S", status: "idle", model: "github-copilot:claude-sonnet-5", createdAt: 1, updatedAt: 2 }],
        });
        store.dispatch({ type: "sessions/selected", sessionId: "plain-switch" });
        try {
            await controller.start();
            await controller.openSwitchModelPicker();
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assertEqual(store.getState().ui.modal?.type, "reasoningEffortPicker");
            await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
            assert(setModelArgs, "switch applied without a tier step");
            assertEqual(setModelArgs.contextTier, undefined, "no contextTier sent for tier-less models");
        } finally {
            await controller.stop();
        }
    });
});
