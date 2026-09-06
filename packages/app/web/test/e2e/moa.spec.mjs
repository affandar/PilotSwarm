import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { normalizeMoa } from "../../../ui/core/src/moa.js";

let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const chat = (i, id = `panel-${i}`) => ({ id, type: "chat", sessionId: sid(i) });
const split = (first, second, id = "split", ratio = 50) => ({ id, type: "split", direction: "row", ratio, first, second });
const layout = (tree, name = "Control room") => ({ name, tree });
const composer = page => page.locator(".ps-moa-composer-strip textarea");
const panel = (page, id) => page.locator(`[data-moa-panel="${id}"]`);

async function fixture(page, slots = [], hash = "") {
    let settings = { themeId: "terminal-green", moa: Array.isArray(slots) ? normalizeMoa({ slots }) : slots };
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
    await expect(composer(page)).toBeVisible();
    await expect(page.locator("[data-moa-panel] textarea")).toHaveCount(0);
    const strip = await page.locator(".ps-moa-composer-strip").boundingBox();
    expect(strip.width).toBeGreaterThan(1500);
    expect(strip.y + strip.height).toBeGreaterThan(980);
    await composer(page).fill("draft for first agent");
    await b.locator("header").first().click();
    await expect(b).toHaveClass(/is-focused/);
    await expect(page.locator(".ps-moa-workspace textarea")).toHaveCount(1);
    await composer(page).fill("message for second agent");
    await a.locator("header").first().click();
    await expect(composer(page)).toHaveValue("draft for first agent");
    await b.locator("header").first().click();
    await expect(composer(page)).toHaveValue("message for second agent");
    await composer(page).press("Enter");
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(sid(2));
    expect(f.sends[0].prompt).toContain("message for second agent");
    await expect(b.locator(".ps-panel-bottom-sticky")).toContainText("Working");
    await expect(page.locator(".ps-moa-composer-strip .ps-panel-bottom-sticky")).toHaveCount(0);
    await a.locator("header").first().click();
    await expect(composer(page)).toHaveValue("draft for first agent");
    expect(f.errors).toEqual([]);
});

test("splitting creates a focused blank panel and right-click opens the familiar session list", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    await open(page);
    await panel(page, "panel-1").getByRole("button", { name: "Session control panel" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Split right", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    const blank = page.locator(".ps-moa-panel.is-focused");
    await expect(blank.getByRole("button", { name: "Choose session or canvas" })).toBeVisible();
    await expect(page.locator(".ps-moa-workspace textarea")).toHaveCount(0);
    await blank.focus();
    await page.keyboard.press("Tab");
    await expect(composer(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(blank).toBeFocused();
    await blank.locator(".ps-moa-empty").click({ button: "right" });
    await expect(page.getByRole("dialog", { name: "Sessions", exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "Sessions", exact: true }).locator(`.ps-session-list-button[data-session-id="${sid(2)}"]`).click();
    await page.getByRole("button", { name: "Use chat", exact: true }).click();
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => f.settings().moa.tree?.type).toBe("split");
    expect(f.errors).toEqual([]);
});

test("the personal layout and resized proportions survive reload", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2)))]);
    await open(page);
    const seam = page.getByRole("separator", { name: "Resize MoA panels" });
    await seam.focus(); await seam.press("ArrowRight"); await seam.press("ArrowRight");
    await expect.poll(() => f.settings().moa.tree.ratio).toBe(54);
    await page.reload(); await open(page);
    await expect(page.getByRole("separator", { name: "Resize MoA panels" })).toHaveAttribute("aria-valuenow", "54");
    await expect(page.getByRole("tab")).toHaveCount(0);
    expect(f.settings().moa).toMatchObject({ version: 2, tree: split(chat(1), chat(2), "split", 54) });
    expect(f.settings().moa.aspectRatio).toBeGreaterThan(1);
});

test("mobile resize presents one panel and restores desktop geometry", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2)))]);
    await open(page);
    await expect(composer(page)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".ps-moa-workspace")).toBeVisible();
    await expect(page.locator("[data-moa-panel]:visible")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Open panel map" })).toBeVisible();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(page.locator("[data-moa-panel]:visible")).toHaveCount(2);
    await expect(composer(page)).toBeVisible();
    expect(f.settings().moa.tree.type).toBe("split");
    expect(f.errors).toEqual([]);
});

