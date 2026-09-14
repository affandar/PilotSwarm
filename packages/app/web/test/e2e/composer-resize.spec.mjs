import { test, expect, chromium, webkit } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const failure of [
        { code: "MESSAGE_TOO_LARGE", status: 413, message: "Message exceeds 12288 serialized UTF-8 bytes. Upload large content as an artifact and send a short reference." },
        { code: "INTERNAL_ERROR", status: 409, message: "Session 11111110 is a terminal orchestration and cannot accept new messages." },
    ]) {
        test(`retains rejected drafts without retrying ${failure.status} at ${viewport.width}px`, async ({ page }, testInfo) => {
            await page.setViewportSize(viewport);
            const requests = [];
            await page.routeWebSocket("**/api/v1/ws", () => {});
            await page.route(`**/sessions/${sessionId}/messages`, async (route) => {
                requests.push(route.request().postDataJSON());
                await route.fulfill(requests.length === 1
                    ? { status: failure.status, json: { ok: false, error: { code: failure.code, message: failure.message } } }
                    : { json: { ok: true, result: { queued: true } } });
            });
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
            const input = page.locator(".ps-prompt-input");
            await expect(input).toBeVisible();
            const prompt = "Preserve the original diagnostic request for recovery.";
            await input.fill(prompt);
            await page.getByRole("button", { name: "Send prompt", exact: true }).click();
            await expect(input).toHaveValue("");
            await expect(page.getByText("queued prompts: 1 rejected", { exact: false })).toBeVisible();
            const reason = page.getByText(`Not sent: ${failure.message}`, { exact: true });
            await expect(reason).toBeVisible();
            await expect(page.getByText(prompt, { exact: false }).last()).toBeVisible();
            await input.press("Enter");
            expect(requests).toHaveLength(1);
            const reasonBox = await reason.boundingBox();
            expect(reasonBox.x).toBeGreaterThanOrEqual(0);
            expect(reasonBox.x + reasonBox.width).toBeLessThanOrEqual(viewport.width + 1);
            const screenshotPath = testInfo.outputPath("rejected-draft.png");
            await page.screenshot({ path: screenshotPath });
            await testInfo.attach("rejected-draft", { path: screenshotPath, contentType: "image/png" });

            if (failure.status === 413) {
                await page.getByRole("button", { name: "Recover rejected prompt", exact: true }).click();
                await expect(input).toHaveValue(prompt);
                await input.fill("Read the uploaded artifact.");
                await page.getByRole("button", { name: "Resend prompt", exact: true }).click();
                await expect(page.getByText("queued prompts: 1 queued", { exact: false })).toBeVisible();
                expect(requests).toHaveLength(2);
                expect(requests[0].options.clientMessageIds).toHaveLength(1);
                expect(requests[1].options.clientMessageIds).toHaveLength(1);
                expect(requests[1].options.clientMessageIds).not.toEqual(requests[0].options.clientMessageIds);
                await expect(reason).toHaveCount(0);
            }
        });
    }
}

for (const browserName of ["chromium", "webkit"]) {
    test.describe(`${browserName} mobile composer`, () => {
        test("send/acknowledgement shrinks the empty input without resize or another keystroke", async () => {
            const browser = await ({ chromium, webkit })[browserName].launch();
            try {
                const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
                let socket, sent;
                await page.routeWebSocket("**/api/v1/ws", ws => { socket = ws; });
                await page.route(`**/sessions/${sessionId}/messages`, async route => {
                    sent = route.request().postDataJSON();
                    await route.fulfill({ json: { ok: true, result: { queued: true } } });
                });
                await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
                const input = page.locator(".ps-prompt-input");
                await expect(input).toBeVisible();
                await expect(page.getByRole("button", { name: "Stop the current turn", exact: true })).toBeVisible();
                const height = () => input.evaluate(node => node.getBoundingClientRect().height);
                // Let the initial ResizeObserver measurement complete.
                await input.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const idleHeight = await height();
                const prompt = "Write a detailed report with the test setup and analysis. Include the evidence, tradeoffs and recommendations.";
                await input.fill(prompt);
                await expect.poll(height).toBeGreaterThan(idleHeight);
                await page.getByRole("button", { name: "Send prompt", exact: true }).click();
                await expect(input).toHaveValue("");
                await expect(input).toHaveAttribute("placeholder", "Message…");
                await expect.poll(height).toBeLessThanOrEqual(idleHeight + 1);
                await expect.poll(() => Boolean(sent)).toBe(true);
                socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: {
                    sessionId, seq: 1, eventType: "user.message", createdAt: Date.now(),
                    data: { content: prompt, clientMessageIds: sent.clientMessageIds },
                } }));
                await expect(input).toHaveAttribute("placeholder", "Message…");
                await expect.poll(height).toBeLessThanOrEqual(idleHeight + 1);
                // A huge draft still caps and scrolls, then deleting it shrinks.
                await input.fill("Long draft with soft wrapped lines. ".repeat(150));
                expect(await input.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
                await input.fill("");
                await expect.poll(height).toBeLessThanOrEqual(idleHeight + 1);
            } finally {
                await browser.close();
            }
        });
    });
}
