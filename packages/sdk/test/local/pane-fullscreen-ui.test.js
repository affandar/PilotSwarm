import { describe, it } from "vitest";
import { FOCUS_REGIONS, UI_COMMANDS } from "../../../ui-core/src/commands.js";
import { PilotSwarmUiController } from "../../../ui-core/src/controller.js";
import { appReducer } from "../../../ui-core/src/reducer.js";
import { selectStatusBar } from "../../../ui-core/src/selectors.js";
import { createInitialState } from "../../../ui-core/src/state.js";
import { createStore } from "../../../ui-core/src/store.js";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

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

describe("pane fullscreen UI behavior", () => {
    it("keeps file download and delete shortcuts early in the files help bar", () => {
        const state = createInitialState({ mode: "local" });
        state.ui.focusRegion = FOCUS_REGIONS.INSPECTOR;
        state.ui.inspectorTab = "files";

        const status = selectStatusBar(state);
        assertIncludes(status.right, "a download", "files status hints should mention the artifact download shortcut");
        assertIncludes(status.right, "x delete", "files status hints should mention the artifact delete shortcut");
        assertEqual(
            status.right.indexOf("a download") < status.right.indexOf("u/ctrl-a upload"),
            true,
            "download should appear before upload so it survives status-bar truncation",
        );
        assertEqual(
            status.right.indexOf("x delete") < status.right.indexOf("u/ctrl-a upload"),
            true,
            "delete should appear before upload so it survives status-bar truncation",
        );
    });

    it("collapses focus order to the active pane and prompt while fullscreen is enabled", async () => {
        const { controller, store } = createController();

        controller.setFocus(FOCUS_REGIONS.CHAT);
        await controller.handleCommand(UI_COMMANDS.TOGGLE_PANE_FULLSCREEN);

        let state = store.getState();
        assertEqual(state.ui.fullscreenPane, FOCUS_REGIONS.CHAT, "chat should enter fullscreen mode");
        assertEqual(state.ui.focusRegion, FOCUS_REGIONS.CHAT, "focus should remain on the fullscreen pane");

        controller.focusNext();
        state = store.getState();
        assertEqual(state.ui.focusRegion, FOCUS_REGIONS.PROMPT, "tab should move from the fullscreen pane to the prompt");

        controller.focusNext();
        state = store.getState();
        assertEqual(state.ui.focusRegion, FOCUS_REGIONS.CHAT, "tab should cycle back to the fullscreen pane");

        const status = selectStatusBar(state);
        assertIncludes(status.right, "v/esc close fullscreen", "status hints should advertise how to exit fullscreen");
    });

    it("closes fullscreen back to the pane when toggled from the prompt", async () => {
        const { controller, store } = createController();

        controller.setFocus(FOCUS_REGIONS.ACTIVITY);
        await controller.handleCommand(UI_COMMANDS.TOGGLE_PANE_FULLSCREEN);
        controller.setFocus(FOCUS_REGIONS.PROMPT);

        await controller.handleCommand(UI_COMMANDS.TOGGLE_PANE_FULLSCREEN);

        const state = store.getState();
        assertEqual(state.ui.fullscreenPane, null, "fullscreen mode should close");
        assertEqual(state.ui.focusRegion, FOCUS_REGIONS.ACTIVITY, "focus should return to the pane that was fullscreened");
    });

    it("drops inspector pane fullscreen when switching into the files tab", async () => {
        const { controller, store } = createController();

        controller.setFocus(FOCUS_REGIONS.INSPECTOR);
        await controller.handleCommand(UI_COMMANDS.TOGGLE_PANE_FULLSCREEN);
        await controller.selectInspectorTab("files");

        const state = store.getState();
        assertEqual(state.ui.fullscreenPane, null, "files should not reuse the generic pane fullscreen mode");
        assertEqual(state.ui.inspectorTab, "files", "the files tab should still activate normally");
    });
});
