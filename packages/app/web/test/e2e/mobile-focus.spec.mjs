import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise(r => stub.server.close(r)); });
const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const chat = i => ({ id: `p${i}`, type: 'chat', sessionId: sid(i) });
const tree = { id: 's1', type: 'split', direction: 'row', ratio: 60, first: chat(1), second: { id: 's2', type: 'split', direction: 'column', ratio: 30, first: chat(2), second: chat(3) } };
async function setup(page, theme = 'terminal-green', desktop = false) {
    const errors = [], sends = [];
    let settings = { themeId: theme, moa: { version: 2, tree, aspectRatio: 2 } };
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/v1/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        const answer = result => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
        if (path.endsWith('/me/profile/settings')) { settings = req.postDataJSON().settings; return answer({ profileSettings: settings }); }
        if (path.endsWith('/me/profile')) return answer({ isAdmin: false, profileSettings: settings });
        if (/\/sessions\/[^/]+\/messages$/.test(path)) { sends.push({ path, ...req.postDataJSON() }); return answer({ queued: true }); }
        return route.fallback();
    });
    await page.setViewportSize(desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    await page.goto(base);
    await expect(page.getByRole('button', { name: 'Master of Agents', exact: true })).toBeEnabled();
    return { errors, sends, settings: () => settings };
}
async function swipe(page, locator, dx) {
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
for (const theme of ['terminal-green', 'win95', 'winamp', 'ms-dos']) {
    test(`mobile Zen is compact, restores, and fits the keyboard viewport: ${theme}`, async ({ page }) => {
        const f = await setup(page, theme);
        await page.getByRole('button', { name: 'Enter mobile zen' }).click();
        const zen = page.locator('.ps-mobile-zen');
        await expect(zen).toBeVisible();
        await expect(page.locator('.portal-header')).toBeHidden();
        await expect(zen.getByRole('combobox', { name: 'Select session' })).toBeVisible();
        const input = zen.locator('textarea');
        await expect(input).toHaveAttribute('placeholder', 'Message…');
        expect(await input.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
        expect((await input.boundingBox()).height).toBeLessThan(52);
        await expect(input).not.toBeFocused();
        await expect(zen.getByRole('button')).toHaveCount(2);
        await input.fill('first session draft');
        const select = zen.getByRole('combobox');
        const first = await select.inputValue();
        await select.selectOption(sid(2));
        await expect(input).toHaveValue('');
        await input.fill('second session draft');
        await select.selectOption(first);
        await expect(input).toHaveValue('first session draft');
        await page.setViewportSize({ width: 390, height: 400 });
        await expect.poll(async () => { const box = await input.boundingBox(); return box.y + box.height; }).toBeLessThanOrEqual(400);
        await page.screenshot({ path: `/tmp/mobile-zen-${theme}.png` });
        await zen.getByRole('button', { name: 'Exit mobile zen' }).click();
        await expect(page.locator('.portal-header')).toBeVisible();
        expect(f.errors).toEqual([]);
    });
    test(`mobile MoA map preserves proportions, switches and keeps drafts: ${theme}`, async ({ page }) => {
        const f = await setup(page, theme);
        await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
        const input = page.locator('.ps-moa-composer-strip textarea');
        await expect(input).toBeVisible();
        await expect(page.locator('[data-moa-panel]:visible')).toHaveCount(1);
        await expect(input).not.toBeFocused();
        await input.fill('keep p1');
        await page.getByRole('button', { name: 'Open panel map' }).click();
        const map = page.locator('.ps-moa-map');
        const bounds = await map.boundingBox();
        expect(bounds.width / bounds.height).toBeCloseTo(2, 1);
        const tiles = map.locator('button');
        const a = await tiles.nth(0).boundingBox(), b = await tiles.nth(1).boundingBox(), c = await tiles.nth(2).boundingBox();
        expect(a.width / bounds.width).toBeCloseTo(.6, 1);
        expect(b.height / bounds.height).toBeCloseTo(.3, 1);
        expect(c.height / bounds.height).toBeCloseTo(.7, 1);
        await page.screenshot({ path: `/tmp/mobile-moa-map-${theme}.png` });
        await tiles.nth(1).click();
        await expect(page.locator('[data-moa-panel="p2"]')).toBeVisible();
        await input.fill('keep p2');
        await swipe(page, page.locator('.ps-mobile-focus-header .ps-moa-panel-title'), -110);
        await expect(page.locator('[data-moa-panel="p3"]')).toBeVisible();
        await swipe(page, page.locator('.ps-mobile-focus-header .ps-moa-panel-title'), 110);
        await expect(input).toHaveValue('keep p2');
        await swipe(page, page.locator('.ps-mobile-focus-header .ps-moa-panel-title'), 110);
        await expect(input).toHaveValue('keep p1');
        await page.screenshot({ path: `/tmp/mobile-moa-chat-${theme}.png` });
        expect(f.errors).toEqual([]);
    });
}

for (const theme of ['terminal-green', 'win95', 'winamp', 'ms-dos']) {
    test(`desktop focus controls and compact right-aligned zen exit: ${theme}`, async ({ page }) => {
        await setup(page, theme, true);
        await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
        const a = page.locator('[data-moa-panel="p1"]'), b = page.locator('[data-moa-panel="p2"]');
        await expect(a.locator('header > button:visible')).toHaveCount(4);
        await expect(b.locator('header > button:visible')).toHaveCount(0);
        const idleHeaderHeight = (await b.locator('header').first().boundingBox()).height;
        const border = await a.evaluate(el => getComputedStyle(el).borderTopColor);
        expect(border).not.toEqual(await b.evaluate(el => getComputedStyle(el).borderTopColor));
        await b.locator('header').first().click();
        await expect(b.locator('header > button:visible')).toHaveCount(4);
        await expect(a.locator('header > button:visible')).toHaveCount(0);
        expect((await b.locator('header').first().boundingBox()).height).toBe(idleHeaderHeight);
        await page.getByRole('button', { name: 'Enter zen', exact: true }).click();
        const exit = page.getByRole('button', { name: 'Exit zen', exact: true });
        const box = await exit.boundingBox();
        expect(box.height).toBeLessThanOrEqual(22);
        expect(1440 - box.x - box.width).toBeLessThanOrEqual(6);
        await page.screenshot({ path: `/tmp/desktop-moa-focus-${theme}.png` });
        await exit.click();
        await expect(page.locator('.portal-header')).toBeVisible();
    });
}
