import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 0 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

async function mount(page, { kind, long = false, moa = false, atTop = false }) {
    const events = [];
    const add = (eventType, data) => events.push({ sessionId, seq: events.length + 200,
        eventType, data, createdAt: Date.now() + events.length });
    if (!atTop) for (let i = 0; i < 30; i++) add("user.message", { content: `Before the activity ${i}.` });
    const content = long ? Array.from({ length: 100 }, (_, i) => `Result line ${i}`).join("\n\n") : "A short result.";
    if (kind === "update") add("assistant.message", { messageId: "update", content });
    else {
        const native = kind === "native";
        const owner = native ? { nativeAgentId: "agent-1", parentToolCallId: "task-1" } : {};
        if (native) add("subagent.started", { toolName: "task", toolCallId: "task-1", nativeAgentId: "agent-1",
            agentName: "swarm-explore", arguments: { description: "Inspect the repository", agent_type: "swarm-explore" } });
        add(native ? "native.tool.execution_start" : "tool.execution_start",
            { ...owner, toolCallId: "read-1", toolName: "view", arguments: { path: "README.md" } });
        add(native ? "native.tool.execution_complete" : "tool.execution_complete",
            { ...owner, toolCallId: "read-1", toolName: "view", success: true, result: content });
    }
    // Fill exactly one history page: paging remains eligible without trimming
    // the activity at the beginning out of the stored 300-event window.
    const followingCount = 300 - events.length;
    for (let i = 0; i < followingCount; i++) add("assistant.message", { messageId: `after-${i}`, phase: "commentary", content: `After the activity ${i}.` });
    let historyRequests = 0;
    await page.route("**/api/v1/me/profile**", route => route.fulfill({ json: { ok: true, result: {
        isAdmin: false, profileSettings: { themeId: moa ? "win95" : "terminal-green", touchScale: false,
            touchScaleMobile: false, moa: { version: 2, tree: { id: "chat", type: "chat", sessionId } } },
    } } }));
    await page.route(/\/events(?:\?|$)/, route => {
        const after = Number(new URL(route.request().url()).searchParams.get("afterSeq") || 0);
        return route.fulfill({ json: { ok: true, result: events.filter(event => event.seq > after) } });
    });
    await page.route(/\/events-before(?:\?|$)/, route => {
        // Canvas discovery also uses this endpoint, independently of scrolling.
        const types = JSON.parse(new URL(route.request().url()).searchParams.get("eventTypes") || "[]");
        if (types.includes("user.message") || types.includes("assistant.message")) historyRequests++;
        return route.fulfill({ json: { ok: true, result: [] } });
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await expect(page.getByText(`After the activity ${followingCount - 1}.`, { exact: true })).toBeAttached();
    if (moa) await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    const scope = page.locator(moa ? ".ps-moa-workspace" : ".ps-chat-panel");
    const pane = scope.locator(".ps-scroll-panel").first();
    if (kind === "tool") await scope.locator(".ps-activity-run > summary").click();
    if (kind !== "update") await scope.locator(".ps-chat-call > summary").click();
    const target = scope.locator(kind === "update" ? ".ps-assistant-preview-viewport" : ".ps-chat-call > .ps-system-notice-body").first();
    await expect(target).toBeVisible();
    await target.evaluate((element, top) => {
        const pane = element.closest(".ps-scroll-panel");
        pane.scrollTop = top ? 0 : pane.scrollTop + element.getBoundingClientRect().top - pane.getBoundingClientRect().top - 70;
    }, atTop);
    return { pane, target, historyRequests: () => historyRequests };
}

async function pointInside(target) {
    return target.evaluate(element => {
        let { left, right, top, bottom } = element.getBoundingClientRect();
        for (let node = element.parentElement; node; node = node.parentElement) {
            if (!/(auto|scroll|hidden)/.test(getComputedStyle(node).overflowY)) continue;
            const box = node.getBoundingClientRect();
            left = Math.max(left, box.left); right = Math.min(right, box.right);
            top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        }
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
    });
}

async function setBoundary(target, down) {
    await target.evaluate((element, down) => {
        for (let node = element; node && !node.classList.contains("ps-scroll-panel"); node = node.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node.scrollTop = down ? node.scrollHeight : 0;
        }
    }, down);
}

async function swipe(page, target, down) {
    // Native input targets compositor scroll offsets, which catch up on paint
    // after the fixture's programmatic scrollTop assignments.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const { x, y } = await pointInside(target);
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (const offset of [8, 20, 40, 65, 90]) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + offset * (down ? -1 : 1) }] });
            await page.waitForTimeout(20);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await cdp.detach(); }
}

