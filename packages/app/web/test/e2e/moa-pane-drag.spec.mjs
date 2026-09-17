import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
import { normalizeMoa, activeMoaDashboard } from '../../../ui/core/src/moa.js';
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 5, transcriptTurns: 40 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
const chat = (id, i) => ({ id, type: 'chat', sessionId: sid(i) });
const split = (id,direction,first,second,ratio=50) => ({ id,type:'split',direction,first,second,ratio });
const example = split('root','row',chat('super',1),split('right','column',chat('paw',2),split('bottom','row',chat('b',3),{id:'c',type:'empty'})),30);
const panel = (page,id) => page.locator(`[data-moa-panel="${id}"]`);
async function fixture(page, {tree=example,theme='terminal-green',composerMode='per-chat'} = {}) {
    let settings = { themeId:theme, moa:{...normalizeMoa({tree,focusedPanelId:'b'}),composerMode} };
    const errors=[], sends=[], reads=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/v1/**', async route => {
        const req=route.request(), path=new URL(req.url()).pathname;
        const reply=result=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result})});
        if (path.endsWith('/me/profile/settings')) { settings=structuredClone(req.postDataJSON().settings); return reply({profileSettings:settings}); }
        if (path.endsWith('/me/profile')) return reply({isAdmin:false,profileSettings:settings});
        if (/\/sessions\/[^/]+\/messages$/.test(path)) { sends.push({path,...req.postDataJSON()}); return reply({queued:true}); }
        if (/\/sessions\/[^/]+$/.test(path)) reads.push(path);
        return route.fallback();
    });
    await page.setViewportSize({width:1600,height:1000});
    await page.goto(base);
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    await expect(panel(page,'b')).toBeVisible();
    await expect(panel(page,'paw').getByLabel('Session status')).toContainText('Working');
    return {errors,sends,reads,tree:()=>activeMoaDashboard(settings.moa).tree};
}
async function startDrag(page,source,target,edge='center',extend=false) {
    const head=await panel(page,source).locator(':scope > header .ps-moa-panel-title').boundingBox();
    const box=await panel(page,target).boundingBox();
    const x=box.x+box.width*(edge==='left'?.06:edge==='right'?.94:.5);
    const y=box.y+box.height*(edge==='top'?.06:edge==='bottom'?.94:.5);
    await page.mouse.move(head.x+Math.min(40,head.width/2),head.y+head.height/2);
    await page.mouse.down();
    if (extend) await page.keyboard.down('Shift');
    await page.mouse.move(x,y,{steps:12});
    return {x,y};
}
const bounds = async(page,id)=>panel(page,id).boundingBox();
const near=(actual,expected)=>expect(Math.abs(actual-expected)).toBeLessThan(2);

for(const theme of ['terminal-green','win95','winamp','ms-dos','github-light','workspace-dark']) {
    test(`${theme}: preview extension, apply, undo and reload without losing the layout`,async({page})=>{
        const f=await fixture(page,{theme});
        const initial=structuredClone(f.tree()), superBox=await bounds(page,'super'), beforeB=await bounds(page,'b');
        await startDrag(page,'b','paw','left',true);
        await expect(page.locator('.ps-moa-drop-preview')).toHaveAttribute('data-drop-kind','extend');
        await expect(page.locator('.ps-moa-drag-hint')).toContainText('Extend upward');
        expect(f.tree()).toEqual(initial); // Preview alone must never persist.
        const source=page.locator('.ps-moa-preview-pane.is-source');
        const preview=await source.boundingBox();
        near(preview.y,superBox.y); near(preview.height,superBox.height);
        if(theme==='win95'||theme==='winamp') await page.screenshot({path:test.info().outputPath(`${theme}-drop-preview.png`)});
        await page.mouse.up(); await page.keyboard.up('Shift');
        await expect(page.locator('.ps-moa-drop-preview')).toHaveCount(0);
        const b=await bounds(page,'b'), paw=await bounds(page,'paw'), c=await bounds(page,'c');
        near(b.y,superBox.y); near(b.height,superBox.height); near(b.width,beforeB.width);
        near(paw.x,c.x); near(paw.width,c.width);
        expect(await bounds(page,'super')).toEqual(superBox);
        await expect.poll(()=>f.tree().second.direction).toBe('row');
        await page.getByRole('button',{name:'Undo',exact:true}).click();
        await expect.poll(()=>f.tree()).toEqual(initial);
        await startDrag(page,'b','paw','left',true); await page.mouse.up(); await page.keyboard.up('Shift');
        await expect.poll(()=>f.tree().second.direction).toBe('row');
        await page.reload();
        await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
        near((await bounds(page,'b')).height,(await bounds(page,'super')).height);
        expect(f.errors).toEqual([]);
    });
}

test('swap keeps pane DOM, draft, queued prompt, scroll position and connections',async({page})=>{
    const f=await fixture(page);
    const b=panel(page,'b');
    await b.locator(':scope > header').click();
    await b.locator('textarea').fill('queued before moving'); await b.locator('textarea').press('Enter');
    await expect.poll(()=>f.sends.length).toBe(1);
    await b.locator('textarea').fill('unsent draft stays here');
    // Hold actual DOM references: preserving IDs alone cannot prove the
    // controller or transcript survived a change in tree parentage.
    await b.evaluate(el=>{window.beforePane=el; window.beforeText=el.querySelector('textarea');});
    const oldB=await bounds(page,'b'), oldPaw=await bounds(page,'paw');
    const beforeReads=f.reads.length;
    const scrollNode=b.locator('.ps-chat-panel .ps-scroll-panel');
    await expect(scrollNode).toBeVisible();
    await scrollNode.evaluate(el=>{el.scrollTop=100; window.beforeScroll=el;});
    await expect.poll(()=>scrollNode.evaluate(el=>el.scrollTop)).toBe(100);
    await scrollNode.evaluate(el=>{
        const anchor=[...el.children].find(n=>n.getBoundingClientRect().bottom>el.getBoundingClientRect().top);
        window.dragAnchor=anchor;
        window.dragAnchorTop=anchor.getBoundingClientRect().top-el.getBoundingClientRect().top;
    });
    await startDrag(page,'b','paw');
    await expect(page.locator('.ps-moa-drop-preview')).toHaveAttribute('data-drop-kind','swap');
    await page.mouse.up();
    near((await bounds(page,'b')).x,oldPaw.x); near((await bounds(page,'paw')).y,oldB.y);
    expect(await b.evaluate(el=>el===window.beforePane&&el.querySelector('textarea')===window.beforeText)).toBe(true);
    await expect(b.locator('textarea')).toHaveValue('unsent draft stays here');
    await expect(b.locator('.ps-chat-panel')).toContainText('queued before moving');
    expect(await scrollNode.evaluate(el=>el===window.beforeScroll)).toBe(true);
    // A new width reflows earlier text. Compare the visible content anchor,
    // not the old pixel offset (which would move the reader to another line).
    expect(await scrollNode.evaluate(el=>Math.abs(window.dragAnchor.getBoundingClientRect().top-el.getBoundingClientRect().top-window.dragAnchorTop))).toBeLessThan(2);
    expect(f.reads.length).toBe(beforeReads);
    expect(f.sends).toHaveLength(1); expect(f.sends[0].path).toContain(sid(3));
    expect(f.errors).toEqual([]);
});

test('Escape in Zen cancels only the drag, and outside/self drops do nothing',async({page})=>{
    const f=await fixture(page);
    await page.getByRole('button',{name:'Enter zen',exact:true}).click();
    const before=structuredClone(f.tree());
    await startDrag(page,'b','paw','left'); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.ps-moa-drop-preview')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Exit zen',exact:true})).toBeVisible();
    expect(f.tree()).toEqual(before);
    await startDrag(page,'b','paw'); await page.mouse.move(0,0); await page.mouse.up();
    expect(f.tree()).toEqual(before);
    await startDrag(page,'b','b'); await expect(page.locator('.ps-moa-drop-preview')).toHaveAttribute('data-drop-kind','none'); await page.mouse.up();
    expect(f.tree()).toEqual(before); expect(f.errors).toEqual([]);
});

test('edge move, swap and keyboard divider resize still work after reshaping',async({page})=>{
    const f=await fixture(page);
    await startDrag(page,'super','paw','right'); await page.mouse.up();
    await expect.poll(()=>f.tree().first.direction).toBe('row');
    await startDrag(page,'b','paw'); await page.mouse.up();
    const seam=page.getByRole('separator').first();
    const ratio=Number(await seam.getAttribute('aria-valuenow'));
    await seam.focus(); await seam.press('ArrowRight');
    await expect(seam).toHaveAttribute('aria-valuenow',String(ratio+2));
    await expect(page.getByRole('button',{name:'Undo',exact:true})).toHaveCount(0); // stale undo must not erase a later edit
    expect(f.errors).toEqual([]);
});

test('buttons do not start drags; switching to mobile cancels a pending drag',async({page})=>{
    const f=await fixture(page);
    await panel(page,'b').locator(':scope > header').click();
    await panel(page,'b').getByRole('button',{name:'Session control panel'}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.ps-moa-drop-preview')).toHaveCount(0);
    await page.keyboard.press('Escape');
    const before=structuredClone(f.tree());
    await startDrag(page,'b','paw','left');
    await page.setViewportSize({width:390,height:844}); await page.mouse.up();
    await expect(page.locator('.ps-moa-drop-preview')).toHaveCount(0);
    expect(f.tree()).toEqual(before);
    await page.setViewportSize({width:1600,height:1000});
    expect(f.errors).toEqual([]);
});

test('canvas iframe and its own state survive swaps and T-junction rotations',async({page})=>{
    await page.route('**/api/v1/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname.endsWith('/events-before')&&url.search.includes('session.canvas_updated')) return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:[{seq:1,eventType:'session.canvas_updated',data:{slot:1,rev:1,sizeBytes:128,name:'Canvas one'}}]})});
        if(url.pathname.includes('/artifacts/')&&/canvas(?:2)?\.html/.test(url.pathname)) return route.fulfill({contentType:'text/html',body:'<!doctype html><input aria-label="Canvas draft"><button id="inside">Canvas one</button>'});
        return route.fallback();
    });
    const tree=structuredClone(example); tree.second.second.second={id:'c',type:'canvas',sessionId:sid(4),slot:1};
    const f=await fixture(page,{tree});
    const frame=panel(page,'c').locator('iframe').first();
    const input=frame.contentFrame().getByLabel('Canvas draft');
    await input.fill('iframe state survives');
    await frame.evaluate(el=>{window.beforeFrame=el;});
    await startDrag(page,'c','paw','right',true);
    await expect(page.locator('.ps-moa-drag-hint')).toContainText('Extend upward');
    await page.mouse.up(); await page.keyboard.up('Shift');
    expect(await frame.evaluate(el=>el===window.beforeFrame)).toBe(true);
    await expect(input).toHaveValue('iframe state survives');
    await startDrag(page,'b','c'); await page.mouse.up();
    expect(await frame.evaluate(el=>el===window.beforeFrame)).toBe(true);
    await expect(input).toHaveValue('iframe state survives');
    expect(f.errors).toEqual([]);
});

