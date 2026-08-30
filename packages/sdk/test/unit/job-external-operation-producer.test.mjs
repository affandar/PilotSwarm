import assert from "node:assert/strict";
import test from "node:test";
import { MockJobExternalOperationProducer } from "../../dist/job-external-operation-producer.js";

function operation(overrides = {}) {
    return {
        operationId: "operation-1",
        sessionId: "session-1",
        signalKey: "job-operation:operation-1",
        correlationId: "mock:operation-1",
        provider: "mock",
        kind: "pvs",
        request: {},
        status: "pending",
        result: null,
        evidence: null,
        error: null,
        ...overrides,
    };
}

test("mock producer completes an operation and delivers its matching signal", async () => {
    const completed = [];
    const delivered = [];
    const signals = [];
    const pending = operation({
        request: {
            result: { passed: true },
            evidence: { runId: "pvs-1" },
        },
    });
    const readySignal = operation({
        status: "succeeded",
        result: { passed: true },
        evidence: { runId: "pvs-1" },
    });
    const producer = new MockJobExternalOperationProducer({
        workerId: "producer-1",
        store: {
            async claimDueJobExternalOperations() {
                return [pending];
            },
            async completeJobExternalOperation(input) {
                completed.push(input);
                return readySignal;
            },
            async claimJobExternalOperationSignals() {
                return [readySignal];
            },
            async markJobExternalOperationSignalDelivered(operationId, workerId) {
                delivered.push({ operationId, workerId });
            },
            async markJobExternalOperationSignalFailed() {
                throw new Error("must not be called");
            },
        },
        signalSender: {
            async sendSystemSignal(sessionId, signalKey, payload) {
                signals.push({ sessionId, signalKey, payload });
            },
        },
        logger: { info() {}, warn() {}, error() {} },
    });

    const result = await producer.runOnce();

    assert.deepEqual(result, { completed: 1, delivered: 1, deliveryFailed: 0 });
    assert.deepEqual(completed, [{
        operationId: "operation-1",
        workerId: "producer-1",
        status: "succeeded",
        result: { passed: true },
        evidence: { runId: "pvs-1" },
        error: null,
    }]);
    assert.equal(signals[0].sessionId, "session-1");
    assert.equal(signals[0].signalKey, "job-operation:operation-1");
    assert.equal(signals[0].payload.operationId, "operation-1");
    assert.deepEqual(delivered, [{ operationId: "operation-1", workerId: "producer-1" }]);
});

test("mock producer persists signal delivery failures for retry", async () => {
    const failures = [];
    const readySignal = operation({ status: "succeeded" });
    const producer = new MockJobExternalOperationProducer({
        workerId: "producer-1",
        retryDelayMs: 50,
        store: {
            async claimDueJobExternalOperations() {
                return [];
            },
            async completeJobExternalOperation() {
                throw new Error("must not be called");
            },
            async claimJobExternalOperationSignals() {
                return [readySignal];
            },
            async markJobExternalOperationSignalDelivered() {
                throw new Error("must not be called");
            },
            async markJobExternalOperationSignalFailed(operationId, workerId, error, retryAt) {
                failures.push({ operationId, workerId, error, retryAt });
            },
        },
        signalSender: {
            async sendSystemSignal() {
                throw new Error("orchestration unavailable");
            },
        },
        logger: { info() {}, warn() {}, error() {} },
    });

    const before = Date.now();
    const result = await producer.runOnce();

    assert.deepEqual(result, { completed: 0, delivered: 0, deliveryFailed: 1 });
    assert.equal(failures[0].operationId, "operation-1");
    assert.equal(failures[0].workerId, "producer-1");
    assert.equal(failures[0].error, "orchestration unavailable");
    assert.ok(failures[0].retryAt.getTime() >= before + 50);
});

test("mock producer continues after completion and delivery bookkeeping failures", async () => {
    const completed = [];
    const sent = [];
    const marked = [];
    const first = operation({ operationId: "operation-1" });
    const second = operation({
        operationId: "operation-2",
        signalKey: "job-operation:operation-2",
        correlationId: "mock:operation-2",
    });
    const producer = new MockJobExternalOperationProducer({
        workerId: "producer-1",
        store: {
            async claimDueJobExternalOperations() {
                return [first, second];
            },
            async completeJobExternalOperation(input) {
                if (input.operationId === "operation-1") throw new Error("lost completion lease");
                completed.push(input.operationId);
                return second;
            },
            async claimJobExternalOperationSignals() {
                return [
                    { ...first, status: "succeeded" },
                    { ...second, status: "succeeded" },
                ];
            },
            async markJobExternalOperationSignalDelivered(operationId) {
                if (operationId === "operation-1") throw new Error("database unavailable");
                marked.push(operationId);
            },
            async markJobExternalOperationSignalFailed() {
                throw new Error("must not reset a signal that was already sent");
            },
        },
        signalSender: {
            async sendSystemSignal(sessionId, signalKey) {
                sent.push({ sessionId, signalKey });
            },
        },
        logger: { info() {}, warn() {}, error() {} },
    });

    const result = await producer.runOnce();

    assert.deepEqual(result, { completed: 1, delivered: 1, deliveryFailed: 0 });
    assert.deepEqual(completed, ["operation-2"]);
    assert.equal(sent.length, 2);
    assert.deepEqual(marked, ["operation-2"]);
});

test("mock producer does not abort when retry bookkeeping loses its lease", async () => {
    const producer = new MockJobExternalOperationProducer({
        workerId: "producer-1",
        store: {
            async claimDueJobExternalOperations() {
                return [];
            },
            async completeJobExternalOperation() {
                throw new Error("must not be called");
            },
            async claimJobExternalOperationSignals() {
                return [{ ...operation(), status: "succeeded" }];
            },
            async markJobExternalOperationSignalDelivered() {
                throw new Error("must not be called");
            },
            async markJobExternalOperationSignalFailed() {
                throw new Error("lost retry lease");
            },
        },
        signalSender: {
            async sendSystemSignal() {
                throw new Error("orchestration unavailable");
            },
        },
        logger: { info() {}, warn() {}, error() {} },
    });

    await assert.doesNotReject(() => producer.runOnce());
});

test("mock producer fails malformed outcomes instead of treating them as success", async () => {
    const completions = [];
    const producer = new MockJobExternalOperationProducer({
        workerId: "producer-1",
        store: {
            async claimDueJobExternalOperations() {
                return [operation({ request: { outcome: "failure" } })];
            },
            async completeJobExternalOperation(input) {
                completions.push(input);
                return operation({ status: input.status, error: input.error });
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
        },
        signalSender: {
            async sendSystemSignal() {
                throw new Error("must not be called");
            },
        },
        logger: { info() {}, warn() {}, error() {} },
    });

    await producer.runOnce();

    assert.equal(completions[0].status, "failed");
    assert.match(completions[0].error, /outcome must be succeeded or failed/);
});
