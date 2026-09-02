// The Agents tab on Providers & Budgets: the header checkbox above the rows.
//
// WHY THIS EXISTS: the only way to empty the chart was to untick forty rows
// one at a time. The header checkbox clears every agent in one click and
// brings them all back with the next; it sits half-filled while the rows
// disagree.
import { test, expect } from "@playwright/test";
import { startProviderBudgetStub } from "./providers-budget-stub.mjs";

async function openAgents(page, stub) {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}`, { waitUntil: "networkidle" });
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.getByRole("button", { name: /Budget — providers/i }).click();
    await page.getByRole("tab", { name: "Agents" }).click();
    await expect(page.locator(".ps-summary__table tbody tr")).toHaveCount(3);
}

test("the header checkbox clears every agent and brings them all back", async ({ page }) => {
    const stub = await startProviderBudgetStub({ admin: true });
    try {
        await openAgents(page, stub);
        const rowBoxes = page.locator(".ps-summary__table tbody input[type=checkbox]");
        const legend = page.locator(".ps-summary__legend span");
        await expect(rowBoxes).toHaveCount(3);
        for (let i = 0; i < 3; i += 1) await expect(rowBoxes.nth(i)).toBeChecked();
        await expect(legend).toHaveCount(3);

        // Clear all: no row ticked, nothing in the chart legend.
        await page.getByRole("checkbox", { name: "Clear all agents" }).click();
        for (let i = 0; i < 3; i += 1) await expect(rowBoxes.nth(i)).not.toBeChecked();
        await expect(legend).toHaveCount(0);

        // Select all: every row back, legend full again.
        await page.getByRole("checkbox", { name: "Select all agents" }).click();
        for (let i = 0; i < 3; i += 1) await expect(rowBoxes.nth(i)).toBeChecked();
        await expect(legend).toHaveCount(3);

        // One row unticked: the header goes half-filled, and clearing from
        // there still empties everything.
        await rowBoxes.nth(1).uncheck();
        const header = page.locator(".ps-summary__table thead input[type=checkbox]");
        await expect.poll(() => header.evaluate((el) => el.indeterminate)).toBe(true);
        await header.click();
        for (let i = 0; i < 3; i += 1) await expect(rowBoxes.nth(i)).not.toBeChecked();
        await expect.poll(() => header.evaluate((el) => el.indeterminate)).toBe(false);
    } finally {
        await stub.close();
    }
});
