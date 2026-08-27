/**
 * The Cluster summary slice: the filter, the load, and the view the tab
 * renders from — every day of the window present in the series, sparklines
 * aligned to those days, shares against the window total.
 *
 * Run: node --test ui/core/test/usage-summary.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";
import { PilotSwarmUiController } from "../src/controller.js";
import { selectUsageSummary } from "../src/selectors.js";

const grid = [
    { rowKind: "provider", providerName: "team", class: "shared" },
    { rowKind: "model", providerName: "team", class: "shared" },
    { rowKind: "provider", providerName: "mine", class: "personal" },
];

test("the view fills every day of the window and aligns sparklines to it", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", grid, paused: [] });
    state = appReducer(state, {
        type: "budget/summary/loaded",
        data: {
            days: 14, today: "2026-08-27", scope: "cluster",
            windows: { day: { total: 5 }, week: { total: 50 }, month: { total: 500, turns: 7 } },
            daily: [{ day: "2026-08-27", input: 3, output: 1, cacheRead: 1, total: 5, turns: 1 }, { day: "2026-08-20", total: 45, turns: 6 }],
            models: [
                { model: "gpt-5.4", providers: 2, turns: 6, total: 40, daily: [{ day: "2026-08-20", total: 40 }] },
                { model: "nano", providers: 1, turns: 1, total: 10, daily: [{ day: "2026-08-27", total: 5 }, { day: "2026-08-20", total: 5 }] },
            ],
            classes: [{ chargeClass: "user", total: 30, turns: 4 }, { chargeClass: "system", total: 20, turns: 3 }],
        },
    });
    const view = selectUsageSummary(state);
    assert.equal(view.loaded, true);
    assert.equal(view.series.length, 14, "14 days, quiet ones included");
    assert.equal(view.series[13].day, "2026-08-27", "ends on the server's today");
    assert.equal(view.series[0].day, "2026-08-14");
    assert.deepEqual(view.series.filter((d) => d.total > 0).map((d) => [d.day, d.total]), [["2026-08-20", 45], ["2026-08-27", 5]]);
    assert.equal(view.windowTotal, 50);
    assert.equal(view.models[0].model, "gpt-5.4");
    assert.equal(view.models[0].share, 0.8);
    assert.equal(view.models[0].sparkline.length, 14);
    assert.equal(view.models[0].sparkline[6], 40, "the 20th is index 6 of a window ending on the 27th");
    assert.deepEqual(view.models[1].sparkline.filter(Boolean), [5, 5]);
    // Provider choices come from the grid's PROVIDER rows only, with class.
    assert.deepEqual(view.providers, [{ name: "team", class: "shared" }, { name: "mine", class: "personal" }]);
    assert.equal(view.windows.month.turns, 7);
});

test("the filter is what the request carries; the tab switch loads", async () => {
    const calls = [];
    const transport = {
        getProviderUsageSummary: async (query) => { calls.push(query); return { days: query.days, today: "2026-08-27", windows: {}, daily: [], models: [], classes: [] }; },
    };
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({ store, transport });

    controller.setBudgetTab("summary");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(store.getState().budget.tab, "summary");
    assert.deepEqual(calls[0], { days: 14 }, "the default asks for 14 days and every provider");

    await controller.setUsageSummaryFilter({ days: 90 });
    assert.deepEqual(calls[1], { days: 90 });
    await controller.setUsageSummaryFilter({ preset: "shared", providers: ["team"] });
    assert.deepEqual(calls[2], { days: 90, providers: ["team"] });
    assert.equal(store.getState().budget.summary.preset, "shared");
    // A hand-picked list is "custom" whatever preset was showing.
    await controller.setUsageSummaryFilter({ providers: ["mine"] });
    assert.equal(store.getState().budget.summary.preset, "custom");
    assert.deepEqual(calls[3], { days: 90, providers: ["mine"] });
    // Empty list = all providers: nothing on the wire.
    await controller.setUsageSummaryFilter({ preset: "all", providers: [] });
    assert.deepEqual(calls[4], { days: 90 });
    assert.equal(store.getState().budget.summary.error, null);
    assert.equal(store.getState().budget.summary.loading, false);
});

test("a failed read keeps the last answer and says so", async () => {
    let fail = false;
    const transport = {
        getProviderUsageSummary: async () => { if (fail) throw new Error("PROVIDER_FORBIDDEN: no"); return { days: 14, today: "2026-08-27", windows: { month: { total: 9 } }, daily: [], models: [], classes: [] }; },
    };
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({ store, transport });
    await controller.loadUsageSummary();
    assert.equal(selectUsageSummary(store.getState()).windows.month.total, 9);
    fail = true;
    await controller.loadUsageSummary();
    const view = selectUsageSummary(store.getState());
    assert.equal(view.windows.month.total, 9, "the old numbers stay");
    assert.match(view.error, /no/);
});
