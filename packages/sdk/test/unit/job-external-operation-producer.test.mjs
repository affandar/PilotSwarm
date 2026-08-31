import assert from "node:assert/strict";
import test from "node:test";
import {
    JobWaitScheduler,
    MockJobWaitObserver,
} from "../../dist/job-external-operation-producer.js";

function wait(overrides = {}) {
    return {
        waitId: "wait-1",
        sessionId: "session-1",
        externalOperationId: "operation-1",
        providerCursor: null,
        latestObservation: null,
        deadlineAt: null,
        checkAttempts: 1,
        consecutiveCheckFailures: 0,
        ...overrides,
    };
}

function operation(overrides = {}) {
    return {
        operationId: "operation-1",
        sessionId: "session-1",
        signalKey: "job-operation:operation-1",
        correlationId: "mock:operation-1",
        provider: "mock",
        kind: "validation",
        request: {},
        status: "pending",
        result: null,
        evidence: null,
        error: null,
        ...overrides,
    };
}

function store(overrides = {}) {
    return {
        async claimDueJobWaits() {
            return [];
        },
        async completeJobWaitCheck() {
            throw new Error("must not be called");
        },
        async getJobExternalOperation() {
            throw new Error("must not be called");
        },
        async claimJobExternalOperationSignals() {
            return [];
        },
        async markJobExternalOperationSignalDelivered() {
            throw new Error("must not be called");
        },
        async markJobExternalOperationSignalFailed() {
            throw new Error("must not be called");
        },
        ...overrides,
    };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test("scheduler satisfies an observed condition and delivers its matching signal", async () => {
    const completions = [];
    const delivered = [];
    const signals = [];
    const pendingWait = wait();
    const pendingOperation = operation({
        request: {
            result: { passed: true },
            evidence: { runId: "validation-1" },
        },
    });
    const readySignal = operation({
        status: "succeeded",
        result: { passed: true },
        evidence: { runId: "validation-1" },
    });
    const scheduler = new JobWaitScheduler({
        workerId: "scheduler-1",
        observers: [new MockJobWaitObserver()],
        store: store({
            async claimDueJobWaits() {
                return [pendingWait];
            },
            async getJobExternalOperation() {
                return pendingOperation;
            },
            async completeJobWaitCheck(input) {
                completions.push(input);
            },
            async claimJobExternalOperationSignals() {
                return [readySignal];
            },
            async markJobExternalOperationSignalDelivered(operationId, workerId) {
                delivered.push({ operationId, workerId });
            },
        }),
        signalSender: {
            async sendSystemSignal(sessionId, signalKey, payload) {
                signals.push({ sessionId, signalKey, payload });
            },
        },
        logger: quietLogger,
    });

    const result = await scheduler.runOnce();

    assert.deepEqual(result, {
        checked: 1,
        pending: 0,
        satisfied: 1,
        failed: 0,
        timedOut: 0,
        checkFailed: 0,
        delivered: 1,
        deliveryFailed: 0,
    });
    assert.deepEqual(completions, [{
        waitId: "wait-1",
        workerId: "scheduler-1",
        disposition: "satisfied",
        observation: { passed: true },
        providerCursor: undefined,
        evidence: { runId: "validation-1" },
        result: { passed: true },
        error: null,
        nextCheckAt: undefined,
    }]);
    assert.equal(signals[0].sessionId, "session-1");
    assert.equal(signals[0].signalKey, "job-operation:operation-1");
    assert.equal(signals[0].payload.operationId, "operation-1");
    assert.deepEqual(delivered, [{ operationId: "operation-1", workerId: "scheduler-1" }]);
});

test("scheduler persists pending observations and schedules the next check", async () => {
    const completions = [];
    const scheduler = new JobWaitScheduler({
        workerId: "scheduler-1",
        defaultCheckIntervalMs: 250,
        observers: [{
            provider: "example",
            async observe() {
                return {
                    disposition: "pending",
                    observation: { state: "running" },
                    cursor: "cursor-2",
                };
            },
        }],
        store: store({
            async claimDueJobWaits() {
                return [wait()];
            },
            async getJobExternalOperation() {
                return operation({ provider: "example" });
            },
            async completeJobWaitCheck(input) {
                completions.push(input);
            },
        }),
        signalSender: { async sendSystemSignal() {} },
        logger: quietLogger,
    });

    const before = Date.now();
    const result = await scheduler.runOnce();

    assert.equal(result.pending, 1);
    assert.equal(completions[0].disposition, "pending");
    assert.deepEqual(completions[0].observation, { state: "running" });
    assert.equal(completions[0].providerCursor, "cursor-2");
    assert.ok(completions[0].nextCheckAt.getTime() >= before + 250);
});

test("scheduler records observer failures with bounded retry backoff", async () => {
    const completions = [];
    const scheduler = new JobWaitScheduler({
        workerId: "scheduler-1",
        retryDelayMs: 100,
        maxRetryDelayMs: 250,
        observers: [{
            provider: "example",
            async observe() {
                throw new Error("provider unavailable");
            },
        }],
        store: store({
            async claimDueJobWaits() {
                return [wait({
                    checkAttempts: 4,
                    consecutiveCheckFailures: 3,
                    latestObservation: { state: "running" },
                    providerCursor: "cursor-1",
                })];
            },
            async getJobExternalOperation() {
                return operation({ provider: "example" });
            },
            async completeJobWaitCheck(input) {
                completions.push(input);
            },
        }),
        signalSender: { async sendSystemSignal() {} },
        logger: quietLogger,
    });

    const before = Date.now();
    const result = await scheduler.runOnce();

    assert.equal(result.checkFailed, 1);
    assert.equal(completions[0].disposition, "pending");
    assert.equal(completions[0].error, "provider unavailable");
    assert.deepEqual(completions[0].observation, { state: "running" });
    assert.equal(completions[0].providerCursor, "cursor-1");
    assert.ok(completions[0].nextCheckAt.getTime() >= before + 250);
});

test("scheduler lets the catalog apply deadline fencing to a pending observation", async () => {
    const completions = [];
    const scheduler = new JobWaitScheduler({
        workerId: "scheduler-1",
        observers: [{
            provider: "example",
            async observe() {
                return { disposition: "pending", observation: { state: "running" } };
            },
        }],
        store: store({
            async claimDueJobWaits() {
                return [wait({ deadlineAt: new Date(Date.now() - 1_000) })];
            },
            async getJobExternalOperation() {
                return operation({ provider: "example" });
            },
            async completeJobWaitCheck(input) {
                completions.push(input);
                return wait({ status: "timed_out" });
            },
        }),
        signalSender: { async sendSystemSignal() {} },
        logger: quietLogger,
    });

    const result = await scheduler.runOnce();

    assert.equal(result.timedOut, 1);
    assert.equal(completions[0].disposition, "pending");
    assert.deepEqual(completions[0].observation, { state: "running" });
});

test("scheduler retries waits whose provider has no registered observer", async () => {
    const completions = [];
    const scheduler = new JobWaitScheduler({
        workerId: "scheduler-1",
        retryDelayMs: 50,
        store: store({
            async claimDueJobWaits() {
                return [wait()];
            },
            async getJobExternalOperation() {
                return operation({ provider: "unregistered" });
            },
            async completeJobWaitCheck(input) {
                completions.push(input);
            },
        }),
        signalSender: { async sendSystemSignal() {} },
        logger: quietLogger,
    });

    const result = await scheduler.runOnce();

    assert.equal(result.checkFailed, 1);
    assert.match(completions[0].error, /No JobWait observer registered/);
});

test("scheduler continues after a check failure and a signal delivery failure", async () => {
    const completions = [];
    const failures = [];
    const scheduler = new JobWaitScheduler({
        workerId: "scheduler-1",
        observers: [{
            provider: "example",
            async observe({ wait: claimed }) {
                if (claimed.waitId === "wait-1") throw new Error("first check failed");
                return { disposition: "satisfied", result: { passed: true } };
            },
        }],
        store: store({
            async claimDueJobWaits() {
                return [
                    wait(),
                    wait({ waitId: "wait-2", externalOperationId: "operation-2" }),
                ];
            },
            async getJobExternalOperation(_sessionId, operationId) {
                return operation({ operationId, provider: "example" });
            },
            async completeJobWaitCheck(input) {
                completions.push(input);
            },
            async claimJobExternalOperationSignals() {
                return [operation({ status: "succeeded" })];
            },
            async markJobExternalOperationSignalFailed(operationId, workerId, error, retryAt) {
                failures.push({ operationId, workerId, error, retryAt });
            },
        }),
        signalSender: {
            async sendSystemSignal() {
                throw new Error("orchestration unavailable");
            },
        },
        logger: quietLogger,
    });

    const result = await scheduler.runOnce();

    assert.equal(result.checkFailed, 1);
    assert.equal(result.satisfied, 1);
    assert.equal(result.deliveryFailed, 1);
    assert.equal(completions.length, 2);
    assert.equal(failures[0].error, "orchestration unavailable");
});

test("mock observer fails malformed outcomes instead of treating them as success", async () => {
    const completions = [];
    const scheduler = new JobWaitScheduler({
        workerId: "scheduler-1",
        observers: [new MockJobWaitObserver()],
        store: store({
            async claimDueJobWaits() {
                return [wait()];
            },
            async getJobExternalOperation() {
                return operation({ request: { outcome: "failure" } });
            },
            async completeJobWaitCheck(input) {
                completions.push(input);
            },
        }),
        signalSender: { async sendSystemSignal() {} },
        logger: quietLogger,
    });

    await scheduler.runOnce();

    assert.equal(completions[0].disposition, "failed");
    assert.match(completions[0].error, /outcome must be succeeded or failed/);
});
