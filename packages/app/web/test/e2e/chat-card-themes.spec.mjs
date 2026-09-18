import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { listThemes } from "../../../ui/core/src/themes/index.js";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 0 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

for (const { id: themeId } of listThemes()) test(`${themeId}: filled cards remain readable in chat, MoA and mobile`, async ({ page }) => {
    const entries = [
        ["user.message", { content: "Inspect the runtime" }],
        ["assistant.message", { content: "The earlier inspection is complete." }],
        ["session.turn_completed", { resultType: "completed" }],
        ["user.message", { content: "Now check the deployment" }],
        ["assistant.message", { content: "I am checking the deployment and its configuration." }],
        ["subagent.started", { toolName: "task", toolCallId: "task-1", nativeAgentId: "agent-1", arguments: { description: "Inspect configuration", agent_type: "swarm-explore" } }],
        ["native.tool.execution_start", { toolName: "view", toolCallId: "native-read", parentToolCallId: "task-1", nativeAgentId: "agent-1", arguments: { path: "config.json" } }],
        ["tool.execution_start", { toolName: "view", toolCallId: "failed-read", arguments: { path: "missing.json" } }],
        ["tool.execution_complete", { toolName: "view", toolCallId: "failed-read", success: false, error: "File not found" }],
        ["tool.execution_start", { toolName: "view", toolCallId: "parent-read", arguments: { path: "README.md" } }],
    ];
    const events = entries.map(([eventType, data], i) => ({ sessionId, seq: i + 1, eventType, data, createdAt: Date.now() - 10000 + i * 100 }));
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { profileSettings: {
            themeId, touchScale: false, touchScaleMobile: false, moa: { version: 2, tree: { id: "chat", type: "chat", sessionId } },
        } } } });
        if (url.pathname.endsWith("/events")) return route.fulfill({ json: { ok: true, result: events.filter(e => e.seq > Number(url.searchParams.get("afterSeq") || 0)) } });
        return route.fallback();
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", themeId);
    for (const mode of ["chat", "MoA", "mobile"]) {
        if (mode === "MoA") await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
        if (mode === "mobile") {
            await page.getByRole("button", { name: "Workspace — sessions, chat and panels", exact: true }).click();
            await page.setViewportSize({ width: 390, height: 844 });
            await expect(page.locator(".ps-mobile-workspace")).toBeVisible();
        }
        const scope = page.locator(".ps-chat-panel:visible").first();
        const preview = scope.locator(".ps-assistant-preview:not(.is-final)");
        await expect(preview).toBeVisible();
        if (await preview.getAttribute("open") === null) await preview.locator(":scope > summary").click();
        await expect(scope.locator(".ps-native-task .ps-chat-call")).toBeVisible();
        await expect(scope.locator(".ps-activity-run-viewport")).toBeVisible();
        const samples = await scope.evaluate(panel => {
            // Resolve color-mix and alpha using the browser's color parser;
            // compare the painted surfaces, including inherited backgrounds.
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
            const painted = (element, color = "transparent") => {
                let result = rgba(color);
                for (let node = element; node; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    result = over(result, rgba(style.backgroundColor));
                    result[3] *= Number(style.opacity);
                }
                return over(result, [255, 255, 255, 1]);
            };
            const luminance = color => color.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
            const transcript = painted(panel.querySelector(".ps-scroll-panel"));
            const cards = [...panel.querySelectorAll(".ps-native-tasks, .ps-native-task, .ps-chat-call, .ps-activity-run-viewport, .ps-assistant-preview:not(.is-final) > .ps-assistant-preview-viewport")].map(node => {
                const color = painted(node);
                return { class: node.className, delta: Math.max(...color.slice(0, 3).map((v, i) => Math.abs(v - transcript[i]))) };
            });
            const labels = [...panel.querySelectorAll(".ps-native-tasks-title, .ps-native-task-title, .ps-native-task-scope, .ps-activity-run-latest, .ps-activity-run-status, .ps-activity-run-footer, .ps-chat-call-status, .ps-chat-call-tag, .ps-chat-call-summary .ps-system-notice-summary-text, .ps-assistant-preview-viewport .ps-line")].filter(node => node.getClientRects().length).map(node => {
                const fg = luminance(painted(node, getComputedStyle(node).color)), bg = luminance(painted(node));
                return { class: node.className, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
            });
            const finals = [...panel.querySelectorAll(".ps-assistant-preview.is-final > .ps-assistant-preview-viewport")].map(node => rgba(getComputedStyle(node).backgroundColor)[3]);
            return { cards, labels, finals };
        });
        for (const card of samples.cards) {
            expect(card.delta, `${mode} visible fill: ${card.class}`).toBeGreaterThanOrEqual(10);
            expect(card.delta, `${mode} subtle fill: ${card.class}`).toBeLessThanOrEqual(50);
        }
        for (const label of samples.labels) expect.soft(label.ratio, `${mode} readable ${label.class}`).toBeGreaterThanOrEqual(4.5);
        expect(samples.finals).toEqual([0]);
        expect(await scope.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`${themeId}-${mode}.png`) });
    }
});
