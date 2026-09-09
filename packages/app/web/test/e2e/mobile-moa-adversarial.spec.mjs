import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

async function chooseZenSession(page, id) {
    await page.getByRole('button', { name: 'Select session', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Sessions', exact: true });
    await picker.locator(`[data-session-id="${id}"]`).click();
    await picker.getByRole('button', { name: 'Use chat', exact: true }).click();
    await expect(picker).toBeHidden();
}

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4, transcriptTurns: 40 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });
const sid = n => `1111111${n}-2222-3333-4444-55555555555${n}`;
const chat = n => ({ id: `p${n}`, type: "chat", sessionId: sid(n) });
// DFS order is 0,1,2,3; clockwise order is 0,2,3,1.
const tree = { id: "root", type: "split", direction: "row", ratio: 30,
    first: { id: "left", type: "split", direction: "column", ratio: 40, first: chat(0), second: chat(1) },
    second: { id: "right", type: "split", direction: "column", ratio: 60, first: chat(2), second: chat(3) } };
const active = page => page.locator(".ps-moa-panel.is-focused");
const moaComposer = page => page.locator(".ps-moa-composer-strip textarea");
const zenComposer = page => page.locator(".ps-mobile-zen-composer textarea");

async function fixture(page, extra = {}) {
    await page.setViewportSize({ width: 390, height: 844 });
    let settings = { themeId: "terminal-green", moa: { version: 2, tree, aspectRatio: 2 }, ...extra };
    const sends = [];
    await page.route("**/api/v1/**", route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const answer = result => route.fulfill({ json: { ok: true, result } });
        if (path.endsWith("/me/profile/settings")) { settings = request.postDataJSON().settings; return answer({ profileSettings: settings }); }
        if (path.endsWith("/me/profile")) return answer({ isAdmin: false, profileSettings: settings });
        const sent = /\/sessions\/([^/]+)\/messages$/.exec(path);
        if (sent) { sends.push({ id: sent[1], ...request.postDataJSON() }); return answer({ queued: true }); }
        return route.fallback();
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid(0)}`);
    await expect(page.getByRole("button", { name: "Enter mobile zen", exact: true })).toBeVisible();
    return { sends };
}
async function openMoa(page) {
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    await expect(moaComposer(page)).toBeVisible();
}
async function swipe(locator, dx) {
    await locator.evaluate((node, dx) => {
        const fire = (type, x, ended = false) => {
            // WebKit exposes TouchEvent but rejects its constructor on desktop.
            const touch = { identifier: 1, target: node, clientX: x, clientY: 160 };
            const event = new Event(type, { bubbles: true });
            Object.defineProperties(event, { touches: { value: ended ? [] : [touch] }, changedTouches: { value: [touch] } });
            node.dispatchEvent(event);
        };
        fire('touchstart', 190);
        fire('touchend', 190 + dx, true);
    }, dx);
}

test("map preserves the saved desktop ratio and panel rectangles without changing profile on phone", async ({ page }) => {
    await fixture(page); await openMoa(page);
    await page.getByRole("button", { name: "Open panel map", exact: true }).click();
    const map = page.locator(".ps-moa-map");
    const bounds = await map.boundingBox();
    expect(bounds.width / bounds.height).toBeCloseTo(2, 1);
    const rects = await map.locator("button").evaluateAll(nodes => nodes.map(n => ({
        left: parseFloat(n.style.left), top: parseFloat(n.style.top), width: parseFloat(n.style.width), height: parseFloat(n.style.height),
    })));
    expect(rects).toEqual([
        { left: 0, top: 0, width: 30, height: 40 }, { left: 0, top: 40, width: 30, height: 60 },
        { left: 30, top: 0, width: 70, height: 60 }, { left: 30, top: 60, width: 70, height: 40 },
    ]);
    await expect(page.locator(".ps-moa-map-list button")).toHaveCount(4);
    for (const button of await page.locator(".ps-moa-map-list button").all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test("map numbers follow clockwise swipe order instead of split-tree traversal", async ({ page }) => {
    await fixture(page); await openMoa(page);
    await page.getByRole("button", { name: "Open panel map", exact: true }).click();
    const numberedTitle = await page.locator(".ps-moa-map button").evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.querySelector("span").textContent, n.querySelector("b").textContent])));
    await page.getByRole("dialog", { name: "Panel map" }).getByRole("button", { name: "Close dialog", exact: true }).click();
    for (let n = 1; n <= 4; n++) {
        const title = await page.locator(".ps-mobile-focus-header .ps-moa-panel-title").textContent();
        expect(numberedTitle[title]).toBe(String(n));
        await swipe(page.locator(".ps-mobile-focus-header"), -100);
    }
    await expect(active(page)).toHaveAttribute("data-moa-panel", "p0");
});

test("native horizontal scrolling does not switch panels; swipe back restores each unsent draft", async ({ page }) => {
    const f = await fixture(page); await openMoa(page);
    await moaComposer(page).fill("first private draft");
    await swipe(page.locator(".ps-mobile-focus-header"), -100);
    await expect(active(page)).toHaveAttribute("data-moa-panel", "p2");
    await moaComposer(page).fill("second private draft");
    await active(page).locator(".ps-moa-live").evaluate(node => {
        const div = document.createElement("div"); div.id = "native-scroll-test";
        div.style.cssText = "overflow-x:auto;width:180px;height:44px";
        div.innerHTML = '<div style="width:900px">wide content</div>'; node.append(div);
    });
    await swipe(page.locator("#native-scroll-test"), -100);
    await expect(active(page)).toHaveAttribute("data-moa-panel", "p2");
    await swipe(page.locator(".ps-mobile-focus-header"), 100);
    await expect(moaComposer(page)).toHaveValue("first private draft");
    await swipe(page.locator(".ps-mobile-focus-header"), -100);
    await expect(moaComposer(page)).toHaveValue("second private draft");
    expect(f.sends).toEqual([]);
});

test("mobile Zen retains drafts after exit and re-entry", async ({ page }) => {
    await fixture(page);
    await page.getByRole("button", { name: "Enter mobile zen", exact: true }).click();
    await zenComposer(page).fill("do not discard first draft");
    await chooseZenSession(page, sid(1));
    await expect(zenComposer(page)).toHaveValue("");
    await zenComposer(page).fill("second draft");
    await page.getByRole("button", { name: "Exit mobile zen", exact: true }).click();
    await page.getByRole("button", { name: "Enter mobile zen", exact: true }).click();
    await chooseZenSession(page, sid(0));
    await expect(zenComposer(page)).toHaveValue("do not discard first draft");
});

test("failed Zen session navigation restores the outgoing draft", async ({ page }) => {
    await fixture(page);
    await page.getByRole("button", { name: "Enter mobile zen", exact: true }).click();
    await zenComposer(page).fill("draft before denied navigation");
    await page.route(`**/api/v1/sessions/${sid(1)}`, route => route.fulfill({ status: 403, json: { ok: false, error: { code: "FORBIDDEN", message: "Denied" } } }));
    await chooseZenSession(page, sid(1));
    await expect(page.locator(".ps-mobile-zen [role=alert]")).toBeVisible();
    await expect(zenComposer(page)).toHaveValue("draft before denied navigation");
});

test("read-only MoA panel and Zen session never mount a writable composer", async ({ page }) => {
    const f = await fixture(page);
    await page.route(`**/api/v1/sessions/${sid(2)}/access`, route => route.fulfill({ json: { ok: true, result: { canRead: true, canWrite: false, owner: { displayName: "Other owner" } } } }));
    await openMoa(page); await swipe(page.locator(".ps-mobile-focus-header"), -100);
    await expect(page.locator(".ps-moa-composer-strip .ps-composer-readonly")).toContainText("view access");
    await expect(moaComposer(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Back to normal view", exact: true }).click();
    await page.getByRole("button", { name: "Enter mobile zen", exact: true }).click();
    await chooseZenSession(page, sid(2));
    await expect(page.locator(".ps-mobile-zen-composer .ps-composer-readonly")).toContainText("view access");
    await expect(zenComposer(page)).toHaveCount(0);
    expect(f.sends).toEqual([]);
});

test("hiding and restoring a mobile panel preserves the reading position", async ({ page }) => {
    await fixture(page); await openMoa(page);
    const scroll = page.locator('[data-moa-panel="p0"] .ps-scroll-panel');
    await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
    await scroll.evaluate(el => { el.scrollTop = 120; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeCloseTo(120, 0);
    await swipe(page.locator(".ps-mobile-focus-header"), -100);
    await expect(active(page)).toHaveAttribute("data-moa-panel", "p2");
    await swipe(page.locator(".ps-mobile-focus-header"), 100);
    await expect(active(page)).toHaveAttribute("data-moa-panel", "p0");
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeCloseTo(120, 0);
});

test("canvas remains interactive and switches only from the outer title strip", async ({ page }) => {
    const canvas = { id: "canvas", type: "canvas", sessionId: sid(1), slot: 2 };
    await fixture(page, { moa: { version: 2, aspectRatio: 2, tree: { id: "pair", type: "split", direction: "row", ratio: 50, first: chat(0), second: canvas } } });
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 2, rev: 1, sizeBytes: 200, name: "Interactive canvas" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && /canvas2\.html/.test(url.pathname)) {
            return route.fulfill({ contentType: "text/html", body: '<!doctype html><label><input id="inside" type="checkbox">Canvas control</label><div style="width:1200px;height:1400px">Wide canvas content</div>' });
        }
        return route.fallback();
    });
    await openMoa(page);
    await swipe(page.locator(".ps-mobile-focus-header"), -100);
    await expect(active(page)).toHaveAttribute("data-moa-panel", "canvas");
    const frame = active(page).locator("iframe").first();
    const checkbox = frame.contentFrame().getByRole("checkbox", { name: "Canvas control" });
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await expect(active(page)).toHaveAttribute("data-moa-panel", "canvas");
    await moaComposer(page).fill("canvas session draft");
    await page.setViewportSize({ width: 390, height: 400 });
    await expect.poll(async () => { const r = await moaComposer(page).boundingBox(); return r.y + r.height; }).toBeLessThanOrEqual(400);
    await swipe(page.locator(".ps-mobile-focus-header"), 100);
    await expect(active(page)).toHaveAttribute("data-moa-panel", "p0");
    await expect(moaComposer(page)).toHaveValue("");
    await swipe(page.locator(".ps-mobile-focus-header"), -100);
    await expect(moaComposer(page)).toHaveValue("canvas session draft");
});

test("staged image attachments remain with their MoA session when swiping", async ({ page }) => {
    const f = await fixture(page); await openMoa(page);
    await moaComposer(page).evaluate(el => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "private-draft-image.png", { type: "image/png" }));
        el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    });
    const attachments = page.locator(".ps-moa-composer-strip .ps-prompt-attachments");
    await expect(attachments.locator("img")).toHaveAttribute("alt", "private-draft-image.png");
    await swipe(page.locator(".ps-mobile-focus-header"), -100);
    await expect(active(page)).toHaveAttribute("data-moa-panel", "p2");
    await expect(attachments).toHaveCount(0);
    await swipe(page.locator(".ps-mobile-focus-header"), 100);
    await expect(attachments.locator("img")).toHaveAttribute("alt", "private-draft-image.png");
    expect(f.sends).toEqual([]);
});
