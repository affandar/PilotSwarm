/**
 * Migration-shape invariants for the CMS registry — pure, no database.
 *
 * Guards the class of bug fixed by 0028: a session read path whose column
 * set silently diverges from the canonical cms_list_sessions shape. The
 * paged list (cms_list_sessions_page) originally returned SETOF sessions —
 * no owner columns — so every paged row reached clients with owner: null
 * and the UI rendered "?" initials.
 *
 * Run: node --test test/unit/cms-migrations-shape.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

const SCHEMA = "shape_check";
const migrations = CMS_MIGRATIONS(SCHEMA);

test("registry is strictly ordered and includes 0028_list_sessions_page_owner", () => {
    const versions = migrations.map((m) => m.version);
    assert.deepEqual([...versions].sort(), versions, "versions must sort lexicographically");
    assert.equal(new Set(versions).size, versions.length, "versions must be unique");
    const m28 = migrations.find((m) => m.version === "0028");
    assert.ok(m28, "migration 0028 must be registered");
    assert.equal(m28.name, "list_sessions_page_owner");
});

// Extract the RETURNS TABLE column list of a named function from a SQL blob.
// Matches the LAST definition in the blob (later migrations win).
function returnsTableColumns(sql, fnName) {
    const re = new RegExp(
        `CREATE (?:OR REPLACE )?FUNCTION "${SCHEMA}"\\.${fnName}\\s*\\([^;]*?\\)\\s*RETURNS TABLE\\s*\\(([^;]*?)\\)\\s*AS`,
        "gs",
    );
    let cols = null;
    for (const m of sql.matchAll(re)) {
        cols = m[1]
            .split(",")
            .map((line) => line.trim().split(/\s+/)[0])
            .filter(Boolean);
    }
    return cols;
}

test("0028: paged list column set matches the canonical cms_list_sessions shape", () => {
    const allSql = migrations.map((m) => m.sql).join("\n");
    const listCols = returnsTableColumns(allSql, "cms_list_sessions");
    const pageCols = returnsTableColumns(allSql, "cms_list_sessions_page");
    assert.ok(listCols?.length, "cms_list_sessions RETURNS TABLE columns must parse");
    assert.ok(pageCols?.length, "cms_list_sessions_page RETURNS TABLE columns must parse");
    assert.deepEqual(
        pageCols,
        listCols,
        "cms_list_sessions_page must return exactly the cms_list_sessions columns " +
        "(same names, same order) so rowToSessionRow treats both paths identically. " +
        "If you added a session column, recreate BOTH functions in your migration.",
    );
    for (const col of ["owner_provider", "owner_subject", "owner_email", "owner_display_name"]) {
        assert.ok(pageCols.includes(col), `paged list must carry ${col}`);
    }
});

test("0028: drops the old SETOF signature and joins owners", () => {
    const sql = migrations.find((m) => m.version === "0028").sql;
    assert.match(sql, /DROP FUNCTION IF EXISTS "shape_check"\.cms_list_sessions_page\(/,
        "return-shape change requires DROP before CREATE");
    assert.match(sql, /LEFT JOIN "shape_check"\.session_owners/, "must join session_owners");
    assert.match(sql, /LEFT JOIN "shape_check"\.users/, "must join users");
    // Strip `--` comment lines before asserting: the migration's own header
    // comment legitimately mentions the old "RETURNS SETOF sessions" shape.
    const code = sql.split("\n").filter((ln) => !ln.trimStart().startsWith("--")).join("\n");
    assert.doesNotMatch(code, /RETURNS SETOF/, "paged list must not regress to SETOF sessions");
});
