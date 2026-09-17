import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
import { normalizeMoa, moaLeaves } from '../../../ui/core/src/moa.js';

let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const panel = (page, id) => page.locator(`[data-moa-panel="${id}"]`);
const chat = (id, i) => ({ id, type: 'chat', sessionId: sid(i) });

async function fixture(page, { initialError = 0 } = {}) {
    let deleted = false, failure = initialError, deleteFailure = false, lifecycle = null;
    const errors = [], actions = [];
    let settings = { themeId: 'workspace-dark', moa: normalizeMoa({ version: 3, dashboards: [
        { id: 'main', name: 'Main', focusedPanelId: 'a', tree: { id: 'root', type: 'split', direction: 'row', ratio: 37, first: chat('a', 1), second: chat('b', 2) } },
        { id: 'other', name: 'Other', focusedPanelId: 'c', tree: { id: 'other-root', type: 'split', direction: 'column', ratio: 61, first: chat('c', 1), second: { id: 'd', type: 'canvas', sessionId: sid(1), slot: 1 } } },
    ], activeDashboardId: 'main' }) };
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/v1/**', async route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        const reply = result => route.fulfill({ json: { ok: true, result } });
        const fail = status => route.fulfill({ status, json: { ok: false, error: { code: status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE', message: 'Fixture session unavailable' } } });
        if (path.endsWith('/bootstrap')) return reply({ auth: { principal: { provider: 'none', subject: 'test' }, authorization: { role: 'admin' } } });
        if (path.endsWith('/me/profile/settings')) { settings = structuredClone(req.postDataJSON().settings); return reply({ profileSettings: settings }); }
        if (path.endsWith('/me/profile')) return reply({ isAdmin: true, profileSettings: settings });
        if (path.endsWith(`/sessions/${sid(1)}`)) {
            if (req.method() === 'DELETE') {
                actions.push('delete');
                if (deleteFailure) return fail(503);
                deleted = true; return reply({});
            }
            if (deleted || failure) return fail(deleted ? 404 : failure);
            const response = await route.fetch(), body = await response.json();
            if (lifecycle) body.result.status = lifecycle;
            return route.fulfill({ response, json: body });
        }
        if (path.endsWith(`/sessions/${sid(1)}/complete`) || path.endsWith(`/sessions/${sid(1)}/cancel`)) {
            lifecycle = path.endsWith('/complete') ? 'completed' : 'cancelled'; actions.push(lifecycle); return reply({});
        }
        if (path.endsWith('/management/sessions')) {
            const response = await route.fetch(), body = await response.json();
            body.result.sessions = body.result.sessions.filter(s => !(deleted && s.sessionId === sid(1))).map(s => lifecycle && s.sessionId === sid(1) ? { ...s, status: lifecycle } : s);
            return route.fulfill({ response, json: body });
        }
        return route.fallback();
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(base);
    await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
    await expect(panel(page, 'b').getByLabel('Session status')).toBeVisible();
    return { errors, actions, settings: () => settings, setFailure: n => { failure = n; }, failDeletion: () => { deleteFailure = true; }, deleteExternally: () => { deleted = true; } };
}

async function lifecycleAction(page, action) {
    await panel(page, 'a').getByRole('button', { name: 'Session control panel', exact: true }).click();
    await page.getByRole('button', { name: 'Terminate — mark completed, cancel, or delete this session', exact: true }).click();
    await page.locator('.ps-modal').getByRole('button', { name: action, exact: true }).click();
}
const allLeaves = f => f.settings().moa.dashboards.flatMap(d => moaLeaves(d.tree));

test('deleting in a pane resets all its chat and canvas bindings, persists, and allows replacement', async ({ page }) => {
    const f = await fixture(page);
    await expect(panel(page, 'a').locator('textarea')).toBeVisible();
    await lifecycleAction(page, 'Delete Session');
    await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toHaveCount(0); // confirmation alone changes nothing
    await page.locator('.ps-modal').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toBeVisible();
    await expect.poll(() => allLeaves(f).filter(n => n.sessionId === sid(1)).length).toBe(0);
    expect(f.actions).toEqual(['delete']);
    expect(f.settings().moa.dashboards.map(d => d.tree.ratio)).toEqual([37, 61]);
    await expect(panel(page, 'b')).toHaveAttribute('data-session-id', sid(2));
    await page.reload();
    await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
    await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toBeVisible();
    await page.getByRole('tab', { name: 'Other', exact: true }).click();
    for (const id of ['c', 'd']) await expect(panel(page, id).getByRole('button', { name: 'Choose session or canvas' })).toBeVisible();
    await panel(page, 'c').getByRole('button', { name: 'Choose session or canvas' }).click();
    await page.getByRole('dialog', { name: 'Sessions', exact: true }).locator(`.ps-session-list-button[data-session-id="${sid(2)}"]`).click();
    await page.getByRole('button', { name: 'Use chat', exact: true }).click();
    await expect(panel(page, 'c')).toHaveAttribute('data-session-id', sid(2));
    expect(f.errors).toEqual([]);
});

for (const [action, confirm, status] of [['Mark Completed', 'Complete', 'completed'], ['Cancel Session', 'Cancel Session', 'cancelled']]) {
    test(`${action} preserves bindings and readable history after reload`, async ({ page }) => {
        const f = await fixture(page);
        await lifecycleAction(page, action);
        await page.locator('.ps-modal').getByRole('button', { name: confirm, exact: true }).click();
        await expect.poll(() => f.actions).toEqual([status]);
        await expect(panel(page, 'a')).toHaveAttribute('data-session-id', sid(1));
        await expect(panel(page, 'a').locator('.ps-chat-panel')).toBeVisible();
        expect(allLeaves(f).filter(n => n.sessionId === sid(1))).toHaveLength(3);
        await page.reload();
        await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
        await expect(panel(page, 'a').locator('.ps-chat-panel')).toBeVisible();
        await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toHaveCount(0);
        expect(f.errors).toEqual([]);
    });
}

for (const status of [403, 404, 503]) {
    test(`startup HTTP ${status}: clear only confirmed unavailable sessions`, async ({ page }) => {
        const f = await fixture(page, { initialError: status });
        if (status === 503) {
            await expect(panel(page, 'a').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
            expect(allLeaves(f).filter(n => n.sessionId === sid(1))).toHaveLength(3);
            f.setFailure(0);
            await panel(page, 'a').getByRole('button', { name: 'Retry', exact: true }).click();
            await expect(panel(page, 'a').locator('.ps-chat-panel')).toBeVisible();
        } else {
            await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toBeVisible();
            await expect.poll(() => allLeaves(f).filter(n => n.sessionId === sid(1)).length).toBe(0);
        }
        expect(f.errors).toEqual([]);
    });
}

test('deletion from another client clears cached panes on the next session poll', async ({ page }) => {
    const f = await fixture(page);
    await expect(panel(page, 'a').locator('.ps-chat-panel')).toBeVisible();
    await panel(page, 'a').getByRole('button', { name: 'Session control panel', exact: true }).click();
    f.deleteExternally();
    await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toBeVisible({ timeout: 10000 });
    await expect.poll(() => allLeaves(f).filter(n => n.sessionId === sid(1)).length).toBe(0);
    await expect(page.getByRole('dialog', { name: 'Session control panel', exact: true })).toHaveCount(0);
    expect(f.errors).toEqual([]);
});

test('failed deletion keeps the pane and its bindings', async ({ page }) => {
    const f = await fixture(page);
    f.failDeletion();
    await lifecycleAction(page, 'Delete Session');
    await page.locator('.ps-modal').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => f.actions).toEqual(['delete']);
    await expect(panel(page, 'a').locator('.ps-chat-panel')).toBeVisible();
    expect(allLeaves(f).filter(n => n.sessionId === sid(1))).toHaveLength(3);
    await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toHaveCount(0);
    expect(f.errors).toEqual([]);
});

test('deleting from the normal workspace also clears inactive MoA bindings', async ({ page }) => {
    const f = await fixture(page);
    await page.getByRole('button', { name: /^Workspace/ }).click();
    await page.locator(`.ps-session-list-button[data-session-id="${sid(1)}"]`).click();
    await page.getByRole('button', { name: 'Terminate — mark completed, cancel, or delete this session', exact: true }).click();
    await page.locator('.ps-modal').getByRole('button', { name: 'Delete Session', exact: true }).click();
    await page.locator('.ps-modal').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => allLeaves(f).filter(n => n.sessionId === sid(1)).length).toBe(0);
    await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
    await expect(panel(page, 'a').getByRole('button', { name: 'Choose session or canvas' })).toBeVisible();
    expect(f.errors).toEqual([]);
});

test('absence from a filtered catalog never clears a valid session binding', async ({ page }) => {
    const f = await fixture(page);
    await page.route('**/api/v1/management/sessions**', route => new URL(route.request().url()).pathname === '/api/v1/management/sessions'
        ? route.fulfill({ json: { ok: true, result: { sessions: [], hasMore: false, nextCursor: null } } }) : route.fallback());
    await page.reload();
    await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
    await expect(panel(page, 'a').locator('.ps-chat-panel')).toBeVisible();
    await expect(panel(page, 'b').locator('.ps-chat-panel')).toBeVisible();
    expect(allLeaves(f).filter(n => n.sessionId === sid(1))).toHaveLength(3);
    expect(f.errors).toEqual([]);
});
