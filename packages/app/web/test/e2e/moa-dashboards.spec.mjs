import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
import { normalizeMoa, activeMoaDashboard } from '../../../ui/core/src/moa.js';

test.use({ browserName: process.env.PS_TEST_BROWSER || 'chromium' });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 4 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });
const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const chat = (i, id = `panel-${i}`) => ({ id, type: 'chat', sessionId: sid(i) });
const tree = { id: 'split', type: 'split', direction: 'row', ratio: 63, first: chat(1), second: chat(2) };
const composer = page => page.locator('.ps-moa-composer-strip textarea');
const workspace = page => page.locator('.ps-moa-workspace');
async function fixture(page, { moa = {version: 2, tree, aspectRatio: 2}, width = 1600, themeId = 'terminal-green', touchScale = false } = {}) {
    let settings = { moa, themeId, touchScale, touchScaleMobile: false };
    const sends = [], mutations = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    settings.moa = { ...settings.moa, composerMode: "shared" };
    await page.route('**/api/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const answer = result => route.fulfill({ json: {ok: true, result} });
        if (request.method() !== 'GET') mutations.push(path);
        if (path.endsWith('/me/profile/settings')) { settings = structuredClone(request.postDataJSON().settings); return answer({profileSettings: settings}); }
        if (path.endsWith('/me/profile')) return answer({isAdmin:false,profileSettings:settings});
        const send = /\/sessions\/([^/]+)\/messages$/.exec(path);
        if (send) { sends.push({ sessionId:send[1], ...request.postDataJSON() }); return answer({queued:true}); }
        return route.fallback();
    });
    await page.setViewportSize({width, height: width <= 920 ? 844 : 1000});
    await page.goto(base);
    await page.getByRole('button', {name:'Master of Agents', exact:true}).click();
    await expect(workspace(page)).toBeVisible();
    return { settings: () => settings, sends, mutations, errors };
}
async function choose(page, name) {
    const tab = page.getByRole('tab', {name, exact:true});
    if (await tab.isVisible()) await tab.click();
    else {
        await page.getByRole('button', {name:'Switch MoA dashboard', exact:true}).click();
        await page.locator('.ps-moa-dashboard-choice').filter({hasText:name}).click();
    }
}
const profiles = () => normalizeMoa({version:3, activeDashboardId:'ops', dashboards:[
    {id:'ops',name:'Operations',tree,aspectRatio:2,focusedPanelId:'panel-2'},
    {id:'research',name:'Research',tree:chat(1),aspectRatio:1.6},
    {id:'review',name:'Review',tree:chat(3)},
    {id:'build',name:'Build',tree:chat(4)},
    {id:'notes',name:'Notes',tree:null},
]});

test('migrates one layout, adds at most five dashboards, and safely renames and deletes', async ({page}) => {
    const f = await fixture(page);
    await expect(page.locator('[data-moa-panel]')).toHaveCount(2);
    await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow','63');
    for (let i = 2; i <= 5; i++) {
        await page.getByRole('button',{name:'Add MoA dashboard',exact:true}).click();
        await expect(page.getByRole('button',{name:'Add first MoA panel'})).toBeVisible();
    }
    await expect(page.getByRole('button',{name:'Add MoA dashboard',exact:true})).toBeDisabled();
    await expect.poll(()=>f.settings().moa.dashboards?.length).toBe(5);
    await page.getByRole('button',{name:'Dashboard options',exact:true}).click();
    await page.getByRole('textbox',{name:'Dashboard name'}).fill('Release review');
    await page.getByRole('button',{name:'Save dashboard name'}).click();
    await expect.poll(()=>activeMoaDashboard(f.settings().moa).name).toBe('Release review');
    await choose(page,'MoA 1');
    await expect(page.locator('[data-moa-panel]')).toHaveCount(2);
    await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow','63');
    await choose(page,'Release review');
    await page.getByRole('button',{name:'Dashboard options',exact:true}).click();
    await page.getByRole('button',{name:'Delete dashboard',exact:true}).click();
    await expect.poll(()=>f.settings().moa.dashboards.length).toBe(5);
    await page.getByRole('button',{name:'Confirm delete dashboard'}).click();
    await expect.poll(()=>f.settings().moa.dashboards.length).toBe(4);
    await expect(workspace(page)).toHaveAttribute('data-dashboard-id','moa-1');
    expect(f.mutations.filter(p=>!p.endsWith('/me/profile/settings'))).toEqual([]);
    expect(f.errors).toEqual([]);
});

