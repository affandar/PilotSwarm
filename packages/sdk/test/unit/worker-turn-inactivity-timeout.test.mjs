import test from "node:test";
import assert from "node:assert/strict";

import { resolveWorkerTurnInactivityTimeoutMs } from "../../dist/worker.js";
import { DEFAULT_TURN_INACTIVITY_TIMEOUT_MS } from "../../dist/managed-session.js";

test("uses the existing default when no inactivity timeout is configured", () => {
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs(undefined, undefined),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
});

test("an explicit inactivity timeout takes precedence over the environment", () => {
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(1_000, "9000"), 1_000);
});

test("zero disables the inactivity watchdog", () => {
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(0, undefined), 0);
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(undefined, "0"), 0);
});

test("the environment configures inactivity when no explicit value is provided", () => {
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(undefined, "60000"), 60_000);
});

test("the resolver reads the deployment environment by default", (t) => {
    const key = "PILOTSWARM_TURN_INACTIVITY_TIMEOUT_MS";
    const previous = process.env[key];
    t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
    });
    process.env[key] = "45000";

    assert.equal(resolveWorkerTurnInactivityTimeoutMs(undefined), 45_000);
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(0), 0);
});

test("invalid inactivity timeouts preserve the existing default", () => {
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs("invalid", "60000"),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs(-1, undefined),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs(undefined, "invalid"),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
});
