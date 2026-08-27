// Providers & Budgets — what the one table says, and what it asks for.
//
// The surface is specified in docs/proposals/providers-and-budgets-meters.md.
// It is ONE table: Provider, then Day, Week and Month, under a heading that
// names which pair of numbers is on screen. The two-tab surface, the stat
// tiles, the filters, the pivots and the paused band are gone, and so are the
// tests that were only about them.
//
// Four rules from that document are what most of this file exists to defend:
//
//   1. A meter is not a limit. A period with NO limit still shows what it
//      spent, beside an ∞. That number could not exist before, and it is the
//      reason the counter was re-keyed.
//   2. Two numbers that must never be confused. `used / quota` is the
//      PROVIDER's, shared by everyone; `your used / your share` is the
//      viewer's own. Which pair is on screen is the column HEADING, and the
//      Edit sheet always states the provider's own figure, because a limit
//      caps everyone.
//   3. A failed READ is never dressed up as an empty one. "No provider" and
//      "could not read the providers" are different facts and only one of
//      them is safe to act on.
//   4. Colour is never the only signal. Every cell prints both numbers and
//      the chart states its line and its scope in words.
//
// These run against the BUILT bundle in packages/app/web/dist, so run them
// with `npm run test:e2e --prefix packages/app`, which builds first. A stale
// dist means every assertion here passes against code that is not there.
import { test, expect } from "@playwright/test";
import {
    startProviderBudgetStub, gridFixture, timedHoldRow,
    oneCausePausedFixture, noProviderPausedFixture,
} from "./providers-budget-stub.mjs";

/** One stub per test: the recorded queries and calls are then this test's own. */
async function withStub(options, run) {
    const stub = await startProviderBudgetStub(options);
    try {
        await run(stub);
    } finally {
        await stub.close();
    }
}

async function openBudget(page, stub) {
    await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".ps-panel", { timeout: 15_000 });
    await page.getByRole("button", { name: /^Budget — providers/ }).click();
    await page.waitForSelector(".ps-budget-surface", { timeout: 10_000 });
    // Wait for the read to land rather than for a clock.
    await expect(page.locator(".ps-budget-empty").filter({ hasText: "Reading providers" })).toHaveCount(0);
}

/** One provider row, found by the name printed in it. */
const row = (page, name) => page.locator("tr.ps-budget-grid-row").filter({
    has: page.locator(".ps-budget-grid-pname", { hasText: new RegExp(`^${name}$`) }),
});

/** One model-scoped limit's row, found by the model it is scoped to. */
const modelRow = (page, scope) => page.locator("tr.ps-budget-grid-row.is-model").filter({
    has: page.locator(".ps-budget-grid-mname", { hasText: new RegExp(`^${scope}$`) }),
});

/** Day is 0, Week is 1, Month is 2 — the order of the columns themselves. */
const numCell = (target, index) => target.locator("td.ps-budget-grid-num").nth(index);

/** The used half of a cell, which is the only half that carries a tint. */
const usedPart = (target, index) => numCell(target, index).locator(".ps-budget-pct");

const overallTick = (page) => page.getByRole("checkbox", { name: "Show all user spend" });
const lastUserUsageQuery = (stub) => [...stub.usageQueries].reverse()
    .find((query) => query.chargeClass === "user");

/**
 * Select a provider, and wait for its chart to settle.
 *
 * The chart measures its own x-axis after mount, which changes its height and
 * moves everything under it. Letting that finish before a test clicks anything
 * else keeps the click on the thing it aimed at.
 */
async function selectProvider(page, name) {
    await row(page, name).locator(".ps-budget-grid-pick").click();
    await page.waitForSelector(".ps-budget-chart .ps-budget-tl-x", { timeout: 10_000 });
}

/** The whole table as text: one array per row, name then the three cells. */
const gridText = (page) => page.$$eval("tr.ps-budget-grid-row", (rows) => rows.map((r) => {
    const name = r.querySelector(".ps-budget-grid-pname, .ps-budget-grid-mname")?.textContent || "";
    const cells = [...r.querySelectorAll("td.ps-budget-grid-num")]
        .map((td) => td.textContent.replace(/\s+/g, " ").trim());
    return [name, ...cells];
}));

const sheet = (page) => page.locator(".ps-budget-sheet");
const actions = (page) => page.locator(".ps-budget-actions");

// "in 2h 10m (00:00 UTC)" — the one way this surface spells a reset. Both
// halves, every time: how long, and when.
const RESET_SPELLING = /in \d+[hd] \d{2}[md] \(\d{2}:\d{2} UTC\)/;

// ── The table ──────────────────────────────────────────────────────────

test("the toolbar coin opens one table, and nothing else", async ({ page }) => {
    await withStub({}, async (stub) => {
        await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".ps-panel", { timeout: 15_000 });
        await expect(page.locator(".ps-budget-surface")).toHaveCount(0);

        await page.getByRole("button", { name: /^Budget — providers/ }).click();
        await expect(page.locator(".ps-budget-surface")).toBeVisible();
        await expect(page.locator(".ps-budget-h")).toHaveText("Providers & Budgets");
        await expect(page.locator("table.ps-budget-grid")).toBeVisible();

        // One tab, one list, nothing else. Each of these was a surface of its
        // own and each is deleted, so their absence is the shape of the screen.
        // Two tabs and nothing else: the provider table, and the Cluster
        // summary (its own spec). No stats strip, no filter bar, no pivot.
        await expect(page.getByRole("tab")).toHaveText(["Providers", "Cluster summary"]);
        await expect(page.locator(".ps-budget-stats")).toHaveCount(0);
        await expect(page.locator(".ps-budget-filters")).toHaveCount(0);
        await expect(page.locator(".ps-budget-pivot")).toHaveCount(0);
        await expect(page.locator(".ps-budget-band")).toHaveCount(0);
        await expect(page.locator(".ps-budget-panel")).toHaveCount(0);
    });
});

