// Character-cell panes must fit the pane that renders them.
//
// The sequence grid and the stats boxes are generated at a column count. That
// count used to come from the legacy TUI layout model's imagined pane split,
// which knows nothing about the portal's real grid — so the sequence spilled
// past the pane edge and the stats boxes arrived sliced behind a sideways
// scroll. The fix measures the panel's own content box and font
// (useMeasuredPaneColumns); this spec pins the outcome: no horizontal
// overflow, at two very different pane widths.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { transcriptTurns: 4 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((r) => stub.server.close(r));
});

const SESSION_ID = "11111110-2222-3333-4444-555555555550";

async function openDiagnostics(page) {
    await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Show diagnostics (inspector and activity)" }).click();
    await page.waitForSelector(".ps-inspector-pane .ps-scroll-panel", { timeout: 15_000 });
}

async function panelOverflow(page) {
    // Give the measured-columns hook its debounce + re-render.
    await page.waitForTimeout(400);
    return page.evaluate(() => {
        const panel = document.querySelector(".ps-inspector-pane .ps-scroll-panel");
        if (!panel) return null;
        return {
            scrollWidth: panel.scrollWidth,
            clientWidth: panel.clientWidth,
            scrollLeft: panel.scrollLeft,
        };
    });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1120, height: 800 }]) {
    test(`stats and sequence fit the inspector pane at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openDiagnostics(page);

        for (const tab of ["Stats", "Sequence"]) {
            await page.getByRole("button", { name: tab }).first().click();
            const box = await panelOverflow(page);
            expect(box, `${tab} panel exists`).not.toBeNull();
            // Fitted content: nothing to scroll sideways to, nothing sliced
            // off. A couple of px of slack absorbs subpixel rounding.
            expect(box.scrollWidth, `${tab} content width vs pane`).toBeLessThanOrEqual(box.clientWidth + 4);
            expect(box.scrollLeft, `${tab} starts unscrolled`).toBe(0);
        }
    });
}
