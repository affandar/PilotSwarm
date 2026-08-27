// Portal layout and theming, in a real browser.
//
// WHY THESE EXIST: every one of the failures below shipped past a fully green
// unit suite, because they are cascade and layout OUTCOMES — invisible to
// tests that exercise reducers and selectors, and to jsdom, which has CSSOM
// but no layout engine.
//
//   • pane headers sized by their contents, so panes misaligned
//   • a theme rule losing a specificity contest to a base rule
//   • selection text losing to an inline style, becoming unreadable
//
// Hermetic: served from dist against a stubbed API, so no database, no worker,
// no LLM. That is what lets this gate every portal change.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0);
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((r) => stub.server.close(r));
    // Close every per-theme stub started by openPortal.
    await Promise.all(themedStubs.map((t) => new Promise((resolve) => t.server.close(resolve))));
});

/** Relative luminance / contrast, per WCAG. */
function contrastRatio(fg, bg) {
    // Chrome reports some colours as `color(srgb 1 1 1 / 0.96)`, whose channels
    // are 0-1 rather than 0-255. Reading those as 8-bit made white measure as
    // near-black and reported a false contrast failure.
    const parse = (c) => {
        const nums = (c.match(/\d+(\.\d+)?/g) || []).map(Number);
        if (/^color\(/i.test(c)) return nums.slice(0, 3).map((v) => Math.round(v * 255));
        return nums.slice(0, 3);
    };
    const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b2] = [lum(parse(fg)), lum(parse(bg))].sort((x, y) => y - x);
    return (a + 0.05) / (b2 + 0.05);
}

