import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/index.js";

function createClient() {
    const client = new PilotSwarmClient({ store: "sqlite::memory:" });
    const state = { startInput: null, enqueued: [] };
    client._catalog = {
        async getSession(sessionId) {
            return { sessionId, state: "active", isSystem: false, parentSessionId: null };
        },
        async isSessionActive() {
            return true;
        },
        async updateSession() {},
    };
    client.duroxideClient = {
        async startOrchestrationVersioned(orchestrationId, name, input) {
            state.startInput = input;
        },
        async enqueueEvent(orchestrationId, queue, payload) {
            state.enqueued.push({ orchestrationId, queue, payload: JSON.parse(payload) });
        },
    };
    return { client, state };
}

test("bootstrap first turn rides the durable start input with no messages enqueue", async () => {
    const { client, state } = createClient();

    const orchestrationId = await client._ensureOrchestrationAndSend(
        "session-1",
        "diagnose the failing build",
        { bootstrap: true, clientMessageIds: ["message-1"], requiredTool: "run_build" },
    );

    assert.equal(orchestrationId, "session-session-1");
    // The first turn is delivered atomically as part of the start input.
    assert.equal(state.startInput.prompt, "diagnose the failing build");
    assert.equal(state.startInput.bootstrapPrompt, true);
    assert.equal(state.startInput.requiredTool, "run_build");
    assert.deepEqual(state.startInput.recentClientMessageIds, ["message-1"]);
    // No separate, non-atomic kickoff event is enqueued for a bootstrap.
    assert.deepEqual(state.enqueued, []);
});

test("a non-bootstrap first send keeps the separate messages enqueue", async () => {
    const { client, state } = createClient();

    await client._ensureOrchestrationAndSend(
        "session-1",
        "hello there",
        { clientMessageIds: ["message-1"] },
    );

    // A non-bootstrap send must not fold the turn into the start input.
    assert.equal(state.startInput.prompt, undefined);
    assert.equal(state.startInput.bootstrapPrompt, undefined);
    // The turn is delivered via the existing "messages" event path.
    assert.equal(state.enqueued.length, 1);
    assert.equal(state.enqueued[0].queue, "messages");
    assert.equal(state.enqueued[0].payload.prompt, "hello there");
    assert.deepEqual(state.enqueued[0].payload.clientMessageIds, ["message-1"]);
    assert.equal(state.enqueued[0].payload.bootstrap, undefined);
});
