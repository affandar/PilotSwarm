// The session list on a phone.
//
// WHY THIS EXISTS: drag-to-folder is armed on pointerdown and needs
// `touch-action: none` to receive a move stream. On a touch screen that same
// declaration means the list can no longer be SCROLLED with a finger — every
// touch on a row is claimed as a potential drag — which made the list
// unusable on a phone. Nothing on a desktop viewport can catch that, so these
// run under a real mobile emulation.
import { test, expect, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ ...devices["iPhone 14 Pro"] });

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 24, transcriptTurns: 8 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("rows never claim the finger that scrolls the list", async ({ page }) => {
    await page.goto(base);
    const row = page.locator(".ps-session-list-button").first();
    await row.waitFor();
    // touch-action:none on a row is exactly the regression: it disables
    // native panning over that element.
    const touchAction = await row.evaluate((node) => getComputedStyle(node).touchAction);
    expect(touchAction, "a row must not swallow touch panning").not.toBe("none");
});

test("a tap still selects", async ({ page }) => {
    await page.goto(base);
    const rows = page.locator(".ps-session-list-button");
    await rows.first().waitFor();
    await rows.nth(2).tap();
    await expect(page.locator(".ps-session-list-button.is-selected")).toHaveCount(1);
});

test("the page never scrolls sideways, in or out of focus mode", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    const overflow = () => page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
    });
    expect(await overflow(), "before focus").toBeLessThanOrEqual(0);

    const focus = page.locator('button[aria-label="Focus the chat pane"]');
    if (await focus.count() > 0) {
        await focus.tap();
        await page.waitForTimeout(300);
        expect(await overflow(), "in focus mode").toBeLessThanOrEqual(0);
        // The pane the focus rail opens is the other half of the report.
        const sessions = page.locator(".ps-chat-focus-rail button", { hasText: "Sessions" });
        if (await sessions.count() > 0) {
            await sessions.tap();
            await page.waitForTimeout(300);
            expect(await overflow(), "focus + sessions overlay").toBeLessThanOrEqual(0);
        }
    }
});
