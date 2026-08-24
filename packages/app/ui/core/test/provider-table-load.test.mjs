/**
 * Providers & Budgets — the data path behind the one table.
 *
 * The reducer and the selector are pinned next door
 * (provider-budget-state.test.mjs). This drives the CONTROLLER against a fake
 * transport, which is the only place the three facts below can be checked:
 *
 *   - the table is ONE read. `getProviderUsageGrid` returns the numbers in a
 *     row and the numbers in the row under it from the same statement, so they
 *     cannot be a refresh apart. Fanning back out to per-provider reads is the
 *     regression this catches.
 *   - a refused read renders as a refusal, in the SERVER's words. A failed read
 *     that came out as an empty table would invite someone to create a provider
 *     that already exists.
 *   - the chart under a row always names the row's provider. A slow answer for
 *     a provider the reader has left must not land under the new name.
 *
 * Run: node --test test/provider-table-load.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectProviderTable,
} from "../src/index.js";

const gridRow = (providerName, extra = {}) => ({
    providerName,
    rowKind: "provider",
    scope: "*",
    class: "shared",
    allowancePct: 100,
    holdUntilUtc: null,
    holdIndefinite: false,
    modelRowCount: 0,
    periods: {
        day: cell(), week: cell(), month: cell(),
    },
    ...extra,
});

const cell = () => ({
    ruleId: null,
    quotaTokens: null,
    usedTokens: 0,
    yourQuotaTokens: null,
    yourUsedTokens: 0,
    windowStartUtc: "2026-08-20T00:00:00.000Z",
    resetsAtUtc: "2026-08-21T00:00:00.000Z",
});

function makeController({ transportOverrides = {} } = {}) {
    const calls = [];
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getProviderUsageGrid: async () => {
            calls.push({ name: "getProviderUsageGrid" });
            return { rows: [gridRow("azure-openai"), gridRow("my-copilot", { class: "personal" })] };
        },
        listPausedSessions: async () => {
            calls.push({ name: "listPausedSessions" });
            return { sessions: [] };
        },
        getProviderUsage: async (query) => {
            calls.push({ name: "getProviderUsage", query });
            return { totals: {}, daily: [], breakdown: [] };
        },
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, calls };
}

function makeAdminController(options = {}) {
    const result = makeController(options);
    result.store.dispatch({
        type: "auth/context",
        principal: { provider: "test", subject: "admin" },
        authorization: { role: "admin" },
    });
    return result;
}

test("the whole table is one read, plus what is waiting", async () => {
    const { controller, store, calls } = makeController();
    await controller.loadProviderTable();

    assert.deepEqual(calls.map((c) => c.name).sort(), ["getProviderUsageGrid", "listPausedSessions"]);
    const view = selectProviderTable(store.getState());
    assert.equal(view.loaded, true);
    assert.equal(view.error, null);
    assert.deepEqual(view.rows.map((row) => row.providerName), ["azure-openai", "my-copilot"]);
    assert.equal(view.providerCount, 2);
});

test("a refused read is a refusal, in the words the server wrote", async () => {
    const { controller, store } = makeController({
        transportOverrides: {
            getProviderUsageGrid: async () => {
                throw new Error("You are signed out. Sign in again to see providers.");
            },
        },
    });
    await controller.loadProviderTable();

    const view = selectProviderTable(store.getState());
    // The paused read succeeded, so the table is not blank-and-loaded — it is
    // unread, and it says which part failed and why.
    assert.equal(view.loaded, false);
    assert.equal(view.empty, false);
    assert.equal(view.failed, true);
    assert.match(view.error, /Sign in again to see providers/);
    assert.match(view.error, /provider table could not be read/);
});

test("a deployment without the route says so rather than drawing an empty table", async () => {
    const { controller, store } = makeController({ transportOverrides: { getProviderUsageGrid: undefined } });
    await controller.loadProviderTable();

    const view = selectProviderTable(store.getState());
    assert.equal(view.failed, true);
    assert.equal(view.empty, false);
    assert.match(view.error, /not available on this deployment/);
});

test("selecting a provider reads that provider's chart, and only that provider's", async () => {
    const { controller, store, calls } = makeController();
    await controller.loadProviderTable();
    calls.length = 0;

    await controller.selectBudgetProvider("azure-openai");
    assert.deepEqual(calls.map((c) => c.name), ["getProviderUsage"]);
    assert.equal(calls[0].query.provider, "azure-openai");
    assert.equal(calls[0].query.days, 14);
    assert.equal(store.getState().budget.series.provider, "azure-openai");

    // Collapsing costs no read: the chart goes with the selection.
    calls.length = 0;
    await controller.selectBudgetProvider("azure-openai");
    assert.deepEqual(calls, []);
    assert.equal(store.getState().budget.selectedProvider, null);
});

test("admins read system spend separately from user quota charts", async () => {
    const { controller, store, calls } = makeAdminController({
        transportOverrides: {
            getProviderUsage: async (query) => {
                calls.push({ name: "getProviderUsage", query });
                return query.chargeClass === "system"
                    ? { totals: { tokensTotal: 90, turns: 2 }, daily: [], breakdown: [{ key: "azure-openai:gpt", label: "azure-openai:gpt", tokensTotal: 90, turns: 2 }] }
                    : { totals: {}, daily: [], breakdown: [] };
            },
        },
    });
    await controller.loadProviderTable();
    calls.length = 0;

    await controller.selectBudgetProvider("azure-openai");

    assert.equal(calls.filter((call) => call.name === "getProviderUsage").length, 2);
    assert.equal(calls.some((call) => call.query.chargeClass === "user"), true);
    assert.equal(calls.some((call) => call.query.chargeClass === "system" && call.query.dimension === "model"), true);
    assert.deepEqual(selectProviderTable(store.getState()).systemSpend.models.map((row) => row.label), ["azure-openai:gpt"]);
});

test("range changes reload user and system spend with the selected window", async () => {
    const { controller, store, calls } = makeAdminController();
    await controller.loadProviderTable();
    await controller.selectBudgetProvider("azure-openai");
    calls.length = 0;

    await controller.setBudgetRangeDays(30);
    assert.equal(store.getState().budget.rangeDays, 30);
    const thirty = calls.filter((call) => call.name === "getProviderUsage");
    assert.equal(thirty.length, 2);
    assert.equal(thirty.every((call) => call.query.days === 30), true);
    assert.equal(thirty.some((call) => call.query.chargeClass === "user"), true);
    assert.equal(thirty.some((call) => call.query.chargeClass === "system"), true);

    calls.length = 0;
    await controller.setBudgetRangeDays(90);
    assert.equal(store.getState().budget.rangeDays, 90);
    assert.equal(calls.filter((call) => call.name === "getProviderUsage")
        .every((call) => call.query.days === 90), true);
});

test("a slow chart answer never lands under a provider the reader has left", async () => {
    // The failure this prevents is one provider's spend drawn under another
    // provider's name, which nothing on the screen would contradict.
    let release = null;
    const { controller, store } = makeController({
        transportOverrides: {
            getProviderUsage: async (query) => {
                if (query.provider === "azure-openai") {
                    await new Promise((resolve) => { release = resolve; });
                    return { daily: [{ dayUtc: "2026-08-20", tokensTotal: 9_000_000, turns: 3 }] };
                }
                return { daily: [] };
            },
        },
    });
    await controller.loadProviderTable();

    const slow = controller.selectBudgetProvider("azure-openai");
    await controller.selectBudgetProvider("my-copilot");
    release();
    await slow;

    assert.equal(store.getState().budget.selectedProvider, "my-copilot");
    assert.deepEqual(store.getState().budget.series.days, []);
});

test("the background poll takes the paused list alone, and stays quiet when it fails", async () => {
    const failing = [];
    const { controller, store, calls } = makeController({
        transportOverrides: {
            listPausedSessions: async () => {
                failing.push("listPausedSessions");
                throw new Error("gateway timeout");
            },
        },
    });
    const waiting = [{ sessionId: "s1", status: "waiting", isGroup: false }];
    await controller.refreshBudgetPausesIfStale(waiting);

    // One call, and it is the paused list. The old surface re-read the
    // providers, their limits and the defaults every minute to get this.
    assert.deepEqual(failing, ["listPausedSessions"]);
    assert.deepEqual(calls, []);
    // Nobody asked for this read. An error banner on a table the reader is not
    // looking at is noise, and the next poll tries again.
    assert.equal(store.getState().budget.error, null);
});

test("the background poll does not run while the table is on screen", async () => {
    // The surface runs its own refresh on the same cadence; two pollers on one
    // list is one request a minute nobody reads.
    const { controller, store, calls } = makeController();
    store.dispatch({ type: "ui/budgetOpen", open: true });
    await controller.refreshBudgetPausesIfStale([{ sessionId: "s1", status: "waiting", isGroup: false }]);

    assert.deepEqual(calls, []);
});

test("a change re-reads the table and the chart it belongs to", async () => {
    const { controller, store, calls } = makeController({
        transportOverrides: {
            setProviderLimit: async () => ({ ruleId: "r1", seededTokens: 4_000_000 }),
        },
    });
    await controller.loadProviderTable();
    await controller.selectBudgetProvider("azure-openai");
    calls.length = 0;

    const result = await controller.setProviderLimit({
        provider: "azure-openai", period: "day", tokens: 20_000_000,
    });

    assert.equal(result.ok, true);
    // The number the editor warns with: what this period has ALREADY counted.
    assert.equal(result.result.seededTokens, 4_000_000);
    // A limit that changed moves the chart's dashed line, so both are re-read.
    assert.deepEqual(calls.map((c) => c.name).sort(),
        ["getProviderUsage", "getProviderUsageGrid", "listPausedSessions"]);
    assert.equal(store.getState().budget.selectedProvider, "azure-openai");
});

test("a refused change keeps the server's sentence and changes nothing", async () => {
    const { controller, store } = makeController({
        transportOverrides: {
            setProviderAllowance: async () => {
                const error = new Error("Only an administrator can set an allowance on a shared provider.");
                error.code = "PROVIDER_FORBIDDEN";
                throw error;
            },
        },
    });
    await controller.loadProviderTable();

    const result = await controller.setProviderAllowance({ provider: "azure-openai", pct: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PROVIDER_FORBIDDEN");
    assert.match(result.error, /^Only an administrator can set an allowance/);
    assert.equal(selectProviderTable(store.getState()).loaded, true);
});
