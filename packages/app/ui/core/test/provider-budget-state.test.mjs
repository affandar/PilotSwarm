/**
 * Providers & Budgets — the state the one table lives in.
 *
 * Three things are being protected here.
 *
 * 1. A PAUSED SESSION MUST LOOK PAUSED. A session parked on a provider's
 *    limit goes dormant, and the list used to render that as an ordinary
 *    "waiting" row — indistinguishable from a session with nothing to do. The
 *    only symptom was a session that had been quiet for a suspiciously long
 *    time. The pause record (`pauseState`) is what tells them apart, and the
 *    row has to carry it as a colour, a glyph and words. That work lives on
 *    the SESSION, not on this screen, and it survived the rebuild.
 *
 * 2. A FAILED READ IS NOT AN EMPTY ONE. "This provider has no limits" and "we
 *    could not find out what its limits are" are different facts, and only one
 *    of them is safe to act on. The budget slice keeps them apart with
 *    `loaded`, and a failure never blanks numbers that were read successfully.
 *
 * 3. THE TWO PAIRS OF NUMBERS ARE NEVER MIXED. A cell prints either your spend
 *    against your share, or everyone's spend against the limit. Which one is
 *    on screen is the tick, and the selector decides it once so the component
 *    cannot get it wrong.
 *
 * Run: node --test test/provider-budget-state.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectProviderTable, selectSessionRows } from "../src/selectors.js";

const HOUR = 3_600_000;
const inHours = (n) => new Date(Date.now() + n * HOUR).toISOString();
const dayKey = (back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

const session = (sessionId, status, extra = {}) => ({
    sessionId,
    title: sessionId,
    status,
    createdAt: 100,
    updatedAt: 100,
    ...extra,
});

function loaded(sessions) {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

const rowFor = (state, sessionId) => selectSessionRows(state).find((row) => row.sessionId === sessionId);

const limitPause = {
    kind: "limit",
    provider: "azure-prod",
    period: "day",
    modelQualified: null,
    limitTokens: 20_000_000,
    usedTokens: 20_100_000,
    resetsAtUtc: inHours(2),
};

// ── The session row ────────────────────────────────────────────────────

test("a paused session does not read as an ordinary wait", () => {
    const state = loaded([
        session("paused", "waiting", { pauseState: limitPause }),
        session("quiet", "waiting"),
    ]);

    const paused = rowFor(state, "paused");
    assert.equal(paused.statusColor, "red");
    assert.match(paused.text, /^‖/);
    assert.match(paused.text, /paused · limit/);
    assert.equal(paused.pause.kind, "limit");
    assert.equal(paused.pause.provider, "azure-prod");
    assert.equal(paused.chrome.pause.label, "paused · limit");

    // The control: a session that is simply idle keeps the old treatment.
    const quiet = rowFor(state, "quiet");
    assert.equal(quiet.statusColor, "yellow");
    assert.equal(quiet.pause, null);
});

test("each reason gets its own words, because each has its own remedy", () => {
    const state = loaded([
        session("a", "waiting", { pauseState: limitPause }),
        session("b", "waiting", { pauseState: { kind: "allowance", provider: "azure-prod", period: "day", resetsAtUtc: inHours(3) } }),
        session("c", "waiting", { pauseState: { kind: "hold", provider: "azure-prod" } }),
        session("d", "waiting", { pauseState: { kind: "no_provider", provider: "carol-ghcp" } }),
    ]);

    assert.match(rowFor(state, "a").pause.label, /paused · limit/);
    assert.match(rowFor(state, "b").pause.label, /paused · allowance/);
    assert.match(rowFor(state, "b").pause.reason, /your share of it does not/i);
    assert.match(rowFor(state, "c").pause.reason, /until an administrator releases it/i);
    assert.equal(rowFor(state, "d").pause.label, "no provider");
    assert.match(rowFor(state, "d").pause.reason, /No provider named carol-ghcp/);
});

test("the pause outranks the other dormant readings", () => {
    // A scheduled session that is out of budget is out of budget: the cron
    // will not fire it, and "waiting for its next run" would send the reader
    // to the wrong control.
    const state = loaded([
        session("scheduled", "waiting", { cronActive: true, pauseState: limitPause }),
    ]);

    assert.equal(rowFor(state, "scheduled").statusColor, "red");
    assert.match(rowFor(state, "scheduled").text, /paused · limit/);
});

test("a running session is not paused, whatever record it still carries", () => {
    // The gate clears pause_state when it admits a turn, but the row must not
    // depend on that having landed first.
    const state = loaded([session("busy", "running", { pauseState: limitPause })]);

    assert.equal(rowFor(state, "busy").statusColor, "green");
    assert.equal(rowFor(state, "busy").pause, null);
});

test("the selected row spells out why it is parked", () => {
    const state = loaded([session("paused", "waiting", { pauseState: limitPause })]);
    const detail = rowFor(state, "paused").detailRuns.map((run) => run.text).join("");

    assert.match(detail, /azure-prod has reached its daily limit/);
    assert.match(detail, /Resets /);
});

test("a pause that arrives on its own repaints the row", () => {
    // The per-row memo compares its inputs by IDENTITY, and a stale row here
    // means a stuck session that never looks stuck. What saves it is that the
    // reducer replaces the whole session object whenever a field changes, and
    // that object is in the memo's deps — so this pins the property the deps
    // list depends on, not the individual entry. Built by hand rather than
    // through the reducer because the memo is keyed on the `flat` array, and
    // every reducer path that changes a session also rebuilds `flat`.
    const state = loaded([session("s", "waiting")]);
    const before = rowFor(state, "s");

    const next = {
        ...state,
        sessions: {
            ...state.sessions,
            byId: {
                ...state.sessions.byId,
                s: { ...state.sessions.byId.s, pauseState: limitPause, rowVisualStatus: "budget_paused" },
            },
        },
    };
    assert.equal(next.sessions.flat, state.sessions.flat);

    const after = rowFor(next, "s");
    assert.notEqual(after, before);
    assert.equal(after.statusColor, "red");
    assert.equal(after.pause.kind, "limit");
});

test("a session the reducer never stamped still reads as paused", () => {
    // The row prefers the DEBOUNCED status the reducer stamps, and falls back
    // to deriving one from the session when there is none — which is what a
    // hand-built state gets (the portal composes one, and a stand-in row
    // carries whatever the list handed it). The fallback has to know about
    // pauses too, or the same session reads paused on one surface and merely
    // quiet on another.
    const built = loaded([session("s", "waiting", { pauseState: limitPause })]);
    const unstamped = {
        ...built,
        sessions: {
            ...built.sessions,
            byId: { s: { ...built.sessions.byId.s, rowVisualStatus: undefined, rowVisualStatusCandidate: undefined } },
        },
    };

    const row = rowFor(unstamped, "s");
    assert.equal(row.statusColor, "red");
    assert.equal(row.pause.kind, "limit");
});

test("a released pause is held for the debounce, like every other status change", () => {
    let state = loaded([session("s", "waiting", { pauseState: limitPause })]);
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s", status: "waiting", pauseState: null } });

    // Still shown as paused, with the new reading queued behind the 5s hold.
    assert.equal(state.sessions.byId.s.rowVisualStatus, "budget_paused");
    assert.equal(state.sessions.byId.s.rowVisualStatusCandidate, "waiting");
    // And with the record gone it names the state without inventing a reason.
    assert.equal(rowFor(state, "s").pause, null);
});

// ── The surface ────────────────────────────────────────────────────────

test("the budget surface and the admin console close each other", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "admin/visibility", visible: true });
    state = appReducer(state, { type: "ui/budgetOpen", open: true });
    assert.equal(state.ui.budgetOpen, true);
    assert.equal(state.admin.visible, false);

    state = appReducer(state, { type: "admin/visibility", visible: true });
    assert.equal(state.admin.visible, true);
    assert.equal(state.ui.budgetOpen, false);
});

test("one dispatch can open the surface at the provider that caused a pause", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "ui/budgetOpen", open: true, provider: "azure-prod" });

    assert.equal(state.ui.budgetOpen, true);
    assert.equal(state.budget.selectedProvider, "azure-prod");
});

test("a failed read is not an empty one", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loading" });
    state = appReducer(state, { type: "budget/loadFailed", error: "Provider store unavailable" });

    const view = selectProviderTable(state);
    assert.equal(view.failed, true);
    // The trap: rendering this as "no providers" invites someone to create a
    // second provider that already exists.
    assert.equal(view.empty, false);
    assert.equal(view.error, "Provider store unavailable");
});

test("a read that really came back empty says so", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", grid: [], paused: [] });

    const view = selectProviderTable(state);
    assert.equal(view.empty, true);
    assert.equal(view.failed, false);
});

test("a failed refresh keeps the numbers and says they are old", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", grid: [gridRow("azure-prod")] });
    state = appReducer(state, { type: "budget/loadFailed", error: "timed out" });

    const view = selectProviderTable(state);
    assert.equal(view.stale, true);
    assert.equal(view.failed, false);
    assert.equal(view.rows.length, 1);
});

test("reading the paused list alone does not claim the table was read", () => {
    // The background poll takes the paused list on its own, so the session
    // rows can say why a session stopped while this surface is closed. If that
    // read set `loaded`, an unread namespace would come up as "you have no
    // providers" — the exact confusion the flag exists to prevent.
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", paused: [] });

    assert.equal(state.budget.loaded, false);
    const view = selectProviderTable(state);
    assert.equal(view.empty, false);
    assert.equal(view.failed, false);
});

test("a paused-list read does not wipe a table read that failed", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loadFailed", error: "Provider store unavailable" });
    state = appReducer(state, { type: "budget/loaded", paused: [] });

    assert.equal(selectProviderTable(state).error, "Provider store unavailable");
});

test("a refresh does not blank the table someone is reading", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", grid: [gridRow("azure-prod")] });
    state = appReducer(state, { type: "budget/loading" });

    assert.equal(state.budget.loading, false);
    assert.equal(state.budget.refreshing, true);
    assert.equal(state.budget.grid.length, 1);
});

// ── The table ──────────────────────────────────────────────────────────

/**
 * One cell as `cms_provider_usage_grid` returns it. The four numbers are two
 * pairs: the provider's, and the viewer's own share of it.
 */
