import assert from "node:assert/strict";
import test from "node:test";
import { createJobLifecycleTools } from "../../dist/job-lifecycle-tools.js";
import {
    azureDevOpsPullRequestApprovalOperationKey,
    azureDevOpsPullRequestCompletionOperationKey,
    azureDevOpsPullRequestResourceKey,
} from "../../dist/azure-devops-job-waits.js";

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
    const before = Date.now();
    const result = JSON.parse(await tool.handler(
        {
            provider: "mock",
            kind: "pvs",
            operationKey: "validation",
            detectionMode: "hybrid",
            deadlineSeconds: 60,
            request: { delayMs: 25, result: { passed: true } },
        },
        { durableSessionId: "session-1" },
    ));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, "session-1");
    assert.equal(calls[0].provider, "mock");
    assert.equal(calls[0].kind, "pvs");
    assert.equal(calls[0].operationKey, "validation");
    assert.equal(calls[0].detectionMode, "hybrid");
    assert.ok(calls[0].deadlineAt.getTime() >= before + 60_000);
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

test("start_external_operation validates and normalizes Azure DevOps approval targets", async () => {
    const calls = [];
    const sourceCommit = "a".repeat(40);
    const tools = createJobLifecycleTools({
        async startJobExternalOperation(input) {
            calls.push(input);
            return {
                operationId: "operation-ado-1",
                correlationId: "azure_devops:operation-ado-1",
                signalKey: "job-operation:operation-ado-1",
                provider: "azure_devops",
                kind: "pull_request_approval",
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
    await tool.handler(
        {
            provider: "azure_devops",
            kind: "pull_request_approval",
            detectionMode: "hybrid",
            request: {
                organization: "https://dev.azure.com/Contoso/",
                project: "Project",
                repositoryId: "repo-1",
                pullRequestId: 42,
                expectedSourceCommit: sourceCommit.toUpperCase(),
                resourceKey: "caller-controlled-value",
            },
        },
        { durableSessionId: "session-1" },
    );

    const expectedIdentity = {
        organization: "Contoso",
        project: "Project",
        repositoryId: "repo-1",
        pullRequestId: 42,
    };
    assert.equal(calls[0].provider, "azure_devops");
    assert.equal(calls[0].kind, "pull_request_approval");
    assert.equal(
        calls[0].operationKey,
        azureDevOpsPullRequestApprovalOperationKey(calls[0].request),
    );
    assert.equal(calls[0].detectionMode, "hybrid");
    assert.deepEqual(calls[0].request, {
        ...expectedIdentity,
        expectedSourceCommit: sourceCommit,
        resourceKey: azureDevOpsPullRequestResourceKey(expectedIdentity),
    });
    assert.ok(calls[0].nextPollAt instanceof Date);
});

test("start_external_operation keys Azure DevOps approval waits by repository and commit", async () => {
    const calls = [];
    const tools = createJobLifecycleTools({
        async startJobExternalOperation(input) {
            calls.push(input);
            return {
                operationId: `operation-${calls.length}`,
                correlationId: `azure_devops:operation-${calls.length}`,
                signalKey: `job-operation:operation-${calls.length}`,
                provider: "azure_devops",
                kind: "pull_request_approval",
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
    const request = {
        organization: "Contoso",
        project: "Project",
        repositoryId: "repo-1",
        pullRequestId: 42,
        expectedSourceCommit: "a".repeat(40),
    };
    await tool.handler(
        { provider: "azure_devops", kind: "pull_request_approval", request },
        { durableSessionId: "session-1" },
    );
    await tool.handler(
        {
            provider: "azure_devops",
            kind: "pull_request_approval",
            request: { ...request, expectedSourceCommit: "b".repeat(40) },
        },
        { durableSessionId: "session-1" },
    );
    await tool.handler(
        {
            provider: "azure_devops",
            kind: "pull_request_approval",
            request: { ...request, repositoryId: "repo-2" },
        },
        { durableSessionId: "session-1" },
    );

    assert.equal(new Set(calls.map((call) => call.operationKey)).size, 3);
});

test("start_external_operation rejects unsupported Azure DevOps predicates", async () => {
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
            {
                provider: "azure_devops",
                kind: "deployment",
                request: {},
            },
            { durableSessionId: "session-1" },
        ),
        /currently supports only pull_request_approval/,
    );
});

test("start_external_operation validates Azure DevOps completion targets", async () => {
    const calls = [];
    const sourceCommit = "a".repeat(40);
    const tools = createJobLifecycleTools({
        async startJobExternalOperation(input) {
            calls.push(input);
            return {
                operationId: "operation-ado-completion-1",
                correlationId: "azure_devops:operation-ado-completion-1",
                signalKey: "job-operation:operation-ado-completion-1",
                provider: "azure_devops",
                kind: "pull_request_completion",
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
    await tool.handler(
        {
            provider: "azure_devops",
            kind: "pull_request_completion",
            request: {
                organization: "https://dev.azure.com/Contoso/",
                project: "Project",
                repositoryId: "repo-1",
                pullRequestId: 42,
                expectedSourceCommit: sourceCommit.toUpperCase(),
            },
        },
        { durableSessionId: "session-1" },
    );

    const expectedIdentity = {
        organization: "Contoso",
        project: "Project",
        repositoryId: "repo-1",
        pullRequestId: 42,
    };
    assert.equal(calls[0].kind, "pull_request_completion");
    assert.equal(
        calls[0].operationKey,
        azureDevOpsPullRequestCompletionOperationKey(calls[0].request),
    );
    assert.notEqual(
        azureDevOpsPullRequestCompletionOperationKey(calls[0].request),
        azureDevOpsPullRequestApprovalOperationKey(calls[0].request),
    );
    assert.deepEqual(calls[0].request, {
        ...expectedIdentity,
        expectedSourceCommit: sourceCommit,
        resourceKey: azureDevOpsPullRequestResourceKey(expectedIdentity),
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
