import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

test("question card lays out escaped paragraphs and keeps literal code/path text", async ({ page }) => {
    const question = "To start I need two things:\\n\\n1. Backfill window?\\n2. Monitor cadence?\\n\\nKeep `\\n` literal and read `C:\\new\\notes.txt`.";
    await page.route(`**/sessions/${sessionId}`, async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.result = { ...body.result, status: "input_required", pendingQuestion: {
            question, choices: ["Default backfill", "Custom window"], allowFreeform: true,
        } };
        await route.fulfill({ response, json: body });
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    const card = page.locator(".ps-chat-card").filter({ hasText: "To start I need" });
    await expect(card).toBeVisible();
    const text = await card.innerText();
    expect(text).not.toContain("things:\\n");
    expect(text).not.toContain("window?\\n");
    expect(text).toContain("\\n"); // The code literal, intentionally preserved.
    expect(text).toContain("C:\\new\\notes.txt");
    await expect(card).toContainText("Default backfill");
    await expect(card).toContainText("free-form answer");
    const intro = card.getByText("To start I need two things:", { exact: true });
    const first = card.getByText(/Backfill window\?/);
    const second = card.getByText(/Monitor cadence\?/);
    const introBox = await intro.boundingBox();
    const firstBox = await first.boundingBox();
    const secondBox = await second.boundingBox();
    expect(firstBox.y).toBeGreaterThan(introBox.y + introBox.height);
    expect(secondBox.y).toBeGreaterThan(firstBox.y);
});
