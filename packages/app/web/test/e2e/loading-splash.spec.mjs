import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const mobile of [false, true]) {
    test(`history loading keeps splash with a footer (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
        await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route('**/api/v1/management/sessions/*/events*', async route => {
            await gate;
            await route.fulfill({ json: { ok: true, result: [] } });
        });
        await page.route('**/api/portal-config', route => route.fulfill({ json: {
            ok: true, portal: { branding: {
                title: 'PilotSwarm', splash: '{cyan-fg}DEFAULT SPLASH ART{/cyan-fg}',
                splashMobile: '{cyan-fg}MOBILE SPLASH ART{/cyan-fg}',
            } },
        } }));
        await page.goto(`http://127.0.0.1:${stub.port}/?session=11111110-2222-3333-4444-555555555550`);
        const art = page.getByText(mobile ? 'MOBILE SPLASH ART' : 'DEFAULT SPLASH ART', { exact: true });
        const footer = page.getByText('Loading conversation…', { exact: true }).filter({ visible: true });
        try {
            await expect(art).toBeVisible();
            await expect(footer).toBeVisible();
            const artBox = await art.boundingBox(), footerBox = await footer.boundingBox();
            expect(footerBox.y).toBeGreaterThan(artBox.y);
            await page.screenshot({ path: `/tmp/loading-splash-${mobile ? 'mobile' : 'desktop'}.png` });
        } finally { release(); }
        await expect(footer).toHaveCount(0);
        await expect(art).toBeVisible();
    });
}
