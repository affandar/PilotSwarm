import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerTimelineSwimlane } from "../src/index.js";

const workerNodeId = "pod-open";

// A Job that turned once, then requested and started an observed-condition wait
// that never completed — i.e. it is still parked right now, holding no worker.
function openWaitEntries() {
    return [
        {
            timelineId: "turn:start",
            at: "2026-09-02T10:00:00.000Z",
            kind: "session_event",
            eventType: "session.turn_started",
            workerNodeId,
            jobId: "job-9",
            jobKey: "wi-9",
            stateName: "FixProposed",
            sessionId: "s-9",
            details: {},
        },
        {
            timelineId: "sys:req",
            at: "2026-09-02T10:00:04.000Z",
            kind: "session_event",
            eventType: "session.system_wait_requested",
            workerNodeId,
            jobId: "job-9",
            jobKey: "wi-9",
            stateName: "AutomatedCodeReview",
            sessionId: "s-9",
            details: { signalKey: "review:9", reason: "Waiting for code review" },
        },
        {
            timelineId: "turn:end",
            at: "2026-09-02T10:00:05.000Z",
            kind: "session_event",
            eventType: "session.turn_completed",
            workerNodeId,
            jobId: "job-9",
            jobKey: "wi-9",
            stateName: "FixProposed",
            sessionId: "s-9",
            details: {},
        },
        {
            timelineId: "sys:start",
            at: "2026-09-02T10:00:06.000Z",
            kind: "session_event",
            eventType: "session.system_wait_started",
            workerNodeId,
            jobId: "job-9",
            jobKey: "wi-9",
            stateName: "AutomatedCodeReview",
            sessionId: "s-9",
            details: { signalKey: "review:9", reason: "Waiting for code review" },
        },
    ];
}

test("an ongoing observed-condition wait extends to now instead of collapsing", () => {
    // Two hours after the wait started, with no further events.
    const now = Date.parse("2026-09-02T12:00:06.000Z");
    const swimlane = buildWorkerTimelineSwimlane(openWaitEntries(), { now, workerNodeId });

    const systemWait = swimlane.segments.find((segment) => segment.kind === "system_wait");
    assert.ok(systemWait, "an observed-condition wait span is present");
    assert.equal(systemWait.ongoing, true, "the still-open wait is marked ongoing");
    assert.equal(
        systemWait.endAt,
        new Date(now).toISOString(),
        "the ongoing wait extends to the wall clock, not the last event",
    );
    // The wait began ~10:00:05-06; extended to 12:00:06 it must span ~2h, proving
    // it did not collapse to the zero-width sliver the event-bounded range gave.
    assert.ok(
        systemWait.durationMs >= 2 * 60 * 60 * 1000 - 5_000,
        `ongoing wait should span ~2h, got ${systemWait.durationMs}ms`,
    );
    assert.match(systemWait.activity, /Still parked/);

    // The whole swimlane now reaches now, and the parked interval is idle compute.
    assert.equal(swimlane.endAt, new Date(now).toISOString());
    assert.equal(swimlane.busyMs + swimlane.overheadMs + swimlane.idleMs, swimlane.durationMs);
});

test("without an ongoing wait the range stays event-bounded", () => {
    const entries = openWaitEntries().concat([
        {
            timelineId: "sys:end",
            at: "2026-09-02T10:00:20.000Z",
            kind: "session_event",
            eventType: "session.system_wait_completed",
            workerNodeId,
            jobId: "job-9",
            jobKey: "wi-9",
            stateName: "AutomatedCodeReview",
            sessionId: "s-9",
            details: { signalKey: "review:9" },
        },
        {
            timelineId: "resume",
            at: "2026-09-02T10:00:22.000Z",
            kind: "session_event",
            eventType: "session.lossy_handoff",
            workerNodeId,
            jobId: "job-9",
            jobKey: "wi-9",
            stateName: "AutomatedCodeReview",
            sessionId: "s-9",
            details: {},
        },
    ]);
    const now = Date.parse("2026-09-02T12:00:06.000Z");
    const swimlane = buildWorkerTimelineSwimlane(entries, { now, workerNodeId });

    const systemWait = swimlane.segments.find((segment) => segment.kind === "system_wait");
    assert.ok(systemWait);
    assert.equal(systemWait.ongoing, false, "a resumed wait is not ongoing");
    // Bounded by the resume, far short of `now`.
    assert.ok(systemWait.endMs <= Date.parse("2026-09-02T10:00:22.000Z"));
    assert.ok(swimlane.endMs ?? true);
    assert.notEqual(swimlane.endAt, new Date(now).toISOString());
});
