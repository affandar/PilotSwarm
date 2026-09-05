import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { LiveTurnCoalescer } from "../../../../sdk/dist/live-turn.js";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 0 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

async function open(page) {
    let socket;
    let subscribed = false;
    await page.routeWebSocket("**/api/v1/ws", (ws) => {
        socket = ws;
        ws.onMessage((raw) => {
            const message = JSON.parse(raw);
            if (message.type === "subscribeLive") subscribed = true;
        });
    });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await expect.poll(() => subscribed).toBe(true);
    let seq = 0;
    let eventSeq = 0;
    const event = (eventType, data) => socket.send(JSON.stringify({ type: "sessionEvent", sessionId, event: {
        sessionId, seq: ++eventSeq, eventType, createdAt: Date.now(), data,
    } }));
    return {
        live: (data) => socket.send(JSON.stringify({ type: "live", sessionId, topic: "turn", seq: ++seq, kind: "snapshot", data })),
        saved: (content) => event("assistant.message", { messageId: "m1", content }),
        complete: () => event("session.turn_completed", { resultType: "completed" }),
        final: (content) => {
            event("assistant.message", { messageId: "m1", content });
            event("session.turn_completed", { resultType: "completed" });
        },
    };
}

test("reasoning → answer → durable final retains the card, disclosure and table DOM", async ({ page }) => {
    const wire = await open(page);
    const draft = { phase: "live", messageId: null, text: "", reasoningId: "r1", reasoningText: "Considering alternatives." };
    wire.live(draft);
    const card = page.locator(".ps-assistant-preview");
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute("open");
    await card.locator(":scope > summary").click();
    const reasoning = card.locator("details.is-live-reasoning");
    await reasoning.locator("summary").click();
    await card.evaluate((element) => { window.testCard = element; window.testDisclosure = element.querySelector("details"); });
    const answer = "A measured answer.\n\n| Choice | Reason |\n|---|---|\n| One | Clear |";
    wire.live({ ...draft, messageId: "m1", text: answer });
    await expect(card.locator("table")).toBeVisible();
    expect(await card.evaluate((element) => element === window.testCard && element.querySelector("details") === window.testDisclosure)).toBe(true);
    await expect(card.locator("details")).toHaveAttribute("open", "");
    await card.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    await card.locator("table").evaluate((element) => { window.testTable = element; window.testTableTop = element.getBoundingClientRect().top; });
    await page.screenshot({ path: test.info().outputPath("live-turn-streaming.png") });
    wire.saved(answer);
    await expect(card.locator(":scope > summary")).toContainText("Saved");
    await expect(card).not.toHaveClass(/is-final/);
    wire.complete();
    await expect(card).toHaveClass(/is-final/);
    await expect(card.locator(":scope > summary")).toContainText("Agent:");
    await expect(card.locator(":scope > summary")).not.toContainText("responded");
    await expect(card).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(card).toHaveCSS("border-left-width", "0px");
    expect(await card.evaluate((element) => element === window.testCard
        && element.querySelector("details") === window.testDisclosure
        && element.querySelector("table") === window.testTable)).toBe(true);
    await expect(card.locator("details")).toHaveAttribute("open", "");
    // Promotion removes preview padding/caps, but never replaces the content.
    await expect(card.locator(".ps-assistant-preview-viewport")).toHaveCSS("max-height", "none");
    await expect(page.locator(".ps-streaming-caret")).toHaveCount(0);
    wire.live({ ...draft, messageId: "m1", text: "STALE DRAFT" });
    await page.waitForTimeout(250);
    await expect(page.getByText("STALE DRAFT", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("live-turn-settled.png") });
});

test("a response completed before reveal never flashes provisional chrome", async ({ page }) => {
    const wire = await open(page);
    await page.clock.install();
    wire.live({ phase: "live", messageId: "m1", text: "Fast draft", reasoningId: "r1", reasoningText: "Brief thought" });
    wire.final("Immediate final answer");
    await expect(page.getByText("Immediate final answer", { exact: false })).toBeVisible();
    await page.clock.runFor(2_000);
    await expect(page.locator(".ps-assistant-preview:not(.is-final)")).toHaveCount(0);
    const reasoning = page.locator("details.is-live-reasoning");
    await expect(reasoning).not.toHaveAttribute("open");
    await reasoning.locator("summary").click();
    await expect(reasoning).toContainText("Brief thought");
});

