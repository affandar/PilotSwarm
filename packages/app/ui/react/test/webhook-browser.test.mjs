// Real React/DOM actions in a fully offline browser. No HTTP server is started;
// the bundle is built in memory and injected into about:blank. All requests are
// aborted, and the browser uses a fresh temporary profile, never the user's.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

let browser, bundle;
before(async () => {
    const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    browser = await chromium.launch({
        ...(existsSync(chromium.executablePath()) ? {} : existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
        headless: true,
        args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--disable-default-apps"],
    });
    const result = await build({
        stdin: {
            resolveDir: fileURLToPath(new URL("../", import.meta.url)),
            contents: `
                import React from "react";
                import {createRoot} from "react-dom/client";
                import {PilotSwarmWebApp} from "./src/web-app.js";
                import {setupWebhooks, TEST_TOKEN, TEST_URL, endpoint, receipt, deferred} from "../core/test/webhook-fixture.mjs";
                let root;
                window.copies = [];
                Object.defineProperty(navigator, "clipboard", {configurable:true, value:{writeText:async text=>{window.copies.push(text);}}});
                window.helpers = {TEST_TOKEN, TEST_URL, endpoint, receipt, deferred};
                window.mountWebhooks = async options => {
                    root?.unmount();
                    const fixture = setupWebhooks(options);
                    fixture.controller.start = async () => {};
                    window.fixture = fixture;
                    root = createRoot(document.getElementById("app"));
                    root.render(React.createElement(PilotSwarmWebApp, {controller:fixture.controller}));
                    await fixture.controller.refreshAdminWebhooks();
                };
            `,
        },
        bundle: true, write: false, platform: "browser", format: "iife", logLevel: "silent",
        define: { "process.env.NODE_ENV": '"test"' },
    });
    bundle = result.outputFiles[0].text;
});
after(async () => { await browser?.close(); });

async function mounted(t, options = {}, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport, offline: true, serviceWorkers: "block" });
    t.after(() => context.close());
    const requests = [], errors = [];
    await context.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<div id="app"></div><style>
        .ps-modal-backdrop{position:fixed;inset:0;display:grid;place-items:center;background:#ccc9;z-index:100}
        .ps-modal{background:white;max-height:95vh;overflow:auto;padding:8px}
        .ps-admin-main{min-width:0}
    </style>`);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(options => window.mountWebhooks(options), options);
    await expect(page.getByRole("region", { name: "Webhook management" })).toBeVisible();
    t.after(() => {
        assert.deepEqual(errors, [], "no React/runtime exceptions");
        assert.deepEqual(requests, [], "rendering and actions never fetch a provider URL or capability");
    });
    return page;
}
const selectTab = (page, label) => page.getByRole("navigation", { name: "Webhook pages" }).getByRole("button", { name: label, exact: true }).click();
const fill = (page, field, value) => page.locator(`#webhook-field-${field}`).fill(typeof value === "string" ? value : JSON.stringify(value));
const calls = (page, name) => page.evaluate(name => window.fixture.calls.filter(call => call[0] === name), name);
const completeForm = async (page, label) => {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
};

test("portal actual controls create/edit/revoke connectors, bindings and approved templates using shared policy", async t => {
    const page = await mounted(t);
    await page.getByRole("button", { name: "Create…", exact: true }).click();
    await fill(page, "label", "PR connector");
    await fill(page, "source", { repositoryId: "repo-1" });
    await fill(page, "auth", { mode: "github-hmac-sha256", secretRef: "WEBHOOK_REFERENCE" });
    await completeForm(page, "Create");
    assert.equal((await calls(page, "createWebhookConnector"))[0][1].auth.secretRef, "WEBHOOK_REFERENCE");
    await page.getByRole("button", { name: "Edit…", exact: true }).click();
    await expect(page.locator("#webhook-field-auth")).toHaveValue("");
    await fill(page, "label", "Updated connector");
    await page.locator("#webhook-field-state").selectOption("disabled");
    await completeForm(page, "Save changes");
    assert.equal((await calls(page, "updateWebhookConnector"))[0][2].expectedRevision, 3);
    await page.getByRole("button", { name: "Revoke…", exact: true }).click();
    await expect(page.getByText("Revoke webhook resource", { exact: true })).toBeVisible();
    assert.equal((await calls(page, "revokeWebhookConnector")).length, 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Revoke…", exact: true }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByRole("button", { name: "Revoke…", exact: true })).toBeDisabled();
    assert.deepEqual(await calls(page, "revokeWebhookConnector"), [["revokeWebhookConnector", "connector-1"]]);

    await selectTab(page, "Bindings");
    await page.getByRole("button", { name: "Create…", exact: true }).click();
    await fill(page, "label", "Fixed route");
    await fill(page, "connectorId", "connectors-new");
    await fill(page, "action", { type: "create_session", templateId: "template-1" });
    await completeForm(page, "Create");
    assert.equal(Object.hasOwn((await calls(page, "createWebhookBinding"))[0][1].action, "coalescing"), false);
    await page.getByRole("button", { name: "Edit…", exact: true }).click();
    await fill(page, "action", { type: "enqueue_prompt", sessionId: "s1", prompt: { instruction: "Review.", fields: ["title"] } });
    await completeForm(page, "Save changes");
    assert.equal((await calls(page, "updateWebhookBinding"))[0][2].expectedRevision, 3);
    await page.getByRole("button", { name: "Dry run…", exact: true }).click();
    await fill(page, "event", { version: 1, provider: "github", eventType: "pull_request.lifecycle", action: "opened", repositoryId: "repo-1" });
    await completeForm(page, "Run policy check");
    await expect(page.getByText(/Scope: persisted_policy/)).toBeVisible();
    await expect(page.getByText(/does not guarantee current host placement, model admission/)).toBeVisible();

    await selectTab(page, "Approved templates");
    await page.getByRole("button", { name: "Approve template…", exact: true }).click();
    await fill(page, "label", "Approved review");
    await fill(page, "source", { repositoryId: "repo-1" });
    await fill(page, "config", { namespace: "app", agentName: "reviewer" });
    await completeForm(page, "Approve template");
    assert.equal((await calls(page, "createWebhookSessionTemplate"))[0][1].config.namespace, "app");
    await page.getByRole("button", { name: "Edit…", exact: true }).click();
    await fill(page, "config", { namespace: "app", agentName: "reviewer", reasoningEffort: "high" });
    await completeForm(page, "Save approved policy");
    assert.equal((await calls(page, "updateWebhookSessionTemplate"))[0][2].expectedRevision, 3);
});

test("portal reports disabled/enabled/unknown ingress without disabling configuration or claiming health", async t => {
    const page = await mounted(t);
    await page.evaluate(async () => {
        window.fixture.transport.bootstrap = { webhooks: { enabled: false } };
        await window.fixture.controller.refreshAdminWebhooks();
    });
    await expect(page.getByText(/Bootstrap reports webhook ingress disabled/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create…", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Create…", exact: true }).click();
    await fill(page, "label", "Configured before ingress enablement");
    await fill(page, "source", { repositoryId: "repo-1" });
    await completeForm(page, "Create");
    assert.equal((await calls(page, "createWebhookConnector")).length, 1);
    await page.evaluate(async () => {
        window.fixture.transport.bootstrap.webhooks.enabled = true;
        await window.fixture.controller.refreshAdminWebhooks();
    });
    await expect(page.getByText(/Bootstrap reports webhook ingress enabled.*not verified/)).toBeVisible();
    await page.evaluate(async () => {
        window.fixture.transport.bootstrap = null;
        await window.fixture.controller.refreshAdminWebhooks();
    });
    await expect(page.getByText(/Webhook ingress status is unavailable/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create…", exact: true })).toBeEnabled();
});

for (const width of [1440, 390]) {
    test(`portal connector URL/path copy is explicit, bootstrap-only and text-only at ${width}px`, async t => {
        const page = await mounted(t, {}, { width, height: 1000 });
        const address = page.getByRole("region", { name: "Connector delivery address" });
        await expect(address.getByText("Relative delivery path", { exact: true })).toBeVisible();
        await expect(address.locator("pre")).toHaveText("/hooks/c/connector-1");
        await expect(address.getByRole("link")).toHaveCount(0);
        assert.deepEqual(await page.evaluate(() => window.copies), []);
        await address.getByRole("button", { name: "Copy relative path" }).click();
        assert.deepEqual(await page.evaluate(() => window.copies), ["/hooks/c/connector-1"]);
        await page.evaluate(async () => {
            window.fixture.transport.bootstrap = { webhooks: { enabled: false, publicOrigin: "https://hooks.example.invalid" } };
            window.fixture.catalog.connectors.push({ ...window.fixture.catalog.connectors[0], id: "connector-2", label: "Second connector" });
            await window.fixture.controller.refreshAdminWebhooks();
        });
        await expect(address.locator("pre")).toHaveText("https://hooks.example.invalid/hooks/c/connector-1");
        await expect(address.getByRole("button", { name: "Copy delivery URL" })).toBeEnabled();
        await page.getByRole("button", { name: "Second connector · active", exact: true }).click();
        await expect(address.locator("pre")).toHaveText("https://hooks.example.invalid/hooks/c/connector-2");
        await address.getByRole("button", { name: "Copy delivery URL" }).click();
        assert.deepEqual(await page.evaluate(() => window.copies), ["/hooks/c/connector-1", "https://hooks.example.invalid/hooks/c/connector-2"]);
        assert.equal(await page.evaluate(() => window.fixture.controller.getWebhookCapability()), null);
        await expect(address).toContainText("Public connector ID, not a capability");
        await page.evaluate(() => {
            window.clipboardAttempts = 0;
            navigator.clipboard.writeText = async () => { window.clipboardAttempts++; throw new Error("Clipboard refused"); };
        });
        await address.getByRole("button", { name: "Copy delivery URL" }).click();
        await expect(address).toContainText("Copy failed. Copy the displayed delivery URL/path manually.");
        assert.equal(await page.evaluate(() => window.clipboardAttempts), 1);
        await page.evaluate(async () => {
            window.fixture.transport.bootstrap.webhooks.publicOrigin = null;
            await window.fixture.controller.refreshAdminWebhooks();
        });
        await expect(address.getByText("Relative delivery path", { exact: true })).toBeVisible();
        await expect(address.locator("pre")).toHaveText("/hooks/c/connector-2");
    });
}

test("portal one-time endpoint dialog renders inert text, copies only on click and erases on Escape/navigation", async t => {
    const page = await mounted(t);
    await selectTab(page, "Session signals");
    await expect(page.getByText(/Waiting for first event: ready or user input.*no deadline/)).toBeVisible();
    await page.getByRole("button", { name: "Mint endpoint…", exact: true }).click();
    await page.getByRole("button", { name: "Mint one-time capability", exact: true }).click();
    const capability = page.getByRole("dialog", { name: "One-time endpoint capability" });
    await expect(capability).toBeVisible();
    const token = await page.evaluate(() => window.helpers.TEST_TOKEN);
    await expect(capability.locator("pre").last()).toHaveText(token);
    await expect(capability.getByRole("link")).toHaveCount(0);
    assert.equal(await page.evaluate(() => JSON.stringify(window.fixture.store.getState()).includes(window.helpers.TEST_TOKEN)), false);
    assert.deepEqual(await page.evaluate(() => window.copies), []);
    await capability.getByRole("button", { name: "Copy capability URL" }).click();
    assert.deepEqual(await page.evaluate(() => window.copies), [await page.evaluate(() => window.helpers.TEST_URL)]);
    await page.keyboard.press("Escape");
    await expect(capability).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.fixture.controller.getWebhookCapability()), null);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".ps-webhooks")).not.toContainText(token);

    await page.getByRole("button", { name: "Raise signal…", exact: true }).click();
    await fill(page, "data", { text: "<img src=x onerror=alert(1)>", model: "inert-data" });
    await fill(page, "payloadRef", "https://example.invalid/no-fetch");
    await completeForm(page, "Raise signal");
    const raised = (await calls(page, "raiseSignal"))[0];
    assert.equal(raised[1], "s1"); assert.equal(raised[3].data.model, "inert-data");
    await expect(page.getByText(/Signal queued durably; consumption is not yet confirmed/)).toBeVisible();
    await page.getByRole("button", { name: "Revoke…", exact: true }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    assert.equal((await calls(page, "revokeSignalEndpoint")).length, 1);
});

test("portal pending controls prevent duplicate mint and reject a late capability after navigation", async t => {
    const page = await mounted(t);
    await selectTab(page, "Session signals");
    await page.evaluate(() => {
        window.pendingMint = window.helpers.deferred();
        window.mintCalls = 0;
        window.fixture.transport.createSignalEndpoint = () => { window.mintCalls++; return window.pendingMint.promise; };
    });
    await page.getByRole("button", { name: "Mint endpoint…", exact: true }).click();
    await page.getByRole("button", { name: "Mint one-time capability", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Pending…", exact: true })).toBeDisabled();
    await expect(page.locator("#webhook-field-signalName")).toBeDisabled();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await selectTab(page, "Health");
    await page.evaluate(async () => {
        window.pendingMint.resolve({ ...window.helpers.endpoint(), token: window.helpers.TEST_TOKEN, url: window.helpers.TEST_URL });
        await window.pendingMint.promise;
    });
    await expect(page.getByRole("dialog", { name: "One-time endpoint capability" })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.mintCalls), 1);
    assert.equal(await page.evaluate(() => window.fixture.controller.getWebhookCapability()), null);
    assert.equal(await page.evaluate(() => JSON.stringify(window.fixture.store.getState()).includes(window.helpers.TEST_TOKEN)), false);
});

test("portal receipts really filter/page, confirm replay, select sessions and show error/health facts", async t => {
    const page = await mounted(t);
    await page.evaluate(() => {
        window.fixture.catalog.receipts = Array.from({ length: 3 }, (_, index) => window.helpers.receipt({
            receiptId: `receipt-${3 - index}`, status: "dead_lettered", attempts: 8, lastErrorCode: "TARGET_DENIED",
        }));
    });
    await selectTab(page, "Receipts");
    await page.getByRole("button", { name: "Filter receipts…", exact: true }).click();
    await fill(page, "limit", "1");
    await page.locator("#webhook-field-status").selectOption("dead_lettered");
    await completeForm(page, "Apply filters");
    await expect(page.getByRole("table", { name: "Receipt timeline" })).toBeVisible();
    await expect(page.getByText("Attempts: 8 · Duplicates: 2 · Replays: 0")).toBeVisible();
    await expect(page.getByText("Last error: TARGET_DENIED")).toBeVisible();
    await page.getByRole("button", { name: "Older", exact: true }).click();
    await expect(page.locator(".ps-webhooks__list")).toContainText("receipt-2");
    await page.getByRole("button", { name: "Newer", exact: true }).click();
    await expect(page.locator(".ps-webhooks__list")).toContainText("receipt-3");
    assert.equal((await calls(page, "listWebhookReceipts")).some(call => call[1].before === "receipt-3" && call[1].status === "dead_lettered"), true);
    await page.getByRole("button", { name: "Replay receipt…", exact: true }).click();
    assert.equal((await calls(page, "replayWebhookReceipt")).length, 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await calls(page, "replayWebhookReceipt")).length, 0);
    await page.getByRole("button", { name: "Replay receipt…", exact: true }).click();
    await page.getByRole("button", { name: "Replay once", exact: true }).click();
    await expect(page.getByText(/Replay requested once/)).toBeVisible();
    assert.deepEqual(await calls(page, "replayWebhookReceipt"), [["replayWebhookReceipt", "receipt-3", { confirmed: true }]]);
    await selectTab(page, "Health");
    await expect(page.getByText("Pending: 4 · Oldest pending age: 25s")).toBeVisible();
    await expect(page.getByText("Dead-lettered: 2 · Oldest dead-letter age: 75s")).toBeVisible();
    await page.evaluate(() => {
        window.fixture.controller.transport.getWebhookMetrics = async () => { throw new Error("Connection failed"); };
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Connection failed" })).toBeVisible();
    await expect(page.getByText("Pending: 4 · Oldest pending age: 25s")).toHaveCount(0);
    await selectTab(page, "Receipts");
    await page.evaluate(() => {
        window.selectedReceiptSession = null;
        window.fixture.controller.setNavigationIntent = id => { window.selectedReceiptSession = id; };
    });
    await page.getByRole("button", { name: "Select receipt session", exact: true }).click();
    assert.equal(await page.evaluate(() => window.selectedReceiptSession), "s1");
    await expect(page.getByRole("region", { name: "Webhook management" })).toHaveCount(0);
});

test("portal admin/ordinary/auth-disabled controls, JSON validation, stale revisions and denied writes remain honest", async t => {
    const page = await mounted(t, { isAdmin: false, authDisabled: true });
    await expect(page.getByRole("button", { name: "Create…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Edit…", exact: true }).click();
    await expect(page.locator("#webhook-field-auth")).toHaveCount(0);
    await fill(page, "label", "My stale edit");
    await page.evaluate(() => { window.fixture.catalog.connectors[0].revision = 9; });
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "STALE_REVISION" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    assert.equal((await calls(page, "updateWebhookConnector")).length, 1);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await selectTab(page, "Bindings");
    await page.getByRole("button", { name: "Create…", exact: true }).click();
    await fill(page, "label", "My route");
    await fill(page, "filters", "globalThis.PWNED=true");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("valid JSON (not JavaScript)");
    assert.equal(await page.evaluate(() => globalThis.PWNED), undefined);
    await fill(page, "filters", {});
    await fill(page, "connectorId", "connector-1");
    await fill(page, "action", { type: "raise_signal", sessionId: "s1", signalName: "ready" });
    await page.evaluate(() => {
        window.fixture.transport.createWebhookBinding = async () => { throw Object.assign(new Error("Owner access denied"), { code: "FORBIDDEN", status: 403 }); };
    });
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("FORBIDDEN: Owner access denied");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await selectTab(page, "Approved templates");
    await expect(page.getByRole("button", { name: "Approve template…", exact: true })).toBeDisabled();
});

for (const width of [1440, 390]) {
    test(`portal retention controls, replay expiry and endpoint warnings remain usable at ${width}px`, async t => {
        const page = await mounted(t, {}, { width, height: 900 });
        await selectTab(page, "Health");
        await expect(page.getByRole("region", { name: "Webhook retention" })).toBeVisible();
        await page.getByRole("button", { name: "Edit retention policy…", exact: true }).click();
        await fill(page, "receiptRetentionDays", "90");
        await fill(page, "replayRetentionDays", "7");
        await completeForm(page, "Save retention policy");
        assert.deepEqual(await calls(page, "updateWebhookRetentionPolicy"),
            [["updateWebhookRetentionPolicy", { expectedRevision: 1, receiptRetentionDays: 90, replayRetentionDays: 7 }]]);
        await expect(page.getByText("Terminal receipt history: 90 days. Replay window: 7 days.")).toBeVisible();
        await page.evaluate(() => {
            window.fixture.catalog.receipts = [window.helpers.receipt({
                status: "dead_lettered", replayAvailable: false,
                replayExpiresAt: new Date(Date.now() - 1000).toISOString(), payloadRetained: false,
            })];
            window.fixture.catalog.endpoints[0].revokedAt = new Date().toISOString();
        });
        await selectTab(page, "Receipts");
        await expect(page.getByRole("button", { name: "Replay receipt…", exact: true })).toBeDisabled();
        await expect(page.getByText(/replay window has expired/i)).toBeVisible();
        await selectTab(page, "Session signals");
        await expect(page.getByText(/wait remains active; other authorized producers/)).toBeVisible();
        assert.equal((await calls(page, "replayWebhookReceipt")).length, 0);
        assert.equal((await calls(page, "raiseSignal")).length, 0);
    });
}

test("mobile portal keeps the same actions and renders hostile labels/references as text without requests", async t => {
    const page = await mounted(t, {}, { width: 390, height: 844 });
    await page.evaluate(async () => {
        window.fixture.catalog.connectors[0].label = '<img src="https://example.invalid/evil" onerror="window.PWNED=true">';
        await window.fixture.controller.refreshAdminWebhooks();
    });
    await expect(page.locator(".ps-webhooks__list")).toContainText('<img src="https://example.invalid/evil"');
    await expect(page.locator(".ps-webhooks img")).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.PWNED), undefined);
    await selectTab(page, "Session signals");
    await page.getByRole("button", { name: "Mint endpoint…", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Raise signal…", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Raise signal manually" })).toBeVisible();
});