test("every provider gets six numbers, and ∞ where a period has no limit", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);

        // The column heading names which pair of numbers is underneath. It is
        // the heading and not a footnote, because every figure below it means
        // something different when the tick changes.
        await expect(page.locator(".ps-budget-grid-h.is-name")).toHaveText("Provider");
        await expect(page.locator(".ps-budget-grid-h.is-span")).toHaveText("My spend");
        expect(await page.$$eval(".ps-budget-grid-h.is-num", (els) => els.map((e) => e.textContent)))
            .toEqual(["Day", "Week", "Month"]);
        await expect(page.locator(".ps-budget-table-head .ps-budget-label")).toHaveText("Providers · 4");

        // Four providers, twelve cells, and every one of them is two numbers.
        // A cell with no limit prints ∞ for the quota and the REAL usage beside
        // it — the fact the old counter could not hold, because it existed only
        // where a limit existed.
        expect(await gridText(page)).toEqual([
            ["copilot-shared", "2.4M ⏻ / 10.0M", "9.6M / ∞", "20.0M / 200.0M"],
            ["azure-prod", "512.0K / 4.0M", "1.2M / ∞", "3.0M / 20.0M"],
            ["paused-vendor", "120.0K / ∞", "400.0K / ∞", "1.5M / ∞"],
            ["my-sandbox", "12.0K / ∞", "840.0K / 5.0M", "3.2M / ∞"],
        ]);
    });
});

test("a period with no limit still shows what it spent", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);

        // paused-vendor has no limit anywhere and has still spent tokens in
        // all three periods. Before the meter was keyed by what it measures,
        // every one of these cells was blank.
        const held = row(page, "paused-vendor");
        for (const index of [0, 1, 2]) {
            await expect(numCell(held, index)).toContainText("∞");
            await expect(usedPart(held, index)).not.toHaveText("—");
            await expect(usedPart(held, index)).not.toHaveText("0");
        }
        await expect(usedPart(held, 0)).toHaveText("120.0K");

        // And on a provider that IS capped for one period and not another:
        // copilot-shared's week is uncapped and has spent 9.6M.
        await expect(numCell(row(page, "copilot-shared"), 1)).toHaveText("9.6M / ∞");

        // The ∞ half is a quota, so it sits in the quota half of the cell and
        // never reads as the number spent.
        await expect(numCell(held, 0).locator(".ps-budget-q.is-inf")).toHaveText("/ ∞");
    });
});

test("the tick swaps your share for everyone's, and only then names the allowance", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        const azure = row(page, "azure-prod");

        // Unticked: the viewer's own spend against their own share. On
        // azure-prod the two pairs are 35 times apart, which is exactly why
        // which pair is on screen has to be said in words.
        await expect(page.locator(".ps-budget-grid-h.is-span")).toHaveText("My spend");
        await expect(numCell(azure, 0)).toHaveText("512.0K / 4.0M");
        // The allowance is a fact about how the TOTAL is divided, so it belongs
        // beside the total and appears nowhere else.
        await expect(page.locator(".ps-budget-grid-allow")).toHaveCount(0);

        await overallTick(page).check();

        await expect(page.locator(".ps-budget-grid-h.is-span")).toHaveText("All user spend");
        await expect(numCell(azure, 0)).toHaveText("18.0M / 20.0M");
        await expect(numCell(azure, 2)).toHaveText("40.0M / 100.0M");
        await expect(azure.locator(".ps-budget-grid-allow")).toHaveText("Per-user allowance: 20% of each limit");
        // 100% is no per-person ceiling, so there is no share to state.
        await expect(row(page, "copilot-shared").locator(".ps-budget-grid-allow")).toHaveCount(0);
        await expect(page.locator(".ps-budget-grid-allow")).toHaveCount(1);

        await overallTick(page).uncheck();
        await expect(numCell(azure, 0)).toHaveText("512.0K / 4.0M");
        await expect(page.locator(".ps-budget-grid-allow")).toHaveCount(0);
    });
});

test("every provider names its class: Shared or User", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        // Both are named. An unmarked row is one whose kind the reader has to
        // infer, and the two behave differently enough that inferring is worse
        // than a second chip.
        for (const name of ["copilot-shared", "azure-prod", "paused-vendor"]) {
            await expect(row(page, name).locator(".ps-budget-chip.is-shared")).toHaveText("Shared");
        }
        await expect(row(page, "my-sandbox").locator(".ps-budget-chip.is-personal")).toHaveText("User");
        // A user provider says WHOSE it is. "User" alone tells two people's
        // providers apart only by whatever they happened to name them.
        await expect(row(page, "my-sandbox").locator(".ps-budget-grid-owner")).toHaveText("(Ada Admin)");
        // A shared provider is everybody's and names no owner.
        await expect(row(page, "copilot-shared").locator(".ps-budget-grid-owner")).toHaveCount(0);
        await expect(page.locator(".ps-budget-chip.is-shared")).toHaveCount(3);
        await expect(page.locator(".ps-budget-chip.is-personal")).toHaveCount(1);
        // A model row is not a provider and carries no class mark.
        await selectProvider(page, "azure-prod");
        await expect(modelRow(page, "gpt-5.4").locator(".ps-budget-chip")).toHaveCount(0);
    });
});

test("a hold is marked on the row it stops, and counts down when it has an end", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        // A hold stops every turn against this provider right now. Its three
        // cells read 0% of ∞, so the row itself has to say why nothing runs.
        const chip = row(page, "paused-vendor").locator(".ps-budget-chip.is-hold");
        await expect(chip).toHaveText("on hold");
        await expect(chip).toHaveAttribute("title", "It lifts when an administrator releases it.");
        await expect(page.locator(".ps-budget-chip.is-hold")).toHaveCount(1);
    });
    await withStub({ grid: [...gridFixture(), timedHoldRow()] }, async (stub) => {
        await openBudget(page, stub);
        // The same spelling as every other clock on this surface: how long,
        // and when.
        await expect(row(page, "timed-vendor").locator(".ps-budget-chip.is-hold"))
            .toHaveAttribute("title", /^It lifts in \d+h \d{2}m \(\d{2}:\d{2} UTC\)\.$/);
    });
});

