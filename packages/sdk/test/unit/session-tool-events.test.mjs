import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_SESSION_TOOL_EVENT_CATCH_UP_LIMIT,
    MAX_SESSION_TOOL_EVENT_CATCH_UP_LIMIT,
    classifySessionToolEvent,
    SessionToolEventLedger,
    SessionToolEventTracker,
} from "../../dist/session-tool-events.js";

const start = (seq, name = "read_file", toolCallId = `call-${seq}`) => ({
    seq,
    eventType: "tool.execution_start",
    data: { toolName: name, toolCallId },
});
const complete = (seq, success, name = "read_file", toolCallId = `call-${seq - 1}`) => ({
    seq,
    eventType: "tool.execution_complete",
    data: { name, toolCallId, success },
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function sourceWithCatchUp(catchUp) {
    let handler;
    let unsubscribeCount = 0;
    let getMessagesCount = 0;
    return {
        source: {
            on(fn) {
                handler = fn;
                return () => { unsubscribeCount += 1; handler = undefined; };
            },
            async getMessages(limit) {
                getMessagesCount += 1;
                return catchUp(limit);
            },
        },
        emit(event) { handler?.(event); },
        counts() { return { unsubscribeCount, getMessagesCount }; },
    };
}

test("classification normalizes identifiers and rejects malformed tool events", () => {
    assert.deepEqual(classifySessionToolEvent(start(1, "  read_file  ", "  call-1  ")), {
        seq: 1,
        phase: "start",
        toolName: "read_file",
        toolCallId: "call-1",
    });
    assert.deepEqual(classifySessionToolEvent(complete(2, false)), {
        seq: 2,
        phase: "complete",
        toolName: "read_file",
        toolCallId: "call-1",
        success: false,
    });
    for (const event of [
        null,
        {},
        { seq: Number.NaN, eventType: "tool.execution_start", data: { toolName: "x" } },
        { seq: 1.5, eventType: "tool.execution_start", data: { toolName: "x" } },
        { seq: 1, eventType: "assistant.message", data: { toolName: "x" } },
        { seq: 1, eventType: "tool.execution_start", data: {} },
        { seq: 1, eventType: "tool.execution_complete", data: { toolName: "x" } },
    ]) {
        assert.equal(classifySessionToolEvent(event), undefined);
    }
});

test("catch-up limits are bounded positive safe integers", async () => {
    for (const catchUpLimit of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        MAX_SESSION_TOOL_EVENT_CATCH_UP_LIMIT + 1,
    ]) {
        let subscribed = false;
        const source = {
            on() {
                subscribed = true;
                return () => {};
            },
            async getMessages() { return []; },
        };
        assert.throws(
            () => new SessionToolEventTracker(source, { catchUpLimit }),
            RangeError,
        );
        assert.equal(subscribed, false, "invalid configuration must fail before subscribing");
    }

    const requestedLimits = [];
    const defaultHarness = sourceWithCatchUp(async (limit) => {
        requestedLimits.push(limit);
        return [];
    });
    await new SessionToolEventTracker(defaultHarness.source).finish();
    const maxHarness = sourceWithCatchUp(async (limit) => {
        requestedLimits.push(limit);
        return [];
    });
    await new SessionToolEventTracker(maxHarness.source, {
        catchUpLimit: MAX_SESSION_TOOL_EVENT_CATCH_UP_LIMIT,
    }).finish();
    assert.deepEqual(requestedLimits, [
        DEFAULT_SESSION_TOOL_EVENT_CATCH_UP_LIMIT,
        MAX_SESSION_TOOL_EVENT_CATCH_UP_LIMIT,
    ]);
});

test("ledger accepts delayed sequences once without regressing its watermark", () => {
    const ledger = new SessionToolEventLedger();
    assert.equal(ledger.ingest(complete(12, true, "write_file", "c1")).seq, 12);
    assert.equal(ledger.highWatermark, 12);
    assert.equal(ledger.ingest(start(10, "write_file", "c1")).seq, 10);
    assert.equal(ledger.highWatermark, 12);
    assert.equal(ledger.ingest(start(10, "different", "c2")), undefined);
    assert.deepEqual(ledger.events.map((event) => event.seq), [10, 12]);
    assert.deepEqual(ledger.executions, [{
        toolCallId: "c1",
        toolName: "write_file",
        start: { seq: 10, phase: "start", toolName: "write_file", toolCallId: "c1" },
        completion: { seq: 12, phase: "complete", toolName: "write_file", toolCallId: "c1", success: true },
    }]);
});

test("tracker deduplicates live and durable start/complete pairs", async () => {
    const observed = [];
    const harness = sourceWithCatchUp(async () => [
        start(1, "search", "c1"),
        complete(2, true, "search", "c1"),
        start(3, "edit", "c2"),
        complete(4, false, "edit", "c2"),
    ]);
    const tracker = new SessionToolEventTracker(harness.source, {
        onEvent: (event) => observed.push(event.seq),
    });
    harness.emit(start(3, "edit", "c2"));
    harness.emit(complete(4, false, "edit", "c2"));

    const result = await tracker.finish();
    assert.deepEqual(observed, [3, 4, 1, 2]);
    assert.deepEqual(tracker.ledger.events.map((event) => event.seq), [1, 2, 3, 4]);
    assert.deepEqual([...tracker.attempted].sort(), ["edit", "search"]);
    assert.deepEqual([...tracker.succeeded], ["search"]);
    assert.deepEqual([...tracker.failed], ["edit"]);
    assert.deepEqual(result, { durableEventCount: 4, trackedEventCount: 4, highWatermark: 4 });
});

test("finish keeps live delivery active across catch-up and is idempotent", async () => {
    const gate = deferred();
    const harness = sourceWithCatchUp(() => gate.promise);
    const tracker = new SessionToolEventTracker(harness.source);
    harness.emit(start(20, "run", "c20"));

    const first = tracker.finish();
    const second = tracker.finish();
    assert.equal(first, second);
    harness.emit(complete(21, true, "run", "c20"));
    gate.resolve([start(20, "run", "c20"), complete(21, true, "run", "c20")]);

    await first;
    assert.deepEqual(harness.counts(), { unsubscribeCount: 1, getMessagesCount: 1 });
    assert.deepEqual(tracker.ledger.events.map((event) => event.seq), [20, 21]);
    tracker.unsubscribe();
    assert.equal(harness.counts().unsubscribeCount, 1);
});

test("durable catch-up failures propagate after unsubscribing", async () => {
    const failure = new Error("durable history unavailable");
    const harness = sourceWithCatchUp(async () => { throw failure; });
    const tracker = new SessionToolEventTracker(harness.source);

    const first = tracker.finish();
    await assert.rejects(first, (error) => error === failure);
    await assert.rejects(tracker.finish(), (error) => error === failure);
    assert.deepEqual(harness.counts(), { unsubscribeCount: 1, getMessagesCount: 1 });
});
