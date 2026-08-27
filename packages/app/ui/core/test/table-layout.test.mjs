/**
 * Fit-width table layout: a rigid column is never narrower than its longest
 * unbreakable token.
 *
 * The layout hands the browser a fixed table with percentage columns, and
 * rigid columns wrap at spaces only. Their budget was capped at 32
 * characters of the longest CELL — so a cell holding one 60-character
 * CamelCase test name was given a 32ch column, could not break, and painted
 * itself across the next column. The person reading it expected the table
 * to widen and scroll instead. Sizing the budget to the longest TOKEN is
 * what makes that happen: the table's min-width then exceeds the pane and
 * the wrapper scrolls.
 *
 * Run: node --test ui/core/test/table-layout.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { computeFitWidthColumnLayout } from "../src/table-layout.js";

// Recover each column's budget in ch from the percentages + the min-width
// (minWidth = ceil(total + 2)ch), close enough to compare against a token.
function budgetsInCh(layout) {
    const total = Number.parseInt(layout.minWidth, 10) - 2;
    return layout.widths.map((pct) => (Number.parseFloat(pct) / 100) * total);
}

const LONG = "CreateVNetInjectedFlexibleServerAndVerifyStartStopOperations";

test("a rigid column is budgeted at least its longest token", () => {
    // The shape from the report: a Test column of unbreakable names and a
    // prose column that qualifies as the flex column.
    const rows = [
        ["Test", "Dossier finding"],
        [`${LONG} — two stages`, "Production issue bucket VNetPowerStopPostcondition; no category supplied"],
        ["PromoteReplica_Forced_SingleShotReplaceObserved", "Test asset, FlexClusterMongo; occurrence no longer active"],
        ["ImpactlessHAComputeScaleUpTest", "Test asset, HaOperations; occurrence no longer active"],
    ];
    const layout = computeFitWidthColumnLayout(rows);
    assert.ok(layout, "this table has a flex column and gets a fixed layout");
    assert.equal(layout.flexIndex, 1, "the prose column is the flex column");
    const [testCol] = budgetsInCh(layout);
    assert.ok(
        testCol >= LONG.length,
        `the Test column must hold its longest token whole: ${testCol.toFixed(1)}ch for a ${LONG.length}-char token`,
    );
});

test("short tokens keep the old cap: a long cell of short words does not widen its column", () => {
    const rows = [
        ["Stage", "Notes"],
        ["one two three four five six seven eight nine ten eleven twelve", "a description that is long enough to be the flex column of this table, easily"],
        ["a b c", "more prose here with several words in it to qualify as the flex column"],
    ];
    const layout = computeFitWidthColumnLayout(rows);
    assert.ok(layout);
    const [stage] = budgetsInCh(layout);
    // 63 chars of short words: capped at 32 (+ nothing for tokens ≤ 6 chars).
    assert.ok(stage <= 33, `short-word column stays capped: ${stage.toFixed(1)}ch`);
});

test("no flex column, no fixed layout — the table keeps max-content and scrolls", () => {
    // A flex column needs a cell of 24+ characters; every cell here is
    // shorter, so nothing qualifies and the table is left to the browser.
    const rows = [["Result", "Count"], ["Unique exact", "8"], ["Unmatched", "8"]];
    assert.equal(computeFitWidthColumnLayout(rows), null);
});
