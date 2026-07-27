// CSV preview: copy semantics, in a real browser.
//
// WHY THESE EXIST: every behaviour here is a Selection/Range/clipboard outcome.
// jsdom implements none of it meaningfully, and reducer tests cannot see it at
// all — the only honest way to check "Ctrl+A selects the table" is to press
// Ctrl+A in a browser and read back what got selected.
import { test, expect } from "@playwright/test";
import { startStubServer, CSV_ARTIFACT } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0);
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((r) => stub.server.close(r));
});

const SESSION_ID = "11111110-2222-3333-4444-555555555550";

/** Open the portal on a session, reveal the Files pane, and preview the CSV. */
async function openCsvPreview(page) {
    await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".ps-panel", { timeout: 15_000 });

    // The inspector tab row is icon-only; the accessible name is what is stable.
    await page.getByRole("button", { name: "Files" }).first().click();
    await page.getByText(CSV_ARTIFACT.filename, { exact: false }).first().click();
    await page.waitForSelector(".ps-csv-table", { timeout: 15_000 });
}

/** Text content of a specific body cell, straight from the DOM. */
function cellText(page, row, col) {
    return page.$eval(`.ps-csv-table tbody tr:nth-child(${row}) td:nth-child(${col})`,
        (el) => el.textContent);
}

/** Click at a point deliberately INSIDE a cell's text, not at its edge. */
async function pressInside(page, selector) {
    const box = await page.locator(selector).boundingBox();
    return { x: box.x + Math.min(24, box.width / 2), y: box.y + box.height / 2 };
}

test("the row/column tally is gone — nothing under the table to sweep up", async ({ page }) => {
    // The footer was our text, not the file's, so a Ctrl+A that included it
    // pasted commentary into the user's spreadsheet.
    await openCsvPreview(page);
    expect(await page.locator(".ps-csv-status").count()).toBe(0);
});

test("Ctrl+A selects the table and nothing outside it", async ({ page }) => {
    await openCsvPreview(page);

    // Focus the pane the way a user would: by clicking a cell.
    const first = await pressInside(page, ".ps-csv-table tbody tr:nth-child(1) td:nth-child(1)");
    await page.mouse.click(first.x, first.y);
    await page.keyboard.press("ControlOrMeta+a");

    const result = await page.evaluate(() => {
        const selection = window.getSelection();
        const table = document.querySelector(".ps-csv-table");
        const container = selection.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
        const node = container?.nodeType === 1 ? container : container?.parentElement;
        return { text: selection.toString(), inTable: !!node && table.contains(node) };
    });

    // Every cell present...
    expect(result.text).toContain("bd57abbb");
    expect(result.text).toContain("Bulk pgindent, mechanical");
    expect(result.text).toContain("commit_hash");
    // ...and the selection confined to the table, not the whole document.
    expect(result.inTable, "Ctrl+A escaped the table").toBe(true);
    expect(result.text).not.toContain("Session 0");
});

test("dragging selects whole cells, never partial text", async ({ page }) => {
    await openCsvPreview(page);

    // Press well inside the first cell's text and release inside the second
    // row's second cell. Native selection would start mid-word at both ends.
    const from = await pressInside(page, ".ps-csv-table tbody tr:nth-child(1) td:nth-child(1)");
    const to = await pressInside(page, ".ps-csv-table tbody tr:nth-child(2) td:nth-child(2)");

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    const selected = await page.evaluate(() => window.getSelection().toString());
    const firstCell = (await cellText(page, 1, 1)).trim();
    const lastCell = (await cellText(page, 2, 2)).trim();

    // Whole cells at BOTH ends — a partial selection would clip these.
    expect(selected, "start of the drag was clipped mid-cell").toContain(firstCell);
    expect(selected, "end of the drag was clipped mid-cell").toContain(lastCell);
});

test("copying a cell range yields tab-separated rows a spreadsheet can read", async ({ page }) => {
    await openCsvPreview(page);

    // Capture what the copy handler actually put on the clipboard. A listener
    // on document runs after ours (same event, bubbling), so it observes the
    // data we set — no clipboard permissions needed, and fully deterministic.
    await page.evaluate(() => {
        window.__copied = null;
        document.addEventListener("copy", (e) => { window.__copied = e.clipboardData.getData("text/plain"); });
    });

    const first = await pressInside(page, ".ps-csv-table tbody tr:nth-child(1) td:nth-child(1)");
    await page.mouse.click(first.x, first.y);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+c");

    const copied = await page.evaluate(() => window.__copied);
    const lines = String(copied).split("\n");

    expect(lines[0]).toBe("commit_hash\tdate\tsummary");
    expect(lines[1]).toBe("bd57abbb\t2026-06-04\tBulk pgindent, mechanical");
    // A comma needs no TSV quoting — over-quoting would paste literal quotes.
    expect(lines[1]).not.toContain('"');
    expect(lines).toHaveLength(3);
});