test('pointer cancellation and stray pointer releases cannot apply a move',async({page})=>{
    const f=await fixture(page), original=structuredClone(f.tree());
    await startDrag(page,'b','paw','left');
    await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{pointerId:99,clientX:500,clientY:200})));
    await expect(page.locator('.ps-moa-drop-preview')).toBeVisible();
    await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1})));
    await expect(page.locator('.ps-moa-drop-preview')).toHaveCount(0);
    await page.mouse.up(); expect(f.tree()).toEqual(original); expect(f.errors).toEqual([]);
});

test('dragging a divider resizes the correct nested region after a pane move',async({page})=>{
    const f=await fixture(page);
    await startDrag(page,'b','paw','left',true); await page.mouse.up(); await page.keyboard.up('Shift');
    const seam=page.locator('[data-moa-divider="bottom"]'), before=await bounds(page,'b'), superBefore=await bounds(page,'super');
    const box=await seam.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
    await page.mouse.move(box.x+80,box.y+box.height/2,{steps:8}); await page.mouse.up();
    expect((await bounds(page,'b')).width).toBeGreaterThan(before.width+60);
    expect(await bounds(page,'super')).toEqual(superBefore);
    await expect.poll(()=>f.tree().second.ratio).toBeGreaterThan(50);
    expect(f.errors).toEqual([]);
});

