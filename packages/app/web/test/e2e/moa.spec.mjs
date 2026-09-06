import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { normalizeMoa, encodeMoaShare } from "../../../ui/core/src/moa.js";

let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const chat = (i, id = `panel-${i}`) => ({ id, type: "chat", sessionId: sid(i) });
const split = (first, second, id = "split", ratio = 50) => ({ id, type: "split", direction: "row", ratio, first, second });
const layout = (tree, name = "Control room") => ({ name, tree });
const panel = (page, id) => page.locator(`[data-moa-panel="${id}"]`);

async function fixture(page, slots = [], hash = "") {
    let settings = { themeId: "terminal-green", moa: normalizeMoa({ slots }) };
    const sends = [], writes = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/**", async route => {
        const request = route.request(), url = new URL(request.url());
        const answer = result => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result }) });
        if (url.pathname.endsWith("/me/profile/settings")) {
            settings = structuredClone(request.postDataJSON().settings);
            writes.push(settings);
            return answer({ profileSettings: settings });
        }
        if (url.pathname.endsWith("/me/profile")) return answer({ isAdmin: false, profileSettings: settings });
        const send = /\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
        if (send) { sends.push({ sessionId: send[1], ...request.postDataJSON() }); return answer({ queued: true }); }
        return route.fallback();
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(base + hash);
    await expect(page.getByRole("button", { name: "Master of Agents", exact: true })).toBeEnabled();
    return { sends, writes, errors, settings: () => settings };
}

async function open(page) {
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Master of Agents" })).toBeVisible();
}

test("focus owns the sole composer, preserves drafts, and sends only to its session", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2)))]);
    await open(page);
    const a = panel(page, "panel-1"), b = panel(page, "panel-2");
    await expect(a.locator("textarea")).toBeVisible();
    await a.locator("textarea").fill("draft for first agent");
    await b.locator("header").first().click();
    await expect(b).toHaveClass(/is-focused/);
    await expect(page.locator(".ps-moa-workspace textarea")).toHaveCount(1);
    await b.locator("textarea").fill("message for second agent");
    await a.locator("header").first().click();
    await expect(a.locator("textarea")).toHaveValue("draft for first agent");
    await b.locator("header").first().click();
    await expect(b.locator("textarea")).toHaveValue("message for second agent");
    await b.locator("textarea").press("Enter");
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(sid(2));
    expect(f.sends[0].prompt).toContain("message for second agent");
    await a.locator("header").first().click();
    await expect(a.locator("textarea")).toHaveValue("draft for first agent");
    expect(f.errors).toEqual([]);
});

test("splitting creates a focused blank panel and right-click opens the familiar session list", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    await open(page);
    await panel(page, "panel-1").getByRole("button", { name: "Panel options" }).click();
    await page.getByRole("button", { name: "Split right", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    const blank = page.locator(".ps-moa-panel.is-focused");
    await expect(blank.getByRole("button", { name: "Choose session or canvas" })).toBeVisible();
    await expect(page.locator(".ps-moa-workspace textarea")).toHaveCount(0);
    await blank.locator(".ps-moa-empty").click({ button: "right" });
    await expect(page.getByRole("dialog", { name: "Sessions", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Find a session" }).fill("Session 2");
    await page.locator(".ps-moa-session-row").filter({ hasText: "Session 2" }).click();
    await page.getByRole("button", { name: "Use chat", exact: true }).click();
    await expect(page.locator(`.ps-moa-panel.is-focused[data-session-id="${sid(2)}"] textarea`)).toBeVisible();
    await expect.poll(() => f.settings().moa.slots[0].tree?.type).toBe("split");
    expect(f.errors).toEqual([]);
});

test("all five saved slots and resized proportions survive reload", async ({ page }) => {
    const slots = Array.from({ length: 5 }, (_, i) => layout(i === 0 ? split(chat(1), chat(2)) : chat(i % 4, `saved-${i}`), `Room ${i + 1}`));
    const f = await fixture(page, slots);
    await open(page);
    const seam = page.getByRole("separator", { name: "Resize MoA panels" });
    await seam.focus();
    await seam.press("ArrowRight");
    await seam.press("ArrowRight");
    await expect(seam).toHaveAttribute("aria-valuenow", "54");
    await expect.poll(() => f.settings().moa.slots[0].tree.ratio).toBe(54);
    await page.getByRole("button", { name: "MoA 5: Room 5", exact: true }).click();
    await page.getByRole("textbox", { name: "MoA name" }).fill("");
    await page.getByRole("textbox", { name: "MoA name" }).pressSequentially("Night shift");
    await page.getByRole("textbox", { name: "MoA name" }).press("Enter");
    await expect.poll(() => f.settings().moa.slots[4].name).toBe("Night shift");
    await page.reload();
    await open(page);
    await expect(page.getByRole("textbox", { name: "MoA name" })).toHaveValue("Night shift");
    for (let i = 0; i < 5; i++) {
        const name = i === 4 ? "Night shift" : `Room ${i + 1}`;
        await page.getByRole("button", { name: `MoA ${i + 1}: ${name}`, exact: true }).click();
        await expect(page.getByRole("textbox", { name: "MoA name" })).toHaveValue(name);
        await expect(page.locator("[data-moa-panel]")).toHaveCount(i === 0 ? 2 : 1);
    }
    await page.getByRole("button", { name: "MoA 1: Room 1", exact: true }).click();
    await expect(page.getByRole("separator", { name: "Resize MoA panels" })).toHaveAttribute("aria-valuenow", "54");
    expect(f.errors).toEqual([]);
});

test("mobile resize suspends MoA and preserves layouts without automatically reopening", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    await open(page);
    await expect(panel(page, "panel-1").locator("textarea")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Master of Agents", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
    await open(page);
    await expect(panel(page, "panel-1").locator("textarea")).toBeVisible();
    expect(f.settings().moa.slots[0].tree.sessionId).toBe(sid(1));
    expect(f.errors).toEqual([]);
});

test("malformed shared links report an error and cannot modify saved layouts", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))], "#moa=not-a-layout");
    const dialog = page.getByRole("dialog", { name: "Invalid MoA link" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("Invalid");
    await expect(dialog.getByRole("button", { name: "Copy to my slot" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    expect(f.settings().moa.slots[0].tree).toEqual(chat(1));
    expect(f.errors).toEqual([]);
});

test("importing an occupied slot requires explicit replacement and copies independently", async ({ page }) => {
    const source = layout(split(chat(2), { id: "shared-empty", type: "empty" }), "Shared operations");
    const encoded = encodeMoaShare(source);
    const f = await fixture(page, [layout(chat(1), "Existing operations")], `#moa=${encoded}`);
    const dialog = page.getByRole("dialog", { name: "Shared MoA · Shared operations", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Destination MoA slot" }).selectOption("0");
    await dialog.getByRole("button", { name: "Copy to my slot", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Existing operations");
    expect(f.settings().moa.slots[0].tree).toEqual(chat(1));
    await dialog.getByRole("button", { name: "Replace arrangement", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "MoA name" })).toHaveValue("Shared operations");
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await page.getByRole("textbox", { name: "MoA name" }).fill("My operations");
    await page.getByRole("textbox", { name: "MoA name" }).press("Enter");
    await expect.poll(() => f.settings().moa.slots[0].name).toBe("My operations");
    expect(source.name).toBe("Shared operations");
    expect(new URL(page.url()).hash).toBe("");
    expect(f.errors).toEqual([]);
});

test("canvas focus hides every composer and the pinned slot loads its own document", async ({ page }) => {
    const canvasNode = { id: "canvas-panel", type: "canvas", sessionId: sid(1), slot: 2 };
    const f = await fixture(page, [layout(split(chat(1), canvasNode))]);
    const downloads = [];
    await page.route("**/api/v1/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: [1, 2].map(slot => ({ seq: slot, eventType: "session.canvas_updated", data: { slot, rev: 1, sizeBytes: 128, name: `Display ${slot}` } })) }) });
        }
        if (url.pathname.includes("/artifacts/") && /canvas(?:2)?\.html/.test(url.pathname)) {
            downloads.push(url.pathname);
            return route.fulfill({ contentType: "text/html", body: '<!doctype html><button id="inside">Canvas two</button>' });
        }
        return route.fallback();
    });
    await open(page);
    await expect(panel(page, "panel-1").locator("textarea")).toBeVisible();
    await panel(page, "panel-1").locator("textarea").fill("draft while canvas open");
    const c = panel(page, "canvas-panel");
    await expect(c.locator("iframe").first()).toBeAttached();
    await expect.poll(() => downloads.some(p => p.includes("canvas2.html"))).toBe(true);
    await c.locator("iframe").first().contentFrame().getByRole("button", { name: "Canvas two" }).click();
    await expect(c).toHaveClass(/is-focused/);
    await expect(page.locator(".ps-moa-workspace textarea")).toHaveCount(0);
    await panel(page, "panel-1").locator("header").first().click();
    await expect(panel(page, "panel-1").locator("textarea")).toHaveValue("draft while canvas open");
    expect(f.sends).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("an inaccessible session displays a placeholder and cannot expose a composer or send", async ({ page }) => {
    const f = await fixture(page, [layout(chat(3))]);
    await page.route(`**/api/v1/sessions/${sid(3)}`, route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } }) }));
    await open(page);
    const denied = panel(page, "panel-3");
    await expect(denied.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(denied).toContainText(/unavailable|Could not open/);
    await expect(denied.locator("textarea")).toHaveCount(0);
    await page.keyboard.press("Enter");
    expect(f.sends).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("removing a panel during delayed startup cannot resurrect its subscription or composer", async ({ page }) => {
    const f = await fixture(page, [layout(chat(2))]);
    let release, requested = false;
    const gate = new Promise(resolve => { release = resolve; });
    const lateRequests = [];
    await page.route(`**/api/v1/sessions/${sid(2)}`, async route => {
        requested = true;
        await gate;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: { sessionId: sid(2), title: "Delayed session", status: "idle" } }) });
    });
    await open(page);
    await expect.poll(() => requested).toBe(true);
    await panel(page, "panel-2").getByRole("button", { name: "Panel options" }).click();
    await page.getByRole("button", { name: "Remove panel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add first MoA panel" })).toBeVisible();
    page.on("request", request => { if (request.url().includes(sid(2)) && /\/(events|events-before|canvas-live)(\?|$)/.test(request.url())) lateRequests.push(request.url()); });
    release();
    // Give the deliberately delayed response time to reach its continuation;
    // there must be no history load/subscription setup after cancellation.
    await page.waitForTimeout(300);
    await expect(page.locator("[data-moa-panel]")).toHaveCount(0);
    await expect(page.locator(".ps-moa-workspace textarea")).toHaveCount(0);
    expect(lateRequests).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("a failed profile save survives the next server poll and explicit retry persists it", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    await open(page);
    // Allow the ordinary initial selection write to settle before injecting a
    // failed layout save, so the failure belongs to the user's actual edit.
    await page.waitForTimeout(600);
    let fail = true, polls = 0;
    await page.route("**/api/v1/me/profile/settings", route => fail
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "UNAVAILABLE", message: "Profile unavailable" } }) })
        : route.fallback());
    page.on("response", response => { if (new URL(response.url()).pathname === "/api/v1/me/profile") polls++; });
    const name = page.getByRole("textbox", { name: "MoA name" });
    await name.fill("Unsaved incident desk");
    await name.press("Enter");
    const retry = page.getByRole("button", { name: "Save failed · Retry", exact: true });
    await expect(retry).toBeVisible();
    expect(f.settings().moa.slots[0].name).toBe("Control room");
    await expect.poll(() => polls, { timeout: 7000 }).toBeGreaterThan(0);
    await page.waitForTimeout(100); // the completed poll's React effects have run
    await expect(name).toHaveValue("Unsaved incident desk");
    await expect(retry).toBeVisible();
    fail = false;
    await retry.click();
    await expect.poll(() => f.settings().moa.slots[0].name).toBe("Unsaved incident desk");
    await expect(retry).toHaveCount(0);
    await page.reload();
    await open(page);
    await expect(name).toHaveValue("Unsaved incident desk");
    expect(f.errors).toEqual([]);
});

