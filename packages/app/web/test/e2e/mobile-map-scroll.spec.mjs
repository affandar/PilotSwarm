import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

test.use({ browserName: process.env.PS_TEST_BROWSER || 'chromium' });
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 7 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const chat = n => ({ id: `p${n}`, type: 'chat', sessionId: `1111111${n}-2222-3333-4444-55555555555${n}` });
const split = (id, direction, first, second, ratio = 50) => ({ id, type: 'split', direction, ratio, first, second });
const tree = split('root', 'row', split('left', 'column', chat(0), split('lower', 'column', chat(6), chat(5))), split('right', 'row', split('middle', 'column', chat(1), chat(4)), split('edge', 'column', chat(2), chat(3))), 40);

for (const theme of ['terminal-green', 'win95', 'winamp', 'ms-dos']) {
    test(`seven panel map stays visible while its list scrolls: ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 660 });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/api/v1/me/profile', route => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { themeId: theme, moa: { version: 2, tree, aspectRatio: 2 } } } } }));
        await page.goto(`http://127.0.0.1:${stub.port}`);
        await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
        await page.getByRole('button', { name: 'Open panel map', exact: true }).click();
        const map = page.locator('.ps-moa-map'), list = page.locator('.ps-moa-map-list');
        for (const height of [660, 420]) {
            await page.setViewportSize({ width: 390, height });
            await expect.poll(() => list.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true);
            await expect.poll(async () => { const b = await page.getByRole('dialog', { name: 'Panel map' }).boundingBox(); return b.y + b.height; }).toBeLessThanOrEqual(height);
            const dialog = await page.getByRole('dialog', { name: 'Panel map' }).boundingBox();
            const before = await map.boundingBox();
            expect(before.width / before.height).toBeCloseTo(2, 1);
            expect(dialog.y).toBeGreaterThanOrEqual(0);
            expect(dialog.y + dialog.height).toBeLessThanOrEqual(height);
            for (const tile of await map.locator('button').all()) {
                const b = await tile.boundingBox();
                expect(b.y).toBeGreaterThanOrEqual(before.y);
                expect(b.y + b.height).toBeLessThanOrEqual(before.y + before.height + 1);
                expect(await tile.locator('b').evaluate(n => n.getBoundingClientRect().bottom <= n.parentElement.getBoundingClientRect().bottom)).toBe(true);
            }
            await list.evaluate(n => { n.scrollTop = n.scrollHeight; });
            expect(await list.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
            expect(await map.boundingBox()).toEqual(before);
            const last = await list.locator('button').last().boundingBox();
            const bounds = await list.boundingBox();
            expect(last.y + last.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
        }
        await page.setViewportSize({ width: 390, height: 660 });
        await list.evaluate(n => { n.scrollTop = 0; });
        await page.screenshot({ path: `/tmp/moa-map-fixed-${process.env.PS_TEST_BROWSER || 'chromium'}-${theme}.png` });
        await list.locator('button').last().click();
        await expect(page.getByRole('dialog', { name: 'Panel map' })).toHaveCount(0);
        expect(errors).toEqual([]);
    });
}