async function touchToBottom(page, target) {
    // Reach the boundary using native input. Chromium's integer DOM maximum
    // can be one pixel beyond its touch compositor's maximum at fractional
    // line heights; directly assigning that value creates an artificial
    // overscroll that consumes a gesture just to clamp it back.
    await target.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 50; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const { x, y } = await pointInside(target);
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: -150, speed: 1000, gestureSourceType: "touch", preventFling: true });
    } finally { await cdp.detach(); }
    await expect.poll(() => target.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
}

for (const moa of [false, true]) for (const kind of ["tool", "update", "native"]) {
    const label = `${moa ? "MoA" : "chat"} ${kind}`;
    test(`${label}: wheel over short expanded content scrolls the conversation`, async ({ page }) => {
        const { pane, target } = await mount(page, { kind, moa });
        expect(await target.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThan(2);
        const before = await pane.evaluate(node => node.scrollTop);
        const point = await pointInside(target);
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(0, 100);
        await expect.poll(() => pane.evaluate(node => node.scrollTop)).toBeGreaterThan(before + 30);
    });

    test(`${label}: long content scrolls internally and hands both edges to the conversation`, async ({ page }) => {
        const { pane, target } = await mount(page, { kind, long: true, moa });
        expect(await target.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(400);
        await target.evaluate(node => { node.scrollTop = 200; });
        await expect.poll(() => target.evaluate(node => node.scrollTop)).toBe(200);
        const outerBefore = await pane.evaluate(node => node.scrollTop);
        let point = await pointInside(target);
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(0, -70);
        await expect.poll(() => target.evaluate(node => node.scrollTop)).toBeLessThan(175);
        expect(Math.abs(await pane.evaluate(node => node.scrollTop) - outerBefore)).toBeLessThan(2);
        for (const down of [true, false]) {
            await setBoundary(target, down);
            const before = await pane.evaluate(node => node.scrollTop);
            point = await pointInside(target);
            await page.mouse.move(point.x, point.y);
            await page.mouse.wheel(0, down ? 100 : -100);
            await expect.poll(async () => (await pane.evaluate(node => node.scrollTop) - before) * (down ? 1 : -1)).toBeGreaterThan(30);
        }
    });
}

test("wheel at the top of chat loads database history only after the nested result reaches its top", async ({ page }) => {
    const { pane, target, historyRequests } = await mount(page, { kind: "tool", long: true, atTop: true });
    expect(historyRequests(), "before the gesture").toBe(0);
    expect(await target.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(400);
    await target.evaluate(node => { node.scrollTop = 200; });
    await expect.poll(() => target.evaluate(node => node.scrollTop)).toBe(200);
    const point = await pointInside(target);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -80);
    await expect.poll(() => target.evaluate(node => node.scrollTop)).toBeLessThan(175);
    expect(await pane.evaluate(node => node.scrollTop)).toBe(0);
    expect(historyRequests()).toBe(0);
    await setBoundary(target, false);
    await page.mouse.wheel(0, -80);
    await expect.poll(historyRequests).toBe(1);
});

test.describe("native mobile gestures", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test.skip(({ browserName }) => browserName !== "chromium", "Native touch dispatch uses Chromium's CDP input API");
    for (const moa of [false, true]) for (const kind of ["tool", "update", "native"]) for (const state of ["short", "top", "bottom", "internal"]) {
        test(`${moa ? "MoA" : "chat"} ${kind}: touch scrolls ${state} content`, async ({ page }) => {
            const { pane, target } = await mount(page, { kind, moa, long: state !== "short" });
            if (state === "top" || state === "bottom") await setBoundary(target, state === "bottom");
            if (state === "bottom") await touchToBottom(page, target);
            if (state === "internal") {
                await target.evaluate(node => { node.scrollTop = 200; });
                await expect.poll(() => target.evaluate(node => node.scrollTop)).toBe(200);
            }
            const before = await pane.evaluate(node => node.scrollTop);
            const down = state === "short" || state === "bottom";
            await swipe(page, target, down);
            if (state === "internal") {
                await expect.poll(() => target.evaluate(node => node.scrollTop)).toBeLessThan(175);
                expect(Math.abs(await pane.evaluate(node => node.scrollTop) - before)).toBeLessThan(2);
            } else {
                await expect.poll(async () => (await pane.evaluate(node => node.scrollTop) - before) * (down ? 1 : -1)).toBeGreaterThan(25);
            }
        });
    }

    test("touch at the top of chat scrolls the result before pulling database history", async ({ page }) => {
        const { pane, target, historyRequests } = await mount(page, { kind: "tool", long: true, atTop: true });
        await target.evaluate(node => { node.scrollTop = 400; });
        await expect.poll(() => target.evaluate(node => node.scrollTop)).toBe(400);
        await swipe(page, target, false);
        await expect.poll(() => target.evaluate(node => node.scrollTop)).toBeLessThan(375);
        expect(await pane.evaluate(node => node.scrollTop)).toBe(0);
        expect(historyRequests()).toBe(0);
    });
});
