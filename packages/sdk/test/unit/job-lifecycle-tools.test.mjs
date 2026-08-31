import assert from "node:assert/strict";
import test from "node:test";
import { createJobLifecycleTools } from "../../dist/job-lifecycle-tools.js";

test("read_job_source_session is scoped by the durable current JobSession", async () => {
    const calls = [];
    const transitionedAt = new Date("2026-08-28T12:00:00.000Z");
    const tools = createJobLifecycleTools({
        async readJobSourceSession(currentSessionId, sourceSessionId, beforeSeq, limit) {
            calls.push({ currentSessionId, sourceSessionId, beforeSeq, limit });
            return {
                journalEntry: {
                    sequence: 1,
                    fromState: "Diagnosed",
                    toState: "Fixed",
                    outcome: "Fixed",
                    summary: "Applied the fix and retained the validation evidence.",
                    transitionedAt,
                },
                events: [{
                    seq: 42,
                    sessionId: sourceSessionId,
                    eventType: "session.turn_execution_completed",
                    data: { resultType: "completed" },
                    workerNodeId: "worker-a",
                    createdAt: transitionedAt,
                }],
                hasMore: false,
            };
        },
        async startJobExternalOperation() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    const tool = tools.find((entry) => entry.name === "read_job_source_session");
    const result = JSON.parse(await tool.handler(
        { sessionId: "session-prior", beforeSeq: 100, limit: 10 },
        { durableSessionId: "session-current" },
    ));

    assert.deepEqual(calls, [{
        currentSessionId: "session-current",
        sourceSessionId: "session-prior",
        beforeSeq: 100,
        limit: 10,
    }]);
    assert.equal(result.journal.summary, "Applied the fix and retained the validation evidence.");
    assert.equal(result.events[0].eventType, "session.turn_execution_completed");
    assert.equal(result.previousCursor, 42);
    assert.equal(result.hasMore, false);
});

test("read_job_source_session refuses sessions outside the current Job journal", async () => {
    const tools = createJobLifecycleTools({
        async readJobSourceSession() {
            return null;
        },
        async startJobExternalOperation() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    const tool = tools.find((entry) => entry.name === "read_job_source_session");

    await assert.rejects(
        tool.handler(
            { sessionId: "session-unrelated" },
            { durableSessionId: "session-current" },
        ),
        /not referenced by the current Job journal/,
    );
    await assert.rejects(
        tool.handler({ sessionId: "session-prior" }, {}),
        /durable session context/,
    );
});

test("read_job_source_session enforces its UTF-8 response budget without losing the cursor", async () => {
    const transitionedAt = new Date("2026-08-28T12:00:00.000Z");
    const tools = createJobLifecycleTools({
        async readJobSourceSession() {
            return {
                journalEntry: {
                    sequence: 1,
                    fromState: "Diagnosed",
                    toState: "Fixed",
                    outcome: "Fixed",
                    summary: "Durable summary.",
                    transitionedAt,
                },
                events: Array.from({ length: 50 }, (_, index) => ({
                    seq: index + 1,
                    sessionId: "session-prior",
                    eventType: "session.message",
                    data: { text: "😀".repeat(3_000) },
                    workerNodeId: "worker-a",
                    createdAt: transitionedAt,
                })),
                hasMore: false,
            };
        },
        async startJobExternalOperation() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    const tool = tools.find((entry) => entry.name === "read_job_source_session");
    const raw = await tool.handler(
        { sessionId: "session-prior", limit: 50 },
        { durableSessionId: "session-current" },
    );
    const result = JSON.parse(raw);

    assert.ok(Buffer.byteLength(raw, "utf8") <= 64 * 1024);
    assert.ok(result.events.length < 50);
    assert.ok(result.events[0].seq > 1);
    assert.equal(result.events.at(-1).seq, 50);
    assert.equal(result.previousCursor, result.events[0].seq);
    assert.equal(result.hasMore, true);
    assert.equal(result.events[0].dataTruncated, true);
});

test("complete_state binds completion to the durable session", async () => {
    const calls = [];
    const tools = createJobLifecycleTools({
        async startJobExternalOperation() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async completeJobState(input) {
            calls.push(input);
            return {
                jobId: "job-1",
                fromState: "Diagnosed",
                toState: "Fixed",
                outcome: "Fixed",
                sequence: 2,
            };
        },
    });
    const tool = tools.find((entry) => entry.name === "complete_state");
    assert.equal(tool.pilotswarmTerminalTurnBoundary, true);
    const result = JSON.parse(await tool.handler(
        { outcome: "Fixed", summary: "Applied and verified the fix." },
        { durableSessionId: "session-1" },
    ));

    assert.deepEqual(calls, [{
        sessionId: "session-1",
        outcome: "Fixed",
        summary: "Applied and verified the fix.",
    }]);
    assert.deepEqual(result, {
        completed: true,
        jobId: "job-1",
        fromState: "Diagnosed",
        toState: "Fixed",
        outcome: "Fixed",
        journalSequence: 2,
    });
});

test("complete_state refuses calls without durable session identity", async () => {
    const tools = createJobLifecycleTools({
        async startJobExternalOperation() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    const tool = tools.find((entry) => entry.name === "complete_state");
    await assert.rejects(
        tool.handler({ summary: "Done." }, {}),
        /durable session context/,
    );
});

test("start_external_operation uses infrastructure-owned correlation and signal keys", async () => {
    const calls = [];
    const tools = createJobLifecycleTools({
        async startJobExternalOperation(input) {
            calls.push(input);
            return {
                operationId: "operation-1",
                correlationId: "mock:operation-1",
                signalKey: "job-operation:operation-1",
                provider: "mock",
                kind: "pvs",
                status: "pending",
                signalStatus: "blocked",
            };
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    const tool = tools.find((entry) => entry.name === "start_external_operation");
    const result = JSON.parse(await tool.handler(
        {
            provider: "mock",
            kind: "pvs",
            operationKey: "validation",
            request: { delayMs: 25, result: { passed: true } },
        },
        { durableSessionId: "session-1" },
    ));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, "session-1");
    assert.equal(calls[0].provider, "mock");
    assert.equal(calls[0].kind, "pvs");
    assert.equal(calls[0].operationKey, "validation");
    assert.deepEqual(calls[0].request, { delayMs: 25, result: { passed: true } });
    assert.ok(calls[0].nextPollAt instanceof Date);
    assert.deepEqual(result, {
        operationId: "operation-1",
        correlationId: "mock:operation-1",
        signalKey: "job-operation:operation-1",
        provider: "mock",
        kind: "pvs",
        status: "pending",
        signalStatus: "blocked",
        resumed: false,
    });
});

test("get_external_operation is scoped to the durable session", async () => {
    const calls = [];
    const completedAt = new Date("2026-08-28T12:00:00.000Z");
    const tools = createJobLifecycleTools({
        async startJobExternalOperation() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation(sessionId, operationId) {
            calls.push({ sessionId, operationId });
            return {
                operationId,
                correlationId: "mock:operation-1",
                signalKey: "job-operation:operation-1",
                provider: "mock",
                kind: "pvs",
                status: "succeeded",
                signalStatus: "delivered",
                result: { passed: true },
                evidence: { runId: "run-1" },
                error: null,
                completedAt,
                signalDeliveredAt: completedAt,
            };
        },
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    const tool = tools.find((entry) => entry.name === "get_external_operation");
    const result = JSON.parse(await tool.handler(
        { operationId: "operation-1" },
        { durableSessionId: "session-1" },
    ));

    assert.deepEqual(calls, [{ sessionId: "session-1", operationId: "operation-1" }]);
    assert.deepEqual(result, {
        operationId: "operation-1",
        correlationId: "mock:operation-1",
        signalKey: "job-operation:operation-1",
        provider: "mock",
        kind: "pvs",
        status: "succeeded",
        signalStatus: "delivered",
        result: { passed: true },
        evidence: { runId: "run-1" },
        error: null,
        completedAt: completedAt.toISOString(),
        signalDeliveredAt: completedAt.toISOString(),
    });
});

test("start_external_operation rejects malformed mock outcomes", async () => {
    const tools = createJobLifecycleTools({
        async startJobExternalOperation() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async completeJobState() {
            throw new Error("must not be called");
        },
    });
    const tool = tools.find((entry) => entry.name === "start_external_operation");

    await assert.rejects(
        tool.handler(
            { provider: "mock", kind: "pvs", request: { outcome: "failure" } },
            { durableSessionId: "session-1" },
        ),
        /outcome must be succeeded or failed/,
    );
});
