import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

test.use({ browserName: process.env.PS_TEST_BROWSER || 'chromium', viewport: {width:390,height:844} });
let stub,base;
test.beforeAll(async()=>{stub=await startStubServer(0,{sessionCount:8});base=`http://127.0.0.1:${stub.port}`;});
test.afterAll(async()=>{await new Promise(r=>stub.server.close(r));});
async function open(page) {
    // iOS keeps the layout viewport tall while the keyboard shrinks AND pans
    // the visual viewport. setViewportSize alone does not reproduce this.
    await page.addInitScript(()=>{
        const vv=new EventTarget();
        Object.assign(vv,{width:390,height:844,offsetTop:0,offsetLeft:0,pageTop:0,pageLeft:0,scale:1});
        Object.defineProperty(window,'visualViewport',{value:vv,configurable:true});
        window.moveVisualViewport=(height,top)=>{vv.height=height;vv.offsetTop=top;vv.pageTop=top;vv.dispatchEvent(new Event('resize'));vv.dispatchEvent(new Event('scroll'));};
    });
    await page.goto(base);
    await expect(page.locator('.ps-mobile-chat-pane textarea')).toBeVisible();
}
const move=(page,height,top)=>page.evaluate(([h,t])=>window.moveVisualViewport(h,t),[height,top]);
async function fits(page,height,top) {
    await expect.poll(async()=>Math.round((await page.locator('.portal-app-shell').boundingBox()).height)).toBe(height);
    await expect.poll(async()=>Math.round((await page.locator('.portal-app-shell').boundingBox()).y)).toBe(top);
}
test('composer keyboard leaves no ghost session row and follows Safari pan, then restores',async({page})=>{
    await open(page);
    const input=page.locator('.ps-mobile-chat-pane textarea');
    await input.fill('preserve my reply');
    await move(page,360,150);
    await expect(page.locator('body')).toHaveClass(/ps-kb-takeover/);
    await fits(page,360,150);
    await expect(page.locator('.ps-mobile-session-pane')).toBeHidden();
    const chat=await page.locator('.ps-mobile-chat-pane').boundingBox();
    expect(chat.y).toBeLessThan(220);
    const composer=await input.boundingBox();
    expect(composer.y+composer.height).toBeLessThanOrEqual(510);
    expect(chat.height).toBeGreaterThan(260);
    await move(page,345,175);await fits(page,345,175);
    await page.screenshot({path:'/tmp/mobile-keyboard-fixed.png'});
    // Safari swipe-dismiss does not blur the textarea.
    await move(page,844,0);await fits(page,844,0);
    await expect(page.locator('body')).not.toHaveClass(/ps-kb-takeover/);
    await expect(page.locator('.portal-header')).toBeVisible();
    await expect(page.locator('.ps-mobile-session-pane')).toBeVisible();
    await expect(input).toHaveValue('preserve my reply');
});
test('session search stays visible and focused while the keyboard pans the viewport',async({page})=>{
    await open(page);
    const pane=page.locator('.ps-mobile-session-pane');
    await pane.getByRole('button',{name:'Search sessions'}).click();
    const input=pane.getByRole('textbox',{name:'Find a session'});
    await input.fill('Session');
    await move(page,400,110);await fits(page,400,110);
    await expect(page.locator('body')).not.toHaveClass(/ps-kb-takeover/);
    await expect(input).toBeFocused();
    const box=await input.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(110);expect(box.y+box.height).toBeLessThanOrEqual(510);
    await move(page,844,0);await fits(page,844,0);
    await expect(input).toHaveValue('Session');
});