function cell({ quota = null, used = 0, yourQuota = null, yourUsed = 0, ruleId = null } = {}) {
    return {
        ruleId,
        quotaTokens: quota,
        usedTokens: used,
        yourQuotaTokens: yourQuota,
        yourUsedTokens: yourUsed,
        windowStartUtc: inHours(-4),
        resetsAtUtc: inHours(4),
    };
}

function gridRow(providerName, {
    rowKind = "provider",
    scope = "*",
    cls = "shared",
    allowancePct = 100,
    modelRowCount = 0,
    day = cell(),
    week = cell(),
    month = cell(),
    ...rest
} = {}) {
    return {
        providerName,
        rowKind,
        scope,
        class: cls,
        allowancePct,
        holdUntilUtc: null,
        holdIndefinite: false,
        modelRowCount,
        periods: { day, week, month },
        ...rest,
    };
}

function tableState({ grid = [], paused = [], series = null, selected = null, overall = false, admin = true } = {}) {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, {
        type: "auth/context",
        principal: { provider: "github", subject: "1" },
        authorization: { role: admin ? "admin" : "user" },
    });
    state = appReducer(state, { type: "budget/loaded", grid, paused });
    if (selected) state = appReducer(state, { type: "budget/selectProvider", provider: selected });
    if (overall) state = appReducer(state, { type: "budget/overall", overall: true });
    if (series) state = appReducer(state, { type: "budget/series/loaded", provider: selected, days: series });
    return state;
}

