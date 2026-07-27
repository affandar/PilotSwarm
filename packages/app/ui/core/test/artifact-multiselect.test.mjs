// Bulk selection on the artifact list. Marks are deliberately separate from
// selectedArtifactId: marking rows must NOT move the preview, which keeps
// showing the artifact it was already on.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";

const base = () => {
    const state = createInitialState();
    return {
        ...state,
        files: { ...state.files, selectedArtifactId: "s1/a.md", markedIds: [] },
    };
};

test("marks toggle without disturbing the previewed artifact", () => {
    let state = base();
    state = appReducer(state, { type: "files/toggleMark", artifactId: "s1/b.md" });
    assert.deepEqual(state.files.markedIds, ["s1/b.md"]);
    assert.equal(state.files.selectedArtifactId, "s1/a.md", "preview must not move");

    state = appReducer(state, { type: "files/toggleMark", artifactId: "s1/b.md" });
    assert.deepEqual(state.files.markedIds, [], "toggling again unmarks");
    assert.equal(state.files.selectedArtifactId, "s1/a.md");
});

test("setMarks dedupes and clearMarks empties", () => {
    let state = base();
    state = appReducer(state, { type: "files/setMarks", artifactIds: ["s1/b.md", "s1/c.md", "s1/b.md"] });
    assert.deepEqual(state.files.markedIds, ["s1/b.md", "s1/c.md"]);
    state = appReducer(state, { type: "files/clearMarks" });
    assert.deepEqual(state.files.markedIds, []);
});

test("deleting an artifact drops it from the marks", () => {
    let state = base();
    state = appReducer(state, { type: "files/setMarks", artifactIds: ["s1/b.md", "s1/c.md"] });
    state = appReducer(state, { type: "files/deleted", sessionId: "s1", filename: "b.md" });
    assert.deepEqual(state.files.markedIds, ["s1/c.md"]);
});
