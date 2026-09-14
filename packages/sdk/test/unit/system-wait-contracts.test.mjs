import assert from "node:assert/strict";
import test from "node:test";
import {
    SYSTEM_WAIT_MANAGEMENT_CONTRACT,
    SYSTEM_WAIT_TOOL_CONTRACT,
    applySystemWaitCommand,
    createStoredSystemWait,
    normalizeStoredSystemWait,
    normalizeSystemWaitCommand,
    normalizeSystemWaitRequest,
    reuseStoredSystemWait,
    serializeStoredSystemWait,
} from "../../dist/index.js";

test("normalizes public tool and management contracts without an observer domain", () => {
    assert.equal(SYSTEM_WAIT_TOOL_CONTRACT.name, "system_wait");
    assert.deepEqual(SYSTEM_WAIT_TOOL_CONTRACT.inputSchema.required, ["wait_key", "kind", "reason"]);
    assert.deepEqual(SYSTEM_WAIT_TOOL_CONTRACT.inputSchema.properties.kind.enum, ["signal"]);
    assert.equal(SYSTEM_WAIT_MANAGEMENT_CONTRACT.signal.properties.type.const, "signal");
    assert.equal(SYSTEM_WAIT_MANAGEMENT_CONTRACT.cancel.properties.type.const, "cancel");
    assert.doesNotMatch(JSON.stringify({
        SYSTEM_WAIT_TOOL_CONTRACT,
        SYSTEM_WAIT_MANAGEMENT_CONTRACT,
    }), /provider|observer|domain/i);
});

test("validates wait keys, kinds, reasons, and management commands", () => {
    assert.deepEqual(
        normalizeSystemWaitRequest({ wait_key: "operation:42", kind: "signal", reason: " Await result " }),
        { waitKey: "operation:42", kind: "signal", reason: "Await result" },
    );
    assert.deepEqual(
        normalizeSystemWaitCommand({ type: "cancel", wait_key: "operation:42", reason: " superseded " }),
        { type: "cancel", waitKey: "operation:42", reason: "superseded" },
    );
    assert.throws(
        () => normalizeSystemWaitRequest({ waitKey: "contains spaces", kind: "signal", reason: "wait" }),
        /waitKey may contain only/,
    );
    assert.throws(
        () => normalizeSystemWaitRequest({ waitKey: "operation:42", kind: "deployment", reason: "wait" }),
        /unknown system wait kind/,
    );
    assert.throws(
        () => normalizeSystemWaitCommand({ type: "resume", waitKey: "operation:42" }),
        /unknown system wait command/,
    );
});

test("reusing a wait key is idempotent only for the same immutable contract", () => {
    const stored = createStoredSystemWait(
        { waitKey: "operation:42", kind: "signal", reason: "Await result" },
        new Date("2026-01-01T00:00:00Z"),
    );
    assert.deepEqual(reuseStoredSystemWait(stored, {
        waitKey: "operation:42",
        kind: "signal",
        reason: "Await result",
    }), stored);
    assert.throws(() => reuseStoredSystemWait(stored, {
        waitKey: "operation:42",
        kind: "signal",
        reason: "Await another result",
    }), /already has a different contract/);
});

test("signals and cancellations have explicit idempotent terminal representations", () => {
    const stored = createStoredSystemWait(
        { waitKey: "operation:42", kind: "signal", reason: "Await result" },
        new Date("2026-01-01T00:00:00Z"),
    );
    const cancelled = applySystemWaitCommand(
        stored,
        { type: "cancel", waitKey: "operation:42", reason: "No longer needed" },
        new Date("2026-01-01T00:01:00Z"),
    );
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.cancellation, { reason: "No longer needed" });
    assert.deepEqual(applySystemWaitCommand(
        cancelled,
        { type: "signal", waitKey: "operation:42", payload: { late: true } },
    ), cancelled);

    const completed = applySystemWaitCommand(
        stored,
        { type: "signal", waitKey: "operation:42", payload: { outcome: "ok" } },
        new Date("2026-01-01T00:02:00Z"),
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result, { outcome: "ok" });
});

