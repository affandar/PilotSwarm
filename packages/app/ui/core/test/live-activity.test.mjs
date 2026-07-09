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
        text: "20:07 \u25b6 get_file_contents(path: src/x.ts)",
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

test("fact, graph, and skill tools get first-class phases instead of generic tool text", () => {
    const cases = [
        ["read_facts", /— reading facts…/],
        ["facts_search", /— reading facts…/],
        ["store_fact", /— writing facts…/],
        ["graph_search_nodes", /— reading the graph…/],
        ["graph_neighbourhood", /— reading the graph…/],
        ["graph_upsert_node", /— writing to the graph…/],
        ["graph_merge_nodes", /— writing to the graph…/],
        ["search_skills", /— loading skills…/],
    ];
    for (const [tool, expected] of cases) {
        const state = loadRunningSessionWithActivity([{
            seq: 20,
            eventType: "tool.execution_start",
            text: `20:07 \u25b6 ${tool}(q: secret)`,
            createdAt: 1_700_000_002_000,
        }]);
        const text = flatten(selectLiveActivityLines(state, { spinnerFrame: "*", now: 1_700_000_010_000, maxWidth: 96 }));
        assert.match(text, expected, `${tool} phase`);
        assert.doesNotMatch(text, /running tool:/, `${tool} must not fall back to generic phase`);
        assert.doesNotMatch(text, /secret/, `${tool} payload must not leak`);
    }
});

test("SDK knowledge events map directly: skills, facts, graph", () => {
    const cases = [
        ["learned_skill.read", /— loading skills…/],
        ["skills.searched", /— loading skills…/],
        ["facts.searched", /— reading facts…/],
        ["facts.similar", /— reading facts…/],
        ["graph.searched", /— reading the graph…/],
        ["graph.node_loaded", /— reading the graph…/],
        ["graph.namespace_mutated", /— writing to the graph…/],
    ];
    for (const [eventType, expected] of cases) {
        const state = loadRunningSessionWithActivity([{
            seq: 21,
            eventType,
            text: `20:07 [${eventType}] {"detail":"hidden"}`,
            createdAt: 1_700_000_002_000,
        }]);
        const text = flatten(selectLiveActivityLines(state, { spinnerFrame: "*", now: 1_700_000_010_000, maxWidth: 96 }));
        assert.match(text, expected, eventType);
        assert.doesNotMatch(text, /hidden/, `${eventType} payload must not leak`);
    }
});

test("new-turn gap: no stale elapsed or phase while history still shows the previous turn ended", () => {
    // Status is already "running" for the NEW turn, but history so far only
    // contains the PREVIOUS turn (user msg → tool → turn_end). The old bug:
    // elapsed anchored on the stale user message → flashed the whole idle
    // gap ("2h 14m") before snapping to the real timer.
    const state = loadRunningSessionWithActivity([
        { seq: 1, eventType: "assistant.turn_start", text: "[assistant.turn_start] {}", createdAt: 1_700_000_000_500 },
        { seq: 2, eventType: "tool.execution_complete", text: "[tool.execution_complete] search_code {}", createdAt: 1_700_000_001_500 },
        { seq: 3, eventType: "assistant.turn_end", text: "[assistant.turn_end] {}", createdAt: 1_700_000_002_000 },
    ]);

    const text = flatten(selectLiveActivityLines(state, {
        spinnerFrame: "*",
        now: 1_700_008_000_000, // ~2h13m after the stale anchors
        maxWidth: 96,
    }));
    assert.match(text, /Working/);
    assert.doesNotMatch(text, /·/, "no elapsed until evidence of the current turn exists");
    assert.doesNotMatch(text, /2h/, "the idle gap must never flash as elapsed");
    assert.doesNotMatch(text, /finished tool/, "previous turn's phase must not leak");
});

test("cron/command turns anchor elapsed on the current turn_start, not the old user message", () => {
    const state = loadRunningSessionWithActivity([
        { seq: 1, eventType: "assistant.turn_end", text: "[assistant.turn_end] {}", createdAt: 1_700_000_002_000 },
        { seq: 2, eventType: "assistant.turn_start", text: "[assistant.turn_start] {}", createdAt: 1_700_007_935_000 },
        { seq: 3, eventType: "assistant.reasoning", text: "[assistant.reasoning] planning", createdAt: 1_700_007_940_000 },
    ]);

    const text = flatten(selectLiveActivityLines(state, {
        spinnerFrame: "*",
        now: 1_700_008_000_000, // 65s after the new turn_start
        maxWidth: 96,
    }));
    assert.match(text, /1m 05s/, "elapsed measures the current turn, not the gap since the last user message");
    assert.match(text, /— thinking…/);
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