// Themed pages boot a stub that SERVES the theme in profile settings, which
// is how the real app applies one: the id lands on <html data-ps-theme> AND
// the palette lands as CSS variables. Stamping only the attribute (what this
// helper used to do) left every colour at the default theme's value, so a
// contrast assertion measured win95 chrome under noctis-obscuro text and
// failed on a combination no user can produce.
const themedStubs = [];
async function openPortal(page, { theme } = {}) {
    if (theme) {
        const themed = await startStubServer(0, { themeId: theme });
        themedStubs.push(themed);
        await page.goto(`http://127.0.0.1:${themed.port}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".ps-panel", { timeout: 15_000 });
        await page.waitForFunction((id) => document.documentElement.dataset.psTheme === id, theme, { timeout: 10_000 });
        return;
    }
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForSelector(".ps-panel", { timeout: 15_000 });
}

test("all pane headers are the same height", async ({ page }) => {
    // The regression: headers were sized by their contents, so a pane WITH
    // action buttons rendered ~46px while one without rendered 34px, and
    // side-by-side panes started their bodies at different heights.
    await openPortal(page);
    // Comparing side-by-side panes needs side-by-side panes. The default
    // workspace is sessions and chat only since the desktop columns became two
    // independent toggles, so open the diagnostics column — otherwise there is
    // one header, nothing to diverge from, and the test passes vacuously (it
    // did not: it asserted >1 and so failed loudly, which is the better bug).
    const diagnostics = page.getByRole("button", { name: /Show diagnostics/i });
    if (await diagnostics.count() > 0) {
        await diagnostics.first().click();
        await page.waitForTimeout(500);
    }
    const heights = await page.$$eval(".ps-panel-header", (els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0));
    expect(heights.length, "expected at least two panes to compare").toBeGreaterThan(1);
    expect(new Set(heights).size, `header heights diverged: ${heights.join(", ")}`).toBe(1);
});

test("no pane header overflows its own controls", async ({ page }) => {
    await openPortal(page);
    const overflow = await page.$$eval(".ps-panel-header", (els) => els.flatMap((header) => {
        const hb = header.getBoundingClientRect();
        if (hb.height === 0) return [];
        return [...header.querySelectorAll("button")]
            .filter((b) => b.getBoundingClientRect().height > hb.height + 0.5)
            .map((b) => `${b.className}: ${b.getBoundingClientRect().height} > ${hb.height}`);
    }));
    expect(overflow, `controls taller than their header:\n${overflow.join("\n")}`).toEqual([]);
});

test("the page never scrolls horizontally", async ({ page }) => {
    await openPortal(page);
    const overflows = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows).toBe(false);
});

test("full-screen canvas moves the normal toolbar actions to the left rail", async ({ page }) => {
    await openPortal(page);
    // The canvas may already be up — the toggle reads "Hide the canvas" then,
    // and waiting for "Show canvas" simply times out. Same shape the
    // diagnostics test below already uses: open it only if it is closed.
    const showCanvas = page.getByRole("button", { name: "Show canvas" });
    if (await showCanvas.count() > 0) {
        await showCanvas.first().click();
        await page.waitForTimeout(300);
    }
    await page.getByRole("button", { name: "Full screen canvas" }).click();

    await expect(page.locator(".ps-toolbar-side.is-left .ps-icon-button")).toHaveCount(4);
    await expect(page.locator(".ps-toolbar > .ps-toolbar-actions .ps-icon-button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restore canvas" })).toBeVisible();
});

test("vertical diagnostics grid lets either pane fully cover the column", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPortal(page);

    const showDiagnostics = page.getByRole("button", { name: "Show diagnostics (inspector and activity)" });
    if (await showDiagnostics.isVisible()) await showDiagnostics.click();

    const handle = page.getByRole("button", { name: "Resize the inspector and activity panes" });
    await expect(handle).toHaveCount(1);
    await expect(handle).toBeVisible();
    const handlerGeometry = await handle.evaluate((element) => ({
        columnHeight: element.closest(".ps-workspace-column")?.getBoundingClientRect().height || 0,
        dividerHeight: element.getBoundingClientRect().height,
    }));
    expect(handlerGeometry.columnHeight).toBeGreaterThan(100);
    expect(handlerGeometry.dividerHeight).toBeGreaterThan(0);
    const column = handle.locator("xpath=../..");
    const slots = column.locator(":scope > .ps-workspace-pane-slot");
    await expect(slots).toHaveCount(2);
    const applyAdjust = async (adjust) => {
        await column.evaluate((element, value) => {
            element.style.gridTemplateRows = `minmax(0px, calc(50% + ${value}px)) var(--ps-resizer-track, 16px) minmax(0px, 1fr)`;
        }, adjust);
    };

    let columnBox = await column.boundingBox();
    await applyAdjust(-(handlerGeometry.columnHeight / 2));
    let inspectorBox = await slots.nth(0).boundingBox();
    let activityBox = await slots.nth(1).boundingBox();
    expect(inspectorBox.height).toBeLessThanOrEqual(1);
    expect(activityBox.height).toBeGreaterThan(columnBox.height - 22);
    await expect(handle).toBeVisible();

    columnBox = await column.boundingBox();
    await applyAdjust((handlerGeometry.columnHeight / 2) - handlerGeometry.dividerHeight);
    inspectorBox = await slots.nth(0).boundingBox();
    activityBox = await slots.nth(1).boundingBox();
    expect(inspectorBox.height).toBeGreaterThan(columnBox.height - 22);
    expect(activityBox.height).toBeLessThanOrEqual(1);
    await expect(handle).toBeVisible();
});

// Every theme, because nobody clicks through twenty of them by hand — and
// that is exactly where these regressions hide.
// Current palettes only: light-high-contrast and friends were retired.
// "workspace-dark-rich" was retired along with the rich transcript renderer.
// Asking the stub for a theme that no longer exists left every one of these
// waiting 10s for a data-ps-theme that could never arrive.
const THEMES = ["github-dark", "github-light", "win95", "ms-dos", "workspace-dark"];

for (const theme of THEMES) {
    test(`[${theme}] themed controls actually receive the theme`, async ({ page }) => {
        // The regression: base rules at specificity (0,3,1) outranked
        // :root[data-ps-theme=…] at (0,3,0), so the inspector tab row silently
        // kept its default styling while every other control was themed.
        await openPortal(page, { theme });
        // The inspector tab row lives in the diagnostics column, which has
        // defaulted CLOSED since the desktop columns became two independent
        // toggles. Without opening it the selector matched nothing and every
        // one of these skipped — five silent passes on the exact bug class
        // this release fixed three instances of.
        const diagnostics = page.getByRole("button", { name: /Show diagnostics/i });
        if (await diagnostics.count() > 0) {
            await diagnostics.first().click();
            await page.waitForTimeout(400);
        }
        const tab = await page.$(".ps-tab-row-icons .ps-toolbar-button");
        // A skip here is now a FAILURE: the row is expected to exist.
        expect(tab, "no inspector tab row after opening diagnostics").not.toBeNull();
        // "Themed" means it paints SOMETHING: win95's selected tab is a
        // latched face drawn with a conic-gradient, and a gradient is a
        // background-image, so backgroundColor alone reads as transparent on a
        // button that is in fact fully themed.
        const paint = await tab.evaluate((el) => {
            const s = getComputedStyle(el);
            return { color: s.backgroundColor, image: s.backgroundImage, border: s.borderTopWidth };
        });
        const painted = paint.color !== "rgba(0, 0, 0, 0)"
            || (paint.image && paint.image !== "none")
            || parseFloat(paint.border) > 0;
        expect(painted, `tab button is unstyled under ${theme} (${JSON.stringify(paint)})`).toBe(true);
    });

    test(`[${theme}] body text is readable against its surface`, async ({ page }) => {
        await openPortal(page, { theme });
        const { fg, bg } = await page.evaluate(() => {
            const el = document.querySelector(".ps-panel-body") || document.body;
            const s = getComputedStyle(el);
            let bgEl = el;
            let bgc = s.backgroundColor;
            while (bgEl && (bgc === "rgba(0, 0, 0, 0)" || bgc === "transparent")) {
                bgEl = bgEl.parentElement;
                if (!bgEl) break;
                bgc = getComputedStyle(bgEl).backgroundColor;
            }
            return { fg: s.color, bg: bgc || "rgb(0,0,0)" };
        });
        const ratio = contrastRatio(fg, bg);
        expect(ratio, `${theme}: body text ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThan(4.5);
    });
}

