import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { normalizeMoa } from "../../../ui/core/src/moa.js";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

// Sample computed CSS colors through canvas so browser-supported color-mix()
// and color(srgb ...) values are measured, not silently skipped. Composite
// each ancestor's background and opacity in paint order: token-only contrast
// would miss the opacity on collapsed preview summaries.
async function contrast(locator, label, { property = "color", minimum = 4.5, foreground = null } = {}) {
    await expect(locator, label).toBeVisible();
    const result = await locator.evaluate((element, { property, foreground }) => {
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const rgba = css => {
            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b, a / 255];
        };
        const over = (fg, bg) => {
            const a = fg[3] + bg[3] * (1 - fg[3]);
            return a ? [...[0, 1, 2].map(i => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / a), a] : [0, 0, 0, 0];
        };
        let fg = rgba(foreground || getComputedStyle(element)[property]), bg = [0, 0, 0, 0];
        const ancestors = [];
        for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node), fill = rgba(style.backgroundColor), opacity = Number(style.opacity);
            fg = over(fg, fill); bg = over(bg, fill);
            fg[3] *= opacity; bg[3] *= opacity;
            ancestors.push({ class: node.className, fill: style.backgroundColor, opacity });
        }
        fg = over(fg, [255, 255, 255, 1]); bg = over(bg, [255, 255, 255, 1]);
        const luminance = color => color.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
        const a = luminance(fg), b = luminance(bg);
        return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fg, bg, ancestors };
    }, { property, foreground });
    expect(result.ratio, `${label}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(minimum);
}

async function previewContrast(card, prefix) {
    await contrast(card.locator(":scope > summary .ps-system-notice-summary-text"), `${prefix} summary`);
    await contrast(card.locator(":scope > summary .ps-canvas-action-tag"), `${prefix} Agent badge`);
    const status = card.locator(":scope > summary .ps-preview-status");
    if (await status.count()) await contrast(status, `${prefix} status`);
}

for (const themeId of ["win95", "winamp", "ms-dos"]) {
    test(`${themeId}: default and MoA previews, personal workspace, empty state, and dialogs retain readable contrast`, async ({ page }) => {
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let settings = { themeId, moa: normalizeMoa({ slots: [
            { name: "Operations", tree: { id: "split", type: "split", direction: "row", ratio: 66, first: { id: "chat", type: "chat", sessionId }, second: { id: "missing-canvas", type: "canvas", sessionId, slot: 5 } } },
            { name: "Reserve", tree: null },
        ] }) };
        await page.route("**/api/v1/me/profile**", route => {
            if (route.request().method() === "PATCH") settings = route.request().postDataJSON().settings;
            return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } });
        });
        const subscribers = new Set();
        await page.routeWebSocket("**/api/v1/ws", socket => {
            socket.onMessage(raw => { if (JSON.parse(raw).type === "subscribeLive") subscribers.add(socket); });
        });
        let seq = 0, eventSeq = 0;
        const live = messageId => { for (const socket of subscribers) socket.send(JSON.stringify({ type: "live", sessionId, topic: "turn", kind: "snapshot", seq: ++seq, data: { phase: "live", messageId, text: "Checking the deployment report." } })); };
        const event = (eventType, data) => { for (const socket of subscribers) socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: { sessionId, seq: ++eventSeq, eventType, createdAt: Date.now(), data } })); };
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
        await expect(page.locator("html")).toHaveAttribute("data-ps-theme", themeId);
        await expect.poll(() => subscribers.size).toBeGreaterThan(0);
        live("default-message");
        const card = page.locator(".ps-assistant-preview").first();
        await expect(card).toBeVisible();
        await previewContrast(card, `${themeId} default collapsed preview`);
        await card.locator(":scope > summary").click();
        await previewContrast(card, `${themeId} default expanded preview`);
        await page.screenshot({ path: test.info().outputPath(`${themeId}-default-preview.png`) });
        await card.evaluate(el => { window.retroCard = el; });
        event("assistant.message", { messageId: "default-message", content: "The deployment report is ready." });
        await expect(card.locator(":scope > summary")).toContainText("Agent update");
        await previewContrast(card, `${themeId} default saved update`);
        event("session.turn_completed", { resultType: "completed" });
        await expect(card).toHaveClass(/is-final/);
        expect(await card.evaluate(el => el === window.retroCard)).toBe(true);
        await expect(card.locator(":scope > summary")).toContainText("Agent:");
        await expect(card.locator(".ps-canvas-action-tag")).toHaveCount(0);
        await expect(card.locator(".ps-assistant-preview-viewport")).toHaveCSS("max-height", "none");

        await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
        await expect(page.locator(".ps-moa-composer-strip textarea")).toBeVisible();
        await contrast(page.locator(".ps-moa-save"), `${themeId} header save status`);
        const focusedPanel = page.locator('[data-moa-panel="chat"]');
        await contrast(focusedPanel, `${themeId} focus border against pane`, { property: "borderTopColor", minimum: 3 });
        const focusBorder = await focusedPanel.evaluate(el => getComputedStyle(el).borderTopColor);
        await contrast(page.locator(".ps-moa-toolbar"), `${themeId} focus border against chrome`, { foreground: focusBorder, minimum: 3 });
        const empty = page.locator('[data-moa-panel="missing-canvas"] .ps-moa-empty');
        await expect(empty).toContainText("empty or no longer available");
        await contrast(empty, `${themeId} empty canvas notice`);
        await expect.poll(() => subscribers.size).toBeGreaterThanOrEqual(3);
        live("moa-message");
        const moaCard = page.locator(".ps-moa-workspace .ps-assistant-preview:not(.is-final)").first();
        await previewContrast(moaCard, `${themeId} MoA collapsed preview`);
        await moaCard.locator(":scope > summary").click();
        await previewContrast(moaCard, `${themeId} MoA expanded preview`);
        await page.screenshot({ path: test.info().outputPath(`${themeId}-moa-preview.png`) });
        await focusedPanel.getByRole("button", { name: "Session control panel", exact: true }).click();
        const controls = page.getByRole("dialog", { name: "Session control panel", exact: true });
        await contrast(controls.getByRole("heading", { name: "Session", exact: true }), `${themeId} session controls heading`);
        await contrast(controls.getByRole("heading", { name: "Panel layout", exact: true }), `${themeId} layout controls heading`);
        await contrast(controls.getByRole("button", { name: "Session information", exact: true }), `${themeId} info control`);
        await expect(focusedPanel.locator(":scope > header button")).toHaveCount(2);
        await page.screenshot({ path: test.info().outputPath(`${themeId}-control-panel.png`) });
        await controls.getByRole("button", { name: "Close dialog", exact: true }).click();
        await expect(page.getByRole("tab")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
        expect(errors).toEqual([]);
    });
}
