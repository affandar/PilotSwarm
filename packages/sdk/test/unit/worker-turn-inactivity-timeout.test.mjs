import test from "node:test";
import assert from "node:assert/strict";

import { resolveWorkerTurnInactivityTimeoutMs } from "../../dist/worker.js";
import { DEFAULT_TURN_INACTIVITY_TIMEOUT_MS } from "../../dist/managed-session.js";

// Characterizes resolveWorkerTurnInactivityTimeoutMs: precedence is explicit
// option > env var > default, an explicit/env 0 disables the watchdog, and any
// invalid value falls back to the default (an invalid explicit value does NOT
// fall through to the env var).

test("falls back to the default when neither explicit nor env value is provided", () => {
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs(undefined, undefined),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
});

test("an explicit numeric option wins over the env value", () => {
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(1000, "9999"), 1000);
});

test("an explicit 0 disables the watchdog", () => {
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(0, undefined), 0);
});

test("an invalid explicit option falls back to the default without consulting env", () => {
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs("not-a-number", "60000"),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs(-5, "60000"),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
});

test("the env value is used when no explicit option is provided", () => {
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(undefined, "60000"), 60000);
});

test("an env value of 0 disables the watchdog", () => {
    assert.equal(resolveWorkerTurnInactivityTimeoutMs(undefined, "0"), 0);
});

test("an invalid env value falls back to the default", () => {
    assert.equal(
        resolveWorkerTurnInactivityTimeoutMs(undefined, "nope"),
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS,
    );
});
