import assert from "node:assert/strict";
import test from "node:test";
import { runMigrations, validateMigrationEntries } from "../../src/pg-migrator.ts";

test("migration entries require exactly one non-empty execution mode", () => {
    assert.throws(
        () => validateMigrationEntries([{ version: "0001", name: "none" }]),
        /exactly one execution mode/,
    );
    assert.throws(
        () => validateMigrationEntries([{ version: "0001", name: "both", sql: "SELECT 1", steps: ["SELECT 2"] }]),
        /exactly one execution mode/,
    );
    assert.throws(
        () => validateMigrationEntries([{ version: "0001", name: "empty", steps: [] }]),
        /at least one statement/,
    );
    assert.throws(
        () => validateMigrationEntries([
            { version: "0001", name: "first", sql: "SELECT 1" },
            { version: "0001", name: "duplicate", sql: "SELECT 2" },
        ]),
        /Duplicate migration version/,
    );
});

test("invalid migration definitions fail before acquiring a pool connection", async () => {
    let connected = false;
    const pool = { connect: async () => { connected = true; throw new Error("should not connect"); } };
    await assert.rejects(
        runMigrations(pool, "test_schema", [{ version: "0001", name: "invalid", sql: "", steps: [] }], 42),
        /exactly one execution mode/,
    );
    assert.equal(connected, false);
});

test("non-transactional steps rerun from the top after partial failure", async () => {
    const executed = [];
    const applied = new Set();
    let failSecondStep = true;
    let lockAttempt = 0;
    const client = {
        async query(sql, params = []) {
            if (sql === "SELECT pg_try_advisory_lock($1) AS locked") {
                lockAttempt += 1;
                return { rows: [{ locked: lockAttempt > 1 }] };
            }
            if (sql.includes("SELECT version FROM")) {
                return { rows: [...applied].map((version) => ({ version })) };
            }
            if (sql.includes("INSERT INTO") && sql.includes("schema_migrations")) {
                applied.add(params[0]);
                return { rows: [] };
            }
            if (sql === "STEP_ONE") {
                executed.push(sql);
                return { rows: [] };
            }
            if (sql === "STEP_TWO") {
                executed.push(sql);
                if (failSecondStep) {
                    failSecondStep = false;
                    throw new Error("step two failed");
                }
                return { rows: [] };
            }
            return { rows: [] };
        },
        release() {},
    };
    const pool = { connect: async () => client };
    const migrations = [{ version: "0029", name: "stepped", steps: ["STEP_ONE", "STEP_TWO"] }];

    await assert.rejects(runMigrations(pool, "test_schema", migrations, 42), /step two failed/);
    assert.equal(applied.has("0029"), false, "failed stepped migration stays unrecorded");

    lockAttempt = 1;
    await runMigrations(pool, "test_schema", migrations, 42);
    assert.deepEqual(executed, ["STEP_ONE", "STEP_TWO", "STEP_ONE", "STEP_TWO"]);
    assert.equal(applied.has("0029"), true, "successful rerun records the migration");
});