test("rows are drawn in the order the server sent them, never re-sorted", () => {
    // Shared first, then yours, each provider immediately followed by its
    // model rows. Sorting here would move a model row out from under the
    // provider it belongs to.
    const grid = [
        gridRow("azure-openai", { modelRowCount: 1 }),
        gridRow("azure-openai", { rowKind: "model", scope: "azure-openai:gpt-5.4" }),
        gridRow("azure-research"),
        gridRow("my-copilot", { cls: "personal" }),
    ];
    const view = selectProviderTable(tableState({ grid, selected: "azure-openai" }));

    assert.deepEqual(
        view.rows.map((row) => `${row.kind}:${row.label}`),
        // A model row prints just the model: the provider is the line above
        // it, and "azure-openai:gpt-5.4" under "azure-openai" says it twice.
        ["provider:azure-openai", "model:gpt-5.4", "provider:azure-research", "provider:my-copilot"],
    );
    // The full scope is still on the row, for anything that must name it.
    assert.equal(view.rows[1].scope, "azure-openai:gpt-5.4");
    assert.equal(view.rows[1].providerName, "azure-openai");
    assert.equal(view.providerCount, 3);
    // Both classes are named, the way the model names them: an unmarked row
    // is one whose kind the reader has to infer.
    assert.equal(view.rows[0].classLabel, "Shared");
    assert.equal(view.rows[3].classLabel, "User");
});

