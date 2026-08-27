// The Cluster summary tab on Providers & Budgets.
//
// One answer from getProviderUsageSummary feeds the KPIs, the chart and
// the model table; the stub's fixture has known arithmetic, so the tab can
// be checked against it. The picker and the range buttons are checked by
// what they made the portal ASK for, since that is the only thing the
// portal decides — the database does the counting.
import { test, expect } from "@playwright/test";
import { startProviderBudgetStub } from "./providers-budget-stub.mjs";

async function openSummary(page, stub) {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.getByRole("button", { name: /Budget — providers/i }).click();
    await page.getByRole("tab", { name: "Cluster summary" }).click();
    await expect(page.locator(".ps-summary")).toBeVisible();
    await expect.poll(() => stub.summaryQueries.length).toBeGreaterThan(0);
}

test("the tab shows the fixture's totals, split, chart and model pivot", async ({ page }) => {
    const stub = await startProviderBudgetStub({ admin: true });
    try {
        await openSummary(page, stub);
        // Windows: month = 25.64M + 6.549M + 322.6K = 32.51M; today = 322.6K.
        const kpis = page.locator(".ps-summary-kpi");
        await expect(kpis).toHaveCount(3);
        await expect(kpis.nth(0)).toContainText("Today");
        await expect(kpis.nth(0).locator(".ps-summary-kpi__value")).toHaveText(/322\.6K/);
        await expect(kpis.nth(2).locator(".ps-summary-kpi__value")).toHaveText(/32\.5M/);
        await expect(kpis.nth(2)).toContainText("71 turns");
        // The chart: 14 bars, one per day of the window, quiet days included.
        await expect(page.locator(".ps-summary-chart__bar")).toHaveCount(14);
        // The model table: three rows, biggest first, shares against the window.
        const rows = page.locator(".ps-summary__table tbody tr");
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(0)).toContainText("gpt-5.4");
        await expect(rows.nth(0)).toContainText("30.6M");
        await expect(rows.nth(0).locator("td").nth(2)).toHaveText("3"); // providers folded
        await expect(rows.nth(2)).toContainText("claude-sonnet-5");
        // System usage is named, not hidden.
        await expect(page.locator(".ps-summary")).toContainText("system 8.2M");
        await expect(page.locator(".ps-summary__scope")).toContainText("system sessions included");
    } finally {
        await stub.close();
    }
});

test("the range buttons and the provider picker change what is asked for", async ({ page }) => {
    const stub = await startProviderBudgetStub({ admin: true });
    try {
        await openSummary(page, stub);
        const last = () => stub.summaryQueries[stub.summaryQueries.length - 1];
        expect(last().days).toBe("14");
        expect(last().providers).toBeUndefined();

        await page.getByRole("button", { name: "Last 30 days" }).click();
        await expect.poll(() => last().days).toBe("30");

        // Shared: the preset expands to the shared providers of the grid.
        await page.getByRole("button", { name: "Providers filter" }).click();
        await page.getByRole("option", { name: "Shared providers" }).click();
        await expect.poll(() => last().providers).toBe("copilot-shared,azure-prod,paused-vendor");
        await expect(page.getByRole("button", { name: "Providers filter" })).toContainText("Shared providers");

        // Users: the personal ones.
        await page.getByRole("button", { name: "Providers filter" }).click();
        await page.getByRole("option", { name: "User providers" }).click();
        await expect.poll(() => last().providers).toBe("my-sandbox");

        // Clear all, then pick one by hand.
        await page.getByRole("button", { name: "Providers filter" }).click();
        await page.getByRole("button", { name: "Clear all" }).click();
        await page.getByRole("checkbox", { name: "Include azure-prod" }).check();
        await expect.poll(() => last().providers).toBe("azure-prod");
        await expect(page.getByRole("button", { name: "Providers filter" })).toContainText("azure-prod");

        // Back to All: no provider list on the wire at all.
        await page.getByRole("option", { name: "All providers" }).click();
        await expect.poll(() => last().providers).toBeUndefined();
    } finally {
        await stub.close();
    }
});
