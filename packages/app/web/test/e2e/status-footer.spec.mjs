import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

const sessionId = '11111110-2222-3333-4444-555555555550';
const T0 = 1785000000000;
for (const themeId of ['terminal-green', 'win95', 'winamp', 'ms-dos']) {
    test(`mobile footer stays stable through stale status races: ${themeId}`, async ({ page }) => {
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
            const chat = page.locator('.ps-chat-panel');
            const footer = chat.locator('.ps-panel-bottom-sticky');
            const stop = chat.getByRole('button', { name: 'Stop the current turn', exact: true });
            const input = chat.locator('textarea');
            await expect(input).toBeVisible();
            await expect(footer).toBeVisible();
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
                const footer = el.querySelector('.ps-panel-bottom-sticky').getBoundingClientRect();
                return { transcriptBottom: transcript.bottom, footerTop: footer.top, footerHeight: footer.height };
            });
            const assertSame = async expected => {
                const actual = await geometry();
                for (const key of Object.keys(expected)) expect(Math.abs(actual[key] - expected[key]), key).toBeLessThan(1);
            };
            const idle = await geometry();
            await expect(stop).toHaveCount(0);
            await update({ status: 'running', statusVersion: 5, updatedAt: T0 + 5000 });
            await expect(footer).not.toContainText('Working');
            await expect(stop).toHaveCount(0);
            await assertSame(idle);
            await update({ status: 'running', statusVersion: 7, updatedAt: T0 + 1000 });
            await expect(footer).toContainText('Working');
            await expect(stop).toBeVisible();
            await assertSame(idle);
            await update({ status: 'idle', statusVersion: 8, updatedAt: T0 + 2000 });
            await expect(footer).not.toContainText('Working');
            await expect(stop).toHaveCount(0);
            await assertSame(idle);
            await update({ status: 'running', statusVersion: 9, updatedAt: T0 + 3000 });
            await expect(stop).toBeVisible();
            await input.fill('Preserve this queued prompt');
            await chat.getByRole('button', { name: 'Send prompt', exact: true }).click();
            await page.clock.runFor(100);
            await expect.poll(() => sends).toBe(1);
            await expect(footer).toContainText('Preserve this queued prompt');
            const queued = await geometry();
            await update({ status: 'idle', statusVersion: 8, updatedAt: T0 + 9000 });
            await expect(stop).toBeVisible();
            await expect(footer).toContainText('Preserve this queued prompt');
            await expect(footer).toContainText('Working');
            await assertSame(queued);
            expect(errors).toEqual([]);
        } finally { await new Promise(resolve => stub.server.close(resolve)); }
    });
}
