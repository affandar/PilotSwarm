// The divider between the Inspector (Sequence) and Activity panes in the
// diagnostics column.
//
// WHY THIS EXISTS: the drag handle called a `clamp()` helper that v0.5.39
// deleted. Every pointerdown, keypress and touch on the seam then threw
// "clamp is not defined" before dispatching, so the two panes could not be
// resized — for six releases, with no test noticing because nothing dragged
// the seam. This one does, and it also fails on any uncaught page error.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 4 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const rows = (page) => page.evaluate(() =>
    document.querySelector(".ps-workspace-column[style*='grid-template-rows']")?.style.gridTemplateRows || null);

async function openDiagnostics(page) {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    const toggle = page.getByRole("button", { name: /Show diagnostics/i });
    if (await toggle.count() > 0) await toggle.first().click();
    await expect(page.locator(".ps-row-resizer").first()).toBeAttached();
    await page.waitForTimeout(300);
}

test("dragging the inspector/activity seam resizes the panes", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openDiagnostics(page);

    const before = await rows(page);
    expect(before, "the diagnostics column is a three-row grid").toMatch(/calc\(50% \+ 0px\)/);

    // The seam is a 1px hairline with a ±5px grab band; aim at its centre.
    const box = await page.locator(".ps-row-resizer").first().boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 40, { steps: 4 });
    await page.mouse.move(x, y + 80, { steps: 4 });
    await page.mouse.up();

    const after = await rows(page);
    expect(after, "the first row must have grown by the drag").toMatch(/calc\(50% \+ 80px\)/);
    expect(errors, "no uncaught error during the drag").toEqual([]);
});

test("the seam answers the keyboard and double-click resets it", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openDiagnostics(page);

    const seam = page.locator(".ps-row-resizer").first();
    await seam.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const moved = await rows(page);
    expect(moved, "ArrowDown moves the seam").not.toMatch(/calc\(50% \+ 0px\)/);

    await seam.dblclick();
    expect(await rows(page), "double-click resets to the middle").toMatch(/calc\(50% \+ 0px\)/);
    expect(errors).toEqual([]);
});
