import { test } from "vitest";
import assert from "node:assert/strict";

import {
    advisoryLockKeyParts,
    hashSchemaName,
    HORIZON_FACTS_LOCK_SEED,
    HORIZON_GLOBAL_DDL_LOCK_LABEL,
    migrationRequiresGlobalDdlLock,
} from "../dist/src/horizon-migrator.js";

test("global DDL lock is required only for database-global migration SQL", () => {
    assert.equal(migrationRequiresGlobalDdlLock({ sql: `CREATE EXTENSION IF NOT EXISTS vector;` }), true);
    assert.equal(migrationRequiresGlobalDdlLock({ sql: `PERFORM ag_catalog.create_graph('g');` }), true);
    assert.equal(migrationRequiresGlobalDdlLock({ sql: `CREATE TABLE IF NOT EXISTS "s".facts (id bigint);` }), false);
    assert.equal(migrationRequiresGlobalDdlLock({ sql: `CREATE INDEX IF NOT EXISTS idx ON "s".facts (id);` }), false);
});

test("advisory lock key parts match pg_locks classid/objid for global DDL lock", () => {
    const key = hashSchemaName(HORIZON_GLOBAL_DDL_LOCK_LABEL, HORIZON_FACTS_LOCK_SEED);
    assert.equal(key, 671448370);
    assert.deepEqual(advisoryLockKeyParts(key), { classid: "0", objid: "671448370" });
});