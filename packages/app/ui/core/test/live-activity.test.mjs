import test from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState,
    appReducer,
    selectLiveActivityLines,
} from "../src/index.js";

function loadRunningSessionWithChat(chat) {
    let state = createInitialState();
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{
            sessionId: "session-1",
            title: "Live turn",
            status: "running",
            updatedAt: 1_700_000_001_000,
        }],
    });
    state = appReducer(state, { type: "sessions/selected", sessionId: "session-1" });
    state = appReducer(state, {
        type: "history/set",
        sessionId: "session-1",
        history: {
            chat,
            events: [],
            activity: [{
                seq: 10,
                eventType: "session.tools_updated",
                text: "[session.tools_updated] {\"model\":\"gpt-5.4\"}",
                createdAt: 1_700_000_002_000,
            }],
        },
    });
    return state;
}

test("live activity card remains visible after assistant output while session is still running", () => {
    const state = loadRunningSessionWithChat([
        { id: "u1", role: "user", text: "Keep checking every hour.", createdAt: 1_700_000_000_000 },
        { id: "a1", role: "assistant", text: "I will keep watching.", createdAt: 1_700_000_001_000 },
    ]);

    const lines = selectLiveActivityLines(state, {
        spinnerFrame: "*",
        now: 1_700_000_014_000,
        maxWidth: 72,
    });

    assert.notEqual(lines.length, 0);
    const flattened = lines.flat().map((run) => run.text).join("");
    assert.match(flattened, /Working/);
    assert.match(flattened, /gpt-5\.4/);
});

test("live activity card hides when the session is no longer running", () => {
    let state = loadRunningSessionWithChat([
        { id: "u1", role: "user", text: "Keep checking every hour.", createdAt: 1_700_000_000_000 },
        { id: "a1", role: "assistant", text: "Done for now.", createdAt: 1_700_000_001_000 },
    ]);
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{
            sessionId: "session-1",
            title: "Live turn",
            status: "idle",
            updatedAt: 1_700_000_002_000,
        }],
    });

    const lines = selectLiveActivityLines(state, {
        spinnerFrame: "*",
        now: 1_700_000_014_000,
        maxWidth: 72,
    });

    assert.equal(lines.length, 0);
});