test("message previews are compact canvas-style disclosures with bounded scrolling", async ({ page }) => {
    const wire = await open(page);
    wire.live({ phase: "live", messageId: "m1", text: Array.from({ length: 80 }, (_, i) => `Preview line ${i}`).join("\n\n") });
    const preview = page.locator(".ps-assistant-preview");
    await expect(preview).toBeVisible();
    await expect(preview).not.toHaveAttribute("open");
    await expect(preview).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(preview).toHaveCSS("border-top-width", "0px");
    await expect(preview).toHaveCSS("border-left-width", "0px");
    expect((await preview.boundingBox()).height).toBeLessThan(40);
    const summary = preview.locator(":scope > summary");
    await summary.focus();
    await summary.press("Enter");
    const viewport = preview.locator(".ps-assistant-preview-viewport");
    await expect(viewport).toBeVisible();
    expect((await viewport.boundingBox()).height).toBeLessThanOrEqual(280);
    expect(await viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(viewport).toHaveCSS("border-top-width", "0px");
    await summary.press("Enter");
    await expect(viewport).not.toBeVisible();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`plain replies share the Agent prefix line without streaming (${viewport.width}px)`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const wire = await open(page);
        wire.final("pong");
        const card = page.locator(".ps-assistant-preview.is-final");
        await expect(card).toBeVisible();
        const geometry = await card.evaluate(element => {
            const header = element.querySelector(":scope > summary");
            const body = element.querySelector(".ps-assistant-preview-content > .ps-line");
            const range = document.createRange();
            range.selectNodeContents(body);
            const text = range.getClientRects()[0];
            return { header: header.getBoundingClientRect().toJSON(), text: text.toJSON(),
                height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(body).lineHeight) };
        });
        expect(Math.abs(geometry.text.top - geometry.header.top)).toBeLessThan(4);
        expect(geometry.text.left).toBeGreaterThanOrEqual(geometry.header.right);
        expect(geometry.height).toBeLessThan(geometry.lineHeight * 1.5);
    });
}

test("interleaved progress leaves one growing answer with its reasoning and DOM intact", async ({ page }) => {
    const wire = await open(page);
    const live = new LiveTurnCoalescer(wire.live, { intervalMs: 10_000, charThreshold: 10_000 });
    try {
        live.startTurn();
        live.reasoningDelta({ reasoningId: "r1", deltaContent: "A retained thought." });
        live.flushLive();
        const card = page.locator(".ps-assistant-preview");
        await expect(card).toBeVisible();
        await card.locator(":scope > summary").click();
        await card.locator("details.is-live-reasoning > summary").click();
        await card.evaluate(element => { window.testProgressCard = element; });
        let answer = "";
        for (const deltaContent of ["Hello", " world", "! This text grows", " instead of being replaced."]) {
            answer += deltaContent;
            live.messageDelta({ totalResponseSizeBytes: answer.length });
            live.messageDelta({ messageId: "m1", deltaContent });
            live.messageDelta({ totalResponseSizeBytes: answer.length + 100 });
            live.flushLive();
            await expect(card.locator(".ps-assistant-preview-content")).toContainText(answer);
            await expect(card.locator("details")).toHaveAttribute("open", "");
            await expect(card.locator("details")).toContainText("A retained thought.");
            expect(await card.evaluate(element => element === window.testProgressCard)).toBe(true);
            await expect(card).toHaveCount(1);
        }
        wire.final(answer);
        await expect(card).toHaveClass(/is-final/);
        await expect(card.locator(":scope > summary")).toContainText("Agent:");
        await expect(card).not.toContainText("Agent responded");
        await expect(card.locator(".ps-assistant-preview-content")).toContainText(answer);
    } finally { live.dispose(); }
});

for (const [name, answer] of [
    ["table-only", "| Choice | Reason |\n|---|---|\n| One | Clear |"],
    ["code-only", "```js\nconst answer = 42;\n```"],
]) {
    test(`a ${name} preview hugs short content and promotes without replacing it`, async ({ page }) => {
        const wire = await open(page);
        wire.live({ phase: "live", messageId: "m1", text: answer });
        const card = page.locator(".ps-assistant-preview");
        await expect(card).toBeVisible();
        await card.locator(":scope > summary").click();
        await card.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
        const content = card.locator(name === "table-only" ? "table" : ".ps-chat-code-block");
        await expect(content).toBeVisible();
        await content.evaluate(element => { window.testContent = element; });
        const viewport = await card.locator(".ps-assistant-preview-viewport").boundingBox();
        expect(viewport.height).toBeLessThan(200);
        wire.final(answer);
        await expect(card).toHaveClass(/is-final/);
        expect(await content.evaluate(element => element === window.testContent)).toBe(true);
        await expect(card.locator(".ps-assistant-preview-viewport")).toHaveCSS("max-height", "none");
        await expect(card.locator(".ps-streaming-caret")).toHaveCount(0);
    });
}
