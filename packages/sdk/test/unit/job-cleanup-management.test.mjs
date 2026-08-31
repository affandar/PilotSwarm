import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmManagementClient } from "../../dist/index.js";

const actor = {
    provider: "dev",
    subject: "alice",
    email: "alice@example.test",
    displayName: "Alice",
};

function createClient(plan) {
    const calls = [];
    const client = new PilotSwarmManagementClient({});
    client._started = true;
    client._duroxideClient = {
        async deleteInstance(orchestrationId, force) {
            calls.push({ method: "deleteInstance", orchestrationId, force });
        },
        async getInstanceInfo() {
            throw new Error("instance not found");
        },
    };
    client._catalog = {
        async beginJobGeneratorCleanup(generatorId, cleanupActor, isAdmin) {
            calls.push({ method: "begin", generatorId, cleanupActor, isAdmin });
            return plan;
        },
        async beginSessionTreeDeletion(sessionId) {
            calls.push({ method: "fence", sessionId });
        },
        async getDescendantSessionIdsIncludingDeleted(sessionId) {
            calls.push({ method: "descendants", sessionId });
            return sessionId === "session-root"
                ? ["session-child"]
                : [];
        },
        async recordJobCleanupSessions(aggregateType, aggregateId, sessionIds) {
            calls.push({ method: "recordSessions", aggregateType, aggregateId, sessionIds: [...sessionIds].sort() });
            return [...new Set(sessionIds)].sort();
        },
        async getSession(sessionId) {
            calls.push({ method: "getSession", sessionId });
            return null;
        },
        async completeJobCleanup(aggregateType, aggregateId, outcome) {
            calls.push({ method: "complete", aggregateType, aggregateId, outcome });
        },
    };
    client.deleteSession = async (sessionId) => {
        calls.push({ method: "deleteSession", sessionId });
    };
    return { client, calls };
}

test("management cleanup completes only after roots and descendants disappear", async () => {
    const plan = {
        aggregateType: "generator",
        aggregateId: "generator-1",
        generatorId: "generator-1",
        jobIds: ["job-1"],
        sessionIds: ["session-root"],
        alreadyDeleted: false,
    };
    const { client, calls } = createClient(plan);

    const result = await client.deleteJobGenerator("generator-1", actor, false);

    assert.deepEqual(result, {
        aggregateType: "generator",
        aggregateId: "generator-1",
        alreadyDeleted: false,
        deletedSessionCount: 2,
    });
    assert.deepEqual(
        calls.filter((call) => call.method === "getSession").map((call) => call.sessionId).sort(),
        ["session-child", "session-root"],
    );
    assert.deepEqual(
        calls.filter((call) => call.method === "deleteSession").map((call) => call.sessionId),
        ["session-child", "session-root"],
    );
    assert.deepEqual(calls.find((call) => call.method === "recordSessions"), {
        method: "recordSessions",
        aggregateType: "generator",
        aggregateId: "generator-1",
        sessionIds: ["session-child", "session-root"],
    });
    assert.deepEqual(calls.at(-1), {
        method: "complete",
        aggregateType: "generator",
        aggregateId: "generator-1",
        outcome: {
            status: "completed",
            deletedSessionCount: 2,
        },
    });
});

test("management cleanup records a retryable failure when a session remains visible", async () => {
    const plan = {
        aggregateType: "generator",
        aggregateId: "generator-1",
        generatorId: "generator-1",
        jobIds: ["job-1"],
        sessionIds: ["session-root"],
        alreadyDeleted: true,
    };
    const { client, calls } = createClient(plan);
    client.deleteSession = async (sessionId) => {
        calls.push({ method: "deleteSession", sessionId });
        throw new Error("temporary deletion failure");
    };
    client._catalog.getSession = async (sessionId) => {
        calls.push({ method: "getSession", sessionId });
        return sessionId === "session-root" ? { sessionId } : null;
    };

    await assert.rejects(
        client.deleteJobGenerator("generator-1", actor, false),
        (error) => (
            error.code === "JOB_CLEANUP_INCOMPLETE"
            && error.message.includes("session-root")
        ),
    );

    const completion = calls.find((call) => call.method === "complete");
    assert.equal(completion.aggregateType, "generator");
    assert.equal(completion.aggregateId, "generator-1");
    assert.equal(completion.outcome.status, "failed");
    assert.match(completion.outcome.error, /session-root/);
});

