import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const ID = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

function fixtureEvents() {
    const started = Date.now() - 5000;
    const event = (seq, eventType, data) => ({ sessionId: ID, seq, eventType, data, createdAt: started + seq * 100, timestamp: started + seq * 100 });
    const task = { toolName: "task", toolCallId: "call-1", nativeAgentId: "agent-1", agentName: "swarm-explore",
        agentDisplayName: "Runtime investigator", arguments: { description: "Map runtime boundaries", agent_type: "swarm-explore" } };
    return { event, task, events: [
        event(1, "user.message", { content: "Research the runtime" }),
        event(2, "assistant.message", { content: "I’ll delegate the runtime investigation." }),
        event(3, "subagent.started", task),
        event(4, "subagent.configured", { nativeAgentId: "agent-1", model: "claude-opus-5", reasoningEffort: "high" }),
        event(5, "native.tool.execution_start", { nativeAgentId: "agent-1", parentToolCallId: "call-1", toolCallId: "read-1", toolName: "view", arguments: { description: "Read session manager" } }),
        event(6, "session.background_tasks_changed", {}),
    ] };
}

async function mount(page, fixture) {
    await page.route(/\/api\/v1\/.*\/events(?:\?|$)/, route => {
        const after = Number(new URL(route.request().url()).searchParams.get("afterSeq") || 0);
        return route.fulfill({ json: { ok: true, result: fixture.events.filter(ev => ev.seq > after) } });
    });
    await page.route(new RegExp(`/api/v1/sessions/${ID}$`), route => route.fulfill({ json: { ok: true, result: {
        sessionId: ID, title: "Native task chat test", status: fixture.status || "running", orchestrationStatus: "Running",
        error: fixture.error || null, messages: [], events: [], pendingMessages: [],
    } } }));
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${ID}`);
}

test("native task updates in place, preserves disclosure, and retains cancellation on reload", async ({ page }) => {
    const fixture = fixtureEvents();
    await mount(page, fixture);
    const row = page.locator('.ps-native-task[data-task-id="call-1"]');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "running");
    await expect(row).toHaveAttribute("open", "");
    await row.locator(":scope > summary").click();
    await row.locator(":scope > summary").click();
    await expect(row).toHaveAttribute("open", "");
    await expect(row.locator(".ps-native-task-scope")).toContainText("Same worker");
    fixture.events.push(fixture.event(7, "subagent.completed", { ...fixture.task, cancelled: true, durationMs: 632570, totalToolCalls: 115 }));
    fixture.events.push(fixture.event(8, "session.turn_completed", { resultType: "error", errorMessage: "Turn timed out" }));
    // The stub has no live socket, so exercise the real fallback event poll.
    await expect(row).toHaveAttribute("data-status", "cancelled", { timeout: 20000 });
    await expect(row).toHaveAttribute("open", "");
    await expect(row.locator(".ps-native-task-meta")).toContainText("115 calls");
    await expect(page.locator("section.ps-native-tasks")).toHaveCount(1);
    await expect(page.locator("body")).not.toContainText("background_tasks_changed");
    await page.reload();
    await expect(row).toHaveAttribute("data-status", "cancelled");
    await expect(row.locator(".ps-native-task-status")).toHaveText("Cancelled");
});

test("a warning stays above the successful follow-up and native rows fit mobile", async ({ page }) => {
    const fixture = fixtureEvents();
    fixture.error = "Turn timed out";
    fixture.events.push(fixture.event(7, "subagent.completed", { ...fixture.task, cancelled: true }));
    fixture.events.push(fixture.event(8, "session.turn_completed", { resultType: "error", errorMessage: fixture.error }));
    fixture.events.push(fixture.event(9, "user.message", { content: "Continue after the timeout" }));
    fixture.events.push(fixture.event(10, "assistant.message", { content: "The recovered investigation is complete." }));
    fixture.events.push(fixture.event(11, "session.turn_completed", { resultType: "completed" }));
    await mount(page, fixture);
    const warning = page.locator(".ps-chat-card").filter({ hasText: "Turn timed out" });
    await expect(warning).toHaveCount(1);
    const answer = page.getByText("The recovered investigation is complete.", { exact: true }).first();
    await expect(answer).toBeVisible();
    expect(await warning.evaluate((node) => {
        const all = [...document.querySelectorAll(".ps-chat-card, .ps-assistant-preview")];
        return all.findIndex(item => item === node) < all.findIndex(item => item.textContent.includes("The recovered investigation is complete."));
    })).toBe(true);
    await expect(warning).not.toContainText("orchestration is still running");
    await page.setViewportSize({ width: 390, height: 844 });
    const group = page.locator(".ps-native-tasks");
    await expect(group).toBeVisible();
    expect(await group.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});

test("parallel native calls nest once under their owner, keep parent calls separate, and survive reload", async ({ page }) => {
    const fixture = fixtureEvents();
    fixture.events.push(
        fixture.event(7, "subagent.started", { ...fixture.task, toolCallId: "call-2", nativeAgentId: "agent-2", arguments: { description: "Inspect volume configuration", agent_type: "swarm-task" } }),
        fixture.event(8, "tool.execution_start", { toolName: "repo_cache_fetch", toolCallId: "fetch-2", arguments: { repo: "pilotswarm" } }),
        fixture.event(9, "native.tool.execution_start", { toolName: "repo_cache_fetch", toolCallId: "fetch-2", parentToolCallId: "call-2", nativeAgentId: "agent-2", arguments: { repo: "pilotswarm" } }),
        fixture.event(10, "tool.execution_complete", { toolName: "repo_cache_fetch", toolCallId: "fetch-2", success: true, result: "Fetched main" }),
        fixture.event(11, "tool.execution_start", { toolName: "repo_cache_fetch", toolCallId: "parent-fetch", arguments: { repo: "waldemort" } }),
    );
    await mount(page, fixture);
    const first = page.locator('.ps-native-task[data-task-id="call-1"]');
    const second = page.locator('.ps-native-task[data-task-id="call-2"]');
    await expect(first.locator(".ps-chat-call")).toHaveCount(1);
    await expect(first.locator(".ps-chat-call-summary")).toContainText("view");
    await expect(second.locator(".ps-chat-call")).toHaveCount(1);
    await expect(second.locator(".ps-chat-call-summary")).toContainText("repo_cache_fetch");
    await expect(second.locator(".ps-native-task-profile")).toHaveText("Task");
    await expect(page.locator(".ps-activity-run .ps-chat-call")).toHaveCount(1);
    await expect(page.locator(".ps-activity-run .ps-chat-call-summary")).toContainText("waldemort");
    await page.screenshot({ path: test.info().outputPath("nested-native-desktop.png") });
    await second.locator(".ps-chat-call-summary").click();
    await expect(second.locator(".ps-chat-call-payload")).toContainText("Fetched main");
    fixture.events.push(fixture.event(12, "subagent.completed", { ...fixture.task, toolCallId: "call-2", nativeAgentId: "agent-2" }));
    await expect(second).toHaveAttribute("data-status", "completed", { timeout: 20000 });
    await expect(second).toHaveAttribute("open", ""); // Preserve the result being inspected.
    await page.reload();
    await expect(second).not.toHaveAttribute("open", "");
    await second.locator(":scope > summary").click();
    await expect(second.locator(".ps-chat-call")).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(second).toBeVisible();
    if (await second.getAttribute("open") === null) await second.locator(":scope > summary").click();
    await expect(second.locator(".ps-native-task-calls")).toBeVisible();
    expect(await second.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("nested-native-mobile.png") });
});

test("uninspected success collapses while a failed task expands with its failed call", async ({ page }) => {
    const fixture = fixtureEvents();
    await mount(page, fixture);
    const row = page.locator('.ps-native-task[data-task-id="call-1"]');
    await expect(row).toHaveAttribute("open", "");
    fixture.events.push(fixture.event(7, "subagent.completed", fixture.task));
    await expect(row).toHaveAttribute("data-status", "completed", { timeout: 20000 });
    await expect(row).not.toHaveAttribute("open", "");
    fixture.events.push(
        fixture.event(8, "subagent.started", { ...fixture.task, toolCallId: "failed-task", nativeAgentId: "failed-agent" }),
        fixture.event(9, "native.tool.execution_complete", { toolName: "view", toolCallId: "failed-read", parentToolCallId: "failed-task", nativeAgentId: "failed-agent", success: false, error: "File not found" }),
        fixture.event(10, "subagent.failed", { toolCallId: "failed-task", nativeAgentId: "failed-agent", error: "Cannot read configuration" }),
    );
    const failed = page.locator('.ps-native-task[data-task-id="failed-task"]');
    await expect(failed).toHaveAttribute("data-status", "failed", { timeout: 20000 });
    await expect(failed).toHaveAttribute("open", "");
    await expect(failed.locator(".ps-chat-call-status")).toHaveText("Failed");
    await expect(failed.locator(".ps-native-task-result")).toHaveText("Cannot read configuration");
});
