import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const oldId = "11111110-2222-3333-4444-555555555550";
const newId = "99999999-2222-3333-4444-555555555555";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const mobile of [false, true]) {
    test(`New opens its chat with a stale catalog and a previous deep link (${mobile ? "mobile" : "desktop MoA"})`, async ({ page }) => {
        const errors = [], subscriptions = [];
        let creations = 0, releaseCreate;
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
        await page.routeWebSocket("**/api/v1/ws", ws => {
            ws.onMessage(raw => subscriptions.push(JSON.parse(raw)));
        });
        await page.route("**/api/v1/**", async route => {
            const req = route.request(), path = new URL(req.url()).pathname;
            const answer = result => route.fulfill({ json: { ok: true, result } });
            if (path.endsWith("/models")) return answer([{ providerId: "test", modelName: "test-model", qualifiedName: "test:test-model" }]);
            if (path.endsWith("/providers")) return answer({ providers: [{ name: "test", typeId: "test", class: "shared", hasCredential: true, usableByMe: true }] });
            if (path.endsWith("/providers/status")) return answer({ providers: [] });
            if (path.endsWith("/defaults")) return answer({});
            if (path.endsWith("/sessions") && req.method() === "POST") {
                creations++;
                if (!mobile) return new Promise(resolve => { releaseCreate = () => resolve(answer({ sessionId: newId })); });
                return answer({ sessionId: newId });
            }
            if (path.endsWith(`/sessions/${newId}`)) return answer({ sessionId: newId, title: "Fresh session", status: "idle", events: [], messages: [] });
            // The catalog deliberately never includes newId.
            return route.fallback();
        });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${oldId}`);
        await expect(page.locator(".ps-prompt-input")).toBeVisible();
        if (mobile) {
            await page.getByRole("button", { name: /^Diagnostics/ }).click();
        }
        await page.getByRole("button", { name: "New session — choose model and agent", exact: true }).click();
        await expect(page.getByText("Select model for new session", { exact: true })).toBeVisible();
        await page.keyboard.press("Enter");
        await expect.poll(() => creations).toBe(1);
        if (!mobile) {
            // The normal workspace owns New. Switch views while creation is
            // in flight; its successful completion must reveal the new chat.
            await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
            await expect(page.locator(".ps-moa-workspace")).toBeVisible();
            releaseCreate();
        }
        await expect(page.locator(".ps-chat-panel")).toContainText("Fresh session");
        await expect(page.locator(".ps-prompt-input")).toBeVisible();
        await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
        await expect.poll(() => subscriptions.some(m => m.sessionId === newId && /^subscribe/.test(m.type))).toBe(true);
        expect(errors).toEqual([]);
    });
}