test('desktop tabs drag into a persisted profile order and support keyboard reordering', async ({page}) => {
    const moa=normalizeMoa({version:3,activeDashboardId:'ops',dashboards:profiles().dashboards.slice(0,3)});
    const f=await fixture(page,{moa,width:2000});
    const operations=page.getByRole('tab',{name:'Operations',exact:true});
    const review=page.getByRole('tab',{name:'Review',exact:true});
    await page.getByRole('tab',{name:'Research',exact:true}).click();
    const from=await operations.boundingBox(), to=await review.boundingBox();
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);
    await page.mouse.down();
    await page.mouse.move(to.x+to.width*.8,to.y+to.height/2,{steps:8});
    await page.mouse.up();
    await expect.poll(()=>f.settings().moa.dashboards.map(d=>d.id)).toEqual(['research','review','ops']);
    // pointerup may or may not synthesize a click depending on where the tab
    // was dropped. Either way, the next intentional click must never be lost.
    await operations.click();
    await expect(operations).toHaveAttribute('aria-selected','true');
    await operations.focus();
    await operations.press('Alt+Shift+ArrowLeft');
    await expect.poll(()=>f.settings().moa.dashboards.map(d=>d.id)).toEqual(['research','ops','review']);
    await page.reload();
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    expect(await page.getByRole('tab').allTextContents()).toEqual(['Research','Operations','Review']);
    expect(f.errors).toEqual([]);
});

test('only the visible dashboard refreshes and revisiting it paints from memory immediately', async ({page}) => {
    const sessionRequests=[];
    page.on('request',request=>{ const path=new URL(request.url()).pathname; if(path.includes('/sessions/')) sessionRequests.push(path); });
    const f=await fixture(page,{moa:profiles()});
    await expect(composer(page)).toBeVisible();
    expect(sessionRequests.some(path=>path.includes(sid(3)))).toBe(false);
    expect(sessionRequests.some(path=>path.includes(sid(4)))).toBe(false);
    await choose(page,'Review');
    await expect.poll(()=>sessionRequests.some(path=>path.includes(sid(3)))).toBe(true);
    await expect(page.locator('[data-dashboard-view-id="review"]')).not.toContainText('Connecting…');
    await choose(page,'Operations');
    await expect(page.locator('[data-dashboard-view-id="ops"]')).not.toContainText('Connecting…');
    await page.waitForTimeout(4200);
    expect(sessionRequests.some(path=>path.includes(sid(4)))).toBe(false);
    await choose(page,'Review');
    await expect(page.locator('[data-dashboard-view-id="review"]')).not.toContainText('Connecting…');
    expect(f.errors).toEqual([]);
});

test('a stale dashboard load cannot suspend the controller resumed by a newer visit', async ({page}) => {
    let releaseFirst, firstStarted;
    const held = new Promise(resolve => { releaseFirst = resolve; });
    const started = new Promise(resolve => { firstStarted = resolve; });
    let alphaGets = 0;
    await page.route(`**/api/v1/sessions/${sid(1)}`, async route => {
        if (route.request().method() !== 'GET') return route.fallback();
        alphaGets++;
        if (alphaGets === 1) { firstStarted(); await held; }
        return route.fallback();
    });
    const moa = normalizeMoa({ version: 3, activeDashboardId: 'alpha', dashboards: [
        { id: 'alpha', name: 'Alpha', tree: chat(1) },
        { id: 'beta', name: 'Beta', tree: chat(2) },
    ] });
    try {
        const f = await fixture(page, { moa });
        await started;
        await choose(page, 'Beta');
        await expect(composer(page)).toBeVisible();
        await choose(page, 'Alpha');
        await expect.poll(() => alphaGets).toBeGreaterThanOrEqual(2);
        await expect(composer(page)).toBeVisible();
        releaseFirst();
        const afterRelease = alphaGets;
        // The visible controller polls every four seconds. The obsolete first
        // load used to clear this newer timer and detach its live subscription.
        await expect.poll(() => alphaGets, { timeout: 7_000 }).toBeGreaterThan(afterRelease);
        await expect(page.getByRole('navigation', { name: 'Master of Agents' }).getByRole('button')).toHaveCount(2);
        expect(f.errors).toEqual([]);
    } finally { releaseFirst(); }
});

