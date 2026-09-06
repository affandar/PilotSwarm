import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

test.use({ browserName: process.env.PS_TEST_BROWSER || 'chromium' });

const sessionId = '11111110-2222-3333-4444-555555555550';
const T0 = 1785000000000;
for (const mode of ['zen', 'moa']) for (const themeId of ['terminal-green', 'win95', 'winamp', 'ms-dos']) {
    test(`mobile ${mode} header replaces footer without layout jumps: ${themeId}`, async ({ page }) => {
        const stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 5, themeId });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let snapshot = { status: 'idle', statusVersion: 6, updatedAt: T0 };
        let reads = 0, sends = 0;
        const row = () => ({ sessionId, title: 'Footer regression', model: 'github-copilot:claude-sonnet-5',
            owner: { provider: 'none', subject: 'test', email: 'test@example.com', displayName: 'Test User' },
            createdAt: T0, ...snapshot });
        try {
            await page.route('**/api/v1/**', async route => {
                const request = route.request(), path = new URL(request.url()).pathname;
                const answer = result => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
                if (path.endsWith('/me/profile')) return answer({isAdmin:false,profileSettings:{themeId,moa:{version:2,tree:{id:'header-panel',type:'chat',sessionId},aspectRatio:2}}});
                if (path.endsWith('/management/sessions')) {
                    reads += 1;
                    return answer({ sessions: [row()], hasMore: false });
                }
                if (path.endsWith(`/sessions/${sessionId}`)) return answer(row());
                if (path.endsWith(`/sessions/${sessionId}/messages`)) { sends += 1; return answer({ queued: true }); }
                return route.fallback();
            });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
            await page.getByRole('button',{name:mode==='zen'?'Enter mobile zen':'Master of Agents',exact:true}).click();
            const surface=page.locator(mode==='zen'?'.ps-mobile-zen':'.ps-moa-workspace.is-mobile');
            const chat = surface.locator('.ps-chat-panel');
            const footer = surface.locator('.ps-mobile-session-status');
            const input = surface.locator('textarea');
            await expect(input).toBeVisible();
            await expect(footer).toBeVisible();
            if (mode==='zen') {
                const select=surface.getByRole('combobox',{name:'Select session'});
                expect(await select.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;})).toBe(true);
                expect((await select.boundingBox()).height).toBe(44);
            }
            await page.clock.install();
            async function update(fields) {
                snapshot = fields;
                const before = reads;
                await page.clock.fastForward(4100);
                await expect.poll(() => reads).toBeGreaterThan(before);
                // Give the response merge and layout their next animation frame.
                await page.clock.runFor(32);
            }
            const geometry = () => chat.evaluate(el => {
                const transcript = el.querySelector('.ps-scroll-panel').getBoundingClientRect();
                const header = document.querySelector('.ps-mobile-focus-header').getBoundingClientRect();
                return { transcriptBottom: transcript.bottom, headerTop: header.top, headerHeight: header.height };
            });
            const assertSame = async expected => {
                const actual = await geometry();
                for (const key of Object.keys(expected)) expect(Math.abs(actual[key] - expected[key]), key).toBeLessThan(1);
            };
            const idle = await geometry();
            await expect(chat.locator('.ps-panel-bottom-sticky')).toHaveCount(0);
            await update({ status: 'running', statusVersion: 5, updatedAt: T0 + 5000 });
            await expect(footer).not.toContainText('Working');
            await expect(chat.locator('.ps-panel-bottom-sticky')).toHaveCount(0);
            await assertSame(idle);
            await update({ status: 'running', statusVersion: 7, updatedAt: T0 + 1000 });
            await expect(footer).toContainText('Working');
            await expect(footer).toContainText('Working');
            await assertSame(idle);
            await update({ status: 'idle', statusVersion: 8, updatedAt: T0 + 2000 });
            await expect(footer).not.toContainText('Working');
            await expect(chat.locator('.ps-panel-bottom-sticky')).toHaveCount(0);
            await assertSame(idle);
            await update({ status: 'running', statusVersion: 9, updatedAt: T0 + 3000 });
            await expect(footer).toContainText('Working');
            await input.fill('Preserve this queued prompt');
            await surface.getByRole('button', { name: 'Send prompt', exact: true }).click();
            await page.clock.runFor(100);
            await expect.poll(() => sends).toBe(1);
            await expect(chat).toContainText('Preserve this queued prompt');
            await expect(footer).toContainText('1 queued');
            await assertSame(idle);
            expect(await chat.getByText(/Preserve this queued prompt/).count()).toBe(1);
            const queued = await geometry();
            await update({ status: 'idle', statusVersion: 8, updatedAt: T0 + 9000 });
            await expect(footer).toContainText('Working');
            await expect(chat).toContainText('Preserve this queued prompt');
            await expect(footer).toContainText('1 queued');
            await expect(footer).toContainText('Working');
            await assertSame(queued);
            await page.screenshot({path:`/tmp/mobile-header-${mode}-${themeId}.png`});
            const box = await surface.locator(mode==='zen'?'.ps-mobile-zen-composer':'.ps-moa-composer-strip').boundingBox();
            expect(Math.abs(box.y-(await geometry()).transcriptBottom)).toBeLessThan(5);
            expect(errors).toEqual([]);
        } finally { await new Promise(resolve => stub.server.close(resolve)); }
    });
}
