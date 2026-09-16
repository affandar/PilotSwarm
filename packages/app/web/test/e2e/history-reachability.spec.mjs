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
    await expect(page.locator(".ps-history-load.is-manual")).toBeVisible();
    const button = page.locator(".ps-load-older-button");
    await expect(button, "no control to reach older history past the soft cap").toHaveCount(1);
    await expect(button).toBeEnabled();
});

for (const gesture of ["wheel", "touch"]) test(`a delayed backward page advances one row despite aggressive ${gesture} scrolling and preserves the reading anchor`, async ({ page }) => {
    if (gesture === "touch") await page.setViewportSize({ width: 390, height: 844 });
    const backwardRequests = [];
    const sessionId = "11111110-2222-3333-4444-555555555550";
    const event = (seq, content) => ({
        seq,
        eventType: seq % 2 ? "assistant.message" : "user.message",
        timestamp: 1785000000000 + seq,
        data: { messageId: `message-${seq}`, content },
    });
    const initial = Array.from({ length: 300 }, (_, i) => {
        const seq = 701 + i;
        return event(seq, seq === 702 ? "VISIBLE_ANCHOR_702" : `recent message ${seq}`);
    });
    const older = Array.from({ length: 10 }, (_, i) => event(691 + i, `older message ${691 + i}`));
    let releasePage;
    const pageGate = new Promise(resolve => { releasePage = resolve; });
    await page.route(`**/api/v1/management/sessions/${sessionId}/events?*`, async (route) => {
        const url = new URL(route.request().url());
        const types = JSON.parse(url.searchParams.get("eventTypes") || "[]");
        return route.fulfill({ json: { ok: true, result: types.length === 1 && types[0] === "session.canvas_updated" ? [] : initial } });
    });
    await page.route(`**/api/v1/management/sessions/${sessionId}/events-before*`, async (route) => {
        const url = new URL(route.request().url());
        const types = JSON.parse(url.searchParams.get("eventTypes") || "[]");
        if (!(types.length === 1 && types[0] === "session.canvas_updated")) await pageGate;
        return route.fulfill({ json: { ok: true, result: types.length === 1 && types[0] === "session.canvas_updated" ? [] : older } });
    });
    page.on("request", (request) => {
        const url = new URL(request.url());
        const types = JSON.parse(url.searchParams.get("eventTypes") || "[]");
        if (url.pathname.endsWith("/events-before") && types.some((type) => type === "user.message" || type === "assistant.message")) {
            backwardRequests.push(request.url());
        }
    });
    await open(page);
    const viewport = page.locator(".ps-chat-panel .ps-scroll-panel");
    await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(500);

    // A real upward read gesture first switches chat from bottom-follow to a
    // paused top anchor. Reaching the top and continuing upward must still
    // request the preceding CMS page in that paused mode.
    await viewport.hover();
    await viewport.evaluate((node) => {
        node.scrollTop = Math.max(100, node.scrollHeight - node.clientHeight - 300);
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(50);
    await viewport.evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const anchor = viewport.getByText("VISIBLE_ANCHOR_702").first();
    const anchorBefore = await anchor.boundingBox();
    const pull = () => gesture === "wheel" ? page.mouse.wheel(0, -10000)
        : viewport.evaluate(node => {
            const finger = y => new Touch({ identifier: 1, target: node, clientX: 100, clientY: y });
            node.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [finger(100)] }));
            node.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [finger(600)] }));
            // The new stretch gesture deliberately loads only on release.
            node.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] }));
        });
    await pull();
    await expect.poll(() => backwardRequests.length).toBe(1);
    for (let i = 0; i < 4; i++) await pull();
    releasePage();
    await expect(page.getByText("older message 692").first()).toBeAttached();
    if (gesture === "wheel") await pull();
    if (gesture === "touch") {
        // A fling can emit scroll events even after touchmove has stopped.
        await viewport.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
    }
    const anchorAfter = await anchor.boundingBox();
    // WebKit rounds scrollTop to whole pixels while text boxes are fractional.
    expect(Math.abs(anchorAfter.y - anchorBefore.y - 16), "a page boundary advances only one 16px scroll row").toBeLessThan(1);
    expect(backwardRequests).toHaveLength(1);

    // The page-boundary guard must release for a fresh intentional gesture.
    await page.waitForTimeout(250);
    if (gesture === "touch") {
        // Native touch momentum changes scrollTop; Playwright's mouse wheel is
        // not reliable in a mobile viewport, so model that browser scroll.
        await viewport.evaluate(node => {
            node.scrollTop = Math.max(0, node.scrollTop - 40);
            node.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
    } else await page.mouse.wheel(0, -40);
    await expect.poll(async () => (await anchor.boundingBox()).y - anchorAfter.y).toBeCloseTo(40, 0);
    const resumedAnchorOffset = (await anchor.boundingBox()).y - (await viewport.boundingBox()).y;

    const savedTop = await viewport.evaluate((node) => node.scrollTop);
    await page.locator(`.ps-session-list-button[data-session-id="11111111-2222-3333-4444-555555555551"]`).click();
    await page.locator(`.ps-session-list-button[data-session-id="${sessionId}"]`).click();
    await expect(page.getByText("VISIBLE_ANCHOR_702").first()).toBeAttached();
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(savedTop, 0);
    const anchorAfterRoundTrip = await page.getByText("VISIBLE_ANCHOR_702").first().boundingBox();
    const restoredAnchorOffset = anchorAfterRoundTrip.y - (await viewport.boundingBox()).y;
    expect(Math.abs(restoredAnchorOffset - resumedAnchorOffset), "switching sessions lost the paused history anchor").toBeLessThan(3);
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