test("signal payloads accept only JSON-safe durable data", () => {
    assert.deepEqual(normalizeSystemWaitCommand({
        type: "signal",
        waitKey: "operation:42",
        payload: {
            outcome: "ok",
            attempts: 2,
            flags: [true, null],
        },
    }), {
        type: "signal",
        waitKey: "operation:42",
        payload: {
            outcome: "ok",
            attempts: 2,
            flags: [true, null],
        },
    });

    for (const payload of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        () => "not durable",
        new Date(),
    ]) {
        assert.throws(
            () => normalizeSystemWaitCommand({ type: "signal", waitKey: "operation:42", payload }),
            /finite|JSON-safe|class instances/,
        );
    }

    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(
        () => normalizeSystemWaitCommand({ type: "signal", waitKey: "operation:42", payload: cyclic }),
        /cycles/,
    );
});

test("durable payloads preserve enumerable __proto__ data without prototype mutation", () => {
    const payload = JSON.parse('{"__proto__":{"safe":true},"outcome":"ok"}');
    const normalized = normalizeSystemWaitCommand({
        type: "signal",
        waitKey: "operation:42",
        payload,
    });

    assert.equal(Object.getPrototypeOf(normalized.payload), Object.prototype);
    assert.equal(Object.hasOwn(normalized.payload, "__proto__"), true);
    assert.deepEqual(
        JSON.parse(JSON.stringify(normalized.payload)),
        payload,
    );

    const completed = applySystemWaitCommand(
        createStoredSystemWait(
            { waitKey: "operation:42", kind: "signal", reason: "Await result" },
            new Date("2026-01-01T00:00:00Z"),
        ),
        normalized,
        new Date("2026-01-01T00:01:00Z"),
    );
    assert.deepEqual(
        normalizeStoredSystemWait(serializeStoredSystemWait(completed)),
        completed,
    );
});

test("storage serialization is canonical and tolerates legacy field names and extra fields", () => {
    const normalized = normalizeStoredSystemWait({
        wait_key: "operation:42",
        reason: "Await result",
        cancelled: true,
        cancel_reason: "Operator stopped it",
        created_at: "2026-01-01T00:00:00Z",
        extraFutureField: { ignored: true },
    });
    assert.deepEqual(normalized, {
        schemaVersion: 1,
        waitKey: "operation:42",
        kind: "signal",
        status: "cancelled",
        reason: "Await result",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        cancellation: { reason: "Operator stopped it" },
    });
    assert.deepEqual(normalizeStoredSystemWait(serializeStoredSystemWait(normalized)), normalized);
});

test("stored results fail serialization unless they round-trip as durable JSON", () => {
    const stored = createStoredSystemWait(
        { waitKey: "operation:42", kind: "signal", reason: "Await result" },
        new Date("2026-01-01T00:00:00Z"),
    );
    const completed = applySystemWaitCommand(
        stored,
        {
            type: "signal",
            waitKey: "operation:42",
            payload: { nested: ["value", 3, false, null] },
        },
        new Date("2026-01-01T00:01:00Z"),
    );
    assert.deepEqual(
        normalizeStoredSystemWait(serializeStoredSystemWait(completed)),
        completed,
    );

    assert.throws(
        () => serializeStoredSystemWait({ ...completed, result: Number.NaN }),
        /finite/,
    );
    assert.throws(
        () => serializeStoredSystemWait({ ...completed, result: () => "not durable" }),
        /JSON-safe/,
    );
    assert.throws(
        () => serializeStoredSystemWait({ ...completed, result: new Map([["key", "value"]]) }),
        /class instances/,
    );
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(
        () => serializeStoredSystemWait({ ...completed, result: cyclic }),
        /cycles/,
    );
});