// ── Per-model limits, in the same three columns ────────────────────────

test("the teaser appears where model usage exists, and selecting expands it", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);

        const azure = row(page, "azure-prod");
        await expect(azure.locator(".ps-budget-grid-teaser")).toHaveText("show 4 models");
        // Three providers have no model-scoped limit and claim none.
        await expect(page.locator(".ps-budget-grid-teaser")).toHaveCount(1);
        await expect(azure.locator(".ps-budget-grid-pick")).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator("tr.ps-budget-grid-row.is-model")).toHaveCount(0);

        await selectProvider(page, "azure-prod");

        // The model rows are inserted UNDER the provider they belong to, and
        // read in the same three columns — which is what makes a model limit
        // biting under a provider with room a thing you can see.
        await expect(azure.locator(".ps-budget-grid-pick")).toHaveAttribute("aria-expanded", "true");
        await expect(azure.locator(".ps-budget-grid-pick")).toHaveAttribute("aria-pressed", "true");
        await expect(azure.locator(".ps-budget-grid-teaser")).toHaveText("hide 4 models");
        expect(await gridText(page)).toEqual([
            ["copilot-shared", "2.4M ⏻ / 10.0M", "9.6M / ∞", "20.0M / 200.0M"],
            ["azure-prod", "512.0K / 4.0M", "1.2M / ∞", "3.0M / 20.0M"],
            ["gpt-5.4", "1.2M / 1.0M", "2.0M / ∞", "4.0M / 12.0M"],
            ["gpt-5.4-mini", "60.0K / 400.0K", "180.0K / ∞", "800.0K / ∞"],
            ["gpt-5.6-luna", "420.0K / ∞", "1.3M / ∞", "2.2M / ∞"],
            ["gpt-5.6-sol", "280.0K / ∞", "820.0K / ∞", "1.6M / ∞"],
            ["paused-vendor", "120.0K / ∞", "400.0K / ∞", "1.5M / ∞"],
            ["my-sandbox", "12.0K / ∞", "840.0K / 5.0M", "3.2M / ∞"],
        ]);
        // A model row says what it is, so it is never read as a provider.
        await expect(modelRow(page, "gpt-5.4")).toContainText("model");
        await expect(numCell(modelRow(page, "gpt-5.6-luna"), 0)).toHaveText("420.0K / ∞");
        // The allowance belongs to the provider, not to each of its limits.
        await expect(modelRow(page, "gpt-5.4").locator(".ps-budget-grid-allow")).toHaveCount(0);

        // Selecting the selected row collapses it again: selecting and
        // expanding are one act, so they undo together.
        await azure.locator(".ps-budget-grid-pick").click();
        await expect(page.locator("tr.ps-budget-grid-row.is-model")).toHaveCount(0);
        await expect(azure.locator(".ps-budget-grid-teaser")).toHaveText("show 4 models");
    });
});

test("a model limit can be over while the provider above it still has room", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");
        const azure = row(page, "azure-prod");
        const model = modelRow(page, "gpt-5.4");

        // Your own reading: 512.0K of a 4.0M share is 13%, while your share of
        // this one model's daily limit is already spent past.
        await expect(usedPart(azure, 0)).not.toHaveClass(/over/);
        await expect(numCell(model, 0)).toHaveText("1.2M / 1.0M");
        await expect(usedPart(model, 0)).toHaveClass(/over/);

        // And everyone's: the provider is at 90% — amber, still running — while
        // the model above its own limit. Both numbers are printed in both
        // rows, so the tint is never carrying the fact on its own.
        await overallTick(page).check();
        await expect(numCell(azure, 0)).toHaveText("18.0M / 20.0M");
        await expect(usedPart(azure, 0)).toHaveClass(/warn/);
        await expect(usedPart(azure, 0)).not.toHaveClass(/over/);
        await expect(numCell(model, 0)).toHaveText("5.4M / 5.0M");
        await expect(usedPart(model, 0)).toHaveClass(/over/);
    });
});

test("selecting a per-model limit narrows the chart to that model", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");

        // The provider's own days: 4.4M at the peak, against its 4.0M share.
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-chart-title")).toContainText("azure-prod");
        await expect(page.locator(".ps-budget-legend")).toContainText("Peak 4.4M tokens/day");
        expect(lastUserUsageQuery(stub).model, "the provider's chart asks for no model")
            .toBeUndefined();

        // Standing on one of its model rows is a different question, and gets
        // a different answer: that model alone, against that model's limit.
        await modelRow(page, "gpt-5.4").locator(".ps-budget-grid-pick").click();
        await page.waitForSelector(".ps-budget-chart .ps-budget-tl-x", { timeout: 10_000 });

        await expect(page.locator(".ps-budget-chart-pane .ps-budget-chart-title")).toContainText("azure-prod · gpt-5.4");
        await expect(page.locator(".ps-budget-legend")).toContainText("Peak 366.0K tokens/day");
        // The filter reached the WIRE, not just the heading.
        expect(lastUserUsageQuery(stub).model).toBe("azure-prod:gpt-5.4");
        // And the dashed line moved with it: the model row's Day quota, which
        // is your 1.0M share, not the provider's 4.0M.
        await expect(page.locator(".ps-budget-legend")).toContainText("Dashed line: 1.0M a day");

        // The provider stays expanded while one of its models is the subject —
        // the rows are on screen, so the teaser must not offer to expand them.
        await expect(row(page, "azure-prod").locator(".ps-budget-grid-teaser"))
            .toHaveText("hide 4 models");
        // Usage-policy editing is still about the PROVIDER: there is no such
        // thing as editing policy on a model row independently.
        await expect(actions(page).locator(".ps-budget-sub")).toHaveText("azure-prod");
        await actions(page).getByRole("button", { name: "Edit usage policy" }).click();
        await expect(sheet(page).locator(".ps-budget-sheet-title")).toHaveText("Limits");
        await sheet(page).getByRole("button", { name: "Cancel" }).click();

        // Clicking it again falls back to the provider rather than collapsing
        // the row out from under the reader.
        await modelRow(page, "gpt-5.4").locator(".ps-budget-grid-pick").click();
        await page.waitForSelector(".ps-budget-chart .ps-budget-tl-x", { timeout: 10_000 });
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-chart-title")).toContainText("azure-prod");
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-chart-title")).not.toContainText("gpt-5.4");
        await expect(page.locator(".ps-budget-legend")).toContainText("Peak 4.4M tokens/day");
    });
});