test("a model row shows only under the provider that is selected", () => {
    const grid = [
        gridRow("azure-openai", { modelRowCount: 1 }),
        gridRow("azure-openai", { rowKind: "model", scope: "azure-openai:gpt-5.4" }),
    ];

    const collapsed = selectProviderTable(tableState({ grid }));
    assert.deepEqual(collapsed.rows.map((row) => row.kind), ["provider"]);
    assert.equal(collapsed.rows[0].expandLabel, "show 1 model");
    assert.equal(collapsed.rows[0].expanded, false);

    const expanded = selectProviderTable(tableState({ grid, selected: "azure-openai" }));
    assert.deepEqual(expanded.rows.map((row) => row.kind), ["provider", "model"]);
    assert.equal(expanded.rows[0].expanded, true);
    assert.match(expanded.rows[0].expandLabel, /^hide 1 model$/);
});

test("system spend is admin-only and kept outside quota cells", () => {
    const grid = [gridRow("azure-prod")];
    let admin = tableState({ grid, selected: "azure-prod", admin: true });
    admin = appReducer(admin, {
        type: "budget/systemUsage/loaded",
        provider: "azure-prod",
        scope: "*",
        report: {
            totals: { tokensTotal: 1_200, turns: 3 },
            daily: [],
            breakdown: [{ key: "azure-prod:luna", label: "azure-prod:luna", tokensTotal: 900, turns: 2 }],
        },
    });
    const adminView = selectProviderTable(admin);
    assert.equal(adminView.systemSpend.tokens, 1_200);
    assert.equal(adminView.systemSpend.models[0].label, "azure-prod:luna");
    assert.equal(adminView.rows[0].cells.day.usedTokens, 0);

    let user = tableState({ grid, selected: "azure-prod", admin: false });
    user = appReducer(user, {
        type: "budget/systemUsage/loaded",
        provider: "azure-prod",
        scope: "*",
        report: { totals: { tokensTotal: 1_200 }, breakdown: [] },
    });
    assert.equal(selectProviderTable(user).systemSpend, null);
});

test("the tick swaps which pair of numbers a cell prints", () => {
    // 12M of a 20M limit is the provider's; 3M of a 4M share is this person's.
    // Reporting either one as "the" number misleads, so the selector decides
    // once and the component prints what it is handed.
    const grid = [gridRow("azure-prod", {
        allowancePct: 20,
        day: cell({ quota: 20_000_000, used: 12_000_000, yourQuota: 4_000_000, yourUsed: 3_000_000 }),
    })];

    const yours = selectProviderTable(tableState({ grid })).rows[0].cells.day;
    assert.equal(yours.text, "3.0M / 4.0M");
    assert.equal(yours.pct, 75);

    const everyone = selectProviderTable(tableState({ grid, overall: true })).rows[0].cells.day;
    assert.equal(everyone.text, "12.0M / 20.0M");
    assert.equal(everyone.pct, 60);
});