test("management cleanup does not complete while an orchestration still exists", async () => {
    const plan = {
        aggregateType: "job",
        aggregateId: "job-1",
        generatorId: "generator-1",
        jobId: "job-1",
        sessionIds: ["session-root"],
        alreadyDeleted: false,
    };
    const { client, calls } = createClient(plan);
    client._duroxideClient.getInstanceInfo = async () => ({ status: "Running" });

    await assert.rejects(
        client._executeJobCleanup(plan),
        (error) => (
            error.code === "JOB_CLEANUP_INCOMPLETE"
            && error.message.includes("orchestrations still present")
        ),
    );

    const completion = calls.find((call) => call.method === "complete");
    assert.equal(completion.outcome.status, "failed");
    assert.match(completion.outcome.error, /session-root \(Running\)/);
    assert.deepEqual(
        calls.filter((call) => call.method === "deleteInstance").map((call) => call.orchestrationId),
        ["session-session-child", "session-session-root"],
    );
});

test("management cleanup requires terminal orchestration history to be removed", async () => {
    const plan = {
        aggregateType: "job",
        aggregateId: "job-1",
        generatorId: "generator-1",
        jobId: "job-1",
        sessionIds: ["session-root"],
        alreadyDeleted: false,
    };
    const { client, calls } = createClient(plan);
    client._duroxideClient.getInstanceInfo = async () => ({ status: "Completed" });

    await assert.rejects(
        client._executeJobCleanup(plan),
        (error) => (
            error.code === "JOB_CLEANUP_INCOMPLETE"
            && error.message.includes("session-root (Completed)")
        ),
    );

    assert.equal(calls.find((call) => call.method === "complete").outcome.status, "failed");
});

test("cleanup retries a persisted descendant after its CMS row was already soft-deleted", async () => {
    const persistedSessionIds = new Set(["session-root"]);
    const runningOrchestrations = new Set(["session-child"]);
    let failChildDeletion = true;
    const completions = [];
    const client = new PilotSwarmManagementClient({});
    client._started = true;
    client._catalog = {
        async beginSessionTreeDeletion() {},
        async getDescendantSessionIdsIncludingDeleted(sessionId) {
            return sessionId === "session-root" && !persistedSessionIds.has("session-child")
                ? ["session-child"]
                : [];
        },
        async recordJobCleanupSessions(_aggregateType, _aggregateId, sessionIds) {
            for (const sessionId of sessionIds) persistedSessionIds.add(sessionId);
            return [...persistedSessionIds].sort();
        },
        async getSession() {
            return null;
        },
        async completeJobCleanup(aggregateType, aggregateId, outcome) {
            completions.push({ aggregateType, aggregateId, outcome });
        },
    };
    client.deleteSession = async () => {};
    client._duroxideClient = {
        async deleteInstance(orchestrationId) {
            const sessionId = orchestrationId.replace(/^session-/, "");
            if (sessionId === "session-child" && failChildDeletion) {
                throw new Error("temporary orchestration delete failure");
            }
            runningOrchestrations.delete(sessionId);
        },
        async getInstanceInfo(orchestrationId) {
            const sessionId = orchestrationId.replace(/^session-/, "");
            if (runningOrchestrations.has(sessionId)) return { status: "Running" };
            throw new Error("instance not found");
        },
    };

    const firstPlan = {
        aggregateType: "job",
        aggregateId: "job-1",
        generatorId: "generator-1",
        jobId: "job-1",
        sessionIds: ["session-root"],
        alreadyDeleted: false,
    };
    await assert.rejects(
        client._executeJobCleanup(firstPlan),
        (error) => error.code === "JOB_CLEANUP_INCOMPLETE",
    );
    assert.deepEqual([...persistedSessionIds].sort(), ["session-child", "session-root"]);

    failChildDeletion = false;
    const retryResult = await client._executeJobCleanup({
        ...firstPlan,
        sessionIds: [...persistedSessionIds],
        alreadyDeleted: true,
    });

    assert.equal(retryResult.deletedSessionCount, 2);
    assert.equal(runningOrchestrations.size, 0);
    assert.equal(completions.at(-1).outcome.status, "completed");
});