// ── The chart under the selected row ───────────────────────────────────

test("selecting opens the day chart, and the dashed line is the Day cell's own quota", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await expect(page.locator(".ps-budget-chart-pane")).toHaveCount(0);

        await selectProvider(page, "azure-prod");
        const chart = page.locator(".ps-budget-chart-pane");
        await expect(chart.locator(".ps-budget-chart-title")).toContainText("azure-prod");
        await expect(chart.locator(".ps-budget-chart-title")).toContainText("my spend, by day");

        // Unticked, the Day cell reads 512.0K / 4.0M, so the line is at 4.0M —
        // the same object the row printed, which is what stops the chart and
        // the row disagreeing.
        await expect(numCell(row(page, "azure-prod"), 0)).toHaveText("512.0K / 4.0M");
        await expect(chart.locator(".ps-budget-tl-median span")).toHaveText("the Day limit · 4.0M a day");
        await expect(chart.locator(".ps-budget-legend")).toContainText("Dashed line: 4.0M a day");
        // The BARS are the same scope as the line, because the request says
        // so. This is what the note used to apologise for: an admin's chart
        // drew the whole fleet under a heading that said "your usage".
        expect(lastUserUsageQuery(stub).mine).toBe("true");
        expect(lastUserUsageQuery(stub).chargeClass).toBe("user");
        await expect(chart.locator(".ps-budget-note.is-warn")).toHaveCount(0);

        // Ticked, the same cell reads 18.0M / 20.0M and the line follows it —
        // and so do the bars: `mine` drops off the request.
        await overallTick(page).check();
        await expect(numCell(row(page, "azure-prod"), 0)).toHaveText("18.0M / 20.0M");
        await expect(chart.locator(".ps-budget-tl-median span")).toHaveText("the Day limit · 20.0M a day");
        await expect(chart.locator(".ps-budget-legend")).toContainText("Dashed line: 20.0M a day");
        expect(lastUserUsageQuery(stub).mine).toBeUndefined();
        // System spend is excluded from the bars in BOTH states, because the
        // meters a cell reads never move for it.
        expect(lastUserUsageQuery(stub).chargeClass).toBe("user");
        await expect(chart.locator(".ps-budget-note.is-warn")).toHaveCount(0);
        await expect(chart.locator(".ps-budget-chart-title")).toContainText("all user spend, by day");

        const system = page.locator(".ps-budget-system-spend");
        await expect(system).toContainText("System spend");
        // The headline is a STAT TILE — the number in a <strong> above the word
        // "tokens", not one string — so textContent reads "1.0Mtokens" and a
        // "1.0M tokens" substring can never match. Assert the two parts, which
        // also pins that the number is the emphasised one rather than matching
        // a digit sequence anywhere in the section.
        const headline = system.locator(".ps-budget-system-stat").first();
        await expect(headline.locator("strong")).toHaveText("1.0M");
        await expect(headline).toContainText("tokens");
        // The per-model breakdown is a TABLE now (Model | Tokens | Share |
        // Turns), not a "760.0K · 5 turns" sentence. Assert the row's cells, so
        // this says which column each number is in rather than that the digits
        // appear somewhere in the section.
        const luna = system.locator(".ps-budget-system-models tbody tr", { hasText: "gpt-5.6-luna" }).first();
        await expect(luna).toBeVisible();
        await expect(luna.locator("td").nth(1)).toHaveText("760.0K");
        await expect(luna.locator("td").nth(3)).toHaveText("5");
        await expect(system.locator(".ps-budget-system-models tbody tr", { hasText: "gpt-5.6-sol" }))
            .toHaveCount(1);
    });
});

test("usage range defaults to 14d and reloads user and system spend at 30d and 90d", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await expect(page.getByRole("group", { name: "Chart range" })).toHaveCount(0);
        await selectProvider(page, "azure-prod");
        const range = page.getByRole("group", { name: "Chart range" });
        await expect(range.getByRole("button")).toHaveText(["14d", "30d", "90d"]);
        await expect(range.getByRole("button", { name: "14d" })).toHaveAttribute("aria-pressed", "true");

        expect(lastUserUsageQuery(stub).days).toBe("14");
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-tl-col")).toHaveCount(14);

        await range.getByRole("button", { name: "30d" }).click();
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-chart-head")).toContainText("Last 30 days");
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-tl-col")).toHaveCount(30);
        expect(lastUserUsageQuery(stub).days).toBe("30");
        expect(stub.usageQueries.some((query) => query.chargeClass === "system" && query.days === "30")).toBe(true);
        await expect(page.locator(".ps-budget-system-spend")).toContainText("Last 30 days");

        await range.getByRole("button", { name: "90d" }).click();
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-chart-head")).toContainText("Last 90 days");
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-tl-col")).toHaveCount(90);
        expect(lastUserUsageQuery(stub).days).toBe("90");
        await expect(range.getByRole("button", { name: "90d" })).toHaveAttribute("aria-pressed", "true");
    });
});

test("a day with no limit draws no line, and says so instead", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "paused-vendor");
        const chart = page.locator(".ps-budget-chart-pane");
        await expect(chart.locator(".ps-budget-tl-median")).toHaveCount(0);
        await expect(chart.locator(".ps-budget-legend")).toContainText("No daily limit, so no line");
        // The bars are still drawn: usage exists without a limit.
        await expect(chart.locator(".ps-budget-tl-col:not(.is-idle)").first()).toBeVisible();
    });
});