test("the allowance is stated beside the total, and only there", () => {
    // It is a fact about how the TOTAL is divided. Printed beside your own
    // number it reads as a second cap on a number that already has one.
    const grid = [gridRow("azure-prod", {
        allowancePct: 20, day: cell({ quota: 1000, used: 100, yourQuota: 200, yourUsed: 20 }),
    })];

    assert.equal(selectProviderTable(tableState({ grid })).rows[0].allowanceLabel, null);
    assert.equal(
        selectProviderTable(tableState({ grid, overall: true })).rows[0].allowanceLabel,
        "Per-user allowance: 20% of each limit",
    );

    // A full allowance is no per-person ceiling, so there is nothing to say.
    const full = [gridRow("azure-prod", { allowancePct: 100 })];
    assert.equal(selectProviderTable(tableState({ grid: full, overall: true })).rows[0].allowanceLabel, null);

    // A share of NOTHING is nothing. Printed bare beside three ∞ cells the
    // label implied a cap that does not exist.
    const uncapped = [gridRow("azure-prod", { allowancePct: 20 })];
    assert.equal(
        selectProviderTable(tableState({ grid: uncapped, overall: true })).rows[0].allowanceLabel,
        "Per-user allowance: 20%, but no limit is set to divide",
    );
});

test("an uncapped period still reports what was spent on it", () => {
    // The whole point of metering independently of limits: no limit, real
    // number. A cell that went blank here is a cell that hid the spend.
    const grid = [gridRow("azure-prod", {
        week: cell({ quota: null, used: 1_200_000, yourQuota: null, yourUsed: 900_000 }),
    })];
    const week = selectProviderTable(tableState({ grid })).rows[0].cells.week;

    assert.equal(week.uncapped, true);
    assert.equal(week.quotaLabel, "∞");
    assert.equal(week.text, "900.0K / ∞");
    assert.equal(week.usedTokens, 900_000);
    // No cap, so no percentage and nothing for a meter to fill.
    assert.equal(week.pct, null);
    assert.equal(week.tone, "idle");
});

test("nobody signed in is not the same fact as nothing spent", () => {
    const grid = [gridRow("azure-prod", {
        day: cell({ quota: 20_000_000, used: 5_000_000, yourQuota: 20_000_000, yourUsed: null }),
    })];
    const view = selectProviderTable(tableState({ grid }));

    const yours = view.rows[0].cells.day;
    assert.equal(yours.known, false);
    assert.equal(yours.usedTokens, null);
    // A dash, never a zero.
    assert.equal(yours.usedLabel, "—");
    assert.equal(yours.pct, null);

    // The provider's own number is real and is still printed.
    const everyone = selectProviderTable(tableState({ grid, overall: true })).rows[0].cells.day;
    assert.equal(everyone.usedTokens, 5_000_000);
});

test("colour is plain under 90%, amber to 100%, and red over", () => {
    const at = (used) => selectProviderTable(tableState({
        grid: [gridRow("p", { day: cell({ quota: 100, used, yourQuota: 100, yourUsed: used }) })],
    })).rows[0].cells.day;

    assert.equal(at(50).tone, "plain");
    assert.equal(at(89).tone, "plain");
    assert.equal(at(90).tone, "amber");
    assert.equal(at(100).tone, "amber");
    // The turn that crosses a limit completes and is charged, so a real
    // percentage above 100 is ordinary and must not be clamped away.
    const over = at(120);
    assert.equal(over.tone, "red");
    assert.equal(over.pct, 120);
    assert.equal(over.meterPct, 100);
});

test("selecting the selected provider collapses it, and drops its chart", () => {
    let state = tableState({
        grid: [gridRow("azure-prod", { modelRowCount: 1 })],
        selected: "azure-prod",
        series: [{ dayUtc: dayKey(0), tokensTotal: 1_000_000, turns: 4 }],
    });
    assert.equal(state.budget.series.days.length, 1);

    state = appReducer(state, { type: "budget/selectProvider", provider: "azure-prod" });
    assert.equal(state.budget.selectedProvider, null);
    // The old chart described the old provider. Left up under a new name it
    // would be one provider's spend labelled as another's.
    assert.deepEqual(state.budget.series.days, []);
});

