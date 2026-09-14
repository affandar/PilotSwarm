import { test, expect, chromium, webkit } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const group = (suffix, title, updatedAt) => ({ groupId: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee${suffix}`, title,
    memberCount: 2, createdAt: 1785000000000, updatedAt });
const groups = [group('1', 'First folder', 1785000000010), group('2', 'Second folder', 1785000000020)];
let stub, base;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 8, groups,
        groupMembers: { 2: groups[0].groupId, 3: groups[0].groupId, 4: groups[1].groupId, 5: groups[1].groupId },
        parents: { 1: 0 }, themeId: 'doom' });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

async function fixture(page) {
    let settings = { themeId: 'doom', collapsedSessionIds: [], pinnedSessionIds: [sid(6)],
        sessionOrder: [`group:${groups[0].groupId}`, `group:${groups[1].groupId}`, sid(2), sid(3), sid(4), sid(5)],
        sessionUsedAt: { [sid(3)]: 300, [sid(2)]: 200, [sid(5)]: 500, [sid(4)]: 400 } };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const system = row => row?.sessionId === sid(0) ? { ...row, title: 'PilotSwarm', isSystem: true, agentId: 'pilotswarm' }
        : row?.sessionId === sid(1) ? { ...row, title: 'Sweeper Agent', isSystem: true, agentId: 'sweeper' } : row;
    await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const answer = result => route.fulfill({ json: { ok: true, result } });
        if (path.endsWith('/me/profile/settings')) { settings = route.request().postDataJSON().settings; return answer({ profileSettings: settings }); }
        if (path.endsWith('/me/profile')) return answer({ isAdmin: true, profileSettings: settings });
        if (path.endsWith('/management/sessions') || path === '/api/v1/sessions' || /\/sessions\/[^/]+$/.test(path)) {
            const json = await (await route.fetch()).json();
            if (Array.isArray(json.result)) json.result = json.result.map(system);
            else if (json.result?.sessions) json.result.sessions = json.result.sessions.map(system);
            else json.result = system(json.result);
            return route.fulfill({ json });
        }
        return route.fallback();
    });
    await page.goto(`${base}/?session=${sid(0)}`);
    await expect(page.locator(`[data-session-id="${sid(1)}"]`).first()).toBeVisible();
    return errors;
}

for (const browserName of ['chromium', 'webkit']) test.describe(browserName, () => {
    for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }, { width: 740, height: 400 }]) {
        test(`sort controls keep systems and folders reachable at ${viewport.width}x${viewport.height}`, async () => {
            const browser = await ({ chromium, webkit })[browserName].launch();
            const page = await browser.newPage({ viewport, hasTouch: viewport.width < 921, isMobile: viewport.width < 921 });
            try {
                const errors = await fixture(page);
                const pane = page.locator('.ps-session-pane:visible').first();
                const rows = pane.locator('.ps-session-list-button');
                const ids = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.sessionId));
                const folderG = `group:${groups[0].groupId}`, folderH = `group:${groups[1].groupId}`;
                for (const [label, expected] of [
                    ['Recently used', [sid(0), sid(1), sid(6), folderG, sid(3), sid(2), folderH, sid(5), sid(4), sid(7)]],
                    ['Recently updated', [sid(0), sid(1), sid(6), folderH, sid(5), sid(4), folderG, sid(3), sid(2), sid(7)]],
                    ['Saved order', [sid(0), sid(1), sid(6), folderG, sid(2), sid(3), folderH, sid(4), sid(5), sid(7)]],
                ]) {
                    await pane.getByRole('button', { name: label, exact: true }).click();
                    await expect.poll(ids).toEqual(expected);
                    await pane.getByRole('button', { name: 'Refresh session order', exact: true }).click();
                    await expect.poll(ids).toEqual(expected);
                    // A DOM row can still exist while a scrolling ancestor clips it.
                    const bounds = await pane.evaluate(el => {
                        const pane = el.getBoundingClientRect();
                        const body = el.querySelector('.ps-panel-body').getBoundingClientRect();
                        const list = el.querySelector('.ps-session-list').getBoundingClientRect();
                        const root = el.querySelector('.ps-session-list-button').getBoundingClientRect();
                        const buttons = [...el.querySelectorAll('.ps-session-sort-controls button')].map(button => {
                            const rect = button.getBoundingClientRect();
                            return { top: rect.top, bottom: rect.bottom, hit: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
                        });
                        return { paneBottom: pane.bottom, bodyTop: body.top, rootTop: root.top, listHeight: list.height, buttons };
                    });
                    expect(bounds.rootTop).toBeGreaterThanOrEqual(bounds.bodyTop - 1);
                    expect(bounds.listHeight).toBeGreaterThanOrEqual(20);
                    for (const button of bounds.buttons) {
                        expect(button.bottom).toBeLessThanOrEqual(bounds.paneBottom);
                        expect(button.hit).toBe(true);
                    }
                }
                await page.screenshot({ path: `/tmp/session-sort-${browserName}-${viewport.width}.png` });
                expect(errors).toEqual([]);
            } finally {
                await page.unrouteAll({ behavior: 'wait' });
                await browser.close();
            }
        });
    }
});