test("a range with nothing in it says so rather than drawing an empty axis", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        // The report omits a provider that spent nothing in the range, which
        // is what lets the chart tell "spent nothing" from "no answer held".
        await selectProvider(page, "my-sandbox");
        await expect(page.locator(".ps-budget-noaxis"))
            .toHaveText("No token usage on my-sandbox (Ada Admin) in this range.");
        await expect(page.locator(".ps-budget-chart-pane .ps-budget-empty.is-error")).toHaveCount(0);
    });
});

test("a chart that could not be read is a failure, not an empty chart", async ({ page }) => {
    const message = "The daily report is being rebuilt. Try again in a minute.";
    await withStub({
        fail: { getProviderUsage: { status: 503, code: "INTERNAL_ERROR", message } },
    }, async (stub) => {
        await openBudget(page, stub);
        await row(page, "azure-prod").locator(".ps-budget-grid-pick").click();

        const chart = page.locator(".ps-budget-chart-pane");
        await expect(chart.locator(".ps-budget-empty.is-error"))
            .toContainText("The daily usage for azure-prod could not be read.");
        await expect(chart.locator(".ps-budget-empty.is-error")).toContainText(message);
        // A failed chart never blanks the numbers above it.
        await expect(numCell(row(page, "azure-prod"), 0)).toHaveText("512.0K / 4.0M");
    });
});

// ── Usage-policy editing only ──────────────────────────────────────────

test("provider lifecycle and defaults link to Admin Console instead of mutating here", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        const edit = actions(page).getByRole("button", { name: "Edit usage policy" });

        await expect(actions(page).getByRole("button", { name: "+ Add" })).toHaveCount(0);
        await expect(actions(page).getByRole("button", { name: "Remove" })).toHaveCount(0);
        // The head keeps only Refresh: leaving for the admin console or the
        // workspace is the toolbar's Mode cluster.
        await expect(page.locator(".ps-budget-head-actions button")).toHaveCount(1);
        await expect(edit).toBeDisabled();
        await expect(actions(page).locator(".ps-budget-sub")).toHaveText("No provider selected");

        await numCell(row(page, "azure-prod"), 1).click();
        await page.waitForSelector(".ps-budget-chart .ps-budget-tl-x", { timeout: 10_000 });
        await expect(actions(page).locator(".ps-budget-sub")).toHaveText("azure-prod");
        await expect(edit).toBeEnabled();
        await expect(row(page, "copilot-shared")).toContainText("cluster default");
        await expect(row(page, "my-sandbox")).toContainText("my default");
        await expect(row(page, "my-sandbox")).toContainText("system default");

        expect(stub.calls, "reading and selecting send no mutation").toEqual([]);
    });
});

test("Edit holds limits, allowance and hold, but no default controls", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");
        await actions(page).getByRole("button", { name: "Edit usage policy" }).click();

        const s = sheet(page);
        await expect(s.locator(".ps-budget-sheet-sub")).toHaveText("azure-prod · shared");
        const what = s.locator(".ps-budget-seg[aria-label='What to change']");
        expect(await what.locator("button").allTextContents())
            .toEqual(["Limits", "Allowance", "Hold"]);

        // Limits, which is where it opens.
        await expect(s.locator(".ps-budget-sheet-title")).toHaveText("Limits");
        await expect(s.locator(".ps-budget-note.is-warn").first()).toContainText(
            "Replaces the existing 20.0M token limit.");

        // The allowance, computed against the limits that are really there.
        await what.getByRole("button", { name: "Allowance" }).click();
        await expect(s.locator(".ps-budget-consequences")).toContainText("Daily · 20.0M → 4.0M per person");
        await expect(s.locator(".ps-budget-consequences")).toContainText("Monthly · 100.0M → 20.0M per person");
        await expect(s).toContainText("The provider limit still caps total spend.");

        // The hold, which used to be a panel of its own on the deleted tab.
        await what.getByRole("button", { name: "Hold" }).click();
        await expect(s.locator(".ps-budget-sheet-note")).toHaveText("Stops new turns.");
        await expect(s.locator(".ps-budget-note")).toContainText(
            "Every session on azure-prod pauses on its next turn.");

        await expect(s.getByRole("combobox", { name: /default/i })).toHaveCount(0);
        await s.getByRole("button", { name: "Cancel" }).click();
        expect(stub.calls, "reading the sheet changes nothing").toEqual([]);
    });
});

test("the already-spent figure in Edit is the provider's own, whichever pair is on screen", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");

        // The table is showing the viewer's own 512.0K. A limit caps EVERYONE,
        // so the sentence about what the limit will count from has to be about
        // everyone — 18,000,000, not the 512,000 in the cell.
        await expect(numCell(row(page, "azure-prod"), 0)).toHaveText("512.0K / 4.0M");
        await actions(page).getByRole("button", { name: "Edit usage policy" }).click();
        await expect(sheet(page).locator(".ps-budget-consequences")).toContainText(
            "Daily · all models — 18,000,000 tokens spent by users this period.");
        await expect(sheet(page).locator(".ps-budget-consequences")).not.toContainText("512,000");
        await expect(sheet(page).locator(".ps-budget-consequences .ps-budget-sub"))
            .toHaveText(/^Resets in \d+h \d{2}m \(\d{2}:\d{2} UTC\)\.$/);

        // A cap at or below what the period has already spent stops work now,
        // and the sheet says so with both numbers rather than alluding to them.
        await sheet(page).getByRole("textbox", { name: "Tokens" }).fill("10M");
        await expect(sheet(page).locator(".ps-budget-note.is-warn").last()).toContainText(
            "18,000,000 already meets 10,000,000, so sessions on azure-prod pause on their next turn");
        await sheet(page).getByRole("button", { name: "Cancel" }).click();
        expect(stub.calls).toEqual([]);
    });
});

