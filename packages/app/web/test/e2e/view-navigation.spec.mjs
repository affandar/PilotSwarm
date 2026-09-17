import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { normalizeMoa } from "../../../ui/core/src/moa.js";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4, transcriptTurns: 80 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const main = page => page.locator('.ps-chat-panel:visible');
const back = page => page.getByRole('button', { name: /^Back.*\((Alt|Option)\+/ });
const forward = page => page.getByRole('button', { name: /^Forward.*\((Alt|Option)\+/ });
const row = (page, i) => page.locator(`.ps-session-list-button[data-session-id="${sid(i)}"]`);
const saved = page => page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(k => k.startsWith('pilotswarm.view-history.v1:'));
    return key ? JSON.parse(sessionStorage.getItem(key)) : null;
});
async function fixture(page, themeId = 'terminal-green', width = 1600, {reviewPanelId = 'two', fullHeader = false, admin = false, touchScale = false} = {}) {
    if (fullHeader) {
        const persona = {id:'test',displayName:'Test User With a Longer Display Name',email:'test.user@example.com'};
        await page.addInitScript(persona => { if(window === window.top) sessionStorage.setItem('pilotswarm.devAuth.persona',JSON.stringify(persona)); }, persona);
        await page.route('**/api/portal-config', route => route.fulfill({json:{ok:true,auth:{enabled:true,provider:'dev',client:{users:[persona]}},portal:{branding:{title:'PilotSwarm'}}}}));
        await page.route('**/api/auth/me', route => route.fulfill({json:{ok:true,principal:{provider:'dev',subject:'test',displayName:persona.displayName,email:persona.email},authorization:{allowed:true,role:'user'}}}));
    }
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let settings = { themeId, touchScale, moa: normalizeMoa({ version:3, activeDashboardId:'ops', dashboards:[
        { id:'ops', name:'Operations', tree:{id:'one',type:'chat',sessionId:sid(1)}, focusedPanelId:'one' },
        { id:'review', name:'Review', tree:{id:reviewPanelId,type:'chat',sessionId:sid(2)}, focusedPanelId:reviewPanelId },
    ] }) };
    await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/bootstrap')) return route.fulfill({json:{ok:true,result:{auth:{principal:{provider:'none',subject:'test',email:'test@example.com'},authorization:{allowed:true,role:'user'}}}}});
        if (path.endsWith('/me/profile/settings')) { settings = route.request().postDataJSON().settings; return route.fulfill({json:{ok:true,result:{profileSettings:settings}}}); }
        if (path.endsWith('/me/profile')) return route.fulfill({json:{ok:true,result:{isAdmin:admin,profileSettings:settings}}});
        return route.fallback();
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(base + `/?session=${sid(0)}`);
    await expect(main(page).locator('textarea')).toBeVisible();
    await expect.poll(async () => Boolean(await saved(page))).toBe(true);
    if(fullHeader) await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
    return { errors };
}
async function select(page, i) { await row(page, i).click(); await expect(main(page)).toContainText(`Session ${i}`); }

test('session Back/Forward preserves drafts and branches after new navigation', async ({page}) => {
    const f = await fixture(page);
    await select(page, 1); await main(page).locator('textarea').fill('unfinished first draft');
    await select(page, 2); await main(page).locator('textarea').fill('unfinished second draft');
    await back(page).click(); await expect(main(page).locator('textarea')).toHaveValue('unfinished first draft');
    await forward(page).click(); await expect(main(page).locator('textarea')).toHaveValue('unfinished second draft');
    await back(page).click(); await select(page, 3); await expect(forward(page)).toBeDisabled();
    await back(page).click(); await expect(main(page).locator('textarea')).toHaveValue('unfinished first draft');
    expect(f.errors).toEqual([]);
});

