// The toolbar on a phone, after the desktop regrouping (proposal B).
//
// The phone keeps its own row: actions left, the Main/Diagnostics view cycle
// right. None of the desktop cluster labels ("Panels", "Mode"), no Workspace
// or Expand button, and — by design — no admin console.
import { test, expect, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ ...devices["iPhone 14 Pro"] });

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 3, admin: true });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("no cluster labels, no admin console, no workspace/expand buttons", async ({ page }) => {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    const t = await page.evaluate(() => {
        const bar = document.querySelector(".ps-toolbar");
        return {
            labels: Array.from(bar.querySelectorAll(".ps-toolbar-group-label")).map((el) => el.textContent.trim()),
            names: Array.from(bar.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") || b.title || ""),
            text: bar.textContent,
        };
    });
    expect(t.labels).toEqual([]);
    expect(t.text).not.toMatch(/Panels|Mode/);
    expect(t.names.some((n) => /^Admin console$|^Settings$|^Close (admin console|settings)$/i.test(n)), "admin stays off the phone").toBe(false);
    expect(t.names.some((n) => /^Workspace/i.test(n) || /Expand the canvas|Restore the canvas/i.test(n)), "desktop-only mode/expand buttons").toBe(false);
    // What the phone DOES keep.
    expect(t.names.some((n) => /New session/i.test(n))).toBe(true);
    expect(t.names.some((n) => /Budget/i.test(n)), "budget reflows to a phone and stays").toBe(true);
    expect(t.names.some((n) => /^Main — /i.test(n)), "the Main view cycle").toBe(true);
});