test("saving a limit sends the period, the scope and the token count", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");
        await actions(page).getByRole("button", { name: "Edit usage policy" }).click();

        const s = sheet(page);
        // Weekly · all models has no limit on azure-prod, so this is a save and
        // not a replace, and the button says which.
        await s.locator(".ps-budget-seg[aria-label='Time period']")
            .getByRole("button", { name: "Weekly" }).click();
        await expect(s).not.toContainText("Saving replaces it");
        await s.getByRole("textbox", { name: "Tokens" }).fill("5M");
        await expect(s).toContainText("= 5,000,000 tokens");
        await s.getByRole("button", { name: "Save limit" }).click();
        await expect(page.locator(".ps-budget-sheet")).toHaveCount(0);

        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0].op).toBe("setProviderLimit");
        expect(stub.calls[0].method).toBe("PUT");
        expect(stub.calls[0].name).toBe("azure-prod");
        // "all models" is a null scope on the wire, not an absent one.
        expect(stub.calls[0].body).toEqual({ period: "week", model: null, tokens: 5_000_000 });
    });
});

test("releasing a hold from Edit says what it wakes, and sends the release", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "paused-vendor");
        await actions(page).getByRole("button", { name: "Edit usage policy" }).click();

        const s = sheet(page);
        await s.locator(".ps-budget-seg[aria-label='What to change']")
            .getByRole("button", { name: "Hold" }).click();
        await expect(s.locator(".ps-budget-consequences"))
            .toContainText("This provider is on hold: it lifts when an administrator releases it.");
        await expect(s.locator(".ps-budget-note"))
            .toContainText("Releasing wakes every session waiting on paused-vendor.");
        // Releasing a hold is not a way past a limit.
        await expect(s.locator(".ps-budget-note"))
            .toContainText("A session still over a limit stays paused for that reason instead.");

        await s.getByRole("button", { name: "Release hold" }).click();
        await expect.poll(() => stub.calls.length).toBe(1);
        expect(stub.calls[0].op).toBe("setProviderHold");
        expect(stub.calls[0].name).toBe("paused-vendor");
        expect(stub.calls[0].body).toEqual({ untilUtc: null, release: true });
    });
});

test("a non-admin gets the sections that are theirs, and no others", async ({ page }) => {
    await withStub({ admin: false }, async (stub) => {
        await openBudget(page, stub);
        // The numbers still read, including their own share of a shared one.
        await expect(numCell(row(page, "azure-prod"), 0)).toHaveText("512.0K / 4.0M");

        await selectProvider(page, "azure-prod");
        await expect(actions(page).getByRole("button", { name: "Remove" })).toHaveCount(0);
        await expect(actions(page).getByRole("button", { name: "+ Add" })).toHaveCount(0);
        await expect(actions(page).getByRole("button", { name: "Edit usage policy" })).toBeDisabled();
        await expect(sheet(page)).toHaveCount(0);
    });
});

// ── The one line above the table ───────────────────────────────────────

test("the waiting line appears only when something is waiting, and opens the row", async ({ page }) => {
    await withStub({ paused: oneCausePausedFixture() }, async (stub) => {
        await openBudget(page, stub);
        const line = page.locator(".ps-budget-waiting");
        // One provider accounts for both, so it may be named. Naming one of
        // two causes would send the reader to the wrong row.
        await expect(line).toContainText("2 sessions are waiting on copilot-shared.");
        // A sentence with a link, not a band: WHY a session is stopped is said
        // on the session itself, where the remedy is.
        await expect(page.locator(".ps-budget-band")).toHaveCount(0);

        await line.getByRole("button", { name: "Open copilot-shared" }).click();
        await expect(row(page, "copilot-shared")).toHaveClass(/is-on/);
        await expect(actions(page).locator(".ps-budget-sub")).toHaveText("copilot-shared");
    });
});

test("two causes are counted without naming either", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        // Two on copilot-shared, one on azure-prod.
        await expect(page.locator(".ps-budget-waiting")).toContainText("3 sessions are waiting.");
        await expect(page.locator(".ps-budget-waiting")).not.toContainText("waiting on");
        // The link still goes to the provider stopping the most of them.
        await expect(page.locator(".ps-budget-waiting").getByRole("button", { name: "Open copilot-shared" }))
            .toBeVisible();
    });
});

test("nothing waiting means no line at all", async ({ page }) => {
    await withStub({ paused: [] }, async (stub) => {
        await openBudget(page, stub);
        await expect(page.locator(".ps-budget-waiting")).toHaveCount(0);
        await expect(page.locator("table.ps-budget-grid")).toBeVisible();
    });
});

test("a name that sessions are stuck on, with no provider behind it, links to Model Providers", async ({ page }) => {
    // The worst place to land: a session stopped on `retired-vendor` links
    // here BY that name, and no row carries it. The selection cannot survive
    // the read — so without this the reader arrives at a table with nothing
    // selected and no sign that the name they clicked is the missing thing.
    // The pause record has to sit on a session the LIST actually carries, so
    // it is pinned to that list's own first row.
    const paused = noProviderPausedFixture().map((r) => ({
        ...r, sessionId: "11111110-2222-3333-4444-555555555550",
    }));
    await withStub({ paused }, async (stub) => {
        await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".ps-session-list-button", { timeout: 15_000 });

        // Arrive the way the stranded reader does: from the session itself.
        const listRow = page.locator(".ps-session-list-button", { hasText: "Nightly triage" }).first();
        await expect(listRow).toContainText("no provider", { timeout: 15_000 });
        await listRow.click();
        const pause = page.locator(".ps-session-detail-box .ps-session-detail-pause");
        await expect(pause.getByRole("button", { name: "Open retired-vendor" })).toBeVisible();
        await pause.getByRole("button", { name: "Open retired-vendor" }).click();
        await page.waitForSelector(".ps-budget-surface", { timeout: 10_000 });

        const line = page.locator(".ps-budget-waiting.is-missing");
        await expect(line).toBeVisible();
        await expect(line).toContainText("No provider is named retired-vendor");
        await expect(line).toContainText("1 session waits on it");
        await expect(line).toContainText("They run again as soon as a provider takes that name.");
        // Nothing is selected, because there is nothing to select.
        await expect(page.locator("tr.ps-budget-grid-row.is-on")).toHaveCount(0);

        // Provider lifecycle belongs to Admin Console; this surface links to
        // the owner rather than opening another creation form here.
        await line.getByRole("button", { name: "Open Model Providers" }).click();
        await expect(page.locator(".ps-admin-model-providers")).toBeVisible();
        await expect(page.getByText("Model Providers", { exact: true }).first()).toBeVisible();
    });
});

