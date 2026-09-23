import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { handleWebhookInput } from "../src/webhook-input.js";
import { PilotSwarmTuiApp } from "../src/app.js";
import { createTuiPlatform } from "../src/platform.js";
import { buildHelpModalRows, selectStatusBar } from "../../ui/core/src/index.js";
import { drain, setupWebhooks, TEST_TOKEN, TEST_URL } from "../../ui/core/test/webhook-fixture.mjs";

test("native Webhooks keys use shared actions, real confirmation, pagination and scroll help", async () => {
    const { controller, value, calls } = setupWebhooks();
    await controller.refreshAdminWebhooks();
    assert.equal(handleWebhookInput(controller, "2"), true); await drain();
    assert.equal(value().tab, "bindings");
    handleWebhookInput(controller, "e");
    assert.equal(value().editor.kind, "bindings"); assert.equal(value().editor.expectedRevision, 3);
    handleWebhookInput(controller, "", { tab: true });
    assert.equal(value().editor.fields[value().editor.fieldIndex].id, "state");
    handleWebhookInput(controller, "", { downArrow: true });
    assert.equal(value().editor.values.state, "disabled");
    handleWebhookInput(controller, "", { return: true }); await drain();
    assert.equal(calls.find(call => call[0] === "updateWebhookBinding")[2].state, "disabled");
    handleWebhookInput(controller, "5"); await drain();
    handleWebhookInput(controller, "p");
    assert.equal(controller.getState().ui.modal.action, "webhookReplay");
    handleWebhookInput(controller, "n"); await drain();
    assert.equal(calls.some(call => call[0] === "replayWebhookReceipt"), false);
    handleWebhookInput(controller, "p");
    handleWebhookInput(controller, "y"); await drain();
    assert.deepEqual(calls.find(call => call[0] === "replayWebhookReceipt"), ["replayWebhookReceipt", "receipt-1", { confirmed: true }]);
    handleWebhookInput(controller, "d", { ctrl: true });
    assert.equal(value().detailOffset, 10);
    handleWebhookInput(controller, "u", { ctrl: true });
    assert.equal(value().detailOffset, 0);
    controller.setWebhookScrollLimit(12);
    handleWebhookInput(controller, "d", { ctrl: true });
    handleWebhookInput(controller, "d", { ctrl: true });
    assert.equal(value().detailOffset, 12);
    handleWebhookInput(controller, "u", { ctrl: true });
    assert.equal(value().detailOffset, 2, "scrolling back works immediately after hitting the bottom");
    assert.match(selectStatusBar(controller.getState()).right, /f filters.*p replay.*v related receipts/);
    assert.match(JSON.stringify(buildHelpModalRows()), /Admin Console.*Webhooks.*confirmed revoke/);
});

test("native form consumes q/d/session keys as text, choices as arrows and JSON newlines explicitly", async () => {
    const { controller, value, calls } = setupWebhooks();
    await controller.refreshAdminWebhooks();
    handleWebhookInput(controller, "n");
    handleWebhookInput(controller, "q");
    handleWebhookInput(controller, "d");
    assert.equal(value().editor.values.label, "qd");
    assert.equal(calls.some(call => /revoke|Session$/u.test(call[0])), false);
    handleWebhookInput(controller, "", { tab: true }); // provider
    handleWebhookInput(controller, "", { downArrow: true });
    assert.equal(value().editor.values.provider, "azure-devops");
    handleWebhookInput(controller, "", { tab: true }); // source JSON
    const oldValue = value().editor.values.source;
    handleWebhookInput(controller, "j", { ctrl: true });
    assert.equal(value().editor.values.source, `${oldValue}\n`);
    handleWebhookInput(controller, "", { escape: true });
    assert.equal(value().editor, null);
    handleWebhookInput(controller, "s");
    handleWebhookInput(controller, "", { downArrow: true });
    assert.equal(value().editor.values.sessionId, "s2");
    handleWebhookInput(controller, "", { escape: true });
    assert.equal(handleWebhookInput(controller, "m"), false, "existing section navigation stays with app.js");
    const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
    assert.ok(app.indexOf("if (handleWebhookInput(controller") < app.indexOf('if (focus !== "prompt" && input === "q"'));
    assert.match(app, /input === "h"[\s\S]*setAdminSection\("webhooks"\)/);
});