test("legacy MoA links and stashed imports cannot replace a personal layout", async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem("pilotswarm.moa.shared", "legacy-import"));
    const wire = Buffer.from(JSON.stringify({ version: 1, ...layout(chat(3)) })).toString("base64url");
    const f = await fixture(page, [layout(chat(1))], `/#moa=${wire}`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await open(page);
    await expect(panel(page, "panel-1")).toBeVisible();
    await expect(page.getByRole("button", { name: /Share|Copy.*link|Add MoA tab|Rename MoA/i })).toHaveCount(0);
    expect(f.settings().moa.tree).toEqual(chat(1));
    expect(await page.evaluate(() => sessionStorage.getItem("pilotswarm.moa.shared"))).toBeNull();
    expect(f.errors).toEqual([]);
});

test("canvas focus binds the shared composer and the pinned slot loads its own document", async ({ page }) => {
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
            return route.fulfill({ contentType: "text/html", body: '<!doctype html><button id="inside">Canvas two</button><button id="next">Next native</button>' });
        }
        return route.fallback();
    });
    await open(page);
    await expect(composer(page)).toBeVisible();
    await composer(page).fill("draft while canvas open");
    const c = panel(page, "canvas-panel");
    await expect(c.locator("iframe").first()).toBeAttached();
    await expect.poll(() => downloads.some(p => p.includes("canvas2.html"))).toBe(true);
    const inside = c.locator("iframe").first().contentFrame().getByRole("button", { name: "Canvas two" });
    await expect.poll(() => inside.evaluate(el => el.ownerDocument.compatMode)).toBe("CSS1Compat");
    await page.evaluate(() => new Promise(resolve => {
        window.postMessage({ type: "moa-panel-key", key: "Tab" }, "*");
        setTimeout(resolve, 50);
    }));
    await expect(panel(page, "panel-1")).toHaveClass(/is-focused/);
    await inside.click();
    await expect(c).toHaveClass(/is-focused/);
    await expect(composer(page)).toBeVisible();
    await expect(composer(page)).toHaveValue("");
    await inside.press("Control+ArrowLeft");
    await expect(c).toHaveClass(/is-focused/);
    await inside.press("Tab");
    await expect(panel(page, "panel-1")).toHaveClass(/is-focused/);
    await expect(composer(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(c).toHaveClass(/is-focused/);
    await expect(composer(page)).toBeFocused();
    await page.getByRole("button", { name: "Enter zen", exact: true }).click();
    await inside.click();
    await page.evaluate(() => new Promise(resolve => {
        window.postMessage({ type: "moa-panel-key", key: "Escape" }, "*");
        setTimeout(resolve, 50);
    }));
    await expect(page.locator(".ps-moa-workspace")).toHaveClass(/is-zen/);
    await inside.press("Escape");
    await expect(page.locator(".ps-moa-workspace")).not.toHaveClass(/is-zen/);
    await panel(page, "panel-1").locator("header").first().click();
    await expect(composer(page)).toHaveValue("draft while canvas open");
    await page.getByRole("button", { name: /^Workspace/ }).click();
    await page.locator(`.ps-session-list-button[data-session-id="${sid(1)}"]`).click();
    const showCanvas = page.getByRole("button", { name: "Show canvas", exact: true });
    if (await showCanvas.count()) await showCanvas.click();
    const nativeFrame = page.locator(".ps-canvas-layer:not(.is-hidden) iframe").first().contentFrame();
    const nativeButton = nativeFrame.getByRole("button", { name: "Canvas two", exact: true });
    await expect(nativeButton).toBeVisible();
    expect(await nativeButton.evaluate(el => el.ownerDocument.compatMode)).toBe("CSS1Compat");
    await nativeButton.click();
    await nativeButton.press("Tab");
    await expect(nativeFrame.getByRole("button", { name: "Next native", exact: true })).toBeFocused();
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
    await panel(page, "panel-2").getByRole("button", { name: "Session control panel" }).click();
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
    await panel(page, "panel-1").getByRole("button", { name: "Split right", exact: true }).click();
    const retry = page.getByRole("button", { name: "Save failed · Retry", exact: true });
    await expect(retry).toBeVisible();
    expect(f.settings().moa.tree.type).toBe("chat");
    await expect.poll(() => polls, { timeout: 7000 }).toBeGreaterThan(0);
    await page.waitForTimeout(100); // the completed poll's React effects have run
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await expect(retry).toBeVisible();
    fail = false;
    await retry.click();
    await expect.poll(() => f.settings().moa.tree.type).toBe("split");
    await expect(retry).toHaveCount(0);
    await page.reload();
    await open(page);
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    expect(f.errors).toEqual([]);
});

