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
});

/** Relative luminance / contrast, per WCAG. */
function contrastRatio(fg, bg) {
    const parse = (c) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
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

async function openPortal(page, { theme } = {}) {
    await page.goto(base, { waitUntil: "networkidle" });
    if (theme) {
        await page.evaluate((id) => { document.documentElement.dataset.psTheme = id; }, theme);
    }
    await page.waitForSelector(".ps-panel", { timeout: 15_000 });
}

test("all pane headers are the same height", async ({ page }) => {
    // The regression: headers were sized by their contents, so a pane WITH
    // action buttons rendered ~46px while one without rendered 34px, and
    // side-by-side panes started their bodies at different heights.
    await openPortal(page);
    const heights = await page.$$eval(".ps-panel-header", (els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0));
    expect(heights.length).toBeGreaterThan(1);
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

// Every theme, because nobody clicks through twenty of them by hand — and
// that is exactly where these regressions hide.
const THEMES = ["github-dark", "github-light", "light-high-contrast", "win95", "ms-dos"];

for (const theme of THEMES) {
    test(`[${theme}] themed controls actually receive the theme`, async ({ page }) => {
        // The regression: base rules at specificity (0,3,1) outranked
        // :root[data-ps-theme=…] at (0,3,0), so the inspector tab row silently
        // kept its default styling while every other control was themed.
        await openPortal(page, { theme });
        const tab = await page.$(".ps-tab-row-icons .ps-toolbar-button");
        test.skip(!tab, "no inspector tab row in this layout");
        const bg = await tab.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg, `tab button is fully transparent under ${theme}`).not.toBe("rgba(0, 0, 0, 0)");
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