test("a chart answer for a provider you have left is dropped", () => {
    let state = tableState({ grid: [gridRow("a"), gridRow("b")], selected: "a" });
    state = appReducer(state, { type: "budget/series/loading", provider: "a" });
    state = appReducer(state, { type: "budget/selectProvider", provider: "b" });
    state = appReducer(state, {
        type: "budget/series/loaded",
        provider: "a",
        days: [{ dayUtc: dayKey(0), tokensTotal: 9_000_000, turns: 1 }],
    });

    assert.equal(state.budget.selectedProvider, "b");
    assert.deepEqual(state.budget.series.days, []);
});

test("the chart's dashed line is the number the Day cell just printed", () => {
    const grid = [gridRow("azure-prod", {
        allowancePct: 20,
        day: cell({ quota: 20_000_000, used: 12_000_000, yourQuota: 4_000_000, yourUsed: 3_000_000 }),
    })];
    const days = [
        { dayUtc: dayKey(0), tokensTotal: 1_000_000, turns: 4 },
        { dayUtc: dayKey(3), tokensTotal: 2_000_000, turns: 8 },
    ];

    const yours = selectProviderTable(tableState({ grid, selected: "azure-prod", series: days })).series;
    assert.equal(yours.quotaTokens, 4_000_000);
    assert.equal(yours.quotaLabel, "4.0M");

    const everyone = selectProviderTable(tableState({ grid, selected: "azure-prod", series: days, overall: true })).series;
    assert.equal(everyone.quotaTokens, 20_000_000);

    // The range is drawn in full, one bar per day; a day the report omits is
    // a day with no usage, not a missing axis.
    assert.equal(yours.days.length, 14);
    assert.equal(yours.peak, 2_000_000);
    assert.equal(yours.empty, false);
    // The axis holds the taller of the bars and the line, or the line lands
    // off the top of the plot.
    assert.equal(everyone.scaleMax, 20_000_000);
    assert.equal(everyone.quotaPct, 100);
});

test("range selection builds the full window and drops an older response", () => {
    let state = tableState({ grid: [gridRow("azure-prod")], selected: "azure-prod" });
    assert.equal(selectProviderTable(state).rangeDays, 14);

    state = appReducer(state, { type: "budget/rangeDays", rangeDays: 90 });
    state = appReducer(state, {
        type: "budget/series/loaded",
        provider: "azure-prod",
        scope: "*",
        rangeDays: 14,
        days: [{ dayUtc: dayKey(0), tokensTotal: 9_000, turns: 1 }],
    });
    assert.deepEqual(state.budget.series.days, [], "old-range response is ignored");

    state = appReducer(state, {
        type: "budget/series/loaded",
        provider: "azure-prod",
        scope: "*",
        rangeDays: 90,
        days: [{ dayUtc: dayKey(0), tokensTotal: 9_000, turns: 1 }],
    });
    const view = selectProviderTable(state);
    assert.equal(view.rangeDays, 90);
    assert.deepEqual(view.rangeOptions.map((option) => option.label), ["14d", "30d", "90d"]);
    assert.equal(view.series.days.length, 90);
    assert.equal(view.series.rangeLabel, "Last 90 days");
});

test("a chart that failed to read is not a fortnight with no usage", () => {
    let state = tableState({ grid: [gridRow("azure-prod")], selected: "azure-prod" });
    state = appReducer(state, { type: "budget/series/loading", provider: "azure-prod" });
    state = appReducer(state, { type: "budget/series/failed", provider: "azure-prod", error: "timed out" });

    const series = selectProviderTable(state).series;
    assert.equal(series.failed, true);
    assert.equal(series.empty, false);
    assert.equal(series.error, "timed out");
});

test("the line above the table names one provider only when it explains all of them", () => {
    const grid = [gridRow("azure-prod"), gridRow("azure-dev")];
    const pause = (sessionId, provider) => ({
        sessionId,
        title: sessionId,
        pause: { kind: "limit", provider, period: "day", resetsAtUtc: inHours(2) },
    });

    const one = selectProviderTable(tableState({
        grid, paused: [pause("a", "azure-prod"), pause("b", "azure-prod")],
    })).paused;
    assert.equal(one.count, 2);
    assert.equal(one.sentence, "2 sessions are waiting on azure-prod.");
    assert.equal(one.provider, "azure-prod");

    // Two causes. Naming one of them sends the reader to the wrong row, so
    // the sentence names none — but the link still goes to the bigger cause.
    const two = selectProviderTable(tableState({
        grid, paused: [pause("a", "azure-prod"), pause("b", "azure-prod"), pause("c", "azure-dev")],
    })).paused;
    assert.equal(two.sentence, "3 sessions are waiting.");
    assert.equal(two.provider, "azure-prod");

    // Nothing waiting, nothing said.
    assert.equal(selectProviderTable(tableState({ grid })).paused.sentence, null);
});

