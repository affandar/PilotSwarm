import { test, expect, chromium, webkit } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

for (const browserName of ['chromium', 'webkit']) for (const themeId of ['winamp', 'doom']) {
    test.describe(`${browserName} ${themeId}`, () => {
        let stub, base;
        test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 24, themeId }); base = `http://127.0.0.1:${stub.port}`; });
        test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
        for (const context of ['partial', 'full', 'moa']) test(`${context}: overlay keeps results accessible above the keyboard`, async () => {
            const browser = await ({ chromium, webkit })[browserName].launch();
            const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
            const errors = []; page.on('pageerror', e => errors.push(e.message));
            try {
                await page.addInitScript(() => {
                    const vv = new EventTarget(); Object.assign(vv, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
                    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
                    window.resizeSearchViewport = (height, top) => { vv.height = height; vv.offsetTop = top; vv.pageTop = top; vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll')); };
                });
                await page.goto(base);
                if (context === 'full') {
                    await page.getByRole('button', { name: 'Main — sessions and chat (tap for chat only)' }).click();
                    await page.getByRole('button', { name: 'Main — chat only (tap for sessions only)' }).click();
                } else if (context === 'moa') {
                    await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
                    await page.getByRole('button', { name: 'Add first MoA panel' }).click();
                }
                const pane = page.locator(context === 'moa' ? '.ps-moa-session-picker' : '.ps-mobile-session-pane');
                const search = pane.getByRole('textbox', { name: 'Find a session' });
                const trigger = pane.getByRole('button', { name: 'Search sessions' });
                const sort = pane.getByRole('group', { name: 'Session sort order' });
                await expect(trigger).toBeVisible(); await expect(search).toBeHidden(); await expect(sort).toBeHidden();
                await expect(pane.getByRole('button', { name: 'Refresh session order' })).toBeHidden();
                const collapsedHeight = (await pane.boundingBox()).height;
                await trigger.click(); await expect(search).toBeFocused(); await expect(sort).toBeVisible();
                const overlay = page.locator('.ps-session-search-overlay[open]');
                await expect(overlay).toBeVisible();
                expect(await overlay.evaluate(el => el.matches(':modal'))).toBe(true);
                expect((await pane.locator('.ps-session-list').boundingBox()).height).toBeGreaterThan(500);
                const fits = async (top, bottom) => {
                    await expect.poll(() => pane.evaluate((el, { top, bottom }) => {
                        const p = el.getBoundingClientRect();
                        return [...el.querySelectorAll('.ps-session-find-controls input, .ps-session-sort-controls button, .ps-session-search-clear')].every(node => {
                            const r = node.getBoundingClientRect();
                            return r.height > 0 && r.top >= Math.max(p.top, top) - 1 && r.bottom <= Math.min(p.bottom, bottom) + 1 && node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                        });
                    }, { top, bottom })).toBe(true);
                };
                await fits(0, 844);
                await search.fill('Session 12');
                await expect(pane.locator('.ps-session-list-button')).toHaveCount(1);
                // Safari keeps its layout viewport tall while the keyboard shrinks and pans the visual viewport.
                await page.evaluate(() => window.resizeSearchViewport(400, 110));
                await fits(110, 510);
                await page.evaluate(() => window.resizeSearchViewport(330, 110));
                await fits(110, 440);
                await expect(search).toBeFocused();
                await pane.getByRole('button', { name: 'Recently updated', exact: true }).click();
                await pane.getByRole('button', { name: 'Refresh session order', exact: true }).click();
                await fits(110, 440);
                await expect(search).toBeFocused();
                await expect(pane.locator('.ps-session-list-button')).toBeInViewport();
                await expect.poll(() => pane.locator('.ps-session-list-button').evaluate(el => {
                    const r = el.getBoundingClientRect();
                    return el.contains(document.elementFromPoint(r.x + 20, r.y + r.height / 2));
                })).toBe(true);
                await pane.getByRole('button', { name: 'Clear session search' }).click();
                await expect(pane.locator('.ps-session-list-button')).toHaveCount(24);
                expect((await pane.locator('.ps-session-list').boundingBox()).height).toBeGreaterThan(130);
                await page.screenshot({ path: `/tmp/mobile-search-${browserName}-${themeId}-${context}.png` });
                await page.evaluate(() => window.resizeSearchViewport(844, 0));
                await pane.getByRole('button', { name: 'Close session search' }).click();
                await expect(search).toBeHidden(); await expect(sort).toBeHidden(); await expect(trigger).toBeFocused();
                await expect.poll(async () => Math.round((await pane.boundingBox()).height)).toBe(Math.round(collapsedHeight));
                // Escape clears the filter without closing the underlying MoA picker.
                await trigger.click(); await search.fill('Session 12'); await search.press('Escape');
                await expect(overlay).toHaveCount(0); await expect(trigger).toBeVisible();
                await expect(pane.locator('.ps-session-list-button')).toHaveCount(24);
                // A result far down the list is scrollable, selectable, and closes search.
                await trigger.click();
                const target = pane.locator('.ps-session-list-button').nth(22);
                const targetId = await target.getAttribute('data-session-id');
                await target.scrollIntoViewIfNeeded(); await target.click();
                await expect(overlay).toHaveCount(0);
                await expect(pane.locator('.ps-session-list-button.is-selected')).toHaveAttribute('data-session-id', targetId);
                if (context === 'moa') await expect(page.locator('.ps-moa-picker-detail')).toContainText('Session 1');
                expect(errors).toEqual([]);
            } finally { await browser.close(); }
        });
    });
}
