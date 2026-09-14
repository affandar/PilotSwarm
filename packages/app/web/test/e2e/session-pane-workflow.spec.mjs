import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const tree = { id: 'split', type: 'split', direction: 'row', ratio: 50,
    first: { id: 'a', type: 'chat', sessionId: sid(1) }, second: { id: 'b', type: 'chat', sessionId: sid(2) } };
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4, transcriptTurns: 2 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
async function fixture(page, width = 1600, paneTree = tree) {
    let settings = { themeId: 'terminal-green', moa: { version: 2, tree: paneTree }, sessionOrder: [sid(3),sid(1),sid(2),sid(0)] };
    const sends = [], errors = [];
    let newer = false, catalogReads = 0;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const answer = result => route.fulfill({ json: { ok: true, result } });
        if (path.endsWith('/me/profile/settings')) { settings = request.postDataJSON().settings; return answer({ profileSettings: settings }); }
        if (path.endsWith('/me/profile')) return answer({ isAdmin: false, profileSettings: settings });
        if (path.endsWith('/management/sessions') || path === '/api/v1/sessions') {
            catalogReads++;
            const result = await (await route.fetch()).json();
            if (newer) { const update = s => s.sessionId === sid(1) ? { ...s, title: 'Session 1 updated', updatedAt: 9999999999999 } : s; if (Array.isArray(result.result)) result.result = result.result.map(update); else result.result.sessions = result.result.sessions.map(update); }
            return route.fulfill({ json: result });
        }
        const detail = /\/sessions\/([^/]+)$/.exec(path);
        if (newer && detail?.[1] === sid(1)) { const response = await (await route.fetch()).json(); response.result = { ...response.result, title: 'Session 1 updated', updatedAt: 9999999999999 }; return route.fulfill({ json: response }); }
        const send = /\/sessions\/([^/]+)\/messages$/.exec(path);
        if (send) { sends.push({ sessionId: send[1], ...request.postDataJSON() }); return answer({ queued: true }); }
        const events = /\/sessions\/([^/]+)\/events$/.exec(path);
        if (events) return answer([{ seq: 1, eventType: 'assistant.message', timestamp: 1785000000000,
            data: { content: `Review [changes.csv](artifact://${events[1]}/changes.csv)` } }, { seq: 2, eventType: 'session.turn_completed', timestamp: 1785000000001, data: { resultType: 'completed' } }]);
        return route.fallback();
    });
    await page.setViewportSize({ width, height: width < 920 ? 844 : 1000 });
    await page.goto(base + `/?session=${sid(0)}`);
    await expect(page.getByRole('button', { name: 'Master of Agents', exact: true })).toBeEnabled();
    return { sends, errors, settings: () => settings, makeNewer: () => { newer = true; }, catalogReads: () => catalogReads };
}
const panel = (page, id) => page.locator(`[data-moa-panel="${id}"]`);
async function open(page) { await page.getByRole('button', { name: 'Master of Agents', exact: true }).click(); }
async function mode(page, value) {
    await page.getByRole('button', { name: 'Dashboard options', exact: true }).click();
    await page.getByLabel('Message boxes', { exact: true }).selectOption(value);
    await page.getByRole('button', { name: 'Save dashboard name' }).click();
}
for (const width of [1600, 390]) test(`canvas panes have no per-chat composer and preserve the chat draft at ${width}px`, async ({ page }) => {
    const paneTree = { ...tree, second: { id: 'b', type: 'canvas', sessionId: sid(1), slot: 1 } };
    const f = await fixture(page, width, paneTree);
    await page.route('**/api/v1/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/events') || (url.pathname.endsWith('/events-before') && url.search.includes('session.canvas_updated'))) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 3, eventType: 'session.canvas_updated', data: { slot: 1, rev: 1, sizeBytes: 128, name: 'Report' } }] } });
        }
        if (url.pathname.includes('/artifacts/canvas.html')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><button>Inspect report</button>' });
        return route.fallback();
    });
    await open(page);
    const chat = panel(page, 'a'), canvas = panel(page, 'b');
    const prompt = chat.locator('textarea');
    await expect(prompt).toBeVisible();
    await prompt.fill('Keep this chat draft');
    if (width < 920) {
        await page.getByRole('button', { name: 'Open panel map', exact: true }).click();
        await page.locator('.ps-moa-map-list button').filter({ hasText: 'Canvas 1' }).click();
    } else {
        await canvas.locator(':scope > header').click();
    }
    await expect(canvas).toHaveClass(/is-focused/);
    const report = canvas.locator('iframe').first().contentFrame().getByRole('button', { name: 'Inspect report' });
    await report.click();
    await expect(canvas.locator('.ps-moa-pane-composer')).toHaveCount(0);
    await expect(canvas.locator('textarea')).toHaveCount(0);
    await expect(page.locator('.ps-moa-pane-composer:visible')).toHaveCount(0);
    await expect(prompt).toBeHidden();
    // The live canvas occupies all the space below its header, with no
    // hidden composer footer reserving a strip at the bottom.
    const gap = await canvas.evaluate(el => el.getBoundingClientRect().bottom - parseFloat(getComputedStyle(el).borderBottomWidth) - el.querySelector('.ps-moa-live').getBoundingClientRect().bottom);
    expect(Math.abs(gap)).toBeLessThan(1);
    if (width < 920) {
        await page.getByRole('button', { name: 'Open panel map', exact: true }).click();
        await page.locator('.ps-moa-map-list button').filter({ hasText: 'Session 1' }).filter({ hasNotText: 'Canvas' }).click();
    } else {
        await report.press('Tab');
        await expect(prompt).toBeFocused();
    }
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveValue('Keep this chat draft');
    expect(f.sends).toEqual([]);
    expect(f.errors).toEqual([]);
});
test('per-chat is default, sends stay with the pane, and both drafts survive shared-mode changes', async ({ page }) => {
    const f = await fixture(page); await open(page);
    const a = panel(page, 'a').locator('textarea'), b = panel(page, 'b').locator('textarea');
    await expect(a).toBeVisible(); await expect(b).toBeHidden();
    await expect(a).toBeFocused();
    await expect(page.locator('.ps-moa-pane-composer:visible')).toHaveCount(1);
    await expect(page.locator('.ps-moa-composer-strip')).toHaveCount(0);
    await a.fill('draft one');
    const inactiveHeight = await panel(page, 'b').locator('.ps-moa-live').evaluate(el => el.getBoundingClientRect().height);
    await panel(page, 'b').locator('header').first().click();
    await expect(a).toBeHidden(); await expect(b).toBeVisible();
    await expect(b).toBeFocused();
    expect(await panel(page, 'b').locator('.ps-moa-live').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(inactiveHeight);
    await page.keyboard.type('draft two');
    const geometry = await b.evaluate(el => ({ font: getComputedStyle(el).fontSize, transcriptFont: getComputedStyle(el.closest('[data-moa-panel]').querySelector('.ps-scroll-panel')).fontSize, height: el.getBoundingClientRect().height, footer: el.closest('footer').getBoundingClientRect().height }));
    expect(geometry.font).toBe(geometry.transcriptFont);
    expect(geometry.height).toBeLessThanOrEqual(32); expect(geometry.footer).toBeLessThanOrEqual(42);
    await expect(a).toHaveValue('draft one'); await expect(b).toHaveValue('draft two');
    await page.screenshot({ path: '/tmp/pane-composers-desktop.png' });
    await mode(page, 'shared');
    const shared = page.locator('.ps-moa-composer-strip textarea');
    await expect(shared).toHaveValue('draft two');
    await panel(page, 'a').locator('header').first().click();
    await expect(shared).toHaveValue('draft one');
    await mode(page, 'per-chat');
    await expect(a).toHaveValue('draft one'); await expect(b).toHaveValue('draft two');
    await panel(page, 'b').locator('header').first().click();
    await b.press('Enter');
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(sid(2));
    expect(f.sends[0].prompt).toBe('draft two');
    await expect(a).toHaveValue('draft one');
    await b.press('Tab');
    await expect(a).toBeFocused(); await expect(b).toBeHidden();
    await a.press('Enter');
    await expect.poll(() => f.sends.length).toBe(2);
    expect(f.sends[1].sessionId).toBe(sid(1));
    expect(f.errors).toEqual([]);
    await mode(page, 'shared');
    await expect.poll(() => f.settings().moa.composerMode).toBe('shared');
    await page.reload(); await open(page);
    await expect(shared).toBeVisible();
    await expect(page.locator('[data-moa-panel] textarea')).toHaveCount(0);
});
for (const width of [1600, 390]) test(`artifact opens its owning session outside MoA with preview at ${width}px`, async ({ page }) => {
    const f = await fixture(page, width); await open(page);
    const a = panel(page, 'a');
    await expect(a.locator('textarea')).toBeVisible();
    await a.locator('textarea').fill('Keep this draft');
    await a.locator('.ps-artifact-card').first().click();
    await expect(page.locator('.ps-moa-workspace')).toBeHidden();
    const preview = page.locator(width < 920 ? '.ps-artifact-overlay' : '.ps-artifact-pane');
    await expect(preview).toBeVisible();
    if (width < 920) await expect(preview).toContainText('changes.csv');
    else await expect(preview).toHaveAttribute('aria-label', 'Artifact: changes.csv');
    if (width >= 920) {
        await expect(page.locator('.ps-chat-panel:visible')).toContainText('Session 1');
        await expect(page.locator('.ps-chat-panel:visible textarea')).toHaveValue('Keep this draft');
        await page.locator('.ps-chat-panel:visible textarea').fill('Edited in focused view');
        await page.getByRole('button', { name: 'Back to MoA — Master of Agents', exact: true }).click();
        await expect(panel(page, 'a').locator('textarea')).toHaveValue('Edited in focused view');
    }
    expect(f.errors).toEqual([]);
});
for (const width of [1600, 390]) test(`session sort is available and stable until refresh at ${width}px`, async ({ page }) => {
    const f = await fixture(page, width);
    const select = page.getByRole('group', { name: 'Session sort order', exact: true }).filter({ visible: true });
    // Mobile reveals search and sort together on demand.
    if (width < 921) await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(select).toBeVisible();
    await expect(select.getByRole('button')).toHaveCount(3);
    await expect(select.locator('button[aria-pressed=true]')).toHaveCount(1);
    await expect(select.locator('select')).toHaveCount(0);
    const rows = page.locator('.ps-session-list-button:visible:not([data-group-row])');
    const ids = () => rows.evaluateAll(nodes => nodes.map(n => n.dataset.sessionId));
    await expect.poll(ids).toEqual([sid(3),sid(1),sid(2),sid(0)]);
    await select.getByRole('button', { name: 'Recently updated', exact: true }).click();
    await expect(select.getByRole('button', { name: 'Recently updated', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(ids).toEqual([sid(3),sid(2),sid(1),sid(0)]);
    f.makeNewer();
    // Allow a real background catalog refresh; changed row text proves arrival.
    await expect(rows.filter({ hasText: 'Session 1 updated' })).toBeVisible({ timeout: 15000 });
    await expect.poll(ids).toEqual([sid(3),sid(2),sid(1),sid(0)]);
    await page.getByRole('button', { name: 'Refresh session order' }).filter({ visible: true }).click();
    await expect.poll(ids).toEqual([sid(1),sid(3),sid(2),sid(0)]);
    await select.getByRole('button', { name: 'Saved order', exact: true }).click();
    await expect(select.getByRole('button', { name: 'Saved order', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(ids).toEqual([sid(3),sid(1),sid(2),sid(0)]);
    await select.getByRole('button', { name: 'Recently used', exact: true }).focus();
    await select.getByRole('button', { name: 'Recently used', exact: true }).press('Enter');
    await expect(select.getByRole('button', { name: 'Recently used', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await rows.filter({ hasText: 'Session 2' }).click();
    if (width < 921) await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    const before = await ids();
    await page.getByRole('button', { name: 'Refresh session order' }).filter({ visible: true }).click();
    await expect.poll(async () => (await ids())[0]).toBe(sid(2));
    expect(before).not.toEqual(await ids());
    await expect.poll(() => f.settings().sessionSortMode).toBe('used');
    expect(f.errors).toEqual([]);
});

test('mobile per-chat composers keep drafts with the visible pane and fit the viewport', async ({ page }) => {
    const f = await fixture(page, 390); await open(page);
    const a = panel(page, 'a'), b = panel(page, 'b');
    await expect(a.locator('textarea')).toBeVisible();
    await a.locator('textarea').fill('first mobile draft');
    await page.getByRole('button', { name: 'Open panel map', exact: true }).click();
    await page.locator('.ps-moa-map-list button').filter({ hasText: 'Session 2' }).click();
    await expect(b.locator('textarea')).toBeVisible();
    await expect(a.locator('textarea')).toBeHidden();
    await b.locator('textarea').fill('second mobile message');
    const bounds = await b.locator('.ps-moa-pane-composer').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
    await b.getByRole('button', { name: 'Send prompt', exact: true }).click();
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(sid(2));
    await page.getByRole('button', { name: 'Open panel map', exact: true }).click();
    await page.locator('.ps-moa-map-list button').filter({ hasText: 'Session 1' }).click();
    await expect(a.locator('textarea')).toHaveValue('first mobile draft');
    expect(f.errors).toEqual([]);
});

test('the MoA session picker has the same saved sort preference and refresh control', async ({ page }) => {
    const f = await fixture(page); await open(page);
    await panel(page, 'a').getByRole('button', { name: 'Session control panel' }).click();
    await page.getByRole('button', { name: 'Replace session or canvas…' }).click();
    const picker = page.getByRole('dialog', { name: 'Sessions', exact: true });
    await expect(picker.getByLabel('Session sort order')).toBeVisible();
    const bounds = await picker.locator('.ps-session-find-controls').evaluate(el => {
        const sort = el.querySelector('.ps-session-sort-modes').getBoundingClientRect(), search = el.querySelector('.ps-session-search').getBoundingClientRect(), refresh = el.querySelector('.ps-session-sort-refresh').getBoundingClientRect();
        return { sortRight: sort.right, searchLeft: search.left, searchRight: search.right, refreshLeft: refresh.left, sortY: sort.y, searchY: search.y };
    });
    expect(bounds.sortRight).toBeLessThan(bounds.searchLeft);
    expect(bounds.searchRight).toBeLessThan(bounds.refreshLeft);
    expect(Math.abs(bounds.sortY - bounds.searchY)).toBeLessThanOrEqual(2);
    await picker.getByRole('button', { name: 'Recently updated', exact: true }).click();
    await picker.getByRole('button', { name: 'Refresh session order' }).click();
    const ids = await picker.locator('.ps-session-list-button:not([data-group-row])').evaluateAll(nodes => nodes.map(n => n.dataset.sessionId));
    expect(ids).toEqual([sid(3),sid(2),sid(1),sid(0)]);
    await expect.poll(() => f.settings().sessionSortMode).toBe('updated');
    expect(f.sends).toHaveLength(0);
    expect(f.errors).toEqual([]);
});

test('a delayed artifact click cannot replace a more recently opened pane session', async ({ page }) => {
    const f = await fixture(page); await open(page);
    await expect(panel(page, 'a').locator('.ps-artifact-card')).toBeVisible();
    await expect(panel(page, 'b').locator('.ps-artifact-card')).toBeVisible();
    let release, requested = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/v1/sessions/${sid(1)}`, async route => {
        requested = true; await gate; return route.fallback();
    });
    try {
        await panel(page, 'a').locator('.ps-artifact-card').click();
        await expect.poll(() => requested).toBe(true);
        await panel(page, 'b').locator('.ps-artifact-card').click();
        await expect(page.locator('.ps-moa-workspace')).toBeHidden();
        await expect(page.locator('.ps-chat-panel:visible')).toContainText('Session 2');
        release();
        await expect(page.getByRole('region', { name: 'Artifact: changes.csv', exact: true })).toBeVisible();
        await expect(page.locator('.ps-chat-panel:visible')).toContainText('Session 2');
        expect(f.errors).toEqual([]);
    } finally { release(); }
});


test('desktop panes show activity in their titles without a status footer or height changes', async ({ page }) => {
    const f = await fixture(page);
    let running = false, reads = 0;
    await page.route('**/api/v1/sessions/*', async route => {
        if (!/\/sessions\/[^/]+$/.test(new URL(route.request().url()).pathname)) return route.fallback();
        const response = await (await route.fetch()).json();
        response.result = { ...response.result, status: running ? 'running' : 'idle', statusVersion: running ? 101 : 100, updatedAt: Date.now() };
        reads++;
        return route.fulfill({ json: response });
    });
    await open(page);
    const a = panel(page, 'a'), b = panel(page, 'b');
    await expect(a.getByLabel('Session status')).toBeVisible();
    await expect(b.getByLabel('Session status')).toBeVisible();
    await expect(page.locator('.ps-moa-panel .ps-panel-bottom-sticky')).toHaveCount(0);
    const height = await a.locator('header').first().evaluate(el => el.getBoundingClientRect().height);
    // Refresh the status through the real background polling path.
    running = true;
    await page.clock.install();
    const before = reads;
    await page.clock.fastForward(4100);
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(a.getByLabel('Session status')).toContainText('Working');
    expect(await a.locator('header').first().evaluate(el => el.getBoundingClientRect().height)).toBe(height);
    await expect(page.locator('.ps-moa-panel .ps-panel-bottom-sticky')).toHaveCount(0);
    expect(f.errors).toEqual([]);
});


test('a per-chat composer finishing startup preserves keyboard resize focus', async ({ page }) => {
    await fixture(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/v1/sessions/${sid(1)}`, async route => { await gate; await route.fallback(); });
    try {
        await open(page);
        const seam = page.getByRole('separator', { name: 'Resize MoA panels' });
        await seam.focus();
        release();
        await expect(panel(page, 'a').locator('textarea')).toBeVisible();
        await expect(seam).toBeFocused();
        await seam.press('ArrowRight');
        await expect(seam).toHaveAttribute('aria-valuenow', '52');
    } finally { release(); }
});
