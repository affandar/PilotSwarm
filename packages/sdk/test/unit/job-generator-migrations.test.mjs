import test from "node:test";
import assert from "node:assert/strict";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

const migration = CMS_MIGRATIONS("jobgen_test").find((entry) => entry.version === "0079");
const acknowledgementMigration = CMS_MIGRATIONS("jobgen_test").find((entry) => entry.version === "0080");

test("JobGenerator migration defines durable aggregate and history tables", () => {
    assert.ok(migration);
    assert.equal(migration.name, "job_generators");
    for (const table of [
        "job_generators",
        "job_generator_definitions",
        "job_generator_cycles",
        "jobs",
        "job_sessions",
    ]) {
        assert.match(migration.sql, new RegExp(`CREATE TABLE IF NOT EXISTS \"jobgen_test\"\\.${table}`));
    }
});

test("JobGenerator schema enforces exactly-once jobs and one current session", () => {
    assert.match(migration.sql, /UNIQUE \(generator_id, job_key\)/);
    assert.match(migration.sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_job_sessions_one_current/);
    assert.match(migration.sql, /WHERE is_current/);
    assert.match(migration.sql, /session_id\s+TEXT NOT NULL UNIQUE/);
    assert.match(migration.sql, /UNIQUE \(job_id, ordinal\)/);
});

test("JobGenerator definitions are versioned and immutable", () => {
    assert.match(migration.sql, /UNIQUE \(generator_id, version\)/);
    assert.match(migration.sql, /FOREIGN KEY \(generator_id, definition_id\)[\s\S]*job_generator_definitions/);
    assert.match(migration.sql, /JOB_GENERATOR_DEFINITION_IMMUTABLE/);
    assert.match(migration.sql, /BEFORE UPDATE ON "jobgen_test"\.job_generator_definitions/);
});

test("Job session acknowledgement distinguishes queued from worker-active sessions", () => {
    assert.ok(acknowledgementMigration);
    assert.equal(acknowledgementMigration.name, "job_session_acknowledgement");
    assert.match(acknowledgementMigration.sql, /'reserved', 'unacked', 'active', 'failed', 'replaced'/);
});
