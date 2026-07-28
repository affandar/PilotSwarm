// Resizing a pane must not re-lay-out the whole loaded transcript.
//
// WHY THIS EXISTS: dragging a splitter on a long session was a slideshow. The
// transcript is not virtualised — every loaded block is in the DOM — and a
// resize changes the wrap width, so the browser re-lays-out all of them on
// every frame. The cost is linear in node count (~1.55ms per 1000 nodes
// measured), and a session's window can reach 10k events.
//
// content-visibility on each block makes the browser skip layout for anything
// offscreen. Measured on a 30k-node transcript: 49.6ms -> 2.9ms per re-layout.
// These tests guard both the declaration (deterministic) and the outcome.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 6, transcriptTurns: 600 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((r) => stub.server.close(r));
});

async function openTranscript(page) {
    await page.goto(`${base}/?session=11111110-2222-3333-4444-555555555550`, { waitUntil: "networkidle" });
    await page.waitForSelector(".ps-rich-chat article", { timeout: 20_000 });
    await page.waitForTimeout(1500);
}

test("transcript blocks opt out of offscreen layout", async ({ page }) => {
    await openTranscript(page);
    const applied = await page.evaluate(() => {
        const el = document.querySelector(".ps-rich-chat > *");
        return el ? getComputedStyle(el).contentVisibility : null;
    });
    // A base rule winning a specificity contest here would silently restore the
    // old cost, which only a timing test would otherwise catch.
    expect(applied, "chat blocks lost content-visibility").toBe("auto");
});

test("re-laying out the chat pane stays cheap on a long transcript", async ({ page }) => {
    await openTranscript(page);

    const blocks = await page.locator(".ps-rich-chat article").count();
    expect(blocks, "expected a long transcript to measure against").toBeGreaterThan(100);

    const ms = await page.evaluate(() => {
        const panel = document.querySelector(".ps-chat-panel");
        const measure = () => {
            const t0 = performance.now();
            panel.style.width = `${panel.clientWidth - 9}px`;
            void panel.offsetHeight;   // force synchronous layout
            panel.style.width = "";
            void panel.offsetHeight;
            return performance.now() - t0;
        };
        return Math.min(measure(), measure());
    });

    // 6.2ms without content-visibility at this size, 0.6ms with. 3ms leaves
    // room for CI noise while still failing if offscreen layout comes back.
    expect(ms, `${ms.toFixed(1)}ms to re-lay-out ${blocks} blocks`).toBeLessThan(3);
});

test("dragging the pane splitter does not re-render the whole transcript", async ({ page }) => {
    // Rich message blocks are memoized on identity-stable block objects, so a
    // width change reconciles the container and skips the bodies — which is
    // where markdown parsing lives. Measured over a 20-step drag at 6x CPU
    // throttle with 300 blocks: ~1250ms without the memo, ~985ms with (the
    // figures include ~600ms of deliberate inter-step waiting, so the work
    // itself roughly halves).
    //
    // Generous ceiling on purpose: this guards against unbounded per-step work
    // coming back, it is not a benchmark, and CI machines vary.
    await openTranscript(page);
    const handle = await page.locator(".ps-column-resizer").first().boundingBox();
    test.skip(!handle, "no column resizer in this layout");

    const widthOf = () => page.evaluate(() =>
        Math.round(document.querySelector(".ps-chat-panel").getBoundingClientRect().width));
    const before = await widthOf();

    const y = handle.y + handle.height / 2;
    const x0 = handle.x + handle.width / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    const started = Date.now();
    for (let i = 1; i <= 20; i += 1) await page.mouse.move(x0 - i * 12, y);
    await page.mouse.up();
    const elapsed = Date.now() - started;

    // The drag must actually have resized something, or the timing below is
    // measuring nothing — a trap this suite has fallen into before.
    const after = await widthOf();
    expect(Math.abs(after - before), "the drag did not resize the chat pane").toBeGreaterThan(50);

    expect(elapsed, `${elapsed}ms for a 20-step splitter drag`).toBeLessThan(4000);
});
