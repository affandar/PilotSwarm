import assert from "node:assert/strict";
import test from "node:test";
import {
    deriveLegacyHumanInputCapacityWaits,
    legacyAnswerDeliveryBoundaries,
} from "../../tui/src/worker-timeline-legacy-fallback.js";

function deliveredAnswer(eventId, timestampMs, answer, executionId = 1) {
    return {
        executionId,
        eventId,
        kind: "QueueEventDelivered",
        timestampMs,
        data: JSON.stringify({
            name: "messages",
            data: JSON.stringify({
                answer,
                wasFreeform: true,
                sender: { kind: "user" },
            }),
        }),
    };
}

test("legacy answer extraction returns only boundaries and never answer content", () => {
    const boundaries = legacyAnswerDeliveryBoundaries([
        deliveredAnswer(25, Date.parse("2026-08-30T01:39:28.112Z"), "secret answer"),
        {
            eventId: 26,
            kind: "QueueEventDelivered",
            timestampMs: Date.parse("2026-08-30T01:39:29.000Z"),
            data: JSON.stringify({ name: "other", data: "{}" }),
        },
    ]);

    assert.deepEqual(boundaries, [{
        key: "1:25",
        atMs: Date.parse("2026-08-30T01:39:28.112Z"),
    }]);
    assert.doesNotMatch(JSON.stringify(boundaries), /secret answer/);
});

test("legacy human waits become red queue spans ending at resumed turn startedAt", () => {
    const sessionId = "db4713ad-d0f2-46ba-afdd-51909e3e2420";
    const answerAt = "2026-08-30T01:39:28.112Z";
    const acquiredAt = "2026-08-30T01:47:31.935Z";
    const timeline = [
        {
            timelineId: "input-required",
            at: "2026-08-30T01:39:09.500Z",
            eventType: "session.input_required_started",
            workerNodeId: "worker-1",
            jobId: "job-1",
            jobKey: "work-item-1002",
            stateRunId: "run-1",
            stateName: "WorkDetailsGathered",
            stateRevision: 1,
            sessionId,
            details: {},
        },
        {
            timelineId: "preparation",
            at: "2026-08-30T01:47:33.000Z",
            eventType: "session.lossy_handoff",
            workerNodeId: "worker-1",
            jobId: "job-1",
            jobKey: "work-item-1002",
            stateRunId: "run-1",
            stateName: "WorkDetailsGathered",
            stateRevision: 1,
            sessionId,
            details: {},
        },
        {
            timelineId: "turn-started",
            at: "2026-08-30T01:47:35.000Z",
            eventType: "session.turn_started",
            workerNodeId: "worker-1",
            jobId: "job-1",
            jobKey: "work-item-1002",
            stateRunId: "run-1",
            stateName: "WorkDetailsGathered",
            stateRevision: 1,
            sessionId,
            details: {},
        },
        {
            timelineId: "turn-completed",
            at: "2026-08-30T01:48:10.761Z",
            eventType: "session.turn_completed",
            workerNodeId: "worker-1",
            jobId: "job-1",
            jobKey: "work-item-1002",
            stateRunId: "run-1",
            stateName: "WorkDetailsGathered",
            stateRevision: 1,
            sessionId,
            details: { startedAt: acquiredAt, resultType: "completed" },
        },
    ];
    const historiesBySessionId = new Map([[
        sessionId,
        [deliveredAnswer(25, Date.parse(answerAt), "do not expose", 2)],
    ]]);

    const [entry] = deriveLegacyHumanInputCapacityWaits({
        timeline,
        historiesBySessionId,
        workerNodeId: "worker-1",
    });

    assert.equal(entry.details.runnableAt, answerAt);
    assert.equal(entry.details.workerAcquiredAt, acquiredAt);
    assert.equal(entry.details.acquisitionSource, "session.turn_completed details.startedAt");
    assert.equal(entry.details.waitSource, "human_input");
    assert.equal(entry.details.waitDurationMs, Date.parse(acquiredAt) - Date.parse(answerAt));
    assert.doesNotMatch(JSON.stringify(entry), /do not expose/);
});

test("legacy fallback does not duplicate a CMS human-input capacity entry", () => {
    const sessionId = "session-1";
    const timeline = [
        {
            at: "2026-08-30T01:00:00.000Z",
            eventType: "session.input_required_started",
            sessionId,
            jobId: "job-1",
            details: {},
        },
        {
            at: "2026-08-30T01:00:02.000Z",
            eventType: "job.worker_capacity_wait",
            sessionId,
            jobId: "job-1",
            details: {
                runnableAt: "2026-08-30T01:00:01.000Z",
                workerAcquiredAt: "2026-08-30T01:00:02.000Z",
                waitSource: "human_input",
            },
        },
    ];
    const historiesBySessionId = new Map([[
        sessionId,
        [deliveredAnswer(2, Date.parse("2026-08-30T01:00:01.000Z"), "answer")],
    ]]);

    assert.deepEqual(deriveLegacyHumanInputCapacityWaits({
        timeline,
        historiesBySessionId,
        workerNodeId: "worker-1",
    }), []);
});
