// Keys inside a modal's text box.
//
// The keyboard handler routes Escape / Enter / arrows to the open modal, but
// only when the focus is NOT in an editable — so typing "j" in a search box
// filters instead of moving the selection. That gate also swallowed the four
// modal keys: with a search box focused, the modal's own hint said "Esc close"
// and Escape did nothing. The fix lets those keys through from a box marked
// as a modal's search field (the agent picker's, and the session filter's
// people search used here — the stub has no agents to pick).
//
// Marked, not every input: the rename and group-name boxes confirm on Enter
// themselves, and in a text box the arrows mean the caret. Both halves are
// guarded here — the keys reach the modal from a search box, and a rename
// reaches the API exactly once (a second confirm is a no-op today only
// because the first closes the modal synchronously; this pins the count).
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 6 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

async function openPortal(page) {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.waitForTimeout(300);
}

async function openFilterSearch(page) {
    await page.getByRole("button", { name: /Filter sessions/i }).first().click();
    const search = page.locator(".ps-modal-search");
    await expect(search, "the session filter's people search").toBeVisible();
    await search.focus();
    return search;
}

test("Escape in a modal's search box closes the modal", async ({ page }) => {
    await openPortal(page);
    const search = await openFilterSearch(page);
    // Typing still types: the box is an editable first.
    await search.type("al");
    await expect(search).toHaveValue("al");
    // First Escape clears the box (the box's own handler); second closes.
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(search, "Escape from an empty search box must close the modal").toHaveCount(0);
});

test("ArrowDown in a modal's search box moves the selection", async ({ page }) => {
    await openPortal(page);
    await openFilterSearch(page);
    const selected = () => page.locator(".ps-modal-list-button.is-selected").first();
    expect(await page.locator(".ps-modal-list-button").count(), "rows to arrow between").toBeGreaterThan(1);
    const before = await selected().innerText();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    expect(await selected().innerText(), "selection did not move").not.toBe(before);
});

test("Enter in the rename box renames exactly once", async ({ page }) => {
    await openPortal(page);
    // "t" over the session list opens the rename box for the selected row.
    await page.locator(".ps-session-list-button").first().click();
    await page.keyboard.press("t");
    const box = page.locator(".ps-modal-input").first();
    await expect(box, "the rename box").toBeVisible();
    await box.fill("Renamed by the test");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    expect(stub.renames.map((r) => r.title), "one Enter, one rename").toEqual(["Renamed by the test"]);
});