test("a provider that vanished with nothing waiting on it is not announced", async ({ page }) => {
    // The line is for someone who is STUCK. Selecting a provider and having
    // it disappear from a later read, with no session riding on the name,
    // needs no announcement — and offering to re-create it reads as a fault.
    await withStub({ paused: [] }, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "my-sandbox");
        await expect(row(page, "my-sandbox")).toHaveClass(/is-on/);

        // The next read no longer carries it.
        stub.setGrid(gridFixture().filter((r) => r.providerName !== "my-sandbox"));
        await page.getByRole("button", { name: "Refresh providers and budgets" }).click();

        await expect(row(page, "my-sandbox")).toHaveCount(0);
        await expect(page.locator(".ps-budget-waiting.is-missing")).toHaveCount(0);
        await expect(page.locator("tr.ps-budget-grid-row.is-on")).toHaveCount(0);
    });
});

// ── A failed read is never an empty one ────────────────────────────────

test("a read that failed renders as a failure, not as an empty table", async ({ page }) => {
    const message = "The provider store is being restored. Try again in a minute.";
    await withStub({
        fail: { getProviderUsageGrid: { status: 503, code: "INTERNAL_ERROR", message } },
    }, async (stub) => {
        await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".ps-panel", { timeout: 15_000 });
        await page.getByRole("button", { name: /^Budget — providers/ }).click();

        const failure = page.locator(".ps-budget .ps-budget-empty.is-error");
        await expect(failure).toBeVisible();
        await expect(failure).toContainText("Providers and budgets could not be read.");
        // The server's own words, which name the remedy.
        await expect(failure).toContainText(message);
        await expect(failure.getByRole("button", { name: "Try again" })).toBeVisible();
        // No table, and above all no "there are no providers yet": that is a
        // claim this read never got to make.
        await expect(page.locator("table.ps-budget-grid")).toHaveCount(0);
        expect(await page.locator(".ps-budget").textContent()).not.toContain("No provider exists yet");
    });
});

test("a namespace that really is empty points provider onboarding to Admin Console", async ({ page }) => {
    await withStub({ grid: [], paused: [] }, async (stub) => {
        await openBudget(page, stub);
        await expect(page.locator(".ps-budget-empty"))
            .toHaveText("No provider exists yet. Add one in Admin Console → Model Providers to start spending.");
        // An empty state is not an error state, and only a read that SUCCEEDED
        // may report one.
        await expect(page.locator(".ps-budget-empty.is-error")).toHaveCount(0);
        await expect(actions(page).getByRole("button", { name: "+ Add" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Refresh providers and budgets" })).toBeVisible();
    });
});

// ── One reset, one spelling ────────────────────────────────────────────

test("every clock on the surface is written the same way: how long, and when", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        // The cell's own hover text carries the period, the cap and the reset
        // — and, on this row, the reason a 24% cell is marked: the PROVIDER's
        // own limit is spent, so nothing runs whatever the share says.
        await expect(numCell(row(page, "copilot-shared"), 0)).toHaveAttribute(
            "title", /^copilot-shared · Day — 2\.4M of 10\.0M \(24%\)\. It resets in \d+h \d{2}m \(\d{2}:\d{2} UTC\)\. The provider\x27s own limit for this period is spent, so nothing runs against it whatever your share says\.( Made of in .*\.)?$/);
        // The row with room says nothing extra.
        await expect(numCell(row(page, "azure-prod"), 0)).toHaveAttribute(
            "title", /^azure-prod · Day — 512\.0K of 4\.0M \(13%\)\. It resets in \d+h \d{2}m \(\d{2}:\d{2} UTC\)\.( Made of in .*\.)?$/);
        // An uncapped period says it is uncapped rather than inventing a cap.
        await expect(numCell(row(page, "paused-vendor"), 1)).toHaveAttribute(
            "title", /^paused-vendor · Week — no limit for this period\. It resets in \d+d \d{2}h \(\d{2}:\d{2} UTC\)\.( Made of in .*\.)?$/);

        await selectProvider(page, "azure-prod");
        await actions(page).getByRole("button", { name: "Edit usage policy" }).click();
        await expect(sheet(page).locator(".ps-budget-consequences")).toContainText(RESET_SPELLING);

        // A raw UTC stamp is not something a reader can subtract from their own
        // clock, so no visible text carries one.
        expect(await page.locator(".ps-budget-sheet").innerText())
            .not.toMatch(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/);
    });
});

// ── The session list, which is where a stop explains itself ────────────

test("a stopped session says why, and where to go about it, from the session list", async ({ page }) => {
    await withStub({}, async (stub) => {
        await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".ps-session-list-button", { timeout: 15_000 });

        // The row's own status is a bare "waiting"; the REASON arrives with the
        // provider reads, which the session poll takes while a wait is on
        // screen. Without the join, three sessions stopped for three different
        // reasons all read the same.
        const triage = page.locator(".ps-session-list-button", { hasText: "Nightly triage" }).first();
        await expect(triage).toContainText("paused · limit", { timeout: 15_000 });
        await expect(page.locator(".ps-session-list-button", { hasText: "Cost review" }).first())
            .toContainText("paused · allowance");

        // The detail box carries the sentence, not the state.
        await triage.click();
        const pause = page.locator(".ps-session-detail-box .ps-session-detail-pause");
        await expect(pause.locator(".ps-session-detail-label")).toHaveText("Paused");
        await expect(pause).toContainText("copilot-shared has reached its daily limit.");
        await expect(pause).toContainText(RESET_SPELLING);

        // And a way through to the row that can change it.
        await pause.getByRole("button", { name: "Open copilot-shared" }).click();
        await expect(page.locator(".ps-budget-surface")).toBeVisible();
        await expect(row(page, "copilot-shared")).toHaveClass(/is-on/);
    });
});

