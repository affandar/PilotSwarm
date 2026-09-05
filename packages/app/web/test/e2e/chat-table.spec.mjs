// A markdown table whose cells hold long unbreakable tokens.
//
// WHY THIS EXISTS: the fit-width layout gave every rigid column a budget
// capped at 32 characters and let it wrap at spaces only. A cell holding
// one 60-character CamelCase test name got a 32ch column, could not break,
// and painted itself across the neighbouring column. The person reading it
// expected the table to widen and scroll. This test renders that exact
// shape through the real chat pipeline and asserts that no cell's content
// escapes its box — and that the wrapper, not the text, takes the overflow.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const LONG = "CreateVNetInjectedFlexibleServerAndVerifyStartStopOperations";
const TABLE = [
    "Correlated without an eligible category",
    "",
    "| Test | Dossier finding |",
    "|---|---|",
    `| \`${LONG}\` — two stages | Production issue bucket \`VNetPowerStopPostcondition\`; no category supplied |`,
    "| `PromoteReplica_Forced_SingleShotReplaceObserved` | Test asset, `FlexClusterMongo`; occurrence no longer active |",
    "| `ImpactlessHAComputeScaleUpTest` | Test asset, `HaOperations`; occurrence no longer active |",
].join("\n");

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 2, transcriptTurns: 2, assistantMarkdown: TABLE });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("a cell of long tokens never paints outside its box; the table scrolls instead", async ({ page }) => {
    // Narrow enough that the table cannot fit: the chat column is roughly
    // half of this.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.locator(".ps-session-list-button").first().click();
    // This fixture has no turn-completed boundary: its saved assistant output
    // is intentionally an interim preview and is parsed only when expanded.
    await page.locator(".ps-assistant-preview > summary").first().click();
    const table = page.locator(".ps-chat-table").first();
    await expect(table).toBeVisible();
    await page.waitForTimeout(300);

    const report = await table.evaluate((tbl) => {
        const out = [];
        for (const cell of tbl.querySelectorAll("td, th")) {
            const box = cell.getBoundingClientRect();
            // Every piece of text inside the cell must end inside the cell.
            const range = document.createRange();
            range.selectNodeContents(cell);
            const rects = Array.from(range.getClientRects());
            const rightmost = Math.max(...rects.map((r) => r.right), box.left);
            if (rightmost > box.right + 1) {
                out.push({ text: cell.textContent.trim().slice(0, 40), overflowPx: Math.round(rightmost - box.right) });
            }
        }
        const wrap = tbl.closest(".ps-chat-table-wrap");
        return { overflowing: out, wrapScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null, tableWidth: tbl.getBoundingClientRect().width, wrapWidth: wrap?.clientWidth };
    });

    expect(report.overflowing, "cells whose text escapes the cell").toEqual([]);
    // The long token is wider than half of an 1100px viewport can hold with a
    // second column beside it, so the overflow must have gone to the wrapper.
    expect(report.wrapScrolls, `table ${report.tableWidth}px in a ${report.wrapWidth}px wrapper should scroll`).toBe(true);
});