test('Focus switches with cached content before blocked REST, and Back survives late completion', async ({page}) => {
    const f = await fixture(page);
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    const panel = page.locator('[data-moa-panel="one"]');
    await expect(panel.locator('textarea')).toBeVisible();
    await panel.locator('textarea').fill('MoA draft');
    let release; const gate = new Promise(resolve => { release = resolve; });
    let blocked = 0;
    await page.route(new RegExp(`/sessions/${sid(1)}(?:/events)?(?:\\?.*)?$`), async route => { blocked++; await gate; return route.fallback(); });
    await panel.getByRole('button',{name:'Focus panel',exact:true}).click();
    await expect(page.locator('.ps-moa-workspace')).not.toBeVisible();
    await expect(main(page).locator('textarea')).toHaveValue('MoA draft');
    await expect(main(page)).toContainText('Assessment 79');
    await expect.poll(() => blocked).toBeGreaterThan(0);
    await back(page).click(); await expect(page.locator('.ps-moa-workspace')).toBeVisible();
    release();
    await expect(panel.locator('textarea')).toHaveValue('MoA draft');
    await expect.poll(async () => (await saved(page)).entries[(await saved(page)).index].mode).toBe('moa');
    expect(f.errors).toEqual([]);
});

test('dashboard visits count, panel activity and polling do not, and history is capped at ten', async ({page}) => {
    await fixture(page);
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    await page.getByRole('tab',{name:'Review',exact:true}).click();
    await back(page).click(); await expect(page.locator('.ps-moa-workspace')).toHaveAttribute('data-dashboard-id','ops');
    const before = (await saved(page)).entries.length;
    await page.locator('[data-moa-panel="one"] header').first().click();
    await page.waitForTimeout(4300);
    expect((await saved(page)).entries.length).toBe(before);
    await forward(page).click(); await expect(page.locator('.ps-moa-workspace')).toHaveAttribute('data-dashboard-id','review');
    await page.getByRole('button',{name:'Workspace — sessions, chat and panels',exact:true}).click();
    for (let i=0; i<12; i++) await select(page, 1 + i%3);
    expect((await saved(page)).entries).toHaveLength(10);
});

