import { test, expect, chromium, webkit } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

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
                await expect(input).toHaveAttribute("placeholder", /pending batch/);
                await expect.poll(height).toBeGreaterThan(idleHeight);
                await expect.poll(() => Boolean(sent)).toBe(true);
                socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: {
                    sessionId, seq: 1, eventType: "user.message", createdAt: Date.now(),
                    data: { content: prompt, clientMessageIds: sent.clientMessageIds },
                } }));
                await expect(input).toHaveAttribute("placeholder", "Type a message and press Enter");
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