test("a session stopped on a vanished name says that, and never counts down", async ({ page }) => {
    // The one paused session in this fixture is the list's own first row.
    const paused = noProviderPausedFixture().map((r) => ({
        ...r, sessionId: "11111110-2222-3333-4444-555555555550",
    }));
    await withStub({ paused }, async (stub) => {
        await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".ps-session-list-button", { timeout: 15_000 });
        const listRow = page.locator(".ps-session-list-button", { hasText: "Nightly triage" }).first();
        await expect(listRow).toContainText("no provider", { timeout: 15_000 });

        await listRow.click();
        const pause = page.locator(".ps-session-detail-box .ps-session-detail-pause");
        await expect(pause).toContainText("No provider named retired-vendor.");
        await expect(pause).toContainText("This session waits until that name exists again");
        // Nothing counts this one down: only a person creating the name again
        // ends it, so promising a recovery would be a lie.
        await expect(pause).not.toContainText(RESET_SPELLING);
        await expect(pause).not.toContainText("waits until someone changes it");
        await expect(pause.getByRole("button", { name: "Open retired-vendor" })).toBeVisible();
    });
});

// ── Focus and Escape ───────────────────────────────────────────────────

test("Escape closes the surface, but a sheet takes it first", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");
        await actions(page).getByRole("button", { name: "Edit usage policy" }).click();
        await expect(page.locator(".ps-budget-sheet")).toBeVisible();

        // Escape belongs to whatever is nearest the person.
        await page.keyboard.press("Escape");
        await expect(page.locator(".ps-budget-sheet")).toHaveCount(0);
        await expect(page.locator(".ps-budget-surface")).toBeVisible();

        await page.locator(".ps-budget-head").click({ position: { x: 5, y: 5 } });
        await page.keyboard.press("Escape");
        await expect(page.locator(".ps-budget-surface")).toHaveCount(0);
    });
});

test("closing a sheet hands focus back to the button that opened it", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");
        const edit = actions(page).getByRole("button", { name: "Edit usage policy" });

        // Cancel. A sheet that closes without handing focus back drops it on
        // <body>, and the next Tab restarts at the top of the document.
        await edit.click();
        await sheet(page).getByRole("button", { name: "Cancel" }).click();
        await expect(page.locator(".ps-budget-sheet")).toHaveCount(0);
        await expect(edit).toBeFocused();

        // Escape, which is the same close by another route.
        await edit.click();
        await page.keyboard.press("Escape");
        await expect(edit).toBeFocused();

        expect(stub.calls, "nothing here saved anything").toEqual([]);

        // A SAVED change is the fourth way out, and it lands in the same place.
        await edit.click();
        await sheet(page).locator(".ps-budget-seg[aria-label='Time period']")
            .getByRole("button", { name: "Weekly" }).click();
        await sheet(page).getByRole("textbox", { name: "Tokens" }).fill("5M");
        await sheet(page).getByRole("button", { name: "Save limit" }).click();
        await expect(page.locator(".ps-budget-sheet")).toHaveCount(0);
        await expect(edit).toBeFocused();
    });
});

test("clicking the backdrop closes the sheet and saves nothing", async ({ page }) => {
    await withStub({}, async (stub) => {
        await openBudget(page, stub);
        await selectProvider(page, "azure-prod");
        const edit = actions(page).getByRole("button", { name: "Edit usage policy" });
        await edit.click();
        await page.locator(".ps-budget-sheet-backdrop").click({ position: { x: 5, y: 5 } });
        await expect(page.locator(".ps-budget-sheet")).toHaveCount(0);
        expect(stub.calls, "clicking away is a cancel, not a save").toEqual([]);
        // The backdrop was the last close path that stranded a keyboard user:
        // its handler restored focus and the browser's default action for the
        // same mousedown then moved it onto <body>, because a backdrop is a
        // div nothing can focus. preventDefault settles it.
        await expect(edit).toBeFocused();
    });
});

// ── 0069: the four parts of a used figure ────────────────────────────────

test("a selected row shows what its used figures are made of, and every cell says it on hover", async ({ page }) => {
    const stub = await startProviderBudgetStub({ admin: true });
    try {
        await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
        await page.locator(".ps-session-list-button").first().waitFor();
        await page.getByRole("button", { name: /Budget — providers/i }).click();
        const azure = row(page, "azure-prod");
        await azure.waitFor();
        // Unselected: one number per cell, no split row, the split on hover.
        await expect(page.locator("tr.ps-budget-grid-split")).toHaveCount(0);
        await expect(numCell(azure, 0)).toHaveAttribute("title", /Made of in [\d.]+[KM]? \(cache r [\d.]+[KM]? · w [\d.]+[KM]?\) · out [\d.]+[KM]?/);
        // Selected: the parts appear under the figure, and add up to it. The
        // fixture makes used = 98% input + 2% output, with 70% of the input
        // read from the cache and 5% written to it; the viewer's day figure on
        // azure-prod is 512.0K.
        await numCell(azure, 0).click();
        const splitRow = page.locator("tr.ps-budget-grid-split");
        await expect(splitRow).toHaveCount(1);
        await expect(splitRow.locator("td.is-split").nth(0)).toHaveText(/in 501\.8K.*out 10\.2K.*cache r 351\.2K.*w 25\.1K/);
        // The cell above it still reads as two numbers and nothing else.
        await expect(numCell(azure, 0)).toHaveText("512.0K / 4.0M");
    } finally {
        await stub.close();
    }
});
