import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
} from "../../dist/index.js";

test("direct client records accepted input as a durable session event", async () => {
    const calls = [];
    const client = new PilotSwarmClient({ store: "sqlite::memory:" });
    client._catalog = {
        async recordEvents(sessionId, events) {
            calls.push({ sessionId, events });
        },
    };

    await client._recordInputReceived("session-1", {
        source: "prompt",
        clientMessageIds: ["message-1"],
    });

    assert.deepEqual(calls, [{
        sessionId: "session-1",
        events: [{
            eventType: "session.input_received",
            data: {
                source: "prompt",
                clientMessageIds: ["message-1"],
            },
        }],
    }]);
});

test("management send records durable input acceptance after enqueueing an answer", async () => {
    const calls = [];
    const client = new PilotSwarmManagementClient({});
    client._started = true;
    client.getSession = async () => ({
        sessionId: "session-1",
        status: "input_required",
        parentSessionId: null,
        isSystem: false,
    });
    client._duroxideClient = {
        async getStatus() {
            return { status: "Running" };
        },
        async enqueueEvent(orchestrationId, queue, payload) {
            calls.push({ kind: "enqueue", orchestrationId, queue, payload: JSON.parse(payload) });
        },
    };
    client._catalog = {
        async updateSession() {},
        async recordEvents(sessionId, events) {
            calls.push({ kind: "events", sessionId, events });
        },
    };

    await client.sendMessage("session-1", "Approved", {
        clientMessageIds: ["message-1"],
    });

    assert.deepEqual(calls, [
        {
            kind: "enqueue",
            orchestrationId: "session-session-1",
            queue: "messages",
            payload: {
                prompt: "Approved",
                clientMessageIds: ["message-1"],
            },
        },
        {
            kind: "events",
            sessionId: "session-1",
            events: [{
                eventType: "session.input_received",
                data: {
                    source: "prompt",
                    clientMessageIds: ["message-1"],
                },
            }],
        },
    ]);
});

test("management sendAnswer records input acceptance after the durable answer enqueue", async () => {
    const calls = [];
    const client = new PilotSwarmManagementClient({});
    client._started = true;
    client._duroxideClient = {
        async getStatus() {
            return { status: "Running" };
        },
        async enqueueEvent(orchestrationId, queue, payload) {
            calls.push({ kind: "enqueue", orchestrationId, queue, payload: JSON.parse(payload) });
        },
    };
    client._catalog = {
        async recordEvents(sessionId, events) {
            calls.push({ kind: "events", sessionId, events });
        },
    };

    await client.sendAnswer("session-1", "Approved");

    assert.deepEqual(calls, [
        {
            kind: "enqueue",
            orchestrationId: "session-session-1",
            queue: "messages",
            payload: {
                answer: "Approved",
                wasFreeform: true,
            },
        },
        {
            kind: "events",
            sessionId: "session-1",
            events: [{
                eventType: "session.input_received",
                data: { source: "answer" },
            }],
        },
    ]);
});

test("management history fallback merges multiple executions chronologically", async () => {
    const client = new PilotSwarmManagementClient({});
    client._started = true;
    client._duroxideClient = {
        async listExecutions() {
            return [2, 1];
        },
        async readExecutionHistory(_orchestrationId, executionId) {
            return [{
                eventId: executionId * 10,
                kind: "QueueEventDelivered",
                timestampMs: executionId === 1 ? 100 : 200,
                data: "{}",
            }];
        },
    };

    const history = await client._getAllExecutionHistory("session-1");

    assert.deepEqual(history.map((event) => ({
        executionId: event.executionId,
        eventId: event.eventId,
        timestampMs: event.timestampMs,
    })), [
        { executionId: 1, eventId: 10, timestampMs: 100 },
        { executionId: 2, eventId: 20, timestampMs: 200 },
    ]);
});

test("management history fallback surfaces durable history read failures", async () => {
    const client = new PilotSwarmManagementClient({});
    client._started = true;
    client._duroxideClient = {
        async listExecutions() {
            throw new Error("history store unavailable");
        },
    };

    await assert.rejects(
        client._getAllExecutionHistory("session-1"),
        /history store unavailable/,
    );
});
