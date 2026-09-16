import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

async function openPagedTranscript(page, themeId = null) {
    if (themeId) await page.route("**/api/v1/me/profile**", route => route.fulfill({ json: {
        ok: true, result: { isAdmin: false, profileSettings: { themeId } },
    } }));
    const recent = Array.from({ length: 300 }, (_, index) => ({
        sessionId, seq: index + 200, eventType: "user.message", createdAt: Date.now() + index,
        data: { content: `Recent message ${index}: reading the review.` },
    }));
    await page.route(/\/events(?:\?|$)/, route => route.fulfill({ json: { ok: true, result: recent } }));
    let releasePage;
    await page.route(/\/events-before(?:\?|$)/, async route => {
        await new Promise(resolve => { releasePage = resolve; });
        await route.fulfill({ json: { ok: true, result: [{
            sessionId, seq: 1, eventType: "user.message", createdAt: Date.now() - 1000,
            data: { content: "Earlier message" },
        }] } });
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    const pane = page.locator(".ps-chat-panel .ps-scroll-panel");
    await expect(pane.getByText("Recent message 299:")).toBeVisible();
    await pane.evaluate(node => { node.scrollTop = 0; });
    return { pane, release: () => releasePage?.() };
}

test("wheel paging shows the timeline spinner during the request", async ({ page }) => {
    const { pane, release } = await openPagedTranscript(page);
    const firstRecent = pane.getByText("Recent message 0:");
    const beforeY = (await firstRecent.boundingBox()).y;
    await pane.dispatchEvent("wheel", { deltaY: -100 });
    await pane.dispatchEvent("wheel", { deltaY: -100 });
    const indicator = page.locator(".ps-history-load.is-loading");
    await expect(indicator).toContainText("Loading earlier messages");
    release();
    await expect(indicator).toHaveCount(0);
    await expect(pane.getByText("Earlier message")).toHaveCount(1);
    const afterY = (await firstRecent.boundingBox()).y;
    // The existing history contract advances one 16px row at a page boundary.
    expect(Math.abs(afterY - beforeY - 16), "prepending history should advance only one row").toBeLessThan(2);
});

for (const themeId of ["doom", "terminal-green", "win95", "winamp", "ms-dos"]) {
    test(`${themeId}: loading marker stays readable during a delayed history page`, async ({ page }) => {
        const { pane, release } = await openPagedTranscript(page, themeId);
        await pane.dispatchEvent("wheel", { deltaY: -100 });
        await pane.dispatchEvent("wheel", { deltaY: -100 });
        const indicator = page.locator(".ps-history-load.is-loading");
        await expect(indicator).toContainText("Loading earlier messages");
        const spinner = indicator.locator(".ps-history-text-spinner");
        if (themeId === "ms-dos") {
            await expect(spinner).toBeVisible();
            await expect(indicator.locator(".ps-history-marker svg")).toBeHidden();
        } else {
            await expect(indicator.locator(".ps-history-marker svg")).toBeVisible();
        }
        await indicator.screenshot({ path: test.info().outputPath(`${themeId}-loading-history.png`) });
        release();
        await expect(indicator).toHaveCount(0);
    });
}

test("touch pull stretches the timeline and loads only on release", async ({ page }) => {
    const { pane, release } = await openPagedTranscript(page);
    const firstRecent = pane.getByText("Recent message 0:");
    const beforeY = (await firstRecent.boundingBox()).y;
    await pane.evaluate(node => {
        const finger = y => new Touch({ identifier: 1, target: node, clientX: 50, clientY: y });
        node.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [finger(100)] }));
        node.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [finger(130)] }));
    });
    await expect(page.locator(".ps-history-load")).toContainText("Pull for earlier messages");
    await pane.evaluate(node => node.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] })));
    await expect(page.locator(".ps-history-load")).toHaveCount(0);

    await pane.evaluate(node => {
        const finger = y => new Touch({ identifier: 1, target: node, clientX: 50, clientY: y });
        node.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [finger(100)] }));
        node.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [finger(170)] }));
    });
    const ready = page.locator(".ps-history-load.is-ready");
    await expect(ready).toContainText("Release to load earlier messages");
    await expect(ready).not.toHaveClass(/is-loading/);
    await ready.screenshot({ path: test.info().outputPath("stretched-history-timeline.png") });
    await pane.evaluate(node => node.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] })));
    const indicator = page.locator(".ps-history-load.is-loading");
    await expect(indicator).toContainText("Loading earlier messages");
    release();
    await expect(indicator).toHaveCount(0);
    await expect(pane.getByText("Earlier message")).toHaveCount(1);
    const afterY = (await firstRecent.boundingBox()).y;
    expect(Math.abs(afterY - beforeY - 16), "the pull must advance only one row").toBeLessThan(2);
});