test('shortcuts work in composers, preserve drafts and zoom, and disappear on mobile', async ({page}) => {
    const f = await fixture(page);
    await select(page,1); await main(page).locator('textarea').fill('first draft');
    await select(page,2); await main(page).locator('textarea').fill('second draft');
    await page.keyboard.press('Alt+-');
    await expect(main(page)).toContainText('Session 1');
    await expect(main(page).locator('textarea')).toHaveValue('first draft');
    await main(page).locator('textarea').focus(); await page.keyboard.press('Alt+Shift+=');
    await expect(main(page)).toContainText('Session 2');
    await expect(main(page).locator('textarea')).toHaveValue('second draft');
    const prior = (await saved(page)).index;
    const prevented = await page.evaluate(() => {
        const event = new KeyboardEvent('keydown',{key:'-',code:'Minus',ctrlKey:true,bubbles:true,cancelable:true});
        document.body.dispatchEvent(event); return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    await page.setViewportSize({width:390,height:844});
    await expect(back(page)).toHaveCount(0); await expect(forward(page)).toHaveCount(0);
    await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Alt+-');
    expect((await saved(page)).index).toBe(prior);
    expect(f.errors).toEqual([]);
});

test('composer shortcuts cross MoA and workspace while search and modal editors keep their keys', async ({page}) => {
    const f = await fixture(page);
    await select(page,2); await main(page).locator('textarea').fill('workspace draft');
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    const moaComposer = page.locator('[data-moa-panel="one"] textarea');
    await moaComposer.fill('MoA draft'); await moaComposer.press('Alt+-');
    await expect(page.locator('.ps-moa-workspace')).not.toBeVisible();
    await expect(main(page).locator('textarea')).toHaveValue('workspace draft');
    await main(page).locator('textarea').press('Alt+=');
    await expect(moaComposer).toHaveValue('MoA draft');
    await moaComposer.press('Alt+-');
    const prior = (await saved(page)).index;
    const search = page.locator('.ps-session-search input');
    await search.focus(); await search.press('Alt+-');
    expect((await saved(page)).index).toBe(prior);
    await page.getByRole('button',{name:'Theme',exact:true}).click();
    await expect(page.locator('.ps-modal-backdrop')).toBeVisible();
    await page.keyboard.press('Alt+-');
    expect((await saved(page)).index).toBe(prior);
    await expect(page.locator('.ps-modal-backdrop')).toBeVisible();
    expect(f.errors).toEqual([]);
});

for (const theme of ['terminal-green','win95','winamp','ms-dos']) test(`${theme}: arrows sit between Filter and Canvas without overflowing`, async ({page}) => {
    await fixture(page, theme); await select(page,1);
    const filter = await page.getByRole('button',{name:'Filter sessions',exact:true}).boundingBox();
    const b = await back(page).boundingBox(), f = await forward(page).boundingBox();
    const canvas = await page.getByRole('button',{name:/^(Show canvas|Hide the canvas)$/}).boundingBox();
    expect(b.x).toBeGreaterThanOrEqual(filter.x + filter.width);
    expect(f.x).toBeGreaterThanOrEqual(b.x+b.width); expect(canvas.x).toBeGreaterThanOrEqual(f.x+f.width);
    expect(Math.abs(b.y-filter.y)).toBeLessThan(2); expect(Math.abs(f.y-canvas.y)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({path:test.info().outputPath(`${theme}-navigation.png`)});
});

test('slow artifact completion never reopens it over Back, and Forward restores it', async ({page}) => {
    await page.route('**/sessions/*/events*', route => {
        const match = /\/sessions\/([^/]+)\/events$/.exec(new URL(route.request().url()).pathname);
        if (!match) return route.fallback();
        const id = match[1];
        return route.fulfill({json:{ok:true,result:[{seq:1,eventType:'assistant.message',timestamp:1785000000000,data:{content:`Review [changes.csv](artifact://${id}/changes.csv)`}}]}});
    });
    await fixture(page); await select(page,1);
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/artifacts/changes.csv/text', async route => { await gate; return route.fallback(); });
    try {
        await main(page).locator('.ps-artifact-card').first().click();
        await expect(page.locator('.ps-artifact-pane')).toBeVisible();
        await back(page).click(); await expect(page.locator('.ps-artifact-pane')).toHaveCount(0);
        release();
        await forward(page).click(); await expect(page.locator('.ps-artifact-pane')).toBeVisible();
        await expect(page.locator('.ps-artifact-pane')).toContainText('Bulk pgindent');
        await back(page).click(); await expect(page.locator('.ps-artifact-pane')).toHaveCount(0);
    } finally { release(); }
});

test('a revoked session fails closed and Forward still reaches the accessible session', async ({page}) => {
    await fixture(page); await select(page,1); await select(page,2);
    await page.route(new RegExp(`/sessions/${sid(1)}(?:/.*)?(?:\\?.*)?$`), route => route.fulfill({status:403,json:{ok:false,error:{code:'FORBIDDEN',message:'Access revoked'}}}));
    await back(page).click();
    await expect(main(page)).not.toContainText('Assessment 79');
    await forward(page).click(); await expect(main(page)).toContainText('Session 2');
    await expect(main(page)).toContainText('Assessment 79');
});

test('scrolling up remains paused after navigating away and back', async ({page}) => {
    await fixture(page); await select(page,1);
    const viewport = main(page).locator('.ps-scroll-panel');
    await expect(main(page)).toContainText('Assessment 79');
    await viewport.evaluate(el => { el.scrollTop = 500; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const offset = await viewport.evaluate(el => el.scrollTop);
    await select(page,2); await back(page).click();
    await expect.poll(() => viewport.evaluate((el, expected) => Math.abs(el.scrollTop-expected), offset)).toBeLessThan(20);
});

test('narrow desktop keeps arrows usable, mobile MoA omits them completely', async ({page}) => {
    await fixture(page);
    for (const width of [1280,1024,921]) {
        await page.setViewportSize({width,height:900});
        await expect(back(page)).toBeVisible(); await expect(forward(page)).toBeVisible();
        const b=await back(page).boundingBox(), f=await forward(page).boundingBox();
        expect(b.x).toBeGreaterThanOrEqual(0); expect(f.x+f.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    await expect(back(page)).toHaveCount(0); await expect(forward(page)).toHaveCount(0);
});

test('history persists only references and uses separate storage for another principal', async ({page}) => {
    await fixture(page); await select(page,1); await select(page,2);
    await main(page).locator('textarea').fill('private unsent draft');
    const old = await saved(page);
    await page.reload();
    await expect.poll(async () => (await saved(page)).entries.length).toBeGreaterThanOrEqual(old.entries.length);
    expect(JSON.stringify(await saved(page))).not.toContain('private unsent draft');
    await page.route('**/api/v1/bootstrap', route => route.fulfill({json:{ok:true,result:{auth:{principal:{provider:'none',subject:'different'},authorization:{allowed:true,role:'user'}}}}}));
    await page.reload();
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(k=>k.startsWith('pilotswarm.view-history.v1:')).length)).toBe(2);
    const next = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k=>k.includes('different')))));
    expect(next.entries.length).toBe(1);
});

test('cached pane ownership is scoped to its dashboard even when panel IDs are reused', async ({page}) => {
    await fixture(page, 'terminal-green', 1600, {reviewPanelId:'one'});
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    await expect(page.locator('[data-moa-panel="one"]')).toContainText('Assessment 79');
    await page.getByRole('tab',{name:'Review',exact:true}).click();
    await expect(page.locator('[data-moa-panel="one"]')).toContainText('Assessment 79');
    await page.getByRole('tab',{name:'Operations',exact:true}).click();
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route(new RegExp(`/sessions/${sid(1)}(?:/.*)?(?:\\?.*)?$`), async route => { await gate; return route.fallback(); });
    try {
        await page.locator('[data-moa-panel="one"]').getByRole('button',{name:'Focus panel',exact:true}).click();
        await expect(main(page)).toContainText('Session 1');
        await expect(main(page)).toContainText('Assessment 79');
    } finally { release(); }
});

test('asynchronous session creation becomes a history destination', async ({page}) => {
    const created = '99999999-2222-3333-4444-555555555555';
    await fixture(page); await select(page,1);
    await page.route('**/api/v1/**', async route => {
        const request=route.request(), path=new URL(request.url()).pathname;
        const answer=result=>route.fulfill({json:{ok:true,result}});
        if(path.endsWith('/models')) return answer([{providerId:'test',modelName:'test-model',qualifiedName:'test:test-model'}]);
        if(path.endsWith('/providers')) return answer({providers:[{name:'test',typeId:'test',class:'shared',hasCredential:true,usableByMe:true}]});
        if(path.endsWith('/providers/status')) return answer({providers:[]});
        if(path.endsWith('/defaults')) return answer({});
        if(path.endsWith('/sessions') && request.method()==='POST') return answer({sessionId:created});
        if(path.endsWith(`/sessions/${created}`)) return answer({sessionId:created,title:'Created during navigation test',status:'idle',events:[],messages:[]});
        return route.fallback();
    });
    await page.getByRole('button',{name:'New session — choose model and agent',exact:true}).click();
    await expect(page.getByText('Select model for new session',{exact:true})).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(main(page)).toContainText('Created during navigation test');
    await expect.poll(async () => { const h=await saved(page); return h.entries[h.index].sessionId; }).toBe(created);
    await back(page).click(); await expect(main(page)).toContainText('Session 1');
});

test('Back and Forward restore canvas, diagnostics, Budget and Settings modes', async ({page}) => {
    await fixture(page); await select(page,1);
    await page.getByRole('button',{name:'Show canvas',exact:true}).click();
    await expect(page.locator('.ps-canvas-layer:not(.is-hidden)')).toBeVisible();
    await page.getByRole('button',{name:'Show diagnostics (inspector and activity)',exact:true}).click();
    await page.getByRole('button',{name:'Budget — providers, limits and usage',exact:true}).click();
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await expect(page.locator('.ps-admin-console__header h2')).toBeVisible();
    await back(page).click();
    await expect(page.getByRole('button',{name:'Close budget',exact:true})).toBeVisible();
    await expect(page.locator('.ps-admin-console__header h2')).toHaveCount(0);
    await back(page).click();
    await expect(page.getByRole('button',{name:'Hide the canvas',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Hide diagnostics',exact:true})).toBeVisible();
    await back(page).click();
    await expect(page.getByRole('button',{name:'Show diagnostics (inspector and activity)',exact:true})).toBeVisible();
    await back(page).click();
    await expect(page.getByRole('button',{name:'Show canvas',exact:true})).toBeVisible();
    await forward(page).click();
    await expect(page.locator('.ps-canvas-layer:not(.is-hidden)')).toBeVisible();
});

async function chooseDashboard(page, name) {
    const tab = page.getByRole('tab', {name, exact:true});
    if (await tab.isVisible()) await tab.click();
    else {
        await page.getByRole('button', {name:'Switch MoA dashboard', exact:true}).click();
        await page.locator('.ps-moa-dashboard-choice').filter({hasText:name}).click();
    }
}
async function headerGeometry(page) {
    return page.locator('.portal-header').evaluate(header => {
        const buttons = [...header.querySelectorAll('button, select')].filter(button => {
            const r = button.getBoundingClientRect();
            return r.width && r.height && getComputedStyle(button).visibility !== 'hidden';
        });
        const rect = button => {
            const {x,y,width,height} = button.getBoundingClientRect();
            return {x,y,width,height};
        };
        const label = button => button.getAttribute('aria-label') || button.title || button.textContent;
        const collisions = buttons.flatMap((a,i) => buttons.slice(i+1).filter(b => {
            const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
            return Math.min(ar.right,br.right)-Math.max(ar.left,br.left)>1 && Math.min(ar.bottom,br.bottom)-Math.max(ar.top,br.top)>1;
        }).map(b=>[label(a),label(b)]));
        const clipped = buttons.filter(b => {
            const r=b.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            return !b.contains(hit);
        }).map(label);
        return {
            back: rect(buttons.find(b=>/^Back.*\((Alt|Option)\+/.test(label(b)))),
            forward: rect(buttons.find(b=>/^Forward.*\((Alt|Option)\+/.test(label(b)))),
            collisions, clipped, overflow: document.documentElement.scrollWidth>innerWidth,
        };
    });
}
const geometryCases = ['rust','terminal-green','win95','winamp','ms-dos'].flatMap(theme => [1920,1280,921].map(width => ({theme,width})));
geometryCases.push({theme:'terminal-green',width:1600}, {theme:'terminal-green',width:1024}, {theme:'rust',width:1440,admin:true,touchScale:true}, {theme:'win95',width:1024,admin:true,touchScale:true});
for (const {theme,width,admin=false,touchScale=false} of geometryCases) test(`${theme} ${width}px: identical navigation coordinates across desktop screens`, async ({page}) => {
    await page.route('**/api/v1/**', async route => {
        const url=new URL(route.request().url());
        if(url.pathname.endsWith('/events-before') && url.search.includes('session.canvas_updated')) return route.fulfill({json:{ok:true,result:[1,2].map(slot=>({seq:slot,eventType:'session.canvas_updated',data:{slot,rev:1,sizeBytes:128,name:`Long canvas display name for slot ${slot}`}}))}});
        if(url.pathname.includes('/artifacts/') && /canvas(?:2)?\.html/.test(url.pathname)) return route.fulfill({contentType:'text/html',body:'<!doctype html><h1>Navigation canvas fixture</h1>'});
        return route.fallback();
    });
    const f=await fixture(page,theme,width,{fullHeader:true,admin,touchScale});
    await expect(page.locator('html')).toHaveAttribute('data-ps-theme',theme);
    const baseline=await headerGeometry(page);
    const check=async mode=> {
        await expect.poll(async()=> {
            const g=await headerGeometry(page);
            return Math.max(...['back','forward'].flatMap(key=>['x','y','width','height'].map(axis=>Math.abs(g[key][axis]-baseline[key][axis]))));
        }, {message:`${mode}: navigation must stay at the workspace coordinates`}).toBeLessThan(0.5);
        const g=await headerGeometry(page);
        expect(g.collisions,`${mode}: header controls must not overlap`).toEqual([]);
        expect(g.clipped,`${mode}: header controls must remain reachable`).toEqual([]);
        expect(g.overflow,`${mode}: no horizontal page scroll`).toBe(false);
    };
    await check('workspace');
    await page.getByRole('button',{name:'Show canvas',exact:true}).click();
    await page.getByRole('button',{name:'Full screen canvas',exact:true}).waitFor();
    await expect(page.locator('.ps-canvas-layer:not(.is-hidden) iframe').first().contentFrame().getByRole('heading',{name:'Navigation canvas fixture'})).toBeVisible();
    await check('inset canvas');
    await page.getByRole('button',{name:'Full screen canvas',exact:true}).click();
    await expect(page.getByRole('button',{name:'Restore canvas',exact:true})).toBeVisible();
    await expect(page.locator('.portal-header').getByRole('button',{name:'Zoom out',exact:true})).toBeVisible();
    await expect(page.locator('.portal-header').getByRole('combobox',{name:'Choose canvas',exact:true})).toBeVisible();
    await check('maximized canvas');
    if(theme==='win95') await expect(page.locator('.portal-header').getByRole('button',{name:'Zoom out',exact:true})).toHaveCSS('color','rgb(255, 255, 255)');
    await page.screenshot({path:test.info().outputPath('maximized-canvas.png')});
    await page.getByRole('button',{name:'Restore canvas',exact:true}).click();
    await check('restored canvas');
    await page.getByRole('button',{name:'Show diagnostics (inspector and activity)',exact:true}).click();
    await check('diagnostics');
    await page.getByRole('button',{name:'Budget — providers, limits and usage',exact:true}).click();
    await check('Budget');
    await page.getByRole('button',{name:admin?'Admin console':'Settings',exact:true}).click();
    await expect(page.locator('.ps-admin-console__header h2')).toBeVisible();
    await check(admin?'Admin console':'Settings');
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    await expect(page.getByRole('button',{name:'Clear MoA layout',exact:true})).toBeVisible();
    await check('MoA');
    const clear=await page.getByRole('button',{name:'Clear MoA layout',exact:true}).boundingBox();
    const zen=await page.getByRole('button',{name:'Enter zen',exact:true}).boundingBox();
    expect(clear.x+clear.width).toBeLessThan(baseline.back.x);
    expect(zen.x).toBeGreaterThan(baseline.forward.x+baseline.forward.width);
    expect(clear.y).toBe(baseline.back.y); expect(zen.y).toBe(baseline.forward.y);
    await chooseDashboard(page,'Review'); await check('another MoA dashboard');
    await page.screenshot({path:test.info().outputPath('moa.png')});
    await page.getByRole('button',{name:'Enter zen',exact:true}).click();
    await expect(page.locator('.portal-header')).not.toBeVisible();
    await page.getByRole('button',{name:'Exit zen',exact:true}).click();
    await check('leaving MoA zen');
    await page.getByRole('button',{name:'Workspace — sessions, chat and panels',exact:true}).click();
    await check('returning to workspace');
    expect(f.errors).toEqual([]);
});