test('transcript headers and tiny header movements never rearrange panes',async({page})=>{
    const f=await fixture(page), original=structuredClone(f.tree());
    const b=panel(page,'b'), target=await bounds(page,'paw');
    const header=await b.locator(':scope > header .ps-moa-panel-title').boundingBox();
    await page.mouse.move(header.x+20,header.y+10); await page.mouse.down();
    await page.mouse.move(header.x+23,header.y+11); await page.mouse.up();
    await expect(page.locator('.ps-moa-drop-preview')).toHaveCount(0);
    expect(f.tree()).toEqual(original);
    // A card header is visually a header too, but belongs to transcript content.
    // Add a representative card to exercise the event boundary independently
    // of which fixture messages the renderer groups into a tool card.
    await b.locator('.ps-chat-panel .ps-scroll-panel').evaluate(el=>{
        const header=document.createElement('header'); header.textContent='Tool activity header';
        header.style.height='40px'; el.prepend(header); el.scrollTop=0;
    });
    const inner=await b.getByText('Tool activity header',{exact:true}).boundingBox();
    await page.mouse.move(inner.x+20,inner.y+10); await page.mouse.down();
    await page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:10});
    await expect(page.locator('.ps-moa-drop-preview')).toHaveCount(0);
    await page.mouse.up(); expect(f.tree()).toEqual(original); expect(f.errors).toEqual([]);
});

