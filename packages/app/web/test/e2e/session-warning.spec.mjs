import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
const error = "Execution failed: 400 Unknown parameter: 'snippy'. (retry 1/3 in 15s)";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

test("retry warnings stay mounted, retain their place, and do not block later chat", async ({ page }) => {
    let detail = { status: "error", error, statusVersion: 10 };
    let reads = 0;
    let socket;
    await page.route(`**/sessions/${sessionId}`, async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.result = { ...body.result, ...detail, orchestrationStatus: "Running" };
        reads++;
        await route.fulfill({ response, json: body });
    });
    await page.routeWebSocket("**/api/v1/ws", ws => { socket = ws; });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    const card = page.locator(".ps-chat-card").filter({ hasText: "Unknown parameter" });
    await expect(card).toBeVisible();
    await card.evaluate(el => {
        window.warningCard = el;
        window.warningRemoved = false;
        window.warningObserver = new MutationObserver(records => {
            if (records.some(record => [...record.removedNodes].some(node => node === el || node.contains?.(el)))) {
                window.warningRemoved = true;
            }
        });
        window.warningObserver.observe(el.parentElement, { childList: true, subtree: true });
    });
    let seq = 0;
    for (const next of [
        { status: "running", statusVersion: 11 },
        { status: "idle", statusVersion: 11 },
        { status: "error", error: error.replace("1/3 in 15s", "2/3 in 30s"), statusVersion: 12 },
    ]) {
        detail = next;
        const before = reads;
        socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: {
            sessionId, seq: ++seq, eventType: "model.call_start", createdAt: Date.now(), data: { model: "test-model" },
        } }));
        await expect.poll(() => reads).toBeGreaterThan(before);
        await expect(card).toBeVisible();
        expect(await card.evaluate(el => el === window.warningCard && !window.warningRemoved)).toBe(true);
    }
    await expect(card).toContainText("2/3 in 30s");
    detail = { status: "idle", statusVersion: 13 };
    socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: {
        sessionId, seq: ++seq, eventType: "session.turn_completed", createdAt: Date.now(), data: { resultType: "completed" },
    } }));
    await expect(card).toBeVisible();
    for (const [eventType, data] of [
        ["user.message", { content: "Try once more" }],
        ["assistant.message", { content: "The model recovered and this is the new reply.", messageId: "recovered" }],
        ["session.turn_completed", { resultType: "completed" }],
    ]) {
        socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: {
            sessionId, seq: ++seq, eventType, createdAt: Date.now(), data,
        } }));
    }
    const reply = page.getByText("The model recovered and this is the new reply.", { exact: true });
    await expect(reply).toBeVisible();
    expect(await card.evaluate(el => el === window.warningCard && !window.warningRemoved)).toBe(true);
    const warningBox = await card.boundingBox();
    const replyBox = await reply.boundingBox();
    expect(replyBox.y).toBeGreaterThan(warningBox.y + warningBox.height);
    // Continue far enough that the old warning must scroll out of view. New
    // output must remain reachable without reloading or hiding the warning.
    for (let turn = 0; turn < 16; turn++) {
        for (const [eventType, data] of [
            ["user.message", { content: `Follow-up ${turn}` }],
            ["assistant.message", { content: `Reply ${turn}: the session continues normally.`, messageId: `reply-${turn}` }],
            ["session.turn_completed", { resultType: "completed" }],
        ]) {
            socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: {
                sessionId, seq: ++seq, eventType, createdAt: Date.now(), data,
            } }));
        }
    }
    await expect(page.getByText("Reply 15: the session continues normally.", { exact: true })).toBeInViewport();
    await expect(card).not.toBeInViewport();
    expect(await card.evaluate(el => el === window.warningCard && !window.warningRemoved)).toBe(true);
    await page.evaluate(() => window.warningObserver.disconnect());
});