test("slow profile writes serialize rapid split edits without rolling back the newest layout", async ({ page }) => {
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
    await panel(page, "panel-1").getByRole("button", { name: "Split right", exact: true }).click();
    await expect.poll(() => started.length).toBe(1);
    await panel(page, "panel-1").locator("header").first().click();
    await panel(page, "panel-1").getByRole("button", { name: "Session control panel" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Split below", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(3);
    await page.waitForTimeout(650); // the second debounce expires while the first request is held
    const concurrentWrites = started.length;
    release();
    expect(concurrentWrites, "a stale request cannot finish after a newer request").toBe(1);
    await expect.poll(() => f.settings().moa.tree.type).toBe("split");
    expect(f.settings().moa.tree.first.direction).toBe("column");
    expect(started.at(-1).moa.tree.first.direction).toBe("column");
    await page.reload();
    await open(page);
    await expect(page.locator("[data-moa-panel]")).toHaveCount(3);
    expect(f.errors).toEqual([]);
});

test("replacing a session hides its old composer throughout delayed replacement and cannot reuse its draft", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    await open(page);
    const target = panel(page, "panel-1");
    await expect(composer(page)).toBeVisible();
    await composer(page).fill("private draft for original session");
    let release, requested = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/v1/sessions/${sid(2)}`, async route => {
        requested = true;
        await gate;
        return route.fallback();
    });
    await target.getByRole("button", { name: "Session control panel" }).click();
    await page.getByRole("button", { name: "Replace session or canvas…", exact: true }).click();
    await page.getByRole("dialog", { name: "Sessions", exact: true }).locator(`.ps-session-list-button[data-session-id="${sid(2)}"]`).click();
    await page.getByRole("button", { name: "Use chat", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(target).toHaveAttribute("data-session-id", sid(2));
    await expect(composer(page)).toHaveCount(0);
    await expect(target).not.toContainText("private draft for original session");
    release();
    await expect(composer(page)).toBeVisible();
    await expect(composer(page)).toHaveValue("");
    await composer(page).fill("new target only");
    await composer(page).press("Enter");
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(sid(2));
    expect(f.sends[0].prompt).toBe("new target only");
    expect(f.errors).toEqual([]);
});

test("zen Escape and zoom back restore the saved arrangement and chat draft", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2), "split", 63))]);
    await open(page);
    const a = panel(page, "panel-1");
    await expect(composer(page)).toBeVisible();
    await composer(page).fill("draft before zoom");
    await page.getByRole("button", { name: "Enter zen", exact: true }).click();
    await expect(page.locator(".ps-moa-workspace")).toHaveClass(/is-zen/);
    await expect(page.getByRole("button", { name: "Exit zen", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ps-moa-workspace")).not.toHaveClass(/is-zen/);
    await a.getByRole("button", { name: "Open panel in main view", exact: true }).click();
    await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
    const sessionRow = page.locator(".ps-session-list-button").first();
    await expect(sessionRow).toBeVisible();
    await expect.poll(async () => (await sessionRow.boundingBox())?.width || 0).toBeGreaterThan(150);
    await page.getByRole("button", { name: "Back to MoA — Master of Agents", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await expect(page.getByRole("separator", { name: "Resize MoA panels" })).toHaveAttribute("aria-valuenow", "63");
    await expect(composer(page)).toHaveValue("draft before zoom");
    expect(f.errors).toEqual([]);
});

test("one personal workspace migrates a blank active tab and has no dashboard controls", async ({ page }) => {
    const f = await fixture(page, { version: 1, activeSlot: 3, tabCount: 5, slots: [layout(split(chat(1), chat(2))), layout(chat(3)), null, layout(null), null] });
    await open(page);
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Add MoA tab|Rename MoA|Share|Copy.*link/i })).toHaveCount(0);
    for (const width of [1600, 1024, 921]) {
        await page.setViewportSize({ width, height: 1000 });
        const header = await page.locator(".portal-header").boundingBox();
        const grid = await page.locator(".ps-moa-layout").boundingBox();
        expect(header.height).toBeLessThan(95);
        expect(grid.y - header.y - header.height).toBeLessThan(20);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.getByRole("button", { name: "Enter zen", exact: true })).toBeInViewport();
    }
    await panel(page, "panel-1").getByRole("button", { name: "Split right", exact: true }).click();
    await expect.poll(() => f.settings().moa.version).toBe(2);
    expect(Object.keys(f.settings().moa).sort()).toEqual(["aspectRatio", "tree", "version"]);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.reload(); await open(page);
    await expect(page.locator("[data-moa-panel]")).toHaveCount(3);
});

test("Tab and Shift+Tab cycle panels clockwise and reverse with the composer automatically focused", async ({ page }) => {
    const left = { ...split(chat(0, "tl"), chat(1, "bl"), "left"), direction: "column" };
    const right = { ...split(chat(2, "tr"), chat(3, "br"), "right"), direction: "column" };
    const f = await fixture(page, [layout(split(left, right))]);
    await open(page);
    await expect(composer(page)).toBeFocused();
    await composer(page).fill("clockwise draft");
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Control+ArrowLeft", "Control+ArrowRight"]) {
        await page.keyboard.press(key);
        await expect(panel(page, "tl")).toHaveClass(/is-focused/);
        await expect(composer(page)).toBeFocused();
    }
    for (const target of ["tr", "br", "bl", "tl"]) {
        await page.keyboard.press("Tab");
        await expect(panel(page, target)).toHaveClass(/is-focused/);
        await expect(composer(page)).toBeFocused();
    }
    await expect(composer(page)).toHaveValue("clockwise draft");
    for (const target of ["bl", "br", "tr", "tl"]) {
        await page.keyboard.press("Shift+Tab");
        await expect(panel(page, target)).toHaveClass(/is-focused/);
        await expect(composer(page)).toBeFocused();
    }
    await panel(page, "br").locator("header").first().click();
    await expect(composer(page)).toBeFocused();
    await panel(page, "br").focus();
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        await page.keyboard.press(key);
        await expect(panel(page, "br")).toHaveClass(/is-focused/);
    }
    await page.getByRole("button", { name: "Enter zen", exact: true }).click();
    await composer(page).focus();
    await page.keyboard.press("Tab");
    await expect(panel(page, "bl")).toHaveClass(/is-focused/);
    await expect(composer(page)).toBeFocused();
    expect(f.sends).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("toolbar and session-picker Tab navigation never cycles panels behind them", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2)))]);
    await open(page);
    await expect(composer(page)).toBeVisible();
    await page.getByRole("button", { name: "Clear MoA layout", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(panel(page, "panel-1")).toHaveClass(/is-focused/);
    await panel(page, "panel-1").getByRole("button", { name: "Session control panel" }).click();
    await page.getByRole("button", { name: "Replace session or canvas…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sessions", exact: true });
    await expect(dialog.locator(".ps-session-list-button").first()).toBeVisible();
    await expect(dialog.locator(".ps-session-list-button")).toHaveCount(4);
    for (let i = 0; i < 6; i++) {
        await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
        await expect(panel(page, "panel-1")).toHaveClass(/is-focused/);
    }
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    expect(f.errors).toEqual([]);
});

test("MoA stays in the workspace/budget/admin mode cluster and those modes remain usable outside zen", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    const launcher = page.getByRole("button", { name: "Master of Agents", exact: true });
    const workspace = page.getByRole("button", { name: /^Workspace/ });
    const budget = page.getByRole("button", { name: /^Budget|^Close budget$/ });
    const admin = page.getByRole("button", { name: /^(Admin console|Settings|Close admin console|Close settings)$/ });
    await expect(launcher.locator("xpath=ancestor::*[contains(@class,'ps-toolbar-actions')][1]")).toHaveClass(/is-tools/);
    await open(page);
    for (const button of [launcher, workspace, budget, admin]) await expect(button).toBeVisible();
    const positions = await Promise.all([launcher, workspace, budget, admin].map(button => button.boundingBox()));
    expect(Math.max(...positions.map(b => b.y)) - Math.min(...positions.map(b => b.y))).toBeLessThan(10);
    expect(positions[1].x + positions[1].width).toBeLessThanOrEqual(positions[0].x);
    expect(positions[0].x + positions[0].width).toBeLessThanOrEqual(positions[2].x);
    await budget.click();
    await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close budget", exact: true })).toBeVisible();
    await launcher.click();
    await expect(page.locator(".ps-moa-workspace")).toBeVisible();
    await admin.click();
    await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
    await expect(page.locator(".ps-admin-console__header h2")).toBeVisible();
    await launcher.click();
    await expect(page.locator(".ps-moa-workspace")).toBeVisible();
    await workspace.click();
    await expect(page.locator(".ps-moa-workspace")).toHaveCount(0);
    await expect(page.locator(".ps-session-list-button").first()).toBeVisible();
    await launcher.click();
    await page.getByRole("button", { name: "Enter zen", exact: true }).click();
    for (const button of [launcher, workspace, budget, admin]) await expect(button).not.toBeVisible();
    await page.keyboard.press("Escape");
    for (const button of [launcher, workspace, budget, admin]) await expect(button).toBeVisible();
    expect(f.errors).toEqual([]);
});


test("icon actions clear only the current layout after confirmation and persist the blank screen", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2)), "Operations"), layout(chat(3), "Keep me")]);
    const destructive = [];
    page.on("request", request => {
        if (request.method() !== "GET" && /\/sessions\//.test(request.url())) destructive.push(request.url());
    });
    await open(page);
    for (const name of ["Clear MoA layout", "Enter zen"]) {
        const button = page.getByRole("button", { name, exact: true });
        await expect(button).toHaveText("");
        await expect(button).toHaveAttribute("title", name);
        await expect(button.locator("svg")).toBeVisible();
    }
    await page.getByRole("button", { name: "Clear MoA layout", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Clear MoA layout", exact: true });
    await expect(dialog).toContainText("Your sessions and canvases stay intact");
    await page.getByRole("button", { name: "Cancel clear", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await page.getByRole("button", { name: "Clear MoA layout", exact: true }).click();
    await page.getByRole("button", { name: "Confirm clear layout", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add first MoA panel", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear MoA layout", exact: true })).toBeDisabled();
    await expect.poll(() => f.settings().moa.tree).toBe(null);
    expect(destructive).toEqual([]);
    await page.reload();
    await open(page);
    await expect(page.getByRole("button", { name: "Add first MoA panel", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Enter zen", exact: true }).click();
    const exit = page.getByRole("button", { name: "Exit zen", exact: true });
    await expect(exit).toHaveText("");
    await exit.click();
    await expect(page.getByRole("navigation", { name: "Master of Agents" })).toBeVisible();
    expect(f.errors).toEqual([]);
});

async function mockCreation(page, { fail = false } = {}) {
    const freshId = "99999999-2222-3333-4444-555555555555";
    const creates = [];
    await page.route("**/api/v1/**", async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        const answer = result => route.fulfill({ json: { ok: true, result } });
        if (path.endsWith("/models")) return answer([{ providerId: "test", modelName: "test-model", qualifiedName: "test:test-model" }]);
        if (path.endsWith("/providers")) return answer({ providers: [{ name: "test", typeId: "test", class: "shared", hasCredential: true, usableByMe: true }] });
        if (path.endsWith("/providers/status")) return answer({ providers: [] });
        if (path.endsWith("/defaults")) return answer({});
        if (path.endsWith("/sessions") && req.method() === "POST") {
            creates.push(req.postDataJSON());
            return fail ? route.fulfill({ status: 500, json: { ok: false, error: { message: "Creation failed in test" } } }) : answer({ sessionId: freshId });
        }
        if (path.endsWith(`/sessions/${freshId}`)) return answer({ sessionId: freshId, title: "Fresh MoA session", status: "idle", events: [], messages: [] });
        return route.fallback();
    });
    return { freshId, creates };
}

test("create from the picker uses the standard dialog and binds only its target panel", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), { id: "new", type: "empty" }))]);
    const original = await page.locator(".ps-session-list-button.is-selected").getAttribute("data-session-id");
    const { freshId, creates } = await mockCreation(page);
    await open(page);
    await panel(page, "new").getByRole("button", { name: "Choose session or canvas" }).click();
    const picker = page.getByRole("dialog", { name: "Sessions", exact: true });
    await expect(picker.getByRole("button", { name: /pin/i })).toHaveCount(0);
    const create = picker.getByRole("button", { name: "Create New Session", exact: true });
    await expect(create).toHaveText("");
    await expect(create.locator("svg line")).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath("moa-session-picker.png") });
    await create.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Select model for new session", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(panel(page, "new")).toHaveAttribute("data-session-id", freshId);
    await expect(panel(page, "new")).toContainText("Fresh MoA session");
    await expect(composer(page)).toBeVisible();
    await expect(page.locator(".ps-moa-composer-strip")).toHaveAttribute("data-session-id", freshId);
    await expect(panel(page, "panel-1")).toHaveAttribute("data-session-id", sid(1));
    expect(creates).toHaveLength(1);
    await composer(page).fill("Prompt for the newly created session");
    await composer(page).press("Enter");
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(freshId);
    await page.getByRole("button", { name: /^Workspace/ }).click();
    await expect(page.locator(".ps-session-list-button.is-selected")).toHaveAttribute("data-session-id", original);
    expect(f.errors).toEqual([]);
});

test("cancelling or failing creation returns to the picker without replacing an existing panel", async ({ page }) => {
    const f = await fixture(page, [layout(chat(1))]);
    const { creates } = await mockCreation(page, { fail: true });
    await open(page);
    await panel(page, "panel-1").getByRole("button", { name: "Session control panel" }).click();
    await page.getByRole("button", { name: "Replace session or canvas…" }).click();
    await page.getByRole("button", { name: "Create New Session", exact: true }).click();
    await expect(page.getByText("Select model for new session", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Sessions", exact: true })).toBeVisible();
    expect(creates).toHaveLength(0);
    await page.getByRole("button", { name: "Create New Session", exact: true }).click();
    await expect(page.getByText("Select model for new session", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    const error = page.getByRole("dialog", { name: "Create new session", exact: true });
    await expect(error.getByRole("alert")).toBeVisible();
    await error.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog", { name: "Sessions", exact: true })).toBeVisible();
    await expect(panel(page, "panel-1")).toHaveAttribute("data-session-id", sid(1));
    expect(creates).toHaveLength(1);
    expect(f.errors).toEqual([]);
});

test("panel info, personal manage and terminate actions retain their own session target", async ({ page, context }) => {
    await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
        auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "admin" } },
    } } }));
    const f = await fixture(page, [layout(split(chat(1), chat(2)))]);
    const paths = [];
    await page.route("**/api/v1/sessions/*/access", route => {
        paths.push(new URL(route.request().url()).pathname);
        return route.fulfill({ json: { ok: true, result: { canRead: true, canWrite: true, canManage: true, owner: { provider: "none", subject: "test" } } } });
    });
    await open(page);
    const p = panel(page, "panel-2");
    await p.locator("header").first().click();
    await expect(p.locator(":scope > header button")).toHaveCount(4);
    await expect(composer(page)).toBeVisible();
    await p.getByRole("button", { name: "Session control panel", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Session control panel", exact: true }).getByRole("button", { name: /Open in main view|link|shar/i })).toHaveCount(0);
    await page.getByRole("dialog", { name: "Session control panel", exact: true }).getByRole("button", { name: "Session information", exact: true }).click();
    const info = page.getByRole("dialog", { name: "Session information", exact: true });
    await expect(info).toContainText(sid(2));
    for (const field of ["Owner", "Model", "Context", "Cron", "Agent", "Updated", "Children", "Access"]) await expect(info.locator(".ps-session-detail-label").getByText(field, { exact: true })).toBeVisible();
    await info.getByRole("button", { name: "Close dialog" }).click();
    await p.getByRole("button", { name: "Session control panel", exact: true }).click();
    await page.getByRole("dialog", { name: "Session control panel", exact: true }).getByRole("button", { name: "Manage session — rename and switch model", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Access", exact: true })).toHaveCount(0);
    await expect(page.locator(".ps-share-overlay").getByPlaceholder("Session title")).toHaveValue("Session 2");
    await expect.poll(() => paths.some(path => path.includes(sid(2)))).toBe(true);
    await page.locator(".ps-share-overlay").getByRole("button", { name: "Close", exact: true }).click();
    await p.getByRole("button", { name: "Session control panel", exact: true }).click();
    await page.getByRole("dialog", { name: "Session control panel", exact: true }).getByRole("button", { name: "Terminate — mark completed, cancel, or delete this session", exact: true }).click();
    await expect(page.locator(".ps-modal")).toContainText('What should happen to "Session 2"');
    await expect(composer(page)).toHaveCount(0);
    await page.locator(".ps-modal-close").click();
    await expect(composer(page)).toBeVisible();
    await expect(page.locator(".ps-moa-composer-strip")).toHaveAttribute("data-session-id", sid(2));
    // The normal session view keeps its original link and sharing controls.
    await page.getByRole("button", { name: /^Workspace/ }).click();
    await page.locator(".ps-session-list-button").filter({ hasText: "Session 2" }).first().click();
    await expect(page.getByRole("button", { name: "Copy link — copy a direct link to this session", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Manage session — rename, switch model, and sharing", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Access", exact: true })).toBeVisible();
    expect(f.sends).toEqual([]);
    expect(f.errors).toEqual([]);
});


test("the bottom composer preserves read-only session access", async ({ page }) => {
    const f = await fixture(page, [layout(split(chat(1), chat(2)))]);
    await page.route(`**/api/v1/sessions/${sid(2)}/access`, route => route.fulfill({ json: { ok: true, result: { canRead: true, canWrite: false, owner: { displayName: "Session owner" } } } }));
    await open(page);
    await expect(composer(page)).toBeVisible();
    await composer(page).fill("Keep this private draft");
    await panel(page, "panel-2").locator("header").first().click();
    await expect(page.locator(".ps-moa-composer-strip .ps-composer-readonly")).toContainText("view access");
    await expect(composer(page)).toHaveCount(0);
    await panel(page, "panel-2").focus();
    await page.keyboard.press("Tab");
    await expect(composer(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel(page, "panel-2")).toBeFocused();
    await panel(page, "panel-1").locator("header").first().click();
    await expect(composer(page)).toHaveValue("Keep this private draft");
    expect(f.sends).toEqual([]);
});


test("panel split shortcuts include a fresh workspace and header actions stay centered", async ({ page }) => {
    const f = await fixture(page);
    await open(page);
    await expect(page.getByRole("button", { name: "Add panel", exact: true })).toHaveCount(0);
    await expect(page.getByText("Saved to profile", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
    for (const width of [1600, 1024, 921]) {
        await page.setViewportSize({ width, height: 1000 });
        const toolbar = await page.locator(".ps-toolbar.is-moa").boundingBox();
        const actions = await page.locator(".ps-moa-toolbar").boundingBox();
        expect(Math.abs(actions.x + actions.width / 2 - toolbar.x - toolbar.width / 2)).toBeLessThan(2);
        await expect(page.getByRole("button", { name: "Enter zen", exact: true })).toBeInViewport();
    }
    await page.locator(".ps-moa-initial-panel").getByRole("button", { name: "Split below", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(2);
    await expect.poll(() => f.settings().moa.tree?.direction).toBe("column");
    await page.locator("[data-moa-panel]").first().locator("header").first().click();
    await page.locator("[data-moa-panel]").first().getByRole("button", { name: "Split right", exact: true }).click();
    await expect(page.locator("[data-moa-panel]")).toHaveCount(3);
    await page.locator(".ps-moa-panel.is-focused").getByRole("button", { name: "Choose session or canvas", exact: true }).click();
    await expect(page.getByRole("button", { name: "Use chat", exact: true }).locator("svg path")).toHaveAttribute("d", /.+/);
    expect(f.errors).toEqual([]);
});