test("native capability copy is explicit and navigation/cancel never calls an external opener", async () => {
    const { controller, value } = setupWebhooks();
    await controller.setWebhookTab("endpoints");
    handleWebhookInput(controller, "n");
    handleWebhookInput(controller, "", { return: true }); await drain();
    assert.ok(value().capabilityId);
    const copies = [];
    const platform = { copyText: text => { copies.push(text); return { ok: true }; } };
    handleWebhookInput(controller, "o", {}, platform);
    assert.equal(copies.length, 0);
    handleWebhookInput(controller, "c", {}, platform); await drain();
    assert.deepEqual(copies, [TEST_URL]);
    handleWebhookInput(controller, "", { escape: true }, platform);
    assert.equal(controller.getWebhookCapability(), null);
    assert.equal(value().capabilityId, null);
});

test("native connector c copies the selected delivery URL or labeled relative path", async () => {
    for (const publicOrigin of [null, "https://hooks.example.invalid"]) {
        const { controller, value, calls } = setupWebhooks({ overrides: { bootstrap: { webhooks: { enabled: false, publicOrigin } } } });
        await controller.refreshAdminWebhooks();
        const copies = [];
        const platform = { copyText: text => { copies.push(text); return { ok: true }; } };
        assert.match(selectStatusBar(controller.getState()).right, /c copy delivery URL\/path/);
        assert.match(JSON.stringify(buildHelpModalRows()), /connectors c.*public delivery URL/);
        const before = calls.length;
        handleWebhookInput(controller, "c", {}, platform); await drain();
        assert.deepEqual(copies, [`${publicOrigin || ""}/hooks/c/connector-1`]);
        assert.equal(calls.length, before);
        assert.equal(value().capabilityId, null);
        assert.match(value().copyStatus, publicOrigin ? /Delivery URL copied/ : /Relative delivery path copied/);
    }
});

test("real Ink host boots locally with a synthetic controller and consumes actual keyboard input", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { controller, value } = setupWebhooks();
    await controller.refreshAdminWebhooks();
    // Do not bootstrap a worker, read configuration, or connect to a database.
    controller.start = async () => {};
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    let output = "";
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    stdout.columns = 140; stdout.rows = 45; stdout.isTTY = true;
    const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const platform = createTuiPlatform();
    platform.getViewport = () => ({ width: 140, height: 45 });
    const copies = [];
    platform.copyText = text => { copies.push(text); return { ok: true }; };
    let exits = 0, app;
    const press = async input => act(async () => { stdin.write(input); await drain(); });
    try {
        await act(async () => {
            app = render(React.createElement(PilotSwarmTuiApp, { controller, platform, onRequestExit: async () => { exits++; } }),
                { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false, isScreenReaderEnabled: false });
            await drain();
        });
        assert.match(output, /Webhooks/);
        assert.match(output, /Relative delivery path: \/hooks\/c\/connector-1/);
        await press("c"); assert.deepEqual(copies, ["/hooks/c/connector-1"]);
        await act(async () => {
            controller.transport.bootstrap = { webhooks: { enabled: true, publicOrigin: "https://hooks.example.invalid" } };
            await controller.refreshAdminWebhooks();
        });
        assert.match(output, /Delivery URL: https:\/\/hooks\.example\.invalid\/hooks\/c\/connector-1/);
        await press("c"); assert.equal(copies[1], "https://hooks.example.invalid/hooks/c/connector-1");
        await press("n"); assert.ok(value().editor);
        await press("q"); assert.equal(value().editor.values.label, "q"); assert.equal(exits, 0);
        await act(async () => { controller.closeWebhookDialog(); await controller.setWebhookTab("endpoints"); });
        await press("n"); await press("\r");
        assert.ok(value().capabilityId);
        assert.match(output, /Bearer token/);
        assert.match(output, new RegExp(TEST_TOKEN));
        output = "";
        await act(async () => { controller.closeWebhookDialog(); });
        assert.equal(controller.getWebhookCapability(), null);
        assert.doesNotMatch(output, new RegExp(TEST_TOKEN));
        assert.equal(exits, 0);
    } finally {
        if (app) { await act(async () => app.unmount()); app.cleanup(); }
        stdin.destroy(); stdout.destroy(); stderr.destroy();
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    }
});
