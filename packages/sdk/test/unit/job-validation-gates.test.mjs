import assert from "node:assert/strict";
import test from "node:test";
import { assertExternalOperationValidationGatesSatisfied } from "../../dist/job-validation-gates.js";

const gates = [{
    type: "external_operation",
    name: "Example validation",
    beforeState: "Validated",
    provider: "mock",
    kind: "validation",
}];

function operation(overrides = {}) {
    return {
        provider: "mock",
        kind: "validation",
        status: "succeeded",
        waitCompleted: true,
        evidence: { runId: "validation-1" },
        ...overrides,
    };
}

test("external-operation validation gate accepts delivered success evidence", () => {
    assert.doesNotThrow(() => {
        assertExternalOperationValidationGatesSatisfied(gates, "Validated", [operation()]);
    });
});

test("external-operation validation gate rejects missing, pending, failed, unsignaled, and evidence-free operations", () => {
    for (const operations of [
        [],
        [operation({ status: "pending" })],
        [operation({ status: "failed" })],
        [operation({ waitCompleted: false })],
        [operation({ evidence: null })],
    ]) {
        assert.throws(
            () => assertExternalOperationValidationGatesSatisfied(gates, "Validated", operations),
            /requires completed external operation evidence: Example validation/,
        );
    }
});

test("external-operation gates apply only to their configured destination state", () => {
    assert.doesNotThrow(() => {
        assertExternalOperationValidationGatesSatisfied(gates, "Diagnosed", []);
    });
});
