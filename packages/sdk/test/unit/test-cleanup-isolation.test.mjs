import test from "node:test";
import assert from "node:assert/strict";

import {
    activeTestRunIds,
    shouldPreserveTestSchema,
    testRunIdFromSchemaName,
    testRunIdFromTempName,
} from "../../../../scripts/cleanup-test-schemas.js";

test("test cleanup derives the same run id from layouts and schemas", () => {
    assert.equal(testRunIdFromTempName("pilotswarm-test-a1b2c3d4-Qx7z"), "a1b2c3d4");
    assert.equal(testRunIdFromSchemaName("ps_test_cms_multi_worker_a1b2c3d4"), "a1b2c3d4");
    assert.equal(testRunIdFromSchemaName("ps_test_facts_wait_affinity_A1B2C3D4"), "a1b2c3d4");
    assert.equal(testRunIdFromTempName("other-a1b2c3d4"), null);
    assert.equal(testRunIdFromSchemaName("ps_test_cms_legacy"), null);
});

test("recent test layouts protect every matching provider-run schema", () => {
    const now = 1_000_000;
    const active = activeTestRunIds([
        { runId: "a1b2c3d4", mtimeMs: now - 1_000 },
        { runId: "deadbeef", mtimeMs: now - 50_000 },
    ], now, 60_000);

    assert.equal(shouldPreserveTestSchema("ps_test_cms_suite_a1b2c3d4", active), true);
    assert.equal(shouldPreserveTestSchema("ps_test_duroxide_suite_a1b2c3d4", active), true);
    assert.equal(shouldPreserveTestSchema("ps_test_facts_suite_deadbeef", active), true);
    assert.equal(shouldPreserveTestSchema("ps_test_cms_suite_00112233", active), false);
});

test("expired layouts do not protect stale schemas", () => {
    const now = 1_000_000;
    const active = activeTestRunIds([
        { runId: "a1b2c3d4", mtimeMs: now - 60_001 },
        { runId: null, mtimeMs: now },
    ], now, 60_000);

    assert.deepEqual([...active], []);
    assert.equal(shouldPreserveTestSchema("ps_test_cms_suite_a1b2c3d4", active), false);
});
