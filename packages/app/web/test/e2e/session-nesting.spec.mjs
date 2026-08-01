// Nested sessions render with guide rails and a status dot instead of a
// box-drawing character and punctuation.
//
// WHY THIS EXISTS: the rails are per-row background images so the list stays a
// FLAT row sequence (memoised rendering, keyboard nav and the drag hit-test
// all depend on that). Nothing in a unit test can tell you a rail landed at
// the right depth, that the "└ " glyph actually left the portal while the TUI
// kept it, or that a folder survived a transient empty listing.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const GROUP = {
    groupId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    title: "R2D Sessions",
    description: "",
    owner: null,
    memberCount: 3,
    runningCount: 0, waitingCount: 0, completedCount: 0, failedCount: 0, cancelledCount: 0,
    createdAt: 1785000000000,
    updatedAt: 1785000000000,
};

// Stub session ids are deterministic; matching on them avoids a text locator
// racing a list that is re-rendering under it.
const idOf = (index) => `1111111${index}-2222-3333-4444-55555555555${index}`;
const rowFor = (page, index) => page.locator(`.ps-session-list-button[data-session-id="${idOf(index)}"]`);

// Parents start collapsed; the first click selects, the second toggles. Each
// click is allowed to settle — firing both immediately reads as a double-click
// and the second expand can race the re-render.
async function expand(page, index) {
    const row = rowFor(page, index);
    await row.click();
    await page.waitForTimeout(120);
    await row.click();
    await page.waitForTimeout(160);
}

test.describe("guide rails", () => {
    let stub;
    let base;
    test.beforeAll(async () => {
        stub = await startStubServer(0, { sessionCount: 7, parents: { 2: 1, 3: 2, 5: 1 } });
        base = `http://127.0.0.1:${stub.port}`;
    });
    test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("one rail per ancestor level, and none at top level", async ({ page }) => {
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();
        await expect(page.locator(".ps-session-list-button.is-nested")).toHaveCount(0);

        await expand(page, 1);
        await expand(page, 2);

        const railCount = (node) => {
            const image = getComputedStyle(node).backgroundImage;
            return image === "none" ? 0 : image.split("linear-gradient").length - 1;
        };
        // One hairline per ANCESTOR level, so depth reads without counting
        // indent — the thing the single "└ " could never convey.
        expect(await rowFor(page, 1).evaluate(railCount), "top level has no rail").toBe(0);
        expect(await rowFor(page, 2).evaluate(railCount), "depth 1").toBe(1);
        expect(await rowFor(page, 3).evaluate(railCount), "depth 2").toBe(2);
    });

    test("the box-drawing glyph is gone from the portal", async ({ page }) => {
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();
        await expand(page, 1);
        await expect(page.locator(".ps-session-list-button.is-nested").first()).toBeVisible();
        expect(await page.locator(".ps-session-list").innerText()).not.toContain("└");
    });

    test("status is a dot, not punctuation", async ({ page }) => {
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();
        const dots = page.locator(".ps-session-status-dot");
        expect(await dots.count()).toBeGreaterThan(0);
        // A dot carries the status COLOUR, so it has to be painted, not blank.
        const background = await dots.first().evaluate((node) => getComputedStyle(node).backgroundColor);
        expect(background).not.toBe("rgba(0, 0, 0, 0)");
    });
});

test("a folder survives a transient empty group listing", async ({ page }) => {
    // A successful-but-empty listing used to delete the folder row. Its
    // members then hung off a generic stand-in, and because collapse state is
    // keyed by row id, the pruned entry took the group's COLLAPSED state with
    // it — so the group sprang open and spilled its members into the list.
    const stub = await startStubServer(0, {
        sessionCount: 6,
        groups: [GROUP],
        groupMembers: { 2: GROUP.groupId, 3: GROUP.groupId, 4: GROUP.groupId },
    });
    try {
        const base = `http://127.0.0.1:${stub.port}`;
        await page.goto(base);
        const folder = page.locator(".ps-session-list-button[data-group-row='1']");
        await expect(folder).toContainText("R2D Sessions");
        const before = await page.locator(".ps-session-list-button").count();

        stub.setGroups([]);
        // Long enough for several refresh ticks to land.
        await page.waitForTimeout(6000);

        await expect(folder, "the folder keeps its title").toContainText("R2D Sessions");
        await expect(page.locator(".ps-session-list-button.is-nested"), "and stays collapsed").toHaveCount(0);
        expect(await page.locator(".ps-session-list-button").count()).toBe(before);
    } finally {
        await new Promise((resolve) => stub.server.close(resolve));
    }
});
