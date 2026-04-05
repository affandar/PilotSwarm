import { describe, it } from "vitest";
import { UI_COMMANDS } from "../../../ui-core/src/commands.js";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { selectStatusBar, selectThemePickerModal } from "../../../ui-core/src/selectors.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { DEFAULT_THEME_ID, listThemes } from "../../../ui-core/src/themes/index.js";
import { assertEqual, assertIncludes, assertNotNull } from "../helpers/assertions.js";

function createController() {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    return {
        store,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

describe("theme picker UI behavior", () => {
    it("opens the shared theme picker with the current theme preselected", async () => {
        const { controller, store } = createController();

        await controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER);

        const state = store.getState();
        const modal = state.ui.modal;
        assertNotNull(modal, "theme picker modal should be opened");
        assertEqual(modal.type, "themePicker", "modal type should be themePicker");
        assertEqual(modal.items.length, listThemes().length, "theme picker should list all shared themes");
        assertEqual(modal.items[modal.selectedIndex]?.id, DEFAULT_THEME_ID, "current theme should be preselected");

        const selector = selectThemePickerModal(state);
        assertNotNull(selector, "theme picker selector should render");
        assertIncludes(selector.detailsLines[0][0].text, "theme", "details should describe the selected theme");

        const status = selectStatusBar(state);
        assertIncludes(status.right, "enter apply", "status bar should show theme picker keybindings");
    });

    it("applies the selected theme when the modal is confirmed", async () => {
        const { controller, store } = createController();
        const themes = listThemes();
        const nextTheme = themes.find((theme) => theme.id !== DEFAULT_THEME_ID);
        assertNotNull(nextTheme, "a second theme should be available");

        await controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER);
        const nextIndex = themes.findIndex((theme) => theme.id === nextTheme.id);
        store.dispatch({ type: "ui/modalSelection", index: nextIndex });

        await controller.confirmModal();

        const state = store.getState();
        assertEqual(state.ui.themeId, nextTheme.id, "confirming the modal should update the active theme");
        assertEqual(state.ui.modal, null, "theme picker should close after apply");
        assertIncludes(state.ui.statusText, nextTheme.label, "status should mention the applied theme");
    });

    it("advertises the theme shortcut in the default status hints", () => {
        const status = selectStatusBar(createInitialState({ mode: "local" }));
        assertIncludes(status.right, "T themes", "default hints should advertise the theme picker shortcut");
    });
});
