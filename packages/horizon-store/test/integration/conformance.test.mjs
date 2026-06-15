// §6 / 06 §9 static conformance guards (DB-less — runs everywhere):
//   M1  no inline relational/vector SQL in the provider (procs only)
//   MGn numbered-migration file discipline
//   interface-coverage: every public store method appears in some suite

import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../../src");
const migDir = path.resolve(here, "../../migrations");

const srcFiles = () => readdirSync(srcDir).filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: f, text: readFileSync(path.join(srcDir, f), "utf8") }));

test("M1 grep guard: no inline relational/vector SQL against the facts table in src/", () => {
    // The provider may CALL procs (facts_*) and issue df.* orchestration, but
    // must never touch the facts TABLE directly. `.facts_` (proc prefix) is
    // allowed; `.facts` table access is not.
    const offenders = [];
    const tableAccess = /(FROM|INTO|UPDATE|DELETE\s+FROM)\s+[^;`]*\.facts\b(?!_)/g;
    for (const { name, text } of srcFiles()) {
        for (const m of text.matchAll(tableAccess)) offenders.push(`${name}: ${m[0].slice(0, 80)}`);
    }
    assert.deepEqual(offenders, [], `inline facts-table SQL found:\n${offenders.join("\n")}`);
});

test("DDL guard: no CREATE TABLE/INDEX/FUNCTION DDL in src/ (migrations own all DDL)", () => {
    const offenders = [];
    // Executable DDL statements (IF NOT EXISTS / OR REPLACE forms) — not prose
    // mentions in error messages, and not Cypher `CREATE (node)` patterns.
    const ddl = /CREATE\s+(TABLE|INDEX|TRIGGER|EXTENSION)\s+IF\s+NOT\s+EXISTS|CREATE\s+OR\s+REPLACE\s+(FUNCTION|PROCEDURE)|CREATE\s+(TABLE|INDEX|TRIGGER)\s+\w/gi;
    for (const { name, text } of srcFiles()) {
        // horizon-migrator legitimately creates its own bookkeeping table.
        if (name === "horizon-migrator.ts") continue;
        for (const m of text.matchAll(ddl)) offenders.push(`${name}: ${m[0]}`);
    }
    assert.deepEqual(offenders, [], `DDL found in src/:\n${offenders.join("\n")}`);
});

test("numbered-migration discipline: NNNN_name.sql, contiguous from 0001", () => {
    const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(files.length >= 5, "expected at least the five spec migrations");
    files.forEach((f, i) => {
        const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(f);
        assert.ok(m, `bad migration filename: ${f}`);
        assert.equal(Number(m[1]), i + 1, `non-contiguous numbering at ${f}`);
    });
});

test("interface coverage: every public EnhancedFactStore/GraphInterface method is exercised by some suite", () => {
    const METHODS = [
        "storeFact", "readFacts", "deleteFact", "deleteSessionFactsForSession",
        "getSessionFactsStats", "getFactsStatsForSessions", "getSharedFactsStats",
        "searchFacts", "similarFacts", "readUncrawledFacts", "markFactsCrawled",
        "configureEmbedder", "startEmbedder", "stopEmbedder", "embedderStatus",
        "searchGraphNodes", "searchGraphEdges", "graphNeighbourhood",
        "upsertGraphNode", "upsertGraphEdge", "mergeGraphNodes",
        "deleteGraphNode", "deleteGraphEdge", "initialize", "close",
    ];
    const suiteText = readdirSync(here)
        .filter((f) => f.endsWith(".test.mjs"))
        .map((f) => readFileSync(path.join(here, f), "utf8"))
        .join("\n");
    const uncovered = METHODS.filter((m) => !new RegExp(`\\.${m}\\(`).test(suiteText));
    assert.deepEqual(uncovered, [], `methods with no test coverage: ${uncovered.join(", ")}`);
});