test('a late history load cannot leave a hidden cached dashboard subscribed', async ({page}) => {
    let releaseFirst, firstStarted;
    const held = new Promise(resolve => { releaseFirst = resolve; });
    const started = new Promise(resolve => { firstStarted = resolve; });
    let alphaHistoryGets = 0;
    const sockets = new Map();
    const connections = new Set();
    await page.routeWebSocket('**/api/v1/ws', ws => {
        connections.add(ws);
        ws.onMessage(raw => {
            const message = JSON.parse(raw);
            if (message.type === 'subscribeLive') sockets.set(message.sessionId, ws);
        });
    });
    await page.route(`**/api/v1/management/sessions/${sid(1)}/events?*`, async route => {
        alphaHistoryGets++;
        if (alphaHistoryGets === 1) { firstStarted(); await held; }
        return route.fallback();
    });
    const moa = normalizeMoa({ version: 3, activeDashboardId: 'alpha', dashboards: [
        { id: 'alpha', name: 'Alpha', tree: chat(1) },
        { id: 'beta', name: 'Beta', tree: chat(2) },
    ] });
    try {
        const f = await fixture(page, { moa });
        await started;
        await choose(page, 'Beta');
        await expect(composer(page)).toBeVisible();
        await choose(page, 'Alpha');
        // Re-entry shares the in-flight read instead of starting a second one.
        expect(alphaHistoryGets).toBe(1);
        await expect(workspace(page)).toHaveAttribute('data-dashboard-id', 'alpha');
        await choose(page, 'Beta');
        await expect(composer(page)).toBeVisible();
        const historyResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/management/sessions/${sid(1)}/events`);
        releaseFirst();
        await historyResponse;
        await page.waitForTimeout(250);

        const marker = 'HIDDEN_CACHE_MUST_IGNORE_THIS';
        expect(sockets.has(sid(1))).toBe(false);
        for (const socket of connections) socket.send(JSON.stringify({ type: 'sessionEvent', sessionId: sid(1), event: {
            sessionId: sid(1), seq: 1_000_000, eventType: 'assistant.message', createdAt: Date.now(),
            data: { messageId: 'hidden-cache-event', content: marker },
        } }));
        await page.waitForTimeout(250);
        await expect(page.locator('[data-dashboard-view-id="alpha"]')).not.toContainText(marker);
        expect(f.errors).toEqual([]);
    } finally { releaseFirst(); }
});

test('dashboard switching preserves each layout, selection and session draft, then reloads the active dashboard', async ({page}) => {
    const f=await fixture(page,{moa:profiles()});
    await expect(composer(page)).toBeVisible();
    await composer(page).fill('draft for session two');
    await page.locator('[data-moa-panel="panel-1"] > header').click();
    await composer(page).fill('draft for session one');
    await choose(page,'Research');
    await expect(page.locator('[data-moa-panel]')).toHaveCount(1);
    await expect(composer(page)).toHaveValue('draft for session one');
    await composer(page).fill('updated in research');
    await choose(page,'Operations');
    await expect(page.locator('[data-moa-panel="panel-1"]')).toHaveClass(/is-focused/);
    await expect(composer(page)).toHaveValue('updated in research');
    await page.locator('[data-moa-panel="panel-2"] > header').click();
    await expect(composer(page)).toHaveValue('draft for session two');
    await choose(page,'Review');
    await expect.poll(()=>f.settings().moa.activeDashboardId).toBe('review');
    await page.reload();
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    await expect(workspace(page)).toHaveAttribute('data-dashboard-id','review');
    await choose(page,'Operations');
    await expect(page.locator('[data-moa-panel="panel-2"]')).toHaveClass(/is-focused/);
    await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow','63');
    expect(f.errors).toEqual([]);
});

test('mobile picker preserves map geometry and switching only sends to the selected session', async ({page}) => {
    const f=await fixture(page,{moa:profiles(),width:390});
    await expect(composer(page)).toBeVisible();
    await composer(page).fill('keep session two');
    await page.getByRole('button',{name:'Switch MoA dashboard'}).click();
    const preview=page.locator('.ps-moa-dashboard-choice').filter({hasText:'Operations'}).locator('.ps-moa-dashboard-preview');
    const dimensions=await preview.evaluate(n=>({w:n.clientWidth,h:n.clientHeight,first:n.firstChild.getBoundingClientRect().width}));
    expect(dimensions.w/dimensions.h).toBeCloseTo(2,0);
    expect(dimensions.first/dimensions.w).toBeCloseTo(.63,1);
    await page.screenshot({path:`/tmp/moa-dashboards-${process.env.PS_TEST_BROWSER||'chromium'}-mobile-picker.png`});
    await page.locator('.ps-moa-dashboard-choice').filter({hasText:'Research'}).click();
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('only send to research');
    await page.locator('.ps-moa-composer-strip .ps-send-button').click();
    await expect.poll(()=>f.sends.length).toBe(1);
    expect(f.sends[0].sessionId).toBe(sid(1));
    await choose(page,'Operations');
    await expect(composer(page)).toHaveValue('keep session two');
    await page.getByRole('button',{name:'Open panel map'}).click();
    await page.locator('.ps-moa-map-list button').first().click();
    await expect(page.locator('[data-moa-panel="panel-1"]')).toBeVisible();
    expect(f.errors).toEqual([]);
});

test('mobile uses one compact header and does not expose dashboard reordering', async ({page}) => {
    const f=await fixture(page,{moa:profiles(),width:390});
    await expect(page.locator('.ps-moa-mobile-dashboard-bar')).toHaveCount(0);
    const header=page.locator('.ps-mobile-focus-header');
    const trigger=header.getByRole('button',{name:'Switch MoA dashboard'});
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText('');
    await expect(trigger).toHaveAttribute('aria-haspopup','dialog');
    await expect(header).not.toContainText('Operations');
    const title=header.locator('.ps-mobile-session-name');
    await expect(title).toContainText('Session 2');
    const titleBox=await title.boundingBox(), triggerBox=await trigger.boundingBox();
    expect(titleBox.x+titleBox.width).toBeLessThan(triggerBox.x);
    expect(triggerBox.width).toBeGreaterThanOrEqual(44);
    expect(390-triggerBox.x-triggerBox.width).toBeLessThanOrEqual(10);
    await trigger.click();
    await expect(page.getByRole('dialog',{name:'MoA dashboards',exact:true})).toBeVisible();
    await expect(page.locator('.ps-moa-dashboard-picker [draggable="true"]')).toHaveCount(0);
    expect(f.errors).toEqual([]);
});

for (const themeId of ['terminal-green','win95','winamp','ms-dos']) for (const touchScale of [false,true]) test(`${themeId}, touch scale ${touchScale}: resizing collapses tabs and never overlaps icons`, async ({page}) => {
    const moa=profiles(); moa.dashboards[0].name='Operations with a very long dashboard name';
    const f=await fixture(page,{moa,themeId,touchScale});
    for (const width of [1920,1600,1280,1024,921,820,390,320,1280,1920]) {
        await page.setViewportSize({width,height:width<=920?844:1000});
        await expect(workspace(page)).toBeVisible();
        await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const container=page.locator(width<=920?'.ps-mobile-focus-header':'.ps-toolbar.is-moa');
        await expect.poll(()=>container.evaluate(root=>{
            const boxes=[...root.querySelectorAll('button')].filter(b=>b.getClientRects().length && getComputedStyle(b).visibility!=='hidden').map(b=>({label:b.getAttribute('aria-label')||b.textContent,r:b.getBoundingClientRect()}));
            const problems=[];
            for (const [i,a] of boxes.entries()) {
                if(a.r.width<30||a.r.left < -1||a.r.right>innerWidth+1) problems.push(`bounds:${a.label}`);
                for(const b of boxes.slice(i+1)) if(Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1 && Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1) problems.push(`overlap:${a.label}/${b.label}`);
            }
            return problems;
        })).toEqual([]);
        if(width===1024) await expect(page.getByRole('button',{name:'Switch MoA dashboard'})).toBeVisible();
        if(width===390) await page.screenshot({path:`/tmp/moa-dashboards-${themeId}${touchScale?'-touch':''}-mobile.png`});
    }
    await page.screenshot({path:`/tmp/moa-dashboards-${themeId}${touchScale?'-touch':''}-desktop.png`});
    expect(f.errors).toEqual([]);
});

const sharedSessionDashboards = () => normalizeMoa({version:3, activeDashboardId:'first', dashboards:[
    {id:'first',name:'First dashboard',tree:chat(1,'first-panel')},
    {id:'second',name:'Second dashboard',tree:chat(1,'second-panel')},
]});
async function stageImage(page) {
    await composer(page).evaluate(el => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array([137,80,78,71])], 'review-image.png', {type:'image/png'}));
        el.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data}));
    });
    await expect(page.locator('.ps-moa-composer-strip .ps-prompt-attachments img')).toHaveAttribute('alt','review-image.png');
}

for (const newerText of ['', 'new draft written while the image uploads']) test(`an image send completing in another dashboard ${newerText ? 'preserves newer typing' : 'clears the consumed draft'}`, async ({page}) => {
    const f=await fixture(page,{moa:sharedSessionDashboards()});
    let releaseUpload, uploadStarted;
    const started=new Promise(resolve=>{uploadStarted=resolve;});
    const held=new Promise(resolve=>{releaseUpload=resolve;});
    await page.route(`**/api/v1/sessions/${sid(1)}/artifacts/**`,async route=>{
        if(route.request().method()!=='PUT') return route.fallback();
        uploadStarted(); await held;
        return route.fulfill({json:{ok:true,result:{filename:'review-image.png'}}});
    });
    try {
        await composer(page).fill('submitted with an image'); await stageImage(page);
        await composer(page).press('Enter'); await started;
        await choose(page,'Second dashboard');
        await expect(composer(page)).toHaveValue('submitted with an image');
        if(newerText) await composer(page).fill(newerText);
        releaseUpload();
        await expect.poll(()=>f.sends.length).toBe(1);
        expect(f.sends[0].sessionId).toBe(sid(1));
        expect(f.sends[0].prompt).toBe('submitted with an image');
        expect(f.sends[0].options.attachments).toHaveLength(1);
        await expect(composer(page)).toHaveValue(newerText);
        if(!newerText) await expect(page.locator('.ps-moa-composer-strip .ps-prompt-attachments')).toHaveCount(0);
        await choose(page,'First dashboard');
        await expect(composer(page)).toHaveValue(newerText);
        if(!newerText) await expect(page.locator('.ps-moa-composer-strip .ps-prompt-attachments')).toHaveCount(0);
        expect(f.sends).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { releaseUpload(); }
});

test('failed image upload keeps the draft and attachment after switching dashboards', async ({page}) => {
    const f=await fixture(page,{moa:sharedSessionDashboards()});
    let releaseUpload, uploadStarted;
    const started=new Promise(resolve=>{uploadStarted=resolve;});
    const held=new Promise(resolve=>{releaseUpload=resolve;});
    await page.route(`**/api/v1/sessions/${sid(1)}/artifacts/**`,async route=>{
        if(route.request().method()!=='PUT') return route.fallback();
        uploadStarted(); await held;
        return route.fulfill({status:503,json:{ok:false,error:{code:'UNAVAILABLE',message:'Upload unavailable'}}});
    });
    try {
        await composer(page).fill('keep this failed upload'); await stageImage(page);
        await composer(page).press('Enter'); await started;
        await choose(page,'Second dashboard'); releaseUpload();
        await expect(composer(page)).toHaveValue('keep this failed upload');
        await choose(page,'First dashboard');
        await expect(composer(page)).toHaveValue('keep this failed upload');
        await expect(page.locator('.ps-moa-composer-strip .ps-prompt-attachments img')).toHaveAttribute('alt','review-image.png');
        expect(f.sends).toEqual([]); expect(f.errors).toEqual([]);
    } finally { releaseUpload(); }
});

test('failed enqueue moves its original deduplication IDs to the new dashboard without replacing newer text', async ({page}) => {
    const f=await fixture(page,{moa:sharedSessionDashboards()});
    let releaseSend, sendStarted;
    const started=new Promise(resolve=>{sendStarted=resolve;});
    const held=new Promise(resolve=>{releaseSend=resolve;});
    const attempts=[];
    await page.route(`**/api/v1/sessions/${sid(1)}/messages`,async route=>{
        attempts.push(route.request().postDataJSON());
        if(attempts.length===1) {
            sendStarted(); await held;
            return route.fulfill({status:503,json:{ok:false,error:{code:'UNAVAILABLE',message:'Enqueue unavailable'}}});
        }
        return route.fulfill({json:{ok:true,result:{queued:true}}});
    });
    try {
        await composer(page).fill('outbound message needing retry');
        await composer(page).press('Enter'); await started;
        await choose(page,'Second dashboard');
        await composer(page).fill('new draft after switching');
        releaseSend();
        await expect.poll(()=>attempts.length).toBe(2);
        expect(attempts[1].prompt).toBe('outbound message needing retry');
        expect(attempts[1].options.clientMessageIds).toEqual(attempts[0].options.clientMessageIds);
        await expect(composer(page)).toHaveValue('new draft after switching');
        await choose(page,'First dashboard');
        await expect(composer(page)).toHaveValue('new draft after switching');
        expect(attempts).toHaveLength(2); expect(f.errors).toEqual([]);
    } finally { releaseSend(); }
});

test('switching during an automatic retry retains the failed outbound and its original IDs', async ({page}) => {
    const f=await fixture(page,{moa:sharedSessionDashboards()});
    let releaseRetry, retryStarted;
    const started=new Promise(resolve=>{retryStarted=resolve;});
    const held=new Promise(resolve=>{releaseRetry=resolve;});
    const attempts=[];
    await page.route(`**/api/v1/sessions/${sid(1)}/messages`,async route=>{
        attempts.push(route.request().postDataJSON());
        if(attempts.length===2) { retryStarted(); await held; }
        if(attempts.length<=2) return route.fulfill({status:503,json:{ok:false,error:{code:'UNAVAILABLE',message:'Enqueue unavailable'}}});
        return route.fulfill({json:{ok:true,result:{queued:true}}});
    });
    try {
        await composer(page).fill('failed before dashboard switching');
        await composer(page).press('Enter'); await started;
        await choose(page,'Second dashboard');
        await composer(page).fill('new draft while retry completes');
        releaseRetry();
        await expect.poll(()=>attempts.length).toBe(3);
        expect(attempts[2].prompt).toBe('failed before dashboard switching');
        expect(attempts[2].options.clientMessageIds).toEqual(attempts[0].options.clientMessageIds);
        await expect(composer(page)).toHaveValue('new draft while retry completes');
        await choose(page,'First dashboard');
        await expect(composer(page)).toHaveValue('new draft while retry completes');
        expect(attempts).toHaveLength(3); expect(f.errors).toEqual([]);
    } finally { releaseRetry(); }
});

test('keyboard addition focuses the empty dashboard and Tab remains usable', async ({page}) => {
    const f=await fixture(page,{moa:{version:2,tree:null}});
    const add=page.getByRole('button',{name:'Add MoA dashboard',exact:true});
    await add.focus(); await add.press('Enter');
    await expect(page.getByRole('button',{name:'Add first MoA panel'})).toBeFocused();
    await page.keyboard.press('Tab');
    // The first-panel button is the last document control; one Tab may cross
    // the browser chrome before returning to the document on the next Tab.
    await page.keyboard.press('Tab');
    await expect.poll(()=>page.evaluate(()=>document.activeElement.tagName)).not.toBe('BODY');
    await expect.poll(()=>f.settings().moa.dashboards?.length).toBe(2);
    expect(f.errors).toEqual([]);
});

test('returning to the initially focused canvas selects its session composer', async ({page}) => {
    const canvas={id:'initial-canvas',type:'canvas',sessionId:sid(1),slot:2};
    await page.route('**/api/v1/**',route=>{
        const url=new URL(route.request().url());
        if(url.pathname.endsWith('/events-before')&&url.search.includes('session.canvas_updated')) return route.fulfill({json:{ok:true,result:[{seq:1,eventType:'session.canvas_updated',data:{slot:2,rev:1,sizeBytes:200,name:'Interactive canvas'}}]}});
        if(url.pathname.includes('/artifacts/')&&/canvas2\.html/.test(url.pathname)) return route.fulfill({contentType:'text/html',body:'<!doctype html><button>Focus canvas content</button>'});
        return route.fallback();
    });
    const f=await fixture(page,{moa:{version:3,activeDashboardId:'canvas-dashboard',dashboards:[{id:'canvas-dashboard',name:'Canvas dashboard',focusedPanelId:canvas.id,tree:{...tree,first:canvas}}]}});
    const panel=page.locator('[data-moa-panel="initial-canvas"]');
    const inside=panel.locator('iframe').contentFrame().getByRole('button',{name:'Focus canvas content'});
    await expect(inside).toBeVisible(); await expect(composer(page)).toBeVisible();
    await composer(page).fill('canvas session draft');
    await page.locator('[data-moa-panel="panel-2"] > header').click();
    await expect(composer(page)).toHaveValue(''); await composer(page).fill('other session draft');
    await inside.click();
    await expect(panel).toHaveClass(/is-focused/);
    await expect(composer(page)).toHaveValue('canvas session draft');
    expect(f.errors).toEqual([]);
});
