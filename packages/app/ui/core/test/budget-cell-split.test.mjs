/**
 * A period cell carries the four parts of its used figure, for whichever
 * pair is on screen — everyone's when the overall tick is on, the viewer's
 * own otherwise — and says them in one line for the hover.
 *
 * Run: node --test ui/core/test/budget-cell-split.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectProviderTable } from "../src/selectors.js";

// used = input + output; the cache figures are parts of input (0070).
const cell = {
    ruleId: null, quotaTokens: 1_000_000, usedTokens: 500_000, yourQuotaTokens: 200_000, yourUsedTokens: 40_000,
    inputTokens: 490_000, outputTokens: 10_000, cacheReadTokens: 125_000, cacheWriteTokens: 15_000,
    yourInputTokens: 39_200, yourOutputTokens: 800, yourCacheReadTokens: 10_000, yourCacheWriteTokens: 1_200,
    windowStartUtc: "2026-08-27T00:00:00.000Z", resetsAtUtc: "2026-08-28T00:00:00.000Z",
};
const grid = [{
    providerName: "team", rowKind: "provider", scope: "*", class: "shared",
    allowancePct: 100, holdUntilUtc: null, holdIndefinite: false, modelRowCount: 0,
    ownedByMe: true, manageable: true, ownerLabel: null,
    periods: { day: cell, week: cell, month: cell },
}];

function loaded(overall) {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", grid, paused: [] });
    if (overall) state = appReducer(state, { type: "budget/overall", overall: true });
    return state;
}

test("the viewer's pair carries the viewer's parts, and they add up", () => {
    const row = selectProviderTable(loaded(false)).rows.find((r) => r.providerName === "team");
    const day = row.cells.day;
    assert.deepEqual(day.split, { input: 39_200, output: 800, cacheRead: 10_000, cacheWrite: 1_200 });
    assert.equal(day.split.input + day.split.output, day.usedTokens, "input + output is the used figure");
    assert.ok(day.split.cacheRead + day.split.cacheWrite <= day.split.input, "the cache figures are parts of input");
    // formatCompactNumber keeps thousands whole below 10K: "1,200", not "1.2K".
    assert.match(day.splitText, /in 39\.2K \(cache r 10\.0K · w 1,200\) · out 800/);
});

test("the overall pair carries everyone's parts", () => {
    const row = selectProviderTable(loaded(true)).rows.find((r) => r.providerName === "team");
    const day = row.cells.day;
    assert.deepEqual(day.split, { input: 490_000, output: 10_000, cacheRead: 125_000, cacheWrite: 15_000 });
    assert.equal(day.split.input + day.split.output, day.usedTokens);
});

test("a grid from before 0069 has no split, and the cell says nothing about it", () => {
    const old = { ...cell };
    for (const k of Object.keys(old)) if (/(input|output|cacheRead|cacheWrite)Tokens/i.test(k)) delete old[k];
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", grid: [{ ...grid[0], periods: { day: old, week: old, month: old } }], paused: [] });
    const row = selectProviderTable(state).rows.find((r) => r.providerName === "team");
    assert.equal(row.cells.day.split, null);
    assert.equal(row.cells.day.splitText, null);
});
