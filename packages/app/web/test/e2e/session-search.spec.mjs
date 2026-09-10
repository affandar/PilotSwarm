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
    await expect(pane.locator(".ps-session-list + .ps-session-search")).toHaveCount(1);

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

test("MoA picker uses the same search footer and field syntax", async ({ page }) => {
    await page.goto(base);
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    await page.getByRole("button", { name: "Add first MoA panel" }).click();
    const picker = page.getByRole("dialog", { name: "Sessions", exact: true });
    const search = picker.getByRole("textbox", { name: "Find a session" });
    await expect(picker.locator(".ps-session-list + .ps-session-search")).toHaveCount(1);
    await search.fill("author:test@example.com 23");
    await expect(picker.locator('.ps-session-list-button[data-session-id^="111111123-"]')).toBeVisible();
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
