import { test, expect, chromium, webkit } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
let stub;
test.beforeAll(async()=>{stub=await startStubServer(0,{sessionCount:4});});
test.afterAll(async()=>new Promise(r=>stub.server.close(r)));
for (const engine of ['chromium','webkit']) {
 test(`touch-only panel split, bind and remove: ${engine}`,async()=>{
  const browser=await ({chromium,webkit}[engine]).launch();
  try {
   const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
   let settings={moa:{version:2,tree:null,aspectRatio:2}};
   await page.route('**/api/v1/me/profile', r=>r.fulfill({json:{ok:true,result:{isAdmin:false,profileSettings:settings}}}));
   await page.route('**/api/v1/me/profile/settings',r=>{settings=r.request().postDataJSON().settings;return r.fulfill({json:{ok:true,result:{profileSettings:settings}}});});
   await page.goto(`http://127.0.0.1:${stub.port}`);
   await page.getByRole('button',{name:'Master of Agents',exact:true}).tap();
   const controls=page.locator('.ps-mobile-focus-header').getByRole('button',{name:'Session control panel',exact:true});
   const bounds=await controls.boundingBox();expect(bounds.width).toBeGreaterThanOrEqual(44);expect(bounds.height).toBeGreaterThanOrEqual(44);
   await controls.tap();
   await page.getByRole('dialog',{name:'Session control panel',exact:true}).getByRole('button',{name:'Split right',exact:true}).tap();
   await expect(page.locator('.ps-moa-panel.is-focused')).toHaveAttribute('aria-label','Empty panel');
   await page.getByRole('button',{name:'Choose session or canvas',exact:true}).tap();
   await page.locator('.ps-moa-session-picker .ps-session-list-button').nth(1).tap();
   await page.getByRole('button',{name:'Use chat',exact:true}).tap();
   await expect(page.locator('.ps-moa-panel.is-focused')).toHaveAttribute('data-session-id',/\w/);
   await expect(page.locator('.ps-moa-composer-host textarea')).toBeVisible();
   await page.locator('.ps-moa-composer-host textarea').fill('Keep this draft');
   await controls.tap();
   await page.getByRole('dialog',{name:'Session control panel',exact:true}).getByRole('button',{name:'Split below',exact:true}).tap();
   await expect(page.getByRole('button',{name:'Choose session or canvas',exact:true})).toBeVisible();
   await page.getByRole('button',{name:'Open panel map',exact:true}).tap();
   await expect(page.locator('.ps-moa-map > button')).toHaveCount(3);
   await page.getByRole('button',{name:'Close dialog',exact:true}).tap();
   await controls.tap();
   await page.getByRole('button',{name:'Remove panel',exact:true}).tap();
   await expect.poll(()=>settings.moa?.tree?.second?.type).toBe('chat');
   await page.getByRole('button',{name:'Open panel map',exact:true}).tap();
   await expect(page.locator('.ps-moa-map > button')).toHaveCount(2);
   await page.locator('.ps-moa-map > button').nth(1).tap();
   await expect(page.locator('.ps-moa-composer-host textarea')).toHaveValue('Keep this draft');
   await page.screenshot({path:`/tmp/mobile-panel-controls-${engine}.png`});
  } finally {await browser.close();}
 });
}
