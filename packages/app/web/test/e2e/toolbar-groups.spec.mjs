// The toolbar's two clusters (proposal B, 2026-08-27).
//
//   left  : actions [new, filter] │ PANELS [canvas, diagnostics, expand]
//   right : MODE [workspace, budget, admin] │ theme · sign-out
//
// PANELS are things inside the workspace, so the cluster exists only in
// Workspace mode. MODE is exclusive. The labels are desktop-only, and the
// phone keeps its own view cycle with no admin console.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const NAMES = {
    newSession: /New session/i,
    filter: /Filter sessions/i,
    canvas: /Show canvas|Hide the canvas/i,
    diagnostics: /diagnostics/i,
    expand: /Expand the canvas|Restore the canvas/i,
    workspace: /^Workspace/i,
    budget: /Budget|Close budget/i,
    admin: /^Admin console$|^Settings$|^Close (admin console|settings)$/i,
    theme: /^Theme$/i,
};

function toolbarNames(page) {
    return page.evaluate(() => {
        const bar = document.querySelector(".ps-toolbar");
        return {
            labels: Array.from(bar.querySelectorAll(".ps-toolbar-group-label")).map((el) => el.textContent.trim()),
            left: Array.from(bar.querySelectorAll(".ps-toolbar-actions:not(.is-tools) button, .ps-toolbar-side.is-left button")).map((b) => b.getAttribute("aria-label") || b.title),
            right: Array.from(bar.querySelectorAll(".ps-toolbar-actions.is-tools button")).map((b) => b.getAttribute("aria-label") || b.title),
            active: Array.from(bar.querySelectorAll("button.is-active, button[aria-pressed='true']")).map((b) => b.getAttribute("aria-label") || b.title),
        };
    });
}

test.describe("desktop", () => {
    let stub;
    let base;
    test.beforeAll(async () => {
        stub = await startStubServer(0, { sessionCount: 3, admin: true });
        base = `http://127.0.0.1:${stub.port}`;
    });
    test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("actions and Panels on the left, Mode and theme on the right, both labelled", async ({ page }) => {
        await page.setViewportSize({ width: 1500, height: 900 });
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();
        const t = await toolbarNames(page);
        // No text labels, and the left cluster is one run: the only bar in
        // the toolbar sits on the right, between the modes and theme.
        expect(t.labels).toEqual([]);
        expect(await page.locator(".ps-toolbar .ps-toolbar-actions:not(.is-tools) .ps-toolbar-divider").count()).toBe(0);
        expect(await page.locator(".ps-toolbar .ps-toolbar-actions.is-tools .ps-toolbar-divider").count()).toBe(1);
        // The stub's session may open its canvas by itself, so slot 3 is
        // either face of the toggle.
        expect(t.left.length).toBe(4);
        expect(t.left[0]).toMatch(/^New session/);
        expect(t.left[1]).toBe("Filter sessions");
        expect(t.left[2]).toMatch(/^(Show canvas|Hide the canvas)$/);
        expect(t.left[3]).toMatch(/^(Show|Hide) diagnostics/);
        expect(t.right.map((n) => n.slice(0, 14))).toEqual(["Workspace — se", "Budget — provi", "Admin console", "Theme"]);
    });

    test("a fresh profile opens as sessions + chat only, even on a wide desktop with a canvas to show", async ({ page }) => {
        // The stub's profile is empty (nothing stored) and its sessions have
        // canvases. A first visit on a wide desktop used to open the canvas
        // column by itself; the default is now the two-column workspace, and
        // a column opens when the person opens it.
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();
        await page.locator(".ps-session-list-button").first().click();
        await page.waitForTimeout(800);
        await expect(page.locator(".ps-canvas-layer:not(.is-hidden)"), "no canvas column on load").toHaveCount(0);
        await expect(page.locator(".ps-workspace-column-host .ps-workspace-column:not(.is-artifact)"), "no diagnostics column on load").toHaveCount(0);
        await expect(page.getByRole("button", { name: "Show canvas" })).toBeVisible();
    });

    test("Budget and Admin are one mode at a time, and Panels leave with the workspace", async ({ page }) => {
        await page.setViewportSize({ width: 1500, height: 900 });
        await page.goto(base);
        await page.locator(".ps-session-list-button").first().waitFor();

        await page.getByRole("button", { name: NAMES.budget }).first().click();
        await page.waitForTimeout(300);
        let t = await toolbarNames(page);
        // The whole left cluster is the workspace's: new session, filter,
        // canvas, diagnostics. None of it applies to Budget or Admin.
        expect(t.left, "no workspace buttons in Budget mode").toEqual([]);

        // Admin from Budget: Budget closes, Admin opens — never both.
        await page.getByRole("button", { name: NAMES.admin }).first().click();
        await page.waitForTimeout(300);
        await expect(page.locator(".ps-admin-console__header h2")).toBeVisible();
        t = await toolbarNames(page);
        expect(t.right.some((n) => /^Close budget$/i.test(n)), "Budget is not also open").toBe(false);
        expect(t.right.some((n) => /^Close admin console$/i.test(n)), "Admin is the open mode").toBe(true);
        expect(t.left, "no workspace buttons in Admin mode").toEqual([]);
        // The console has no ✕ and no repeated principal: the Mode cluster is
        // the way out, and the header already names the signed-in person.
        await expect(page.locator(".ps-admin-console__header button")).toHaveCount(0);
        await expect(page.locator(".ps-admin-console__who")).toHaveCount(0);

        // Workspace is a destination: back, with the left cluster.
        await page.getByRole("button", { name: NAMES.workspace }).first().click();
        await page.waitForTimeout(300);
        await expect(page.locator(".ps-admin-console__header h2")).toHaveCount(0);
        t = await toolbarNames(page);
        expect(t.left.length).toBe(4);
        expect(t.left.some((n) => NAMES.diagnostics.test(n))).toBe(true);
    });
});

// The phone half lives in toolbar-groups-mobile.spec.mjs: Playwright only
// accepts a device `use` at the top of a file.
