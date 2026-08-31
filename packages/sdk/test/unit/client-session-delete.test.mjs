import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/index.js";

function createClient(instanceInfo) {
    const calls = [];
    const client = new PilotSwarmClient({ store: "sqlite::memory:" });
    client._catalog = {
        async getSession(sessionId) {
            return { sessionId, isSystem: false };
        },
        async beginSessionTreeDeletion(sessionId) {
            calls.push({ method: "beginSessionTreeDeletion", sessionId });
        },
        async getDescendantSessionIdsIncludingDeleted() {
            return [];
        },
        async softDeleteSession(sessionId) {
            calls.push({ method: "softDeleteSession", sessionId });
        },
    };
    client.duroxideClient = {
        async cancelInstance(orchestrationId) {
            calls.push({ method: "cancelInstance", orchestrationId });
            throw new Error("temporary cancel failure");
        },
        async deleteInstance(orchestrationId, force) {
            calls.push({ method: "deleteInstance", orchestrationId, force });
            throw new Error("temporary delete failure");
        },
        async getInstanceInfo(orchestrationId) {
            calls.push({ method: "getInstanceInfo", orchestrationId });
            if (instanceInfo) return instanceInfo;
            throw new Error("instance not found");
        },
    };
    return { client, calls };
}

test("direct session deletion fails while any Duroxide instance still exists", async () => {
    const { client } = createClient({ status: "Completed" });

    await assert.rejects(
        client.deleteSession("session-1"),
        (error) => (
            error instanceof AggregateError
            && error.errors.some((entry) => (
                entry instanceof Error
                && entry.message.includes("SESSION_ORCHESTRATION_DELETE_INCOMPLETE")
            ))
        ),
    );
});

test("direct session deletion succeeds only after Duroxide absence is verified", async () => {
    const { client, calls } = createClient(null);

    await client.deleteSession("session-1");

    assert.deepEqual(calls.map((call) => call.method), [
        "beginSessionTreeDeletion",
        "softDeleteSession",
        "cancelInstance",
        "deleteInstance",
        "getInstanceInfo",
    ]);
});

test("sending cannot recreate an orchestration for a deleted CMS session", async () => {
    const client = new PilotSwarmClient({ store: "sqlite::memory:" });
    let started = false;
    client._catalog = {
        async getSession() {
            return null;
        },
        async isSessionActive() {
            return false;
        },
    };
    client.duroxideClient = {
        async startOrchestrationVersioned() {
            started = true;
        },
    };

    await assert.rejects(
        client._ensureOrchestrationAndSend("session-1", "bootstrap", { bootstrap: true }),
        /was deleted or does not exist/,
    );
    assert.equal(started, false);
});

test("a deletion fence that wins after orchestration start forces compensation", async () => {
    const client = new PilotSwarmClient({ store: "sqlite::memory:" });
    const calls = [];
    const liveness = [true, true, false];
    client._catalog = {
        async getSession() {
            return {
                sessionId: "session-1",
                state: "pending",
                isSystem: false,
                parentSessionId: null,
            };
        },
        async isSessionActive() {
            return liveness.shift() ?? false;
        },
        async updateSession() {
            calls.push("update");
        },
    };
    client.duroxideClient = {
        async startOrchestrationVersioned() {
            calls.push("start");
        },
        async enqueueEvent() {
            calls.push("enqueue");
        },
        async cancelInstance() {
            calls.push("cancel");
        },
        async deleteInstance() {
            calls.push("delete");
        },
        async getInstanceInfo() {
            calls.push("verify");
            throw new Error("instance not found");
        },
    };

    await assert.rejects(
        client._ensureOrchestrationAndSend("session-1", "bootstrap", { bootstrap: true }),
        (error) => error.code === "SESSION_DELETION_FENCE",
    );
    assert.deepEqual(calls, ["start", "cancel", "delete", "verify"]);
});

test("direct deletion retries soft-deleted descendants until orchestration history is absent", async () => {
    const client = new PilotSwarmClient({ store: "sqlite::memory:" });
    let childDeleteAttempts = 0;
    let childStillExists = true;
    client._catalog = {
        async getSession() {
            return null;
        },
        async beginSessionTreeDeletion() {},
        async getDescendantSessionIdsIncludingDeleted() {
            return ["session-child"];
        },
        async softDeleteSession() {},
    };
    client.duroxideClient = {
        async cancelInstance() {},
        async deleteInstance(orchestrationId) {
            if (orchestrationId === "session-session-child") {
                childDeleteAttempts += 1;
                if (childDeleteAttempts === 1) throw new Error("temporary delete failure");
                childStillExists = false;
            }
        },
        async getInstanceInfo(orchestrationId) {
            if (orchestrationId === "session-session-child" && childStillExists) {
                return { status: "Completed" };
            }
            throw new Error("instance not found");
        },
    };

    await assert.rejects(client.deleteSession("session-root"), AggregateError);
    await client.deleteSession("session-root");

    assert.equal(childDeleteAttempts, 2);
    assert.equal(childStillExists, false);
});
