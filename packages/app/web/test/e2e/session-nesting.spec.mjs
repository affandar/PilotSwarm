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

    // A nested row's mark is a RING sitting ON its deepest rail, so a run of
    // siblings reads as one thread with a node each. Only a real layout pass
    // can tell you the mark and the rail actually line up.
    test("a nested row's mark is a ring centred on its deepest rail", async ({ page }) => {
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();
        await expand(page, 1);

        const nested = rowFor(page, 2);
        const markSelector = ".ps-session-status-dot, .ps-rich-session-dot";
        const mark = nested.locator(markSelector).first();

        // Ring, not disc: the fill empties and the status colour moves to the
        // border, so nothing about status legibility is lost by the swap.
        expect(await mark.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        expect(await mark.evaluate((node) => getComputedStyle(node).borderTopWidth)).not.toBe("0px");

        const offsets = await nested.evaluate((node, selector) => {
            const style = getComputedStyle(node);
            const positions = style.backgroundPosition
                .split(",")
                .map((layer) => parseFloat(layer.trim()));
            // background-position resolves against the PADDING box, so both
            // measurements have to start there or they differ by the row's
            // own horizontal padding.
            const originLeft = node.getBoundingClientRect().left
                + parseFloat(style.borderLeftWidth)
                + parseFloat(style.paddingLeft);
            const box = node.querySelector(selector).getBoundingClientRect();
            return {
                markCentre: box.left + (box.width / 2) - originLeft,
                // Deepest rail, plus half its 1.5px hairline.
                railCentre: Math.max(...positions) + 0.75,
            };
        }, markSelector);
        expect(Math.abs(offsets.markCentre - offsets.railCentre)).toBeLessThan(1.5);
    });

    // Top level keeps the filled disc, so "root" still reads at a glance.
    test("a top-level row keeps the filled disc", async ({ page }) => {
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();
        const mark = rowFor(page, 1).locator(".ps-session-status-dot, .ps-rich-session-dot").first();
        expect(await mark.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
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

// Every folder test above uses ONE folder. With two, a reported bug had the
// second header vanish and reappear for a few ms on each refresh tick, so its
// members read as if they had jumped into the neighbouring folder. The root
// cause was the per-row detail sync fetching the folder's row id
// ("group:<uuid>") as a session, taking the server's 404 as "deleted" and
// evicting the row.
test("two folders both keep their headers across refresh ticks", async ({ page }) => {
    const A = { ...GROUP, groupId: "aaaaaaaa-1111-2222-3333-444444444444", title: "Folder Alpha", memberCount: 4 };
    const B = { ...GROUP, groupId: "bbbbbbbb-1111-2222-3333-444444444444", title: "Folder Beta", memberCount: 4 };
    const stub = await startStubServer(0, {
        sessionCount: 10,
        groups: [A, B],
        groupMembers: {
            1: A.groupId, 2: A.groupId, 3: A.groupId, 4: A.groupId,
            5: B.groupId, 6: B.groupId, 7: B.groupId, 8: B.groupId,
        },
    });
    try {
        const base = `http://127.0.0.1:${stub.port}`;
        await page.goto(base);
        const folders = page.locator(".ps-session-list-button[data-group-row='1']");
        await expect(folders).toHaveCount(2);

        const sample = await page.evaluate(async () => {
            const count = () => document.querySelectorAll(".ps-session-list-button[data-group-row='1']").length;
            let min = count();
            const dips = [];
            const started = Date.now();
            // MutationObserver, not a poll: the gap is only a few ms (far too
            // short for Playwright's per-assertion round trips), and a 10ms
            // interval loads the CPU enough to destabilise neighbouring tests.
            const observer = new MutationObserver(() => {
                const n = count();
                if (n < 2) dips.push({ atMs: Date.now() - started, n });
                if (n < min) min = n;
            });
            observer.observe(document.body, { childList: true, subtree: true });
            await new Promise((resolve) => setTimeout(resolve, 12000));
            observer.disconnect();
            return { min, dips: dips.slice(0, 12), dipCount: dips.length };
        });

        expect(
            sample.min,
            `a folder header dropped out during refresh (min=${sample.min}, dips=${sample.dipCount}, first=${JSON.stringify(sample.dips)})`,
        ).toBe(2);
        await expect(folders).toHaveCount(2);
    } finally {
        await new Promise((resolve) => stub.server.close(resolve));
    }
});
