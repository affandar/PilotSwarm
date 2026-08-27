// The seam between chat and the right block (canvas + diagnostics).
//
// WHY THIS EXISTS: with both canvas and diagnostics open, the right block was
// capped at 60% of the window. A 640px canvas beside a 320px diagnostics
// column already IS 60% of a 1600px window, so dragging the chat↔canvas seam
// could not widen the block; the canvas kept its fixed pixels and the flex
// diagnostics column gave them up. The seam the person dragged moved a
// different seam. Now the block grows until chat is at its floor, and the
// diagnostics column keeps its width while the canvas takes the drag.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 3 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const widths = (page) => page.evaluate(() => {
    const w = (sel) => document.querySelector(sel)?.getBoundingClientRect().width ?? null;
    return {
        canvas: w(".ps-canvas-layer:not(.is-hidden)"),
        diagnostics: w(".ps-workspace-column-host .ps-workspace-column:not(.is-artifact)"),
        chat: w(".ps-workspace-main-grid > .ps-workspace-pane-slot:last-child"),
    };
});

test("dragging the chat seam widens the canvas, and the diagnostics column keeps its width", async ({ page }) => {
    // 1600 wide: 640 + 1 + 320 is exactly the old 60% cap, the failing case.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    // The workspace opens as sessions + chat; open the canvas column here.
    await page.locator(".ps-session-list-button").first().click();
    await page.waitForTimeout(300);
    const showCanvas = page.getByRole("button", { name: /^Show canvas$/i });
    if (await showCanvas.count() > 0) await showCanvas.first().click();
    await page.getByRole("button", { name: /Show diagnostics/i }).first().click();
    await page.waitForTimeout(400);

    const before = await widths(page);
    expect(before.canvas, "canvas column open").toBeGreaterThan(0);
    expect(before.diagnostics, "diagnostics column open").toBeGreaterThan(0);

    const seam = page.getByRole("button", { name: "Resize the right column" });
    const box = await seam.boundingBox();
    // The seam is a 1px hairline with a ±5px grab band; aim inside the band.
    const x = box.x + box.width / 2 - 3;
    const y = box.y + box.height / 2;
    // Both halves of the band must be the seam's. The canvas layer used to
    // paint over the canvas-side half (same z-index, later in the DOM), so
    // the hairline could only be grabbed from the chat side.
    const hits = await page.evaluate(([cx, cy]) => [cx, cx + 3].map((px) => document.elementFromPoint(px, cy)?.className || ""), [box.x + box.width / 2, y]);
    expect(hits.every((cls) => cls.includes("ps-column-resizer")), `seam hit-test: ${hits.join(" | ")}`).toBe(true);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y, { steps: 6 });
    await page.mouse.move(x - 120, y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = await widths(page);
    expect(after.canvas - before.canvas, "the canvas took the drag").toBeGreaterThan(100);
    expect(Math.abs(after.diagnostics - before.diagnostics), "diagnostics did not move").toBeLessThan(3);
    // Chat gives up most of it; the sessions column (a share of the main
    // grid) gives up the rest. What matters is that the right block grew.
    expect(before.chat - after.chat, "chat gave up the pixels").toBeGreaterThan(60);
});

test("the seam stops at chat's floor instead of inflating the stored width", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    // The workspace opens as sessions + chat; open the canvas column here.
    await page.locator(".ps-session-list-button").first().click();
    await page.waitForTimeout(300);
    const showCanvas = page.getByRole("button", { name: /^Show canvas$/i });
    if (await showCanvas.count() > 0) await showCanvas.first().click();
    await page.getByRole("button", { name: /Show diagnostics/i }).first().click();
    await page.waitForTimeout(400);

    const seam = page.getByRole("button", { name: "Resize the right column" });
    const box = await seam.boundingBox();
    // The seam is a 1px hairline with a ±5px grab band; aim inside the band.
    const x = box.x + box.width / 2 - 3;
    const y = box.y + box.height / 2;
    // Drag far past anything the window can give.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 500, y, { steps: 8 });
    await page.mouse.move(x - 1000, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const pinned = await widths(page);
    expect(pinned.chat, "chat is held at its floor, not crushed").toBeGreaterThanOrEqual(200);

    // One small drag back must move the seam immediately: the stored width
    // stopped where the layout stopped, so there is nothing to unwind. The
    // canvas is the column that answers (chat's pixels can go to the
    // sessions column first, by design).
    const box2 = await seam.boundingBox();
    const x2 = box2.x + box2.width / 2 - 3;
    await page.mouse.move(x2, y);
    await page.mouse.down();
    await page.mouse.move(x2 + 40, y, { steps: 4 });
    await page.mouse.move(x2 + 80, y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const released = await widths(page);
    expect(pinned.canvas - released.canvas, "the canvas gives back width on the first drag back").toBeGreaterThan(50);
});
