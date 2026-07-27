// Where the preview backs out to depends on how it was OPENED. A chat-opened
// preview must return to the chat pane AND leave the artifact list exactly as
// it was — following a transcript link must not reorganize the Files tab.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const base = () => {
    const s = createInitialState();
    return { ...s, files: { ...s.files, selectedArtifactId: "s1/list-pick.md" } };
};

test("chat origin captures the list's selection as the restore point", () => {
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/list-pick.md" });
    assert.equal(state.files.previewOrigin, "chat");
    assert.equal(state.files.restoreArtifactId, "s1/list-pick.md");
});

test("list origin clears any restore point", () => {
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/a.md" });
    state = appReducer(state, { type: "files/previewOrigin", origin: "list" });
    assert.equal(state.files.previewOrigin, "list");
    assert.equal(state.files.restoreArtifactId, null, "a list-opened preview has nothing to restore");
});

test("selecting from chat does not lose the restore point", () => {
    // revealArtifact records the origin, then dispatches files/select. The
    // select must not wipe what we need to restore on the way back.
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/list-pick.md" });
    state = appReducer(state, { type: "files/select", sessionId: "s1", filename: "from-chat.md" });
    assert.equal(state.files.selectedArtifactId, "s1/from-chat.md", "preview moved to the chat artifact");
    assert.equal(state.files.restoreArtifactId, "s1/list-pick.md", "restore point survives");
});

test("clearing the origin drops the restore point", () => {
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/a.md" });
    state = appReducer(state, { type: "files/previewOrigin", origin: null });
    assert.equal(state.files.previewOrigin, null);
    assert.equal(state.files.restoreArtifactId, null);
});