for (const edge of ['left','right','top','bottom']) {
    test(`plain ${edge} drop splits only the target 50/50`,async({page})=>{
        const f=await fixture(page);
        const initial=structuredClone(f.tree()), target=await bounds(page,'paw'), untouched=await bounds(page,'super');
        await startDrag(page,'b','paw',edge);
        await expect(page.locator('.ps-moa-drop-preview')).toHaveAttribute('data-drop-kind','move');
        await expect(page.locator('.ps-moa-drag-hint')).toContainText(`Split ${edge} half`);
        const preview=await page.locator('.ps-moa-preview-pane.is-source').boundingBox();
        const row=edge==='left'||edge==='right';
        near(preview.width,row?(target.width-8)/2:target.width);
        near(preview.height,row?target.height:(target.height-8)/2);
        expect(f.tree()).toEqual(initial);
        await page.mouse.up();
        const b=await bounds(page,'b'), paw=await bounds(page,'paw');
        near(b.width,preview.width); near(b.height,preview.height);
        near(paw.width,b.width); near(paw.height,b.height);
        if(edge==='left') near(b.x+b.width+8,paw.x);
        if(edge==='right') near(paw.x+paw.width+8,b.x);
        if(edge==='top') near(b.y+b.height+8,paw.y);
        if(edge==='bottom') near(paw.y+paw.height+8,b.y);
        expect(await bounds(page,'super')).toEqual(untouched);
        await expect.poll(()=>f.tree().second.first.ratio).toBe(50);
        await page.getByRole('button',{name:'Undo',exact:true}).click();
        await expect.poll(()=>f.tree()).toEqual(initial);
        expect(f.errors).toEqual([]);
    });
}

test('Shift toggles split and extension previews without moving the pointer',async({page})=>{
    const f=await fixture(page), original=structuredClone(f.tree());
    const target=await bounds(page,'paw'), superBox=await bounds(page,'super');
    await startDrag(page,'b','paw','left');
    await expect(page.locator('.ps-moa-drag-hint')).toContainText('Hold Shift to extend upward');
    near((await page.locator('.ps-moa-preview-pane.is-source').boundingBox()).height,target.height);
    await page.keyboard.down('Shift');
    await expect(page.locator('.ps-moa-drop-preview')).toHaveAttribute('data-drop-kind','extend');
    near((await page.locator('.ps-moa-preview-pane.is-source').boundingBox()).height,superBox.height);
    await expect(page.locator('.ps-moa-drag-hint')).toContainText('Release Shift');
    await page.keyboard.up('Shift');
    await expect(page.locator('.ps-moa-drop-preview')).toHaveAttribute('data-drop-kind','move');
    near((await page.locator('.ps-moa-preview-pane.is-source').boundingBox()).height,target.height);
    expect(f.tree()).toEqual(original);
    await page.mouse.up();
    near((await bounds(page,'b')).height,target.height);
    expect(f.errors).toEqual([]);
});

test('pane headers and control panel omit redundant focus and arrangement controls',async({page})=>{
    const f=await fixture(page);
    await expect(panel(page,'b')).toHaveClass(/is-focused/);
    await expect(page.locator('[data-moa-panel] > header').getByText('Focused',{exact:true})).toHaveCount(0);
    await panel(page,'b').getByRole('button',{name:'Session control panel'}).click();
    const menu=page.getByRole('dialog',{name:'Session control panel',exact:true});
    await expect(menu.getByRole('button',{name:/Move or swap/})).toHaveCount(0);
    await expect(menu.getByRole('button',{name:'Replace session or canvas…',exact:true})).toBeVisible();
    await expect(menu.getByRole('button',{name:'Split right',exact:true})).toBeVisible();
    await expect(menu.getByRole('button',{name:'Split below',exact:true})).toBeVisible();
    await expect(menu.getByRole('button',{name:'Close panel',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await panel(page,'c').locator(':scope > header').click();
    await expect(panel(page,'c')).toHaveClass(/is-focused/);
    await expect(panel(page,'c').getByText('Focused',{exact:true})).toHaveCount(0);
    expect(f.errors).toEqual([]);
});
