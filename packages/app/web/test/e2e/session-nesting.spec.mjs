// Nested sessions render as a "well" — a tone-separated surface with a left
// rail — instead of a box-drawing character.
//
// WHY THIS EXISTS: the well is built entirely from per-row classes so the list
// stays a FLAT row sequence (memoised rendering, keyboard nav and the drag
// hit-test all depend on that). Nothing in a unit test can tell you the run
// boundaries landed on the right rows, or that the "└ " glyph actually
// disappeared from the portal while the TUI kept it.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    // 1 → {2 → {3}}, 5: a chain deep enough to show more than one level.
    stub = await startStubServer(0, { sessionCount: 7, parents: { 2: 1, 3: 2, 5: 1 } });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

// Parents start collapsed; the first click selects, the second toggles.
async function expand(page, label) {
    const row = page.locator(".ps-session-list-button", { hasText: new RegExp(`${label}\\b`) }).first();
    await row.click();
    await row.click();
}

test("a subtree renders as one well, capped at both ends", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await expect(page.locator(".ps-session-list-button.is-nested")).toHaveCount(0);

    await expand(page, "Session 1");
    const nested = page.locator(".ps-session-list-button.is-nested");
    await expect(nested).toHaveCount(2);
    // Exactly one cap at each end, however deep the run goes.
    await expect(page.locator(".ps-session-list-button.is-well-start")).toHaveCount(1);
    await expect(page.locator(".ps-session-list-button.is-well-end")).toHaveCount(1);

    await expand(page, "Session 2");
    await expect(nested).toHaveCount(3);
    await expect(page.locator(".ps-session-list-button.is-well-start")).toHaveCount(1);
    await expect(page.locator(".ps-session-list-button.is-well-end")).toHaveCount(1);
});

test("the box-drawing glyph is gone from nested rows", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await expand(page, "Session 1");
    await expect(page.locator(".ps-session-list-button.is-nested").first()).toBeVisible();

    // The well says "nested"; the glyph saying it again is the thing being
    // replaced. (The selector still emits it — the TUI renders it.)
    const text = await page.locator(".ps-session-list").innerText();
    expect(text).not.toContain("└");
});

test("the well is labelled with the size of the run", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await expand(page, "Session 1");

    const start = page.locator(".ps-session-list-button.is-well-start");
    await expect(start).toHaveAttribute("data-well-count", "2");
    const label = await start.evaluate((node) => getComputedStyle(node, "::before").content);
    expect(label).toContain("sub-agents");

    // Growing the run re-labels it rather than counting only direct children.
    await expand(page, "Session 2");
    await expect(page.locator(".ps-session-list-button.is-well-start")).toHaveAttribute("data-well-count", "3");
});

test("the well elevates in BOTH polarities, never white-on-white", async ({ page }) => {
    // --ps-surface was invisible on the light themes; the well elevates from
    // the background toward the foreground instead, so it steps darker on
    // light and lighter on dark.
    for (const themeId of ["github-light", "noctis"]) {
        const themed = await startStubServer(0, { sessionCount: 5, themeId, parents: { 2: 1 } });
        try {
            await page.goto(`http://127.0.0.1:${themed.port}`);
            await page.locator(".ps-session-list-button").first().waitFor();
            await expand(page, "Session 1");
            const nested = page.locator(".ps-session-list-button.is-nested").first();
            await expect(nested).toBeVisible();
            const [well, ground] = await page.evaluate(() => {
                const styles = getComputedStyle(document.documentElement);
                const probe = (value) => {
                    const el = document.createElement("span");
                    el.style.color = value;
                    document.body.appendChild(el);
                    const out = getComputedStyle(el).color;
                    el.remove();
                    return out;
                };
                return [probe(styles.getPropertyValue("--ps-well")), probe(styles.getPropertyValue("--ps-background"))];
            });
            expect(well, `${themeId}: the well must not equal the ground`).not.toBe(ground);
        } finally {
            await new Promise((resolve) => themed.server.close(resolve));
        }
    }
});
