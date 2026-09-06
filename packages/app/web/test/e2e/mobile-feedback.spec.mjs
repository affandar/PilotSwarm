import { test, expect, chromium, webkit } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
let stub;
test.beforeAll(async()=>{stub=await startStubServer(0,{sessionCount:20});});
test.afterAll(async()=>new Promise(r=>stub.server.close(r)));
for (const browserName of ['chromium', 'webkit']) {
 test.describe(browserName, () => {

 for (const themeId of ['terminal-green', 'win95', 'winamp', 'ms-dos']) {
 test(`mobile controls and keyboard picker: ${themeId}`,async()=>{
 const browser=await ({chromium,webkit}[browserName]).launch();
 const page=await browser.newPage();
 try {
 await page.route('**/api/v1/me/profile', route=>route.fulfill({json:{ok:true,result:{isAdmin:false,profileSettings:{themeId,sessionDetailCollapsed:false}}}}));
 await page.setViewportSize({width:390,height:844});
 await page.goto(`http://127.0.0.1:${stub.port}`);
 const maximize=page.locator('.ps-chat-panel').getByRole('button',{name:'Enter mobile zen'});
 await expect(maximize).toBeVisible();
 await expect(page.locator('.ps-toolbar').getByRole('button',{name:'Enter mobile zen'})).toHaveCount(0);
 const label=await page.locator('.ps-prompt-label').boundingBox(), input=await page.locator('.ps-prompt-input').boundingBox();
 expect(Math.abs(label.y+label.height/2-input.y-input.height/2)).toBeLessThan(2);
 const status=await page.locator('.ps-chat-panel .ps-panel-title-right').boundingBox();
 expect((await maximize.boundingBox()).x).toBeGreaterThanOrEqual(status.x+status.width);
 const main=page.getByRole('button',{name:'Main — sessions and chat (tap for chat only)',exact:true});
 await main.dispatchEvent('pointerdown',{pointerType:'touch',clientX:330,clientY:100});
 const tip=page.getByRole('tooltip'); await expect(tip).toBeVisible();
 const box=await tip.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390);expect(box.y+box.height).toBeLessThanOrEqual(844);
 await main.dispatchEvent('pointerup',{pointerType:'touch'});
 await maximize.click(); await expect(page.locator('.ps-mobile-zen')).toBeVisible();
 await page.getByRole('button',{name:'Exit mobile zen'}).click();
 await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
 await page.getByRole('button',{name:'Add first MoA panel'}).click();
 const search=page.getByRole('textbox',{name:'Find a session'});
 await expect(search).not.toBeFocused();
 await expect(page.locator('.ps-moa-session-picker .ps-session-list-button').first()).toBeVisible();
 await page.setViewportSize({width:390,height:360}); await search.focus();
 await expect.poll(async()=>{const dialog=await page.getByRole('dialog',{name:'Sessions',exact:true}).boundingBox();return dialog.y+dialog.height;}).toBeLessThanOrEqual(360);
 const list=await page.locator('.ps-moa-session-picker .ps-session-list').boundingBox();expect(list.height).toBeGreaterThan(60);
 await expect(page.getByRole('button',{name:'Close dialog'})).toBeVisible();
 await search.fill('Session');
 await expect(page.locator('.ps-moa-session-picker .ps-session-list-button').first()).toBeVisible();
 await page.screenshot({path:`/tmp/mobile-picker-${browserName}-${themeId}.png`});
 await page.locator('.ps-moa-session-picker .ps-session-list-button').first().click();
 await page.getByRole('button',{name:'Use chat',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Sessions',exact:true})).toHaveCount(0);
 } finally { await browser.close(); }
 });
 }
 });
}
