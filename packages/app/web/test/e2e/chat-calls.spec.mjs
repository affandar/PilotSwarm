import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
test.use({browserName:process.env.PS_TEST_BROWSER || 'chromium'});
const sessionId='11111110-2222-3333-4444-555555555550';
let stub;
test.beforeAll(async()=>{stub=await startStubServer(0,{sessionCount:1,transcriptTurns:0});});
test.afterAll(async()=>{await new Promise(resolve=>stub.server.close(resolve));});
async function fixture(page,theme='terminal-green') {
    const events=[],sockets=[],errors=[];
    let subscribed=false;
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/v1/**',route=>{
        const url=new URL(route.request().url());
        if(url.pathname.endsWith('/me/profile'))return route.fulfill({json:{ok:true,result:{isAdmin:false,profileSettings:{themeId:theme,touchScale:false,touchScaleMobile:false,moa:{version:2,tree:{id:'one',type:'chat',sessionId}}}}}});
        if(url.pathname.endsWith('/events'))return route.fulfill({json:{ok:true,result:events.filter(e=>e.seq>Number(url.searchParams.get('afterSeq')||0))}});
        return route.fallback();
    });
    await page.routeWebSocket('**/api/v1/ws',socket=>{
        sockets.push(socket);
        socket.onMessage(raw=>{if(JSON.parse(raw).type==='subscribeSession')subscribed=true;});
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await expect.poll(()=>subscribed).toBe(true);
    return {errors,event:(eventType,data)=>{
        const event={sessionId,seq:events.length+1,eventType,createdAt:new Date().toISOString(),data};
        events.push(event);
        for(const socket of sockets)socket.send(JSON.stringify({type:'sessionEvent',sessionId,event}));
    }};
}
test('live calls retain their disclosure through updates and reload with no empty-response warning',async({page})=>{
    const f=await fixture(page);
    f.event('user.message',{content:'Inspect this change.'});
    f.event('tool.execution_start',{toolCallId:'one',toolName:'bash',arguments:{command:'git diff --stat\ngit status --short'}});
    const row=page.locator('.ps-chat-call').filter({hasText:'bash'});
    await expect(row).toHaveCount(1);
    await expect(row).not.toHaveAttribute('open');
    await expect(row.locator('summary')).toContainText('bash — git diff --stat');
    await expect(row.locator('summary')).not.toContainText('git status');
    await row.locator('summary').click();
    await expect(row.locator('pre')).toContainText('git status --short');
    await row.evaluate(el=>window.callRow=el);
    f.event('external_tool.requested',{toolCallId:'one',requestId:'r1',toolName:'bash'});
    f.event('tool.execution_partial_result',{toolCallId:'one',partialOutput:'Reading files…'});
    await expect(row.locator('pre')).toContainText('Reading files');
    f.event('tool.execution_complete',{toolCallId:'one',success:true,result:{content:'<script>window.callInjected=true</script>\nDone'}});
    await expect(row.locator('summary')).toContainText('Done');
    await expect(row.locator('pre')).toContainText('<script>');
    expect(await row.evaluate(el=>el===window.callRow)).toBe(true);
    expect(await page.evaluate(()=>window.callInjected)).toBeUndefined();
    await expect(row).toHaveAttribute('open','');
    f.event('tool.execution_start',{toolCallId:'two',toolName:'spawn_agent',arguments:{task:'Review for races\nCheck the migration',model:'test-model'}});
    f.event('user.message',{content:'The review found a race\nFull explanation here.',sender:{kind:'agent',display:'Reviewer'}});
    f.event('session.error',{errorType:'no_response',message:'No response was returned. Send your message again to retry.'});
    await expect(page.locator('.ps-chat-call')).toHaveCount(3);
    await expect(page.locator('.ps-chat-card').filter({hasText:'No response was returned'})).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.ps-chat-call')).toHaveCount(3);
    await expect(row.locator('summary')).toContainText('Done');
    await row.locator('summary').click();
    await expect(row.locator('pre')).toContainText('<script>');
    expect(f.errors).toEqual([]);
});

for(const theme of ['terminal-green','win95','winamp','ms-dos'])test(`${theme}: calls clip in ordinary chat and MoA across desktop/mobile resize`,async({page})=>{
    const f=await fixture(page,theme);
    f.event('tool.execution_start',{toolCallId:'long',toolName:'repo_cache_run',arguments:{command:'Inspect the working tree and compare the active migration with the deployed schema. '.repeat(12)}});
    f.event('tool.execution_start',{toolCallId:'agent',toolName:'wait_for_agents',arguments:{agent_ids:['reviewer','implementer'],reason:'Waiting for independent review'}});
    const check=async()=>{
        await expect.poll(()=>page.locator('.ps-chat-call:visible > summary').evaluateAll(rows=>{
            if(rows.length!==2)return false;
            return rows.every(el=>{
                const text=el.querySelector('.ps-system-notice-summary-text'),r=el.getBoundingClientRect();
                const children=[...el.children].map(c=>c.getBoundingClientRect());
                return el.isConnected&&r.width>0&&getComputedStyle(text).whiteSpace==='nowrap'&&getComputedStyle(text).textOverflow==='ellipsis'
                    &&children.every(c=>c.left>=r.left&&c.right<=r.right+1)
                    &&!children.some((c,i)=>i>0&&c.left<children[i-1].right-1)&&r.height<45
                    &&(!text.textContent.includes('repo_cache_run')||text.scrollWidth>text.clientWidth);
            })&&document.documentElement.scrollWidth<=innerWidth+1;
        })).toBe(true);
    };
    await expect(page.locator('.ps-chat-call')).toHaveCount(2);
    for(const width of [1600,1024,820,390,320]){await page.setViewportSize({width,height:900});await check();}
    await page.getByRole('button',{name:'Master of Agents',exact:true}).click();
    await expect(page.locator('.ps-moa-workspace .ps-chat-call')).toHaveCount(2);
    for(const width of [320,390,820,1024,1600]){await page.setViewportSize({width,height:900});await check();}
    await page.screenshot({path:`/tmp/chat-calls-${theme}-desktop.png`});
    await page.setViewportSize({width:390,height:844});
    await check();
    await page.screenshot({path:`/tmp/chat-calls-${theme}-mobile.png`});
    expect(f.errors).toEqual([]);
});