test("slow profile writes serialize rapid rename and split edits without rolling back the newest layout", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    await open(page);
    await page.waitForTimeout(600);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const started = [];
    await page.route("**/api/v1/me/profile/settings", async route => {
        started.push(structuredClone(route.request().postDataJSON().settings));
        if (started.length === 1) await gate;
        return route.fallback();
    });
    const name = page.getByRole("textbox", { name: "MoA name" });
    await name.fill("First pending name");
    await name.press("Enter");
    await expect.poll(() => started.length).toBe(1);
    await name.fill("Latest operator desk");
    await name.press("Enter");
    await panel(page, "panel-1").getByRole("button", { name: "Panel options" }).click();
    await page.getByRole("button", { name: "Split below", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await page.waitForTimeout(650); // the second debounce expires while the first request is held
    const concurrentWrites = started.length;
    release();
    expect(concurrentWrites, "a stale request cannot finish after a newer request").toBe(1);
    await expect.poll(() => f.settings().moa.slots[0].name).toBe("Latest operator desk");
    await expect.poll(() => f.settings().moa.slots[0].tree.type).toBe("split");
    expect(f.settings().moa.slots[0].tree.direction).toBe("column");
    expect(started.at(-1).moa.slots[0].name).toBe("Latest operator desk");
    await page.reload();
    await open(page);
    await expect(name).toHaveValue("Latest operator desk");
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    expect(f.errors).toEqual([]);
});

test("replacing a session hides its old composer throughout delayed replacement and cannot reuse its draft", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    await open(page);
    const target = panel(page, "panel-1");
    await expect(target.locator("textarea")).toBeVisible();
    await target.locator("textarea").fill("private draft for original session");
    let release, requested = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/v1/sessions/${sid(2)}`, async route => {
        requested = true;
        await gate;
        return route.fallback();
    });
    await target.getByRole("button", { name: "Panel options" }).click();
    await page.getByRole("button", { name: "Replace session or canvas…", exact: true }).click();
    await page.getByRole("textbox", { name: "Find a session" }).fill("Session 2");
    await page.locator(".ps-moa-session-row").filter({ hasText: "Session 2" }).click();
    await page.getByRole("button", { name: "Use chat", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(target).toHaveAttribute("data-session-id", sid(2));
    await expect(target.locator("textarea")).toHaveCount(0);
    await expect(target).not.toContainText("private draft for original session");
    release();
    await expect(target.locator("textarea")).toBeVisible();
    await expect(target.locator("textarea")).toHaveValue("");
    await target.locator("textarea").fill("new target only");
    await target.locator("textarea").press("Enter");
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(sid(2));
    expect(f.sends[0].prompt).toBe("new target only");
    expect(f.errors).toEqual([]);
});

test("zen Escape and zoom back restore the saved arrangement and chat draft", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2), "split", 63))]);
    await open(page);
    const a = panel(page, "panel-1");
    await expect(a.locator("textarea")).toBeVisible();
    await a.locator("textarea").fill("draft before zoom");
    await page.getByRole("button", { name: "Zen ↗", exact: true }).click();
    await expect(page.locator(".ps-moa-workspace")).toHaveClass(/is-zen/);
    await expect(page.getByRole("button", { name: "MoA · Exit zen ↙", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ps-moa-workspace")).not.toHaveClass(/is-zen/);
    await a.getByRole("button", { name: "Open panel in main view", exact: true }).click();
    await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
    const sessionRow = page.locator(".ps-session-list-button").first();
    await expect(sessionRow).toBeVisible();
    await expect.poll(async () => (await sessionRow.boundingBox())?.width || 0).toBeGreaterThan(150);
    await page.getByRole("button", { name: "← Back to MoA", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await expect(page.getByRole("separator", { name: "Resize MoA panels" })).toHaveAttribute("aria-valuenow", "63");
    await expect(a.locator("textarea")).toHaveValue("draft before zoom");
    expect(f.errors).toEqual([]);
});
