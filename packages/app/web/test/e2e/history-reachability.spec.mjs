// A long session's older transcript must stay reachable from the browser.
//
// WHY THIS EXISTS: scroll-up expands the transcript automatically only until
// AUTO_HISTORY_EVENT_SOFT_CAP, then stops and emits "Press e to load more older
// CMS events". `e` is a TUI binding — EXPAND_HISTORY was never wired into the
// portal at all. So on a busy session (56k events observed in production) the
// history simply became unreachable in a browser, with a status line pointing
// at a key that does nothing. Nothing was wrong with the data: backward paging
// works server-side.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

// Comfortably past the 3000-event soft cap.
const BIG = 12_000;

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 6, transcriptTurns: BIG });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((r) => stub.server.close(r));
});

async function open(page) {
    await page.goto(`${base}/?session=11111110-2222-3333-4444-555555555550`, { waitUntil: "networkidle" });
    await page.waitForSelector(".ps-panel", { timeout: 20_000 });
    await page.waitForTimeout(1500);
}

test("a session past the auto-expand cap offers a way to load older messages", async ({ page }) => {
    await open(page);
    const button = page.locator(".ps-load-older-button");
    await expect(button, "no control to reach older history past the soft cap").toHaveCount(1);
    await expect(button).toBeEnabled();
});

// The detail box now starts FOLDED to a one-line summary and remembers the
// choice — ten rows of reference detail under a list you are trying to read
// was too much by default. The full field grid is one click away.
async function expandDetailBox(page) {
    const summary = page.locator(".ps-session-detail-summary");
    if (await summary.count() > 0) {
        await summary.first().click();
        await page.waitForTimeout(300);
    }
}

test("the detail box shows the full session title without changing height", async ({ page }) => {
    await open(page);
    await expandDetailBox(page);

    const title = await page.locator(".ps-session-detail-field.is-title .ps-session-detail-value").textContent();
    // The row above ellipsizes; the box must carry the whole name.
    expect(title).toContain("A deliberately very long session title");
    await expect(page.locator(".ps-session-detail-field", { hasText: "Owner" }).locator(".ps-session-detail-value"))
        .toHaveText("Test User <test@example.com>");

    // Height must not move as the selection does — the reason the box exists.
    const rows = page.locator(".ps-session-list-button");
    const count = Math.min(await rows.count(), 4);
    const heights = [];
    for (let i = 0; i < count; i += 1) {
        await rows.nth(i).click();
        await page.waitForTimeout(400);
        const box = await page.locator(".ps-session-detail-box").boundingBox();
        heights.push(Math.round(box.height));
    }
    expect(new Set(heights).size, `detail box height moved across selections: ${heights.join(", ")}`).toBe(1);
});
