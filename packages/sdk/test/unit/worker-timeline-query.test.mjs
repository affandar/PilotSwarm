import test from "node:test";
import assert from "node:assert/strict";
import { PgSessionCatalog } from "../../dist/index.js";

test("worker timeline projects only durable attached-to-acquired Job capacity waits", async () => {
    let capturedSql = "";
    let capturedParams = null;
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.sql = { schema: "cms" };
    catalog.pool = {
        async query(sql, params) {
            capturedSql = sql;
            capturedParams = params;
            return {
                rows: [{
                    timeline_id: "capacity-wait:association-1",
                    at: "2026-08-29T12:00:30.000Z",
                    kind: "worker_capacity_wait",
                    event_type: "job.worker_capacity_wait",
                    worker_node_id: "worker-1",
                    generator_id: "generator-1",
                    generator_name: "Standard Fix",
                    job_id: "job-2",
                    job_key: "queued-job",
                    state_run_id: "state-run-2",
                    state_name: "Validating",
                    state_revision: 2,
                    session_id: "session-2",
                    summary: null,
                    details: {
                        runnableAt: "2026-08-29T12:00:10.000Z",
                        workerAcquiredAt: "2026-08-29T12:00:30.000Z",
                        waitDurationMs: 20_000,
                    },
                }],
            };
        },
    };

    const timeline = await catalog.getWorkerTimeline(" worker-1 ", { limit: 25 });

    assert.match(capturedSql, /'job\.worker_capacity_wait'::text/);
    assert.match(capturedSql, /'job\.materialized'::text/);
    assert.match(capturedSql, /job\.created_at/);
    assert.match(capturedSql, /event\.event_type IN \(\s*'session\.worker_capacity_acquired',\s*'session\.turn_started'/);
    assert.match(capturedSql, /job_session\.attached_at IS NOT NULL/);
    assert.match(
        capturedSql,
        /COALESCE\(acquisition\.acquired_at, state_run\.started_at\) > job_session\.attached_at/,
    );
    assert.match(capturedSql, /state_run\.session_id = job_session\.session_id/);
    assert.match(capturedSql, /session\.worker_capacity_acquired/);
    assert.match(capturedSql, /input_event\.event_type = 'session\.input_received'/);
    assert.equal(capturedParams[0], "worker-1");
    assert.equal(capturedParams[1], null);
    assert.ok(Array.isArray(capturedParams[2]));
    assert.equal(capturedParams[3], 25);
    assert.equal(timeline[0].kind, "worker_capacity_wait");
    assert.equal(timeline[0].eventType, "job.worker_capacity_wait");
    assert.equal(timeline[0].details.waitDurationMs, 20_000);
    assert.equal(timeline[0].at.toISOString(), "2026-08-29T12:00:30.000Z");
});
