import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyCmsError,
    cmsRetryBestEffort,
    cmsRetryCritical,
    isTransientCmsError,
} from "../../src/cms-retry.ts";

test("classifies bounded transient categories with structured-code precedence", () => {
    assert.equal(classifyCmsError({ code: "53300" }), "connection_saturation");
    assert.equal(
        classifyCmsError({ code: "53400", message: "too many connections" }),
        undefined,
        "a generic configuration limit must not be treated as connection saturation",
    );
    assert.equal(classifyCmsError({ code: "08006" }), "connection_exception");
    assert.equal(classifyCmsError({ code: "ECONNRESET" }), "connection_exception");
    assert.equal(classifyCmsError({ code: "40001" }), "serialization_failure");
    assert.equal(classifyCmsError({ code: "40P01" }), "deadlock_detected");
    assert.equal(classifyCmsError({ code: "57P03" }), "server_unavailable");
    assert.equal(
        classifyCmsError({ message: "remaining connection slots are reserved" }),
        "connection_saturation",
    );
    assert.equal(
        classifyCmsError({ message: "Connection terminated due to connection timeout" }),
        "client_timeout",
    );
    assert.equal(
        classifyCmsError({ code: "23505", message: "too many connections" }),
        undefined,
        "a structured non-transient code must not fall through to message matching",
    );
    assert.equal(isTransientCmsError({ code: "23505" }), false);
});

test("best-effort retries saturation with jitter and actionable logging", async (t) => {
    const delays = [];
    const logs = [];
    let calls = 0;
    t.mock.method(Math, "random", () => 1);
    t.mock.method(globalThis, "setTimeout", (callback, delay) => {
        delays.push(delay);
        queueMicrotask(callback);
        return {};
    });

    const result = await cmsRetryBestEffort(
        "event write",
        async () => {
            calls++;
            if (calls === 1) {
                throw { code: "53300", message: "too many connections" };
            }
            return "written";
        },
        (message) => logs.push(message),
    );

    assert.equal(result, "written");
    assert.equal(calls, 2);
    assert.deepEqual(delays, [3_600], "the configured delay receives bounded +20% jitter");
    assert.match(logs[0], /category=connection_saturation/);
    assert.match(logs[0], /code=53300/);
    assert.match(logs[0], /retrying in 3600ms/);
});

test("best-effort stops after its bounded attempts and reports exhaustion", async (t) => {
    const logs = [];
    let calls = 0;
    t.mock.method(globalThis, "setTimeout", (callback) => {
        queueMicrotask(callback);
        return {};
    });

    const result = await cmsRetryBestEffort(
        "event write",
        async () => {
            calls++;
            throw { code: "53300", message: "too many connections" };
        },
        (message) => logs.push(message),
    );

    assert.equal(result, undefined);
    assert.equal(calls, 2);
    assert.match(logs.at(-1), /transient retries exhausted/);
    assert.match(logs.at(-1), /category=connection_saturation/);
});

test("critical operations reject non-transient failures without retrying", async (t) => {
    let calls = 0;
    const timeout = t.mock.method(globalThis, "setTimeout");
    await assert.rejects(
        cmsRetryCritical("insert", async () => {
            calls++;
            throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }),
        /duplicate key/,
    );
    assert.equal(calls, 1);
    assert.equal(timeout.mock.callCount(), 0);
});

test("critical operations preserve the retry schedule and original transient error", async (t) => {
    const delays = [];
    const failure = Object.assign(new Error("temporarily unavailable"), { code: "57P03" });
    let calls = 0;
    t.mock.method(Math, "random", () => 0);
    t.mock.method(globalThis, "setTimeout", (callback, delay) => {
        delays.push(delay);
        queueMicrotask(callback);
        return {};
    });

    await assert.rejects(
        cmsRetryCritical("catalog update", async () => {
            calls++;
            throw failure;
        }),
        (err) => err === failure,
    );

    assert.equal(calls, 5);
    assert.deepEqual(delays, [800, 4_000, 12_000, 72_000]);
});