test("a provider that is gone cannot stay selected", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "budget/loaded", grid: [gridRow("azure-prod")] });
    state = appReducer(state, { type: "budget/selectProvider", provider: "azure-prod" });
    assert.equal(state.budget.selectedProvider, "azure-prod");

    state = appReducer(state, { type: "budget/loaded", grid: [gridRow("azure-dev")] });
    assert.equal(state.budget.selectedProvider, null);
    // Nothing is selected, so nothing is expanded — this screen shows no
    // provider until one is picked, rather than guessing at a replacement.
    assert.equal(selectProviderTable(state).selected, null);
});

test("the tick costs no read and never changes the grid", () => {
    let state = tableState({ grid: [gridRow("azure-prod")] });
    const before = state.budget.grid;

    state = appReducer(state, { type: "budget/overall" });
    assert.equal(state.budget.overall, true);
    assert.equal(state.budget.grid, before);
    assert.equal(selectProviderTable(state).usageHeading, "All user spend");

    state = appReducer(state, { type: "budget/overall" });
    assert.equal(state.budget.overall, false);
    assert.equal(selectProviderTable(state).usageHeading, "My spend");
});

test("a name sessions are stopped on, with no provider behind it, says so and offers the one remedy", () => {
    const waiting = (sessionId, provider) => ({
        sessionId,
        title: sessionId,
        pause: { kind: "no_provider", provider },
    });

    // Arriving BY name: a session stopped on `retired-vendor` links here, so
    // the surface opens with that name selected — before the table is read.
    let state = tableState({ grid: [gridRow("azure-prod")] });
    state = appReducer(state, { type: "ui/budgetOpen", open: true, provider: "retired-vendor" });
    assert.equal(state.budget.selectedProvider, "retired-vendor");

    // The read comes back and has no such row. The selection cannot stay —
    // but the NAME is remembered, or the reader is left on a table with
    // nothing selected and no sign that what they clicked is the missing bit.
    state = appReducer(state, {
        type: "budget/loaded",
        grid: [gridRow("azure-prod")],
        paused: [waiting("a", "retired-vendor"), waiting("b", "retired-vendor")],
    });
    assert.equal(state.budget.selectedProvider, null);
    assert.equal(state.budget.missingProvider, "retired-vendor");

    const view = selectProviderTable(state);
    assert.equal(view.missing.provider, "retired-vendor");
    assert.equal(view.missing.count, 2);
    assert.equal(
        view.missing.sentence,
        "No provider is named retired-vendor, and 2 sessions wait on it. "
        + "They run again as soon as a provider takes that name.",
    );

    // Picking a row that exists answers the question, so the line goes.
    const picked = appReducer(state, { type: "budget/selectProvider", provider: "azure-prod" });
    assert.equal(picked.budget.missingProvider, null);
    assert.equal(selectProviderTable(picked).missing, null);
});

test("a provider deleted with nothing riding on it just leaves the table, silently", () => {
    // The rescue line is for someone who is STUCK. A provider removed on
    // purpose, with no session waiting on the name, needs no announcement —
    // and offering to re-create what you just deleted reads as a mistake.
    let state = tableState({ grid: [gridRow("azure-prod"), gridRow("azure-dev")], selected: "azure-dev" });
    state = appReducer(state, { type: "budget/loaded", grid: [gridRow("azure-prod")], paused: [] });

    assert.equal(state.budget.selectedProvider, null);
    assert.equal(state.budget.missingProvider, "azure-dev");
    // Remembered in the slice, but nothing waits on it, so nothing is said.
    assert.equal(selectProviderTable(state).missing, null);
});
