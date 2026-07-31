// Dragging sessions into folders, in a real browser.
//
// WHY THIS EXISTS: this interaction was reported broken three times and each
// diagnosis from screenshots was wrong. It cannot be asserted from unit tests
// (it is pointer gestures + hit-testing + DOM state) and it failed in ways a
// single drag would not reveal — one drag worked, every later drag silently
// died because each drag leaked a pointercancel listener whose stale closure
// aborted the next one. So: drive the mouse, and drag MORE THAN ONCE.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const GROUP = {
    groupId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    title: "Test Group",
    description: "0 grouped sessions",
    owner: null,
    memberCount: 0,
    runningCount: 0,
    waitingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    createdAt: 1785000000000,
    updatedAt: 1785000000000,
};

let stub;
let base;

test.beforeAll(async () => {
    // Sessions 4 and 5 start INSIDE the folder, so the folder has an expanded
    // region to drop onto rather than just a header row.
    stub = await startStubServer(0, {
        sessionCount: 6,
        groups: [{ ...GROUP, memberCount: 2 }],
        groupMembers: { 4: GROUP.groupId, 5: GROUP.groupId },
    });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
});

async function dragRowOntoGroup(page, rowText) {
    const row = page.locator(".ps-session-list-button", { hasText: rowText }).first();
    const folder = page.locator(".ps-session-list-button[data-group-row='1']").first();
    const from = await row.boundingBox();
    const to = await folder.boundingBox();
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    // Past the 5px arming threshold, in steps, so pointermove actually streams.
    await page.mouse.move(from.x + 60, from.y + from.height / 2 - 10, { steps: 4 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
}

test("a session can be dragged into a folder REPEATEDLY", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await expect(page.locator(".ps-session-list-button[data-group-row='1']")).toHaveCount(1);

    await dragRowOntoGroup(page, "Session 1");
    await expect.poll(() => stub.placements.length).toBe(1);
    expect(stub.placements[0].groupId).toBe(GROUP.groupId);
    expect(stub.placements[0].sessionIds.length).toBe(1);

    // The regression: the SECOND drag is the one that used to die.
    await dragRowOntoGroup(page, "Session 2");
    await expect.poll(() => stub.placements.length).toBe(2);
    expect(stub.placements[1].groupId).toBe(GROUP.groupId);

    // And a third, because "worked once" was the whole bug signature.
    await dragRowOntoGroup(page, "Session 3");
    await expect.poll(() => stub.placements.length).toBe(3);
});

test("the drag ghost shows a collection for a multi-selection", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();

    const rows = page.locator(".ps-session-list-button");
    await rows.nth(1).click();
    await rows.nth(2).click({ modifiers: ["Meta"] });
    await rows.nth(3).click({ modifiers: ["Meta"] });

    const from = await rows.nth(3).boundingBox();
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + from.height / 2 - 20, { steps: 5 });
    await expect(page.locator(".ps-drag-ghost")).toBeVisible();
    await expect(page.locator(".ps-drag-ghost__stack.is-collection")).toBeVisible();
    await page.mouse.up();
});

test("the folder's WHOLE region is the drop zone, and it lights up", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    const before = stub.placements.length;

    // Folders start collapsed, and this one is already the active row, so a
    // single click expands it into folder + 2 members.
    const folder = page.locator(".ps-session-list-button[data-group-row='1']").first();
    await folder.click();
    await expect(page.locator(".ps-session-list-button[data-drop-group]")).toHaveCount(3);

    // Aim at a MEMBER of the folder, not the folder row. Releasing there used
    // to miss every drop target and file the session nowhere - i.e. the API
    // read it as "remove from folder".
    const member = page.locator(".ps-session-list-button", { hasText: "Session 5" }).first();
    const row = page.locator(".ps-session-list-button", { hasText: "Session 1" }).first();
    const from = await row.boundingBox();
    const to = await member.boundingBox();
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + from.height / 2 - 10, { steps: 4 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });

    // The whole block highlights - the folder row AND both its members - so the
    // destination reads as a region, not a 20px line.
    await expect(page.locator(".ps-session-list-button.is-drop-zone")).toHaveCount(3);
    await expect(page.locator(".ps-session-list-button.is-drop-target")).toHaveCount(1);
    await expect(page.locator(".ps-session-list-button[data-group-row='1'].is-drop-target")).toHaveCount(1);
    expect(await page.evaluate(() => document.body.classList.contains("ps-drop-ok"))).toBe(true);

    await page.mouse.up();
    await expect.poll(() => stub.placements.length).toBe(before + 1);
    expect(stub.placements[before].groupId).toBe(GROUP.groupId);
    expect(await page.evaluate(() => document.body.classList.contains("ps-drop-ok"))).toBe(false);
});

test("dragging over ungrouped rows offers no destination", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();

    const row = page.locator(".ps-session-list-button", { hasText: "Session 1" }).first();
    const target = page.locator(".ps-session-list-button", { hasText: "Session 3" }).first();
    const from = await row.boundingBox();
    const to = await target.boundingBox();
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + from.height / 2 - 10, { steps: 4 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 6 });

    await expect(page.locator(".ps-session-list-button.is-drop-zone")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.classList.contains("ps-drop-ok"))).toBe(false);
    await page.mouse.up();
});

test("with nothing selected the folder button offers only New Group", async ({ page }) => {
    await page.goto(base);
    const rows = page.locator(".ps-session-list-button");
    await rows.first().waitFor();
    await rows.nth(1).click();

    // Deselect via empty space, then press the folder button.
    const list = page.locator(".ps-session-list");
    const box = await list.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
    await expect(page.locator(".ps-session-list-button.is-selected")).toHaveCount(0);

    // The button relabels itself to say what it will actually do.
    await page.locator('button[aria-label="New group"]').click();
    const modal = page.locator(".ps-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(/New Group/i);
    // Not the move picker: no destination list, so no "[No Group]" escape hatch.
    await expect(modal).not.toContainText("[No Group]");
    await expect(modal).not.toContainText("Test Group");
});

test("clicking empty space clears the list highlight", async ({ page }) => {
    await page.goto(base);
    const rows = page.locator(".ps-session-list-button");
    await rows.first().waitFor();
    await rows.nth(1).click();
    await expect(page.locator(".ps-session-list-button.is-selected")).toHaveCount(1);

    // Empty space below the last row, inside the list.
    const list = page.locator(".ps-session-list");
    const box = await list.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
    await expect(page.locator(".ps-session-list-button.is-selected")).toHaveCount(0);
});
