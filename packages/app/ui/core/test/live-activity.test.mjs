// Live activity status line — single dim line pinned outside the scrolling
// transcript (portal: bottom-sticky strip; TUI: below the transcript).
// Replaces the old multi-line bordered card: spinner + "Working" + elapsed +
// a HIGH-LEVEL phase only ("running tool: X…", "thinking…") — never raw event
// payloads; detail lives in the Inspector.
import test from "node:test";
import assert from "node:assert/strict";
import {
    createInitialState,
    appReducer,
    selectLiveActivityLines,
} from "../src/index.js";

function loadRunningSessionWithActivity(activity, chat = [
    { id: "u1", role: "user", text: "Keep checking every hour.", createdAt: 1_700_000_000_000 },
    { id: "a1", role: "assistant", text: "I will keep watching.", createdAt: 1_700_000_001_000 },
]) {
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
        history: { chat, events: [], activity },
    });
    return state;
}

function flatten(lines) {
    return lines.flat().map((run) => run.text).join("");
}

test("emits ONE line with Working, elapsed, and a high-level tool phase", () => {
    const state = loadRunningSessionWithActivity([{
        seq: 10,
        eventType: "tool.execution_start",
        text: "[tool.execution_start] get_file_contents {\"path\":\"src/x.ts\"}",
        createdAt: 1_700_000_002_000,
    }]);

    const lines = selectLiveActivityLines(state, {
        spinnerFrame: "*",
        now: 1_700_000_065_000,
        maxWidth: 96,
    });

    assert.equal(lines.length, 1, "exactly one status line, no card");
    const text = flatten(lines);
    assert.match(text, /\* Working/);
    assert.match(text, /1m 05s/, "elapsed anchored on the latest user message");
    assert.match(text, /running tool: get_file_contents/);
    assert.doesNotMatch(text, /src\/x\.ts/, "raw payloads never surface");
});

test("thinking phase from reasoning events; stays visible after assistant output while running", () => {
    const state = loadRunningSessionWithActivity([{
        seq: 11,
        eventType: "assistant.reasoning",
        text: "[assistant.reasoning] weighing options",
        createdAt: 1_700_000_002_000,
    }]);

    const text = flatten(selectLiveActivityLines(state, { spinnerFrame: "*", now: 1_700_000_014_000, maxWidth: 72 }));
    assert.match(text, /Working/);
    assert.match(text, /— thinking…/);
});

test("unmapped event types fall back to a bare Working line — no raw detail leaks", () => {
    const state = loadRunningSessionWithActivity([{
        seq: 12,
        eventType: "session.tools_updated",
        text: "[session.tools_updated] {\"model\":\"gpt-5.4\"}",
        createdAt: 1_700_000_002_000,
    }]);

    const text = flatten(selectLiveActivityLines(state, { spinnerFrame: "*", now: 1_700_000_014_000, maxWidth: 72 }));
    assert.match(text, /Working/);
    assert.doesNotMatch(text, /gpt-5\.4/);
    assert.doesNotMatch(text, /—/, "no phase suffix for unmapped types");
});

test("hides when the session is no longer running", () => {
    let state = loadRunningSessionWithActivity([{
        seq: 13,
        eventType: "assistant.reasoning",
        text: "[assistant.reasoning] wrap up",
        createdAt: 1_700_000_002_000,
    }]);
    state = appReducer(state, {
        type: "sessions/loaded",
        sessions: [{
            sessionId: "session-1",
            title: "Live turn",
            status: "idle",
            updatedAt: 1_700_000_002_000,
        }],
    });

    const lines = selectLiveActivityLines(state, { spinnerFrame: "*", now: 1_700_000_014_000, maxWidth: 72 });
    assert.equal(lines.length, 0);
    // (The 5s post-turn linger is host-side — useLingeringLines in the portal —
    // so the selector itself must go empty immediately.)
});
