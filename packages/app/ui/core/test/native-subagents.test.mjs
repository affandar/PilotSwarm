import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel, appendEventToHistory } from "../src/history.js";

test("native lifecycle is visible without leaking child answers into parent chat", () => {
    const events = [
        ["subagent.started", { agentName: "swarm-explore", nativeAgentId: "child" }],
        ["native.assistant.message", { content: "CHILD_ANSWER", nativeAgentId: "child" }],
        ["subagent.completed", { agentName: "swarm-explore", durationMs: 1234, nativeAgentId: "child" }],
        ["assistant.message", { content: "PARENT_ANSWER" }],
        ["session.turn_completed", { resultType: "completed" }],
    ].map(([eventType, data], seq) => ({ eventType, data, seq: seq + 1, sessionId: "parent", createdAt: new Date().toISOString() }));
    const replay = buildHistoryModel(events);
    const live = events.slice(1).reduce(appendEventToHistory, buildHistoryModel(events.slice(0, 1)));
    for (const model of [replay, live]) {
        assert.deepEqual(model.chat.map(m => m.text), ["PARENT_ANSWER"]);
        assert.equal(model.chat[0].responseFinal, true);
        assert.ok(model.activity.some(e => e.text.includes("[native agent] swarm-explore started")));
        assert.ok(model.activity.some(e => e.text.includes("[native agent] swarm-explore completed")));
        assert.ok(!model.activity.some(e => e.text.includes("CHILD_ANSWER")));
    }
});
