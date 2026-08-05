/**
 * The agent picker's disclosure keys are actually bound, on both hosts.
 *
 * The dialog tells the user "Enter or → to open" in its detail pane. Nothing
 * listened for it: left/right inside a modal reach `moveModalPane` only via
 * MODAL_PANE_PREV/NEXT, and both hosts bind those to Tab / Shift+Tab. In the
 * TUI the arrow keys were handled for the four text-input modals and the
 * modal block then `return`s; in the web the modal branch handles
 * Escape/Enter/Tab/Up/Down and returns. So the picker documented a key that
 * did nothing, and the one key that worked (Tab) was named nowhere.
 *
 * The binding lives in two host key handlers — a real terminal and a real
 * keydown event, neither of which the reducer tests reach — so it is pinned
 * here at the source, alongside the hint text it has to agree with.
 *
 * Run: node --test test/agent-picker-keys.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { PilotSwarmUiController } from "../src/controller.js";
import { selectStatusBar } from "../src/selectors.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const webApp = read("../../react/src/web-app.js");
const tuiApp = read("../../../tui/src/app.js");

test("the web host binds left/right for the agent picker", () => {
    assert.match(
        webApp,
        /modal\.type === "sessionAgentPicker" && \(event\.key === "ArrowRight" \|\| event\.key === "ArrowLeft"\)/,
    );
});

test("the TUI host binds left/right for the agent picker", () => {
    assert.match(
        tuiApp,
        /modal\.type === "sessionAgentPicker" && \(key\.leftArrow \|\| key\.rightArrow\)/,
    );
});

test("the binding is scoped to the picker so Tab pane-cycling is untouched", () => {
    // Every other list modal is flat; left/right there would either do nothing
    // or fight the pane cycling those hosts already use Tab for.
    for (const [host, source] of [["web", webApp], ["tui", tuiApp]]) {
        const arrowBinding = source.slice(source.indexOf('modal.type === "sessionAgentPicker" && ('));
        assert.match(arrowBinding.slice(0, 400), /MODAL_PANE_(NEXT|PREV)/, `${host} routes to the pane commands`);
    }
});

test("right maps to open and left to close, not the other way round", () => {
    const web = webApp.slice(webApp.indexOf('modal.type === "sessionAgentPicker" && (event.key === "ArrowRight"'));
    assert.match(web.slice(0, 300), /ArrowRight" \? UI_COMMANDS\.MODAL_PANE_NEXT : UI_COMMANDS\.MODAL_PANE_PREV/);
    const tui = tuiApp.slice(tuiApp.indexOf('modal.type === "sessionAgentPicker" && (key.leftArrow'));
    assert.match(tui.slice(0, 300), /key\.rightArrow \? UI_COMMANDS\.MODAL_PANE_NEXT : UI_COMMANDS\.MODAL_PANE_PREV/);
});

test("the status bar names the keys that exist, and no longer promises Enter creates", async () => {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
            listCreatableAgents: async () => [{ name: "alpha", title: "Alpha" }],
            getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        },
    });
    await controller.openSessionAgentPicker();

    const hint = selectStatusBar(store.getState())?.right || "";
    assert.match(hint, /←\/→/, "the disclosure keys are named");
    assert.doesNotMatch(hint, /enter create/, "Enter opens a section when one is selected");
});

test("right opens a closed section and left closes it again", async () => {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
            listCreatableAgents: async () => [
                { name: "solo", title: "Solo", source: "package", scope: "shared", packageName: "kit", packageSemver: "1.0.0" },
            ],
            getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        },
    });
    await controller.openSessionAgentPicker();
    // The picker opens fully collapsed; open the category first.
    controller.toggleAgentPickerSection("installed:shared");

    const modal = store.getState().ui.modal;
    const packageIndex = modal.items.findIndex((item) => item.packageName === "kit");
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: packageIndex } });

    controller.moveModalPane(1);
    assert.ok(store.getState().ui.modal.items.some((item) => item.agentName === "solo"), "right opens it");

    controller.moveModalPane(-1);
    assert.ok(!store.getState().ui.modal.items.some((item) => item.agentName === "solo"), "left closes it");
});

test("left on a leaf steps out to its section header", async () => {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
            listCreatableAgents: async () => [
                { name: "solo", title: "Solo", source: "package", scope: "shared", packageName: "kit", packageSemver: "1.0.0" },
            ],
            getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        },
    });
    await controller.openSessionAgentPicker();
    controller.toggleAgentPickerSection("installed:shared");
    const key = store.getState().ui.modal.items.find((item) => item.packageName === "kit").sectionKey;
    controller.toggleAgentPickerSection(key);

    const modal = store.getState().ui.modal;
    store.dispatch({
        type: "ui/modal",
        modal: { ...modal, selectedIndex: modal.items.findIndex((item) => item.agentName === "solo") },
    });

    controller.moveModalPane(-1);
    const after = store.getState().ui.modal;
    assert.equal(after.items[after.selectedIndex].sectionKey, key, "the cursor walks out, it does not collapse the parent");
    assert.ok(after.items.some((item) => item.agentName === "solo"), "and the section stays open");
});
