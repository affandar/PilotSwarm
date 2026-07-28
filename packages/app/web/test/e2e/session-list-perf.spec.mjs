// Session-list navigation cost, in a real browser, at fleet scale.
//
// WHY THESE EXIST: scrolling the session list was sluggish, and the cause was
// not what it looked like. Two separate defects:
//
//   • every keypress rebuilt EVERY row view model (including flattening each
//     row's runs to text) to flip one boolean on two rows — 5.16ms of work per
//     move at 200 sessions
//   • every keypress issued TWO API round trips (force-refetch the session's
//     events, re-probe access), so scrolling a list fired a request pair per
//     row. Free against this stub; on a remote deployment it put the whole
//     network latency between the key and the highlight.
//
// A wall-clock assertion alone would not have caught the second one, because
// the stub answers instantly — hence the request count, which is the property
// that actually degrades remotely.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const FLEET = 200;

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: FLEET });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((r) => stub.server.close(r));
});

/** Load the portal and put keyboard focus on the session list. */
async function openListFocused(page) {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForSelector(".ps-session-list-button", { timeout: 20_000 });
    await page.waitForTimeout(600);
    await page.locator(".ps-session-list-button").first().click();
    await page.waitForTimeout(400);
}

test("moving through the session list does not fetch per keypress", async ({ page }) => {
    await openListFocused(page);

    const calls = [];
    page.on("request", (r) => {
        const url = r.url();
        if (url.includes("/api/")) calls.push(url.replace(base, "").split("?")[0]);
    });

    const MOVES = 30;
    await page.evaluate(async (moves) => {
        for (let i = 0; i < moves; i += 1) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
            await new Promise((r) => requestAnimationFrame(r));
        }
    }, MOVES);
    // Long enough for the settle timer to fire for the session it landed on.
    await page.waitForTimeout(900);

    const perSession = calls.filter((c) => /\/sessions\//.test(c));
    // The landing session may fetch events + access + detail; a per-keypress
    // regression would put this in the dozens.
    expect(perSession.length,
        `${MOVES} moves issued ${perSession.length} session requests: ${JSON.stringify(perSession)}`)
        .toBeLessThanOrEqual(8);
});

test("the selection still lands on the right session and loads it", async ({ page }) => {
    // The guard on the optimisation: deferring the fetch must not lose it.
    await openListFocused(page);

    const before = await page.locator(".ps-session-list-button.is-selected").textContent();
    await page.evaluate(async () => {
        for (let i = 0; i < 5; i += 1) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
            await new Promise((r) => requestAnimationFrame(r));
        }
    });
    await page.waitForTimeout(900);

    const after = await page.locator(".ps-session-list-button.is-selected").textContent();
    expect(after).not.toBe(before);

    // The detail box reflects the landed session, which only happens once the
    // selection actually took effect.
    const id = await page.locator(".ps-session-detail-field.is-id .ps-session-detail-value").textContent();
    expect(id).toMatch(/^[0-9a-f-]{8,}/i);
});

test("a burst of moves stays within a frame budget per move", async ({ page }) => {
    await openListFocused(page);

    const MOVES = 50;
    const elapsed = await page.evaluate(async (moves) => {
        const t0 = performance.now();
        for (let i = 0; i < moves; i += 1) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now() - t0;
    }, MOVES);

    const perMove = elapsed / MOVES;
    // Measured 5.16ms/move before row memoization and 0.59ms after, at 200
    // sessions. 3ms leaves headroom for CI noise while still failing if the
    // per-row rebuild comes back.
    expect(perMove, `${perMove.toFixed(2)}ms of work per move at ${FLEET} sessions`).toBeLessThan(3);
});
