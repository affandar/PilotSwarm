// cms-retry classifies PostgreSQL transient failures and, for best-effort
// event writes, rides out a short connection storm with jittered exponential
// backoff before swallowing. The regression that motivated the backoff: a
// single 3s retry was not enough when many worker pods exhausted the server's
// max_connections at once, so `tool.execution_complete` event writes were
// dropped and the streaming client saw a session with zero tools.
//
// Run: node --test test/unit/cms-retry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    isTransientCmsError,
    classifyCmsError,
    cmsRetryBestEffort,
    cmsRetryCritical,
} from "../../dist/cms-retry.js";

const saturationByCode = { code: "53300", message: "too many connections for role" };
const saturationByMessage = {
    message:
        'remaining connection slots are reserved for roles with privileges of ' +
        'the "pg_use_reserved_connections" role',
};

test("errors are classified into a transient category, or undefined when not transient", () => {
    // Saturation bucket — by SQLSTATE and by codeless message.
    assert.equal(classifyCmsError(saturationByCode), "connection_saturation");
    assert.equal(classifyCmsError(saturationByMessage), "connection_saturation");
    assert.equal(classifyCmsError({ code: "53400" }), "connection_saturation");
    // Other transient buckets share the same generic mechanism.
    assert.equal(classifyCmsError({ code: "08006" }), "connection_exception");
    assert.equal(classifyCmsError({ code: "ECONNRESET" }), "connection_exception");
    assert.equal(classifyCmsError({ code: "40001" }), "serialization_failure");
    assert.equal(classifyCmsError({ code: "40P01" }), "deadlock_detected");
    assert.equal(classifyCmsError({ code: "57P03" }), "server_unavailable");
    // Non-transient → no category.
    assert.equal(classifyCmsError({ code: "23505" }), undefined); // unique_violation
    assert.equal(classifyCmsError({ message: "syntax error" }), undefined);
    assert.equal(classifyCmsError(null), undefined);
});

test("saturation is just a transient category (retried like any other)", () => {
    assert.equal(isTransientCmsError(saturationByCode), true);
    assert.equal(isTransientCmsError(saturationByMessage), true);
    // A structured non-transient code is never retried, even if its message
    // happens to mention a connection.
    assert.equal(isTransientCmsError({ code: "23505", message: "connection" }), false);
});

test("best-effort swallows a non-transient error immediately (no throw, no delay)", async () => {
    const logs = [];
    const started = Date.now();
    const result = await cmsRetryBestEffort(
        "unit.nontransient",
        async () => {
            throw { code: "23505", message: "duplicate key" };
        },
        (m) => logs.push(m),
    );
    assert.equal(result, undefined);
    assert.ok(Date.now() - started < 500, "must not sleep before swallowing a non-transient");
    assert.ok(logs.some((m) => m.includes("swallowing") && m.includes("non-transient")));
    assert.ok(!logs.some((m) => m.includes("category=")), "non-transient carries no category tag");
});

test("best-effort retries a saturation failure, tags its category, then returns the value", async () => {
    const logs = [];
    let calls = 0;
    const result = await cmsRetryBestEffort(
        "unit.saturation",
        async () => {
            calls++;
            if (calls === 1) throw saturationByCode; // fail once, then succeed
            return "written";
        },
        (m) => logs.push(m),
    );
    assert.equal(result, "written");
    assert.equal(calls, 2);
    const retryLog = logs.find((m) => m.includes("transient failure"));
    assert.ok(retryLog, "a retry must be logged");
    assert.ok(
        retryLog.includes("[category=connection_saturation]"),
        "the transient category must be tagged for analysis/alerting",
    );
    assert.ok(retryLog.includes("sqlstate=53300"), "the SQLSTATE must be surfaced");
    // Best-effort now has 4 total attempts (was 2) — proven by the ladder width.
    assert.ok(retryLog.includes("/4"), "best-effort must allow 4 total attempts");
});

test("critical re-throws a non-transient error", async () => {
    await assert.rejects(
        cmsRetryCritical("unit.critical.nontransient", async () => {
            throw new Error("boom");
        }),
        /boom/,
    );
});
