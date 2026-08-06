// The artifact reader takes over the right column, so closing it has to put
// back exactly what it displaced — including "nothing".
//
// The trap: the pane is itself a visible right column, so asking "is the
// column visible?" at close time always answers yes. What matters is what the
// column looked like BEFORE the pane opened, captured once on the opening
// transition and held across reopens.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    computeLegacyLayout,
} from "../src/index.js";

function controllerAt(viewport = { width: 200, height: 50 }) {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{ sessionId: "s1", title: "One", status: "idle" }],
    });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, {
        type: "ui/layout",
        layout: { viewportWidth: viewport.width, viewportHeight: viewport.height },
    });
    const store = createStore(appReducer, state);
    return new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
        },
    });
}

function rightHidden(controller) {
    const layoutState = controller.getState().ui.layout || {};
    return computeLegacyLayout(
        { width: layoutState.viewportWidth, height: layoutState.viewportHeight },
        layoutState.paneAdjust || 0,
        1,
        layoutState.sessionPaneAdjust || 0,
        layoutState.activityPaneAdjust || 0,
    ).rightHidden;
}

test("the pane opens and closes", () => {
    const controller = controllerAt();
    controller.dispatch({ type: "files/pane", open: true, restoresToHidden: false });
    assert.equal(controller.getState().files.paneOpen, true);

    return controller.closeArtifactPane().then(() => {
        assert.equal(controller.getState().files.paneOpen, false);
    });
});

test("closing hands the column back when it was visible before", async () => {
    const controller = controllerAt();
    assert.equal(rightHidden(controller), false, "precondition: the column is visible");

    controller.dispatch({ type: "files/pane", open: true, restoresToHidden: false });
    const result = await controller.closeArtifactPane();

    assert.equal(result.collapsedRightColumn, false);
    assert.equal(rightHidden(controller), false, "the inspector/activity column comes back");
});

test("closing re-collapses a column the user had already resized away", async () => {
    const controller = controllerAt();
    // The user drags the column shut, THEN follows an artifact link.
    controller.collapseRightColumn();
    assert.equal(rightHidden(controller), true, "precondition: the column is collapsed");

    controller.dispatch({ type: "files/pane", open: true, restoresToHidden: true });
    const result = await controller.closeArtifactPane();

    assert.equal(result.collapsedRightColumn, true);
    assert.equal(rightHidden(controller), true,
        "opening a reader must not become a way to un-hide panes the user dismissed");
});

test("reopening while open does not overwrite what the pane restores to", () => {
    // Stepping ‹ › between artifacts re-enters the open path. If that
    // recaptured "is the column visible", the answer would be yes — the pane
    // IS the column — and a user who started collapsed would be handed an
    // inspector they never asked for.
    let state = createInitialState();
    state = appReducer(state, { type: "files/pane", open: true, restoresToHidden: true });
    state = appReducer(state, { type: "files/pane", open: true, restoresToHidden: false });
    assert.equal(state.files.paneRestoresToHidden, true, "the first capture wins while open");

    state = appReducer(state, { type: "files/pane", open: false });
    assert.equal(state.files.paneOpen, false);
    assert.equal(state.files.paneRestoresToHidden, false, "closing clears the capture");

    state = appReducer(state, { type: "files/pane", open: true, restoresToHidden: false });
    assert.equal(state.files.paneRestoresToHidden, false, "a fresh open captures again");
});

test("opening onto a collapsed column forces it open, and ✕ collapses it back", async () => {
    // Regression: the reader was rendered into the zero-width column, so it
    // existed in the DOM, reported itself open, and was invisible. Opening has
    // to widen the column; closing puts the collapse back, so the detour never
    // shows up as a layout the user did not ask for.
    const controller = controllerAt();
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;

    controller.collapseRightColumn();
    assert.equal(rightHidden(controller), true, "precondition: collapsed");

    await controller.revealArtifact("s1", "dash.html", { pane: true });
    assert.equal(controller.getState().files.paneOpen, true);
    assert.equal(rightHidden(controller), false, "the reader must actually be visible");
    assert.equal(controller.getState().files.paneRestoresToHidden, true,
        "it still remembers the column was collapsed");

    await controller.closeArtifactPane();
    assert.equal(rightHidden(controller), true, "and puts the collapse back");
});

test("opening onto a visible column captures 'restore to visible' by itself", async () => {
    const controller = controllerAt();
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;

    await controller.revealArtifact("s1", "dash.html", { pane: true });
    assert.equal(controller.getState().files.paneRestoresToHidden, false);

    await controller.closeArtifactPane();
    assert.equal(rightHidden(controller), false);
});

test("revealArtifact with pane:true opens the reader and leaves focus on chat", async () => {
    // Following a link from the transcript must not move focus into the
    // artifact list underneath the reader — you should still be able to type.
    const controller = controllerAt();
    controller.dispatch({ type: "ui/focus", focusRegion: "chat" });
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;

    await controller.revealArtifact("s1", "dash.html", { pane: true });

    assert.equal(controller.getState().files.paneOpen, true);
    assert.equal(controller.getState().files.selectedArtifactId, "s1/dash.html");
    assert.equal(controller.getState().ui.focusRegion, "chat");
});

test("the reader leaves the inspector tab alone, so ✕ returns you to it", async () => {
    // The reader replaces the inspector wholesale, so changing which inspector
    // tab is selected is pure side effect: you open an artifact while watching
    // Sequence, and ✕ drops you on a file list you never opened.
    const controller = controllerAt();
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;
    controller.dispatch({ type: "ui/inspectorTab", inspectorTab: "sequence" });

    await controller.revealArtifact("s1", "dash.html", { pane: true });
    assert.equal(controller.getState().ui.inspectorTab, "sequence", "untouched while open");

    await controller.closeArtifactPane();
    assert.equal(controller.getState().ui.inspectorTab, "sequence", "and still there after ✕");
});

test("revealArtifact without pane keeps the old inspector-focused behavior", async () => {
    const controller = controllerAt();
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;

    await controller.revealArtifact("s1", "dash.html", {});

    assert.equal(controller.getState().files.paneOpen, false);
    assert.equal(controller.getState().ui.focusRegion, "inspector");
});
