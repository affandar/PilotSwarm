import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
test.use({ browserName: process.env.PS_TEST_BROWSER || 'chromium' });
for (const themeId of ['workspace-dark','terminal-green','win95','winamp','ms-dos']) {
 test(`header controls stay separate while resizing: ${themeId}`, async ({ page }) => {
  const stub = await startStubServer(0, { sessionCount: 4, themeId });
  try {
   await page.addInitScript(() => sessionStorage.setItem('pilotswarm.devAuth.persona', JSON.stringify({id:'test',email:'a.very.long.account.name@example.com',displayName:'A long administrator name'})));
   await page.route('**/api/portal-config', route => route.fulfill({json:{ok:true,portal:{branding:{title:'PilotSwarm'}},auth:{enabled:true,provider:'dev',client:{users:[]}}}}));
   await page.route('**/api/auth/me', route => route.fulfill({json:{ok:true,principal:{provider:'none',subject:'test',email:'a.very.long.account.name@example.com',displayName:'A long administrator name',groups:[],roles:['admin']},authorization:{allowed:true,role:'admin'}}}));
   await page.route('**/api/v1/me/profile', route => route.fulfill({ json: { ok: true, result: { isAdmin:true, profileSettings:{themeId} } } }));
   await page.setViewportSize({width:1440,height:900});
   await page.goto(`http://127.0.0.1:${stub.port}`);
   await expect(page.getByRole('button',{name:'Master of Agents',exact:true})).toBeVisible();
   await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
   const check = async () => {
    await expect(page.getByRole("button",{name:"Sign out",exact:true})).toBeVisible();
    await expect.poll(() => page.locator('.portal-header').evaluate(root => {
     const box=root.getBoundingClientRect();
     const buttons=[...root.querySelectorAll('button')].filter(b=>b.getClientRects().length && getComputedStyle(b).visibility!=='hidden').map(b=>({name:b.getAttribute('aria-label')||b.title,r:b.getBoundingClientRect()}));
     const bad=[];
     for(let i=0;i<buttons.length;i++) {
      const a=buttons[i];
      if(a.r.left<box.left-1 || a.r.right>box.right+1 || a.r.bottom>box.bottom+1 || a.r.width<28) bad.push(a.name+' clipped');
      for(let j=i+1;j<buttons.length;j++) {const b=buttons[j];if(Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1 && Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1) bad.push(a.name+' overlaps '+b.name);}
     }
     return bad;
    })).toEqual([]);
   };
   for(const width of [1600,1300,1100,1000,940,921,1100,1600]) {await page.setViewportSize({width,height:900});await check();}
   await page.setViewportSize({width:1000,height:900});
   const pane=page.locator('.ps-session-pane').first();
   await expect(pane.locator('.ps-panel-title').first()).toHaveText('Sessions');
   await page.screenshot({path:`/tmp/toolbar-resize-${themeId}.png`});
   await expect.poll(()=>pane.evaluate(root=>{
    const h=root.querySelector('.ps-panel-header'),t=h.querySelector('.ps-panel-title').getBoundingClientRect();
    return [...h.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=h.getBoundingClientRect().left && r.right<=h.getBoundingClientRect().right && (r.top>=t.bottom || r.left>=t.right);});
   })).toBe(true);
   await page.screenshot({path:`/tmp/toolbar-resize-${themeId}.png`});
   await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
   for(const width of [1440,1100,921]) {await page.setViewportSize({width,height:900});await check();}
  } finally {await new Promise(r=>stub.server.close(r));}
 });
}