test("scrolling the transcript does not re-render every line", async ({ page }) => {
    // Guards the regression this test was written for: scroll dispatched state
    // on EVERY scroll event, and each dispatch re-rendered the whole
    // transcript. Rendering is proportional to transcript length, so a loaded
    // session got progressively more sluggish. Assert the work is bounded:
    // a burst of scroll events must not produce a burst of layout work.
    await openPortal(page);
    const scroller = await page.$(".ps-chat-panel .ps-scroll-panel");
    test.skip(!scroller, "no chat scroller in this layout");

    const elapsed = await page.evaluate(async () => {
        const el = document.querySelector(".ps-chat-panel .ps-scroll-panel");
        const start = performance.now();
        // 60 scroll events — far more than the browser will paint.
        for (let i = 0; i < 60; i += 1) {
            el.scrollTop = i * 3;
            el.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now() - start;
    });

    // Generous ceiling: this is a smoke check against unbounded per-event work,
    // not a benchmark. Before frame-coalescing, 60 synchronous dispatches each
    // re-rendered the transcript.
    expect(elapsed, `60 scroll events took ${elapsed.toFixed(0)}ms`).toBeLessThan(1500);
});

test("pane header controls never wrap out of the header", async ({ page }) => {
    // A fixed-height header cannot absorb a wrapped row: the overflow escapes
    // the box and lands on top of the pane content below.
    //
    // HONEST LIMIT: this asserts the invariant, but the stub layout does not
    // reproduce the original failure even at 330px — that needed the real
    // session pane at high browser zoom. So it guards the rule going forward
    // rather than having been proven against the bug it was written for.
    await page.setViewportSize({ width: 330, height: 900 });
    await openPortal(page);
    const escaped = await page.$$eval(".ps-panel-header", (headers) => headers.flatMap((h) => {
        const hb = h.getBoundingClientRect();
        if (hb.height === 0) return [];
        return [...h.querySelectorAll("button")]
            .filter((b) => {
                const bb = b.getBoundingClientRect();
                // Bottom edge past the header means it wrapped to a new row.
                return bb.height > 0 && bb.bottom > hb.bottom + 1;
            })
            .map((b) => `${b.getAttribute("aria-label") || b.className}`);
    }));
    expect(escaped, `controls wrapped outside their header: ${escaped.join(", ")}`).toEqual([]);
});
