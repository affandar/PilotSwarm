import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2, transcriptTurns: 2, admin: true, assistantMarkdown: "PRIVATE_VIEW_CANARY" }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const mobile of [false, true]) {
    test(`${mobile ? "mobile" : "desktop"}: cluster policy is visible and revoked content clears`, async ({ page }) => {
        if (mobile) await page.setViewportSize({ width: 390, height: 844 });
        for (const path of ["**/api/bootstrap", "**/api/v1/me/profile"]) {
            await page.route(path, async route => {
                const response = await route.fetch();
                const body = await response.json();
                if (body.result) body.result.adminScope = "cluster";
                else body.authz = { adminScope: "cluster", policyVersion: 1, enforceOwnership: true };
                await route.fulfill({ response, json: body });
            });
        }
        let socket;
        await page.routeWebSocket("**/api/v1/ws", ws => { socket = ws; });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
        await page.locator(".ps-assistant-preview > summary").first().click();
        await expect(page.locator(".ps-chat-panel")).toContainText("PRIVATE_VIEW_CANARY");
        // Subsequent HTTP refreshes must reflect the same server denial.
        await page.route(`**/api/v1/sessions/${sessionId}`, route => route.fulfill({ status: 404, json: { ok: false, error: "Session not found.", code: "NOT_FOUND" } }));
        socket.send(JSON.stringify({ type: "error", scope: "session", sessionId, code: "ACCESS_REVOKED", error: "Session not found." }));
        await expect(page.locator(".ps-chat-panel")).not.toContainText("PRIVATE_VIEW_CANARY");
        if (mobile) {
            await expect(page.locator('button[aria-label="Admin console"]')).toHaveCount(0);
        } else {
            await page.locator('button[aria-label="Admin console"]').click();
            await expect(page.getByText("Cluster-scoped admin · system-session access retained", { exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: "Refresh model providers" })).toBeVisible();
        }
    });
}
