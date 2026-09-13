import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 40 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("workspace search is fixed below the list, ranked, and restores scroll on clear", async ({ page }) => {
    await page.goto(base);
    const pane = page.locator(".ps-session-pane").first();
    const list = pane.locator(".ps-session-list");
    const search = pane.getByRole("textbox", { name: "Find a session" });
    await expect(search).toBeVisible();
    await expect(pane.locator(".ps-session-list + .ps-session-sort-controls + .ps-session-search")).toHaveCount(1);

    await list.evaluate((node) => { node.scrollTop = 260; });
    const savedScroll = await list.evaluate((node) => node.scrollTop);
    expect(savedScroll).toBeGreaterThan(0);

    await search.fill("sessoin 37");
    await expect(pane.locator('.ps-session-list-button[data-session-id^="111111137-"]')).toBeVisible();
    await expect(pane.locator(".ps-session-list-button")).toHaveCount(1);
    await expect(pane.locator(".ps-session-search-count")).toHaveText("1 match");

    await pane.getByRole("button", { name: "Clear session search" }).click();
    await expect(pane.locator(".ps-session-list-button")).toHaveCount(40);
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(savedScroll);
});

test("MoA picker search updates without waiting for background controller ticks", async ({ page }) => {
    await page.addInitScript(() => {
        const original = window.setInterval.bind(window);
        const intervals = [];
        window.setInterval = (...args) => { const id = original(...args); intervals.push(id); return id; };
        window.pauseBackgroundIntervals = () => intervals.forEach(id => clearInterval(id));
    });
    await page.goto(base);
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    await page.getByRole("button", { name: "Add first MoA panel" }).click();
    const picker = page.getByRole("dialog", { name: "Sessions", exact: true });
    const search = picker.getByRole("textbox", { name: "Find a session" });
    await expect(picker.locator(".ps-session-list + .ps-session-sort-controls + .ps-session-search")).toHaveCount(1);
    await page.evaluate(() => window.pauseBackgroundIntervals());
    await search.fill("author:test@example.com 23");
    await expect(picker.locator('.ps-session-list-button[data-session-id^="111111123-"]')).toBeVisible({ timeout: 750 });
    await expect(picker.locator(".ps-session-list-button")).toHaveCount(1);
    await expect(picker.locator(".ps-session-search-count")).toHaveText("1 match");
});

test("mobile keeps search compact until requested", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    const pane = page.locator(".ps-mobile-session-pane");
    const trigger = pane.getByRole("button", { name: "Search sessions" });
    const search = pane.getByRole("textbox", { name: "Find a session" });
    await expect(trigger).toBeVisible();
    await expect(search).toBeHidden();

    await trigger.click();
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    expect(await search.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    await search.fill("Session 12");
    await expect(pane.locator('.ps-session-list-button[data-session-id^="111111112-"]')).toBeVisible();
    await expect(pane.locator(".ps-session-list-button")).toHaveCount(1);
});

test("large MoA picker paints typed characters promptly on a slower CPU", async ({ page }) => {
    const large = await startStubServer(0, { sessionCount: 1500 });
    try {
        await page.goto(`http://127.0.0.1:${large.port}`);
        await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
        await page.getByRole("button", { name: "Add first MoA panel" }).click();
        const picker = page.getByRole("dialog", { name: "Sessions", exact: true });
        const input = picker.getByRole("textbox", { name: "Find a session" });
        await expect(input).toBeVisible();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await input.evaluate(node => {
            window.searchPaintDelays = [];
            node.addEventListener("input", () => {
                const start = performance.now();
                requestAnimationFrame(() => window.searchPaintDelays.push(performance.now() - start));
            }, true);
        });
        await input.pressSequentially("Session 1499", { delay: 20 });
        await expect(input).toHaveValue("Session 1499");
        await expect(picker.locator('.ps-session-list-button[data-session-id^="11111111499-"]')).toBeVisible();
        const delays = await page.evaluate(() => window.searchPaintDelays);
        expect(delays.length).toBeGreaterThan(0);
        expect(Math.max(...delays)).toBeLessThan(350);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    } finally {
        await page.goto("about:blank");
        await new Promise(resolve => large.server.close(resolve));
    }
});

test("clearing pending typing cancels filtering and composition waits until committed", async ({ page }) => {
    await page.goto(base);
    const pane = page.locator(".ps-session-pane").first();
    const input = pane.getByRole("textbox", { name: "Find a session" });
    await input.fill("never-find-this");
    await pane.getByRole("button", { name: "Clear session search" }).click();
    await expect(input).toHaveValue("");
    // An old scheduled query must not come back after clear.
    await page.waitForTimeout(220);
    await expect(pane.locator(".ps-session-list-button")).toHaveCount(40);
    await input.dispatchEvent("compositionstart");
    await input.fill("Session 12");
    await page.waitForTimeout(220);
    await expect(input).toHaveValue("Session 12");
    await expect(pane.locator(".ps-session-list-button")).toHaveCount(40);
    await input.dispatchEvent("compositionend");
    await expect(pane.locator(".ps-session-list-button")).toHaveCount(1);
});
