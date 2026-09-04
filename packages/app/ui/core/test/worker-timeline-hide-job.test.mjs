import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerTimelineSwimlane } from "../src/index.js";

const workerNodeId = "pod-hide";

// Two independent Jobs that ran back-to-back on the same worker. Job A occupies
// the 10:00 window; Job B occupies the 11:00 window an hour later. Hiding one or
// the other must redraw the swimlane against only the visible Job — including a
// reset of the range boundaries to the surviving window.
function twoJobEntries() {
    return [
        {
            timelineId: "a:start",
            at: "2026-09-02T10:00:00.000Z",
            kind: "session_event",
            eventType: "session.turn_started",
            workerNodeId,
            jobId: "job-a",
            jobKey: "wi-a",
            stateName: "FixProposed",
            sessionId: "s-a",
            details: {},
        },
        {
            timelineId: "a:end",
            at: "2026-09-02T10:05:00.000Z",
            kind: "session_event",
            eventType: "session.turn_completed",
            workerNodeId,
            jobId: "job-a",
            jobKey: "wi-a",
            stateName: "FixProposed",
            sessionId: "s-a",
            details: {},
        },
        {
            timelineId: "b:start",
            at: "2026-09-02T11:00:00.000Z",
            kind: "session_event",
            eventType: "session.turn_started",
            workerNodeId,
            jobId: "job-b",
            jobKey: "wi-b",
            stateName: "FixProposed",
            sessionId: "s-b",
            details: {},
        },
        {
            timelineId: "b:end",
            at: "2026-09-02T11:05:00.000Z",
            kind: "session_event",
            eventType: "session.turn_completed",
            workerNodeId,
            jobId: "job-b",
            jobKey: "wi-b",
            stateName: "FixProposed",
            sessionId: "s-b",
            details: {},
        },
    ];
}

const now = Date.parse("2026-09-02T12:00:00.000Z");

function jobLanes(swimlane) {
    return swimlane.lanes.filter((lane) => lane.kind === "job");
}

test("baseline: both Jobs get a lane and the range spans both windows", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoJobEntries(), { now, workerNodeId });
    const lanes = jobLanes(swimlane);
    assert.equal(lanes.length, 2, "both Jobs are laned when nothing is hidden");
    assert.deepEqual(lanes.map((lane) => lane.jobId).sort(), ["job-a", "job-b"]);
    assert.equal(swimlane.hiddenJobCount, 0);
    assert.deepEqual(swimlane.hiddenJobIds, []);
    assert.deepEqual(swimlane.hiddenJobs, []);
    // Range covers Job A's start through Job B's end.
    assert.equal(swimlane.startAt, "2026-09-02T10:00:00.000Z");
    assert.equal(swimlane.endAt, "2026-09-02T11:05:00.000Z");
});

test("hiding a Job redraws the swimlane and resets the range to the visible Job", () => {
    const baseline = buildWorkerTimelineSwimlane(twoJobEntries(), { now, workerNodeId });
    const hidden = buildWorkerTimelineSwimlane(twoJobEntries(), {
        now,
        workerNodeId,
        hiddenJobIds: ["job-b"],
    });

    const lanes = jobLanes(hidden);
    assert.equal(lanes.length, 1, "only the visible Job keeps a lane");
    assert.equal(lanes[0].jobId, "job-a");

    // Boundaries reset to Job A's window — the whole range no longer reaches
    // Job B's 11:05 end. This is the "reset timestamp boundaries" guarantee.
    assert.equal(hidden.startAt, "2026-09-02T10:00:00.000Z");
    assert.equal(hidden.endAt, "2026-09-02T10:05:00.000Z");
    assert.ok(
        hidden.durationMs < baseline.durationMs,
        "the redrawn range is shorter than the two-Job range",
    );
    assert.ok(
        Date.parse(hidden.displayEndAt) < Date.parse(baseline.displayEndAt),
        "the display window also shrinks to the visible Job",
    );

    // Hidden metadata still describes the dropped Job so the UI can label it.
    assert.equal(hidden.hiddenJobCount, 1);
    assert.deepEqual(hidden.hiddenJobIds, ["job-b"]);
    assert.equal(hidden.hiddenJobs[0].jobId, "job-b");
    assert.equal(hidden.hiddenJobs[0].jobKey, "wi-b");
});

test("hiding every Job yields an empty swimlane with full hidden metadata", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoJobEntries(), {
        now,
        workerNodeId,
        hiddenJobIds: ["job-a", "job-b"],
    });
    assert.deepEqual(swimlane.lanes, []);
    assert.equal(swimlane.startAt, null);
    assert.equal(swimlane.endAt, null);
    assert.equal(swimlane.durationMs, 0);
    assert.equal(swimlane.hiddenJobCount, 2);
    assert.deepEqual(swimlane.hiddenJobIds.sort(), ["job-a", "job-b"]);
});

test("a hidden-id that matches no Job is ignored", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoJobEntries(), {
        now,
        workerNodeId,
        hiddenJobIds: ["job-ghost"],
    });
    assert.equal(jobLanes(swimlane).length, 2, "no real Job is dropped");
    assert.equal(swimlane.hiddenJobCount, 0, "an unmatched id is not counted as hidden");
    assert.deepEqual(swimlane.hiddenJobIds, []);
});

test("hiddenJobIds accepts a Set as well as an array", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoJobEntries(), {
        now,
        workerNodeId,
        hiddenJobIds: new Set(["job-a"]),
    });
    const lanes = jobLanes(swimlane);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].jobId, "job-b");
    assert.equal(swimlane.hiddenJobCount, 1);
    assert.deepEqual(swimlane.hiddenJobIds, ["job-a"]);
});
