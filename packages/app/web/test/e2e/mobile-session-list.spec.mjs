// The session list on a phone.
//
// WHY THIS EXISTS: drag-to-folder is armed on pointerdown and needs
// `touch-action: none` to receive a move stream. On a touch screen that same
// declaration means the list can no longer be SCROLLED with a finger — every
// touch on a row is claimed as a potential drag — which made the list
// unusable on a phone. Nothing on a desktop viewport can catch that, so these
// run under a real mobile emulation.
import { test, expect, devices, chromium } from "@playwright/test";
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

async function checkDragStops(page, nativeTouch = false) {
    await page.goto(base);
    const list = page.locator(".ps-session-list").first();
    await list.waitFor();
    await expect.poll(() => list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
    const box = await list.boundingBox();
    const selected = await page.locator(".ps-session-list-button.is-selected").textContent();
    const cdp = nativeTouch ? await page.context().newCDPSession(page) : null;
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height - 15);
    const touch = async (type, points) => {
        if (cdp) return cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
        // WebKit has no CDP touch driver. Dispatch the input consumed by our
        // non-passive handler; Chromium below also verifies native arbitration.
        await list.evaluate((el, { type, points }) => {
            const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
            Object.defineProperty(event, "targetTouches", { value: points.map(p => ({ clientX: p.x, clientY: p.y })) });
            el.dispatchEvent(event);
        }, { type, points });
    };
    await touch("touchStart", [{ x, y }]);
    for (const delta of [4, 12, 28, 44, 60]) {
        await touch("touchMove", [{ x, y: y - delta }]);
    }
    await touch("touchEnd", []);
    const released = await list.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
    expect(released.y).toBeGreaterThan(20);
    await page.waitForTimeout(500);
    expect(await list.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }))).toEqual(released);
    expect(await page.locator(".ps-session-list-button.is-selected").textContent()).toBe(selected);
    await cdp?.detach();
}

test("a thumb drag stops on release without selecting a row", async ({ page }) => {
    await checkDragStops(page);
});

test("a thumb drag stops on release without browser inertia in Chromium", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ ...devices["Pixel 7"] });
        await checkDragStops(page, true);
    } finally {
        await browser.close();
    }
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

// Mobile Safari zooms the WHOLE page when a focused control's font-size is
// under 16px, and the dense terminal scale is 11.5px. The prompt had opted out
// with its own 1.25rem, so the composer looked fine while the session-filter
// search and the copy-link field silently zoomed the layout and scrolled it
// sideways. Only a real mobile viewport can catch this.
//
// Probing the CLASSES rather than tapping each surface open: most of these
// fields live behind a modal the stub cannot always reach, and the contract
// under test is the stylesheet's, not any one dialog's.
test("no field is small enough to make iOS zoom the page", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();

    const small = await page.evaluate(() => {
        const PROBES = [
            ["input", "ps-modal-input"],
            ["input", "ps-modal-input ps-modal-search"],
            ["input", "ps-link-input"],
            ["input", "ps-share-add-input"],
            ["select", "ps-share-add-select"],
            ["textarea", "ps-prompt-input"],
            ["input", ""],
        ];
        const out = [];
        for (const [tag, className] of PROBES) {
            const el = document.createElement(tag);
            el.className = className;
            document.body.appendChild(el);
            const px = parseFloat(getComputedStyle(el).fontSize);
            el.remove();
            if (px < 16) out.push(`${className || tag}=${px}px`);
        }
        // Plus every field actually on screen right now.
        for (const node of document.querySelectorAll("input, textarea, select")) {
            if (node.type === "file" || node.offsetParent === null) continue;
            const px = parseFloat(getComputedStyle(node).fontSize);
            if (px < 16) out.push(`${node.className || node.tagName}=${px}px`);
        }
        return out;
    });

    expect(small, `these fields would zoom the page on focus: ${small.join(", ")}`).toEqual([]);
});
