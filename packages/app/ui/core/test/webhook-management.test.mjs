import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    selectAdminConsole, selectStatusBar, selectWebhookConsole, webhookFormInput, validateWebhookAction,
    validateWebhookFilters, validateWebhookReceiptQuery, validateWebhookReference, validateWebhookTemplateConfig,
    buildWebhookConsoleLines,
} from "../src/index.js";
import { OWNER, OTHER, TEST_TOKEN, TEST_URL, binding, connector, deferred, drain, endpoint, fillWebhookForm, receipt, setupWebhooks } from "./webhook-fixture.mjs";

test("normal app UI test discovery includes core and React test directories", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    assert.match(scripts.test, /npm run test:ui/);
    assert.match(scripts["test:ui"], /ui\/core\/test\/\*\.test\.mjs/);
    assert.match(scripts["test:ui"], /ui\/react\/test\/\*\.test\.mjs/);
});

test("Webhooks is a shared Admin Console section for ordinary, admin and auth-disabled viewers without inferring admin", async () => {
    for (const [isAdmin, authDisabled] of [[true, false], [false, false], [false, true], [true, true]]) {
        const { controller, store } = setupWebhooks({ isAdmin, authDisabled });
        await controller.refreshAdminWebhooks();
        const view = selectWebhookConsole(store.getState());
        assert.equal(view.isAdmin, isAdmin);
        assert.equal(view.canCreate, isAdmin);
        assert.ok(selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "webhooks"));
        assert.ok(view.canEdit, "the visible resource owner can edit its metadata");
        controller.openWebhookEditor("connectors", "edit");
        assert.equal(store.getState().admin.webhooks.editor.fields.some(field => field.id === "auth"), isAdmin);
    }
    const { controller, store } = setupWebhooks();
    store.dispatch({ type: "auth/context", principal: OTHER, authorization: { role: "user" } });
    await controller.refreshAdminWebhooks();
    assert.equal(selectWebhookConsole(store.getState()).isAdmin, false, "a stale admin profile cannot elevate a new principal");
    assert.equal(selectWebhookConsole(store.getState()).canEdit, false);
});

test("bootstrap ingress is informational, not CRUD authorization or verified authentication", async () => {
    for (const enabled of [false, true, undefined, "true"]) {
        const { controller, store, transport, calls } = setupWebhooks({ overrides: { bootstrap: { webhooks: { enabled } } } });
        await controller.refreshAdminWebhooks();
        let view = selectWebhookConsole(store.getState());
        assert.equal(view.ingressEnabled, typeof enabled === "boolean" ? enabled : null);
        assert.equal(view.canCreate, true, "disabled or unknown ingress must not disable admin policy configuration");
        assert.equal(view.canEdit, true);
        assert.equal(view.selected.auth.configured, true);
        assert.match(view.ingressText, enabled === false ? /ingress disabled.*policies can still be configured/
            : enabled === true ? /ingress enabled.*not verified/ : /status is unavailable/);
        assert.match(JSON.stringify(buildWebhookConsoleLines(view)), /ingress/);
        controller.openWebhookEditor();
        fillWebhookForm(controller, { label: "Prepared policy", source: { repositoryId: "repo-1" } });
        await controller.submitWebhookEditor();
        const input = calls.find(call => call[0] === "createWebhookConnector")[1];
        assert.equal(Object.hasOwn(input, "enabled"), false, "host enablement never enters a management DTO");
        transport.bootstrap = null;
        await controller.refreshAdminWebhooks();
        view = selectWebhookConsole(store.getState());
        assert.equal(view.ingressEnabled, null, "missing metadata must not retain a stale enabled claim");
    }
    const ordinary = setupWebhooks({ isAdmin: false, overrides: { bootstrap: { webhooks: { enabled: true } } } });
    await ordinary.controller.refreshAdminWebhooks();
    assert.equal(selectWebhookConsole(ordinary.store.getState()).canCreate, false, "enabled ingress cannot grant admin powers");
});

test("connector delivery addresses use only bootstrap publicOrigin and the selected public ID", async () => {
    const path = "/hooks/c/connector%2F1%20%3Fx%3D%3Ca%3E";
    for (const publicOrigin of [undefined, null, "https://hooks.example.invalid", "http://127.0.0.1:4567"]) {
        const { controller, store, transport, calls, value } = setupWebhooks({
            isAdmin: false,
            overrides: { bootstrap: { webhooks: { enabled: false, publicOrigin } } },
            rows: { connectors: [connector({ id: "connector/1 ?x=<a>", owner: OTHER, url: "https://not-bootstrap.example.invalid" })] },
        });
        Object.defineProperty(transport, "api", { get() { throw new Error("Never infer an origin from the private API client"); } });
        Object.defineProperty(transport, "options", { get() { throw new Error("Never infer an origin from private transport options"); } });
        await controller.refreshAdminWebhooks();
        const view = selectWebhookConsole(store.getState());
        const expected = `${publicOrigin || ""}${path}`;
        assert.deepEqual(view.connectorDelivery, {
            url: expected, relative: !publicOrigin, label: publicOrigin ? "Delivery URL" : "Relative delivery path",
        });
        assert.equal(view.canCopyConnector, true, "readable public IDs can be copied without write access or enabled ingress");
        assert.equal(view.canEdit, false);
        const text = JSON.stringify(buildWebhookConsoleLines(view));
        assert.ok(text.includes(expected));
        assert.match(text, /Public connector ID, not a capability/);
        const copies = [];
        const callsBeforeCopy = calls.length;
        assert.equal(copies.length, 0);
        await controller.copyWebhookConnectorUrl(text => { copies.push(text); return { ok: true }; });
        assert.deepEqual(copies, [expected]);
        assert.equal(calls.length, callsBeforeCopy, "copy must not fetch or test a delivery");
        assert.equal(controller.getWebhookCapability(), null);
        assert.equal(value().capabilityId, null);
        assert.match(value().copyStatus, publicOrigin ? /Delivery URL copied/ : /Relative delivery path copied/);
        assert.equal(selectWebhookConsole(store.getState()).connectorDelivery.url, expected, "public connector addresses are not one-time capabilities");
    }
});

test("connector clipboard failure is visible and late copy feedback cannot follow selection/origin/navigation changes", async () => {
    const { controller, transport, value } = setupWebhooks({ rows: { connectors: [connector(), connector({ id: "connector-2" })] } });
    await controller.refreshAdminWebhooks();
    let copyCalls = 0;
    await controller.copyWebhookConnectorUrl(() => { copyCalls++; return false; });
    assert.equal(copyCalls, 1); assert.match(value().copyStatus, /Copy failed/);
    const copying = deferred();
    const first = controller.copyWebhookConnectorUrl(() => copying.promise);
    await controller.selectWebhookResource("connector-2");
    copying.resolve({ ok: true }); await first;
    assert.equal(value().copyStatus, null);
    const originCopy = deferred();
    const second = controller.copyWebhookConnectorUrl(() => originCopy.promise);
    transport.bootstrap = { webhooks: { enabled: true, publicOrigin: "https://configured.example.invalid" } };
    await controller.refreshAdminWebhooks();
    originCopy.resolve({ ok: true }); await second;
    assert.equal(value().copyStatus, null);
    const leaving = deferred();
    const third = controller.copyWebhookConnectorUrl(() => leaving.promise);
    await controller.setWebhookTab("health");
    leaving.resolve({ ok: true }); await third;
    assert.equal(value().copyStatus, null);
    await controller.copyWebhookConnectorUrl(() => { throw new Error("No connector selected"); });
    assert.equal(value().copyStatus, null);
});

test("connector create and revision-guarded update use canonical DTOs and never repopulate saved auth references", async () => {
    const { controller, calls, value, catalog } = setupWebhooks({ rows: { connectors: [connector({ auth: {
        mode: "github-hmac-sha256", configured: true, secretRef: "DO_NOT_RETAIN_SAVED_REFERENCE", secret: "DO_NOT_RETAIN_SECRET",
    } })] } });
    await controller.refreshAdminWebhooks();
    assert.doesNotMatch(JSON.stringify(value()), /DO_NOT_RETAIN/);
    controller.openWebhookEditor();
    fillWebhookForm(controller, { label: "PR events", source: { repositoryId: "repo-1" }, auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_WEBHOOK" }, owner: OWNER, rateLimitPerMinute: "120" });
    await controller.submitWebhookEditor();
    const create = calls.find(call => call[0] === "createWebhookConnector");
    assert.deepEqual(create, ["createWebhookConnector", { label: "PR events", provider: "github", source: { repositoryId: "repo-1" },
        auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_WEBHOOK" }, owner: OWNER, rateLimitPerMinute: 120 }]);
    assert.equal(Object.hasOwn(create[1], "viewer"), false);
    controller.openWebhookEditor("connectors", "edit");
    assert.equal(value().editor.values.auth, "");
    fillWebhookForm(controller, { label: "Disabled label", state: "quarantined" });
    await controller.submitWebhookEditor();
    const update = calls.find(call => call[0] === "updateWebhookConnector");
    assert.equal(update[1], "connector-1"); assert.equal(update[2].expectedRevision, 3);
    assert.equal(update[2].state, "quarantined"); assert.equal(update[2].auth, undefined);
    assert.equal(update[2].source, undefined); assert.equal(update[2].owner, undefined);
    assert.equal(catalog.connectors[0].revision, 4);
});

test("Azure DevOps creation labels and validates approved Basic references and fixed source mapping", async () => {
    const { controller, calls, value } = setupWebhooks();
    controller.openWebhookEditor();
    fillWebhookForm(controller, { label: "Builds", provider: "azure-devops", source: { repositoryId: "repo" },
        auth: { mode: "ado-basic", usernameRef: "ADO_USERNAME", passwordRef: "ADO_PASSWORD" } });
    await controller.submitWebhookEditor();
    assert.match(value().editor.error, /projectId/); assert.equal(calls.length, 0);
    fillWebhookForm(controller, { source: { repositoryId: "repo", projectId: "project", buildDefinitionId: "42" } });
    await controller.submitWebhookEditor();
    assert.deepEqual(calls.find(call => call[0] === "createWebhookConnector")[1].auth,
        { mode: "ado-basic", usernameRef: "ADO_USERNAME", passwordRef: "ADO_PASSWORD" });
});

test("JSON/config is parsed, allowlisted and inert; plaintext secrets and privileged action fields are rejected", async () => {
    for (const reference of ["plain-secret", "ghp_not_a_reference", "a", "A".repeat(65), "A;process.exit()"]) {
        assert.throws(() => validateWebhookReference(reference), /Do not paste a secret/);
    }
    assert.equal(validateWebhookReference("SERVER_REF_1"), "SERVER_REF_1");
    assert.throws(() => validateWebhookFilters({ "$.repository": "repo" }), /unsupported/);
    assert.throws(() => validateWebhookFilters({ eventType: { equals: "x" } }), /equality/);
    assert.throws(() => validateWebhookAction({ type: "raise_signal", sessionId: "s1", signalName: "ok", owner: OWNER }), /unsupported/);
    assert.throws(() => validateWebhookAction({ type: "create_session", templateId: "approved", model: "injected" }), /unsupported/);
    assert.throws(() => validateWebhookTemplateConfig({ namespace: "app", tools: ["shell"] }), /unsupported/);
    assert.throws(() => validateWebhookReceiptQuery({ limit: 101 }), /1 to 100/);
    assert.throws(() => validateWebhookReceiptQuery({ bindingId: "unsupported" }), /unsupported/);
    const { controller, calls, value } = setupWebhooks();
    controller.openWebhookEditor();
    fillWebhookForm(controller, { label: "Safe", source: '(()=>{throw "EXECUTED"})()', auth: '{"mode":"github-hmac-sha256","secretRef":"REF"}' });
    await controller.submitWebhookEditor();
    assert.match(value().editor.error, /valid JSON \(not JavaScript\)/);
    assert.doesNotMatch(value().editor.error, /EXECUTED/); assert.equal(calls.length, 0);
});

test("binding forms support every fixed action/coalescing variant without opting in to coalescing", async () => {
    const actions = [
        { type: "create_session", templateId: "template-1" },
        { type: "raise_signal", sessionId: "s1", signalName: "ready", wake: true },
        { type: "enqueue_prompt", sessionId: "s1", prompt: { instruction: "Inspect as data.", fields: ["title"] } },
        ...[{ type: "noop" }, { type: "raise_signal", signalName: "updated", wake: false },
            { type: "enqueue_prompt", prompt: { instruction: "Update.", fields: ["action"] } }]
            .map(onMatch => ({ type: "create_session", templateId: "template-1", coalescing: { key: "repository_pull_request", onMatch } })),
    ];
    for (const action of actions) {
        const { controller, calls } = setupWebhooks({ isAdmin: false });
        await controller.setWebhookTab("bindings");
        controller.openWebhookEditor();
        fillWebhookForm(controller, { label: "Trusted route", connectorId: "connector-1", filters: { action: ["opened", "updated"], pullRequestNumber: 4 }, action });
        await controller.submitWebhookEditor();
        const created = calls.find(call => call[0] === "createWebhookBinding");
        assert.deepEqual(created[1].action, action);
        assert.equal(created[1].owner, undefined);
        assert.equal(Object.hasOwn(created[1].action, "coalescing"), Object.hasOwn(action, "coalescing"));
    }
});

test("template forms preserve minimal effort across create/edit without forcing effort or model", async () => {
    for (const config of [{ namespace: "app" }, { namespace: "app", reasoningEffort: "minimal" }]) {
        const { controller, calls, value } = setupWebhooks();
        await controller.setWebhookTab("templates");
        controller.openWebhookEditor();
        assert.deepEqual(JSON.parse(value().editor.values.config), { namespace: "app" }, "new templates do not force a model or effort");
        fillWebhookForm(controller, { label: "Optional reasoning", source: { repositoryId: "repo-1" }, config });
        assert.equal((await controller.submitWebhookEditor()).ok, true);
        assert.deepEqual(calls.find(call => call[0] === "createWebhookSessionTemplate")[1].config, config);

        await controller.selectWebhookResource("templates-new");
        controller.openWebhookEditor("templates", "edit");
        assert.deepEqual(JSON.parse(value().editor.values.config), config, "the editor retains the saved effort or its absence");
        assert.equal((await controller.submitWebhookEditor()).ok, true);
        assert.deepEqual(calls.find(call => call[0] === "updateWebhookSessionTemplate")[2].config, config);
    }
});

test("templates require admin approval for policy/config but permit owner metadata edits", async () => {
    const { controller, calls, value } = setupWebhooks();
    await controller.setWebhookTab("templates");
    controller.openWebhookEditor();
    fillWebhookForm(controller, { label: "Approved review", owner: OWNER, source: { repositoryId: "repo-1" },
        config: { namespace: "app", agentName: "reviewer", model: "trusted:model", reasoningEffort: "high", contextTier: "long_context", visibility: "private" },
        prompt: { instruction: "Review only this policy.", fields: ["title", "url"] } });
    await controller.submitWebhookEditor();
    const created = calls.find(call => call[0] === "createWebhookSessionTemplate");
    assert.equal(created[1].config.model, "trusted:model"); assert.equal(created[1].source.repositoryId, "repo-1");
    assert.equal(value().editor, null);
    const ordinary = setupWebhooks({ isAdmin: false });
    await ordinary.controller.setWebhookTab("templates");
    ordinary.controller.openWebhookEditor();
    assert.equal(ordinary.value().editor, null);
    ordinary.controller.openWebhookEditor("templates", "edit");
    assert.deepEqual(ordinary.value().editor.fields.map(field => field.id), ["label", "state"]);
    fillWebhookForm(ordinary.controller, { label: "Owner metadata", state: "disabled", config: { namespace: "injection" } });
    await ordinary.controller.submitWebhookEditor();
    assert.deepEqual(ordinary.calls.find(call => call[0] === "updateWebhookSessionTemplate")[2],
        { label: "Owner metadata", expectedRevision: 3, state: "disabled" });
});

test("authorization failures remain visible; readable resources do not imply write privileges", async () => {
    const { controller, value, calls } = setupWebhooks({ isAdmin: false, rows: { connectors: [connector({ owner: OTHER })] },
        overrides: { createWebhookBinding: async () => { throw Object.assign(new Error("Resource owner/admin permission required"), { status: 403, code: "FORBIDDEN" }); } } });
    await controller.refreshAdminWebhooks();
    assert.equal(value().connectors.rows.length, 1, "the UI does not invent client-side read filtering");
    assert.equal(selectWebhookConsole(controller.getState()).canEdit, false);
    controller.openWebhookEditor("connectors", "edit"); assert.equal(value().editor, null);
    await controller.setWebhookTab("bindings"); controller.openWebhookEditor();
    fillWebhookForm(controller, { label: "denied", connectorId: "connector-1", action: { type: "raise_signal", sessionId: "s1", signalName: "ok" } });
    await controller.submitWebhookEditor();
    assert.match(value().error, /FORBIDDEN.*owner\/admin/);
    assert.equal(value().pending, null);
    assert.equal(calls.filter(call => call[0] === "replayWebhookReceipt").length, 0);
});

test("stale patches refresh metadata, preserve the old revision/draft and cannot silently resubmit", async () => {
    const { controller, value, catalog, calls } = setupWebhooks();
    await controller.refreshAdminWebhooks();
    controller.openWebhookEditor("connectors", "edit");
    fillWebhookForm(controller, { label: "my edit" });
    catalog.connectors[0].revision = 9;
    catalog.connectors[0].label = "concurrent edit";
    await controller.submitWebhookEditor();
    assert.equal(value().connectors.rows[0].revision, 9);
    assert.equal(value().editor.expectedRevision, 3);
    assert.equal(value().editor.values.label, "my edit");
    assert.equal(value().editor.stale, true);
    assert.match(value().error, /STALE_REVISION.*not retried/);
    await controller.submitWebhookEditor();
    assert.equal(calls.filter(call => call[0] === "updateWebhookConnector").length, 1);
    controller.closeWebhookDialog();
    controller.openWebhookEditor("connectors", "edit");
    assert.equal(value().editor.expectedRevision, 9);
    assert.equal(value().editor.values.label, "concurrent edit");
    await controller.submitWebhookEditor();
    assert.equal(calls.filter(call => call[0] === "updateWebhookConnector")[1][2].expectedRevision, 9);
});

test("refreshing while editing does not replace expectedRevision or allow a locally stale save", async () => {
    const { controller, catalog, calls, value } = setupWebhooks();
    await controller.setWebhookTab("bindings"); controller.openWebhookEditor("bindings", "edit");
    catalog.bindings[0].revision = 4;
    await controller.refreshAdminWebhooks(); await controller.submitWebhookEditor();
    assert.equal(value().editor.expectedRevision, 3); assert.equal(value().editor.stale, true);
    assert.equal(calls.some(call => call[0] === "updateWebhookBinding"), false);
});

test("dry-run sends a normalized event wrapper and labels persisted policy as weaker than host/model admission", async () => {
    const { controller, calls, value } = setupWebhooks();
    await controller.refreshAdminWebhooks(); await controller.setWebhookTab("bindings");
    controller.openWebhookEditor("test");
    const event = { version: 1, provider: "github", eventType: "pull_request.lifecycle", action: "opened", repositoryId: "repo-1", pullRequestNumber: 42 };
    fillWebhookForm(controller, { event }); await controller.submitWebhookEditor();
    assert.deepEqual(calls.find(call => call[0] === "testWebhookBinding"), ["testWebhookBinding", "binding-1", { event }]);
    assert.deepEqual(value().testResult, { matches: true, authorized: true, authorizationScope: "persisted_policy", action: "raise_signal" });
    const view = selectWebhookConsole(controller.getState());
    assert.match(view.testHelp, /does not guarantee.*model admission/);
    assert.equal(calls.some(call => call[0] === "raiseSignal"), false);
});

test("manual signal controls retain race/wait metadata and send data only as data with a fixed session target", async () => {
    const { controller, calls, value } = setupWebhooks({ isAdmin: false });
    await controller.setWebhookTab("endpoints");
    assert.equal(value().sessionId, "s1");
    assert.match(selectWebhookConsole(controller.getState()).waitText, /Waiting for first event: ready or user input.*no deadline/);
    assert.doesNotMatch(JSON.stringify(value().signalState), /DO_NOT_RETAIN_SIGNAL_PAYLOAD/);
    controller.openWebhookEditor("signal");
    fillWebhookForm(controller, { name: "ready", data: { instruction: "<script>not code</script>", owner: OTHER, model: "inert" },
        payloadRef: "https://example.invalid/do-not-fetch", signalId: "manual-test", wake: "true" });
    await controller.submitWebhookEditor();
    assert.deepEqual(calls.find(call => call[0] === "raiseSignal"), ["raiseSignal", "s1", "ready", {
        data: { instruction: "<script>not code</script>", owner: OTHER, model: "inert" },
        payloadRef: "https://example.invalid/do-not-fetch", signalId: "manual-test", wake: true,
    }]);
    assert.match(value().notice, /queued durably.*not yet confirmed/);
    assert.equal(calls.some(call => call[0] === "createWebhookSessionTemplate"), false);
    await controller.setWebhookSession("system"); assert.match(value().error, /ordinary session/);
});

async function mint(fixture) {
    await fixture.controller.setWebhookTab("endpoints");
    fixture.controller.openWebhookEditor();
    fillWebhookForm(fixture.controller, { signalName: "ready" });
    await fixture.controller.submitWebhookEditor();
}

test("minted capabilities never enter shared state, selectors, actions, statuses or lists; copy requires a gesture", async () => {
    assert.match(TEST_TOKEN, /^pswh_[A-Za-z0-9_-]{43}$/u, "fixture follows the prefixed token contract, not a raw 43-character UI assumption");
    const fixture = setupWebhooks();
    const { controller, store, value, calls } = fixture;
    const snapshots = [];
    const unsubscribe = store.subscribe(state => snapshots.push(JSON.stringify(state)));
    await mint(fixture);
    assert.deepEqual(controller.getWebhookCapability(), { token: TEST_TOKEN, url: TEST_URL });
    assert.ok(value().capabilityId);
    assert.ok(snapshots.every(snapshot => !snapshot.includes(TEST_TOKEN) && !snapshot.includes(TEST_URL)));
    assert.equal(JSON.stringify(selectAdminConsole(store.getState())).includes(TEST_TOKEN), false);
    assert.equal(JSON.stringify(selectStatusBar(store.getState())).includes(TEST_TOKEN), false);
    assert.doesNotMatch(JSON.stringify(value().endpoints.rows), /token|\/hooks\/s\//);
    const sent = calls.find(call => call[0] === "createSignalEndpoint");
    assert.deepEqual(sent, ["createSignalEndpoint", "s1", "ready", { wake: false }], "server applies default 30-day expiry and 60/min quota");
    const copies = [];
    assert.equal(copies.length, 0);
    await controller.copyWebhookCapability(text => { copies.push(text); });
    assert.deepEqual(copies, [TEST_URL]);
    assert.match(value().copyStatus, /sensitive/);
    controller.closeWebhookDialog(); assert.equal(controller.getWebhookCapability(), null);
    await controller.refreshAdminWebhooks();
    assert.equal(controller.getWebhookCapability(), null, "listing is never a way to reveal a capability again");
    unsubscribe();
});

test("capabilities and editors clear on every navigation/identity path, including direct reducer actions", async () => {
    const navigations = [
        c => c.closeWebhookDialog(),
        c => c.closeAdminConsole(),
        c => c.setAdminSection("providers"),
        c => c.setWebhookTab("health"),
        c => c.setWebhookSession("s2"),
        c => c.dispatch({ type: "sessions/selected", sessionId: "s2" }),
        c => c.dispatch({ type: "sessions/navigationIntent", sessionId: "not-yet-loaded" }),
        c => c.dispatch({ type: "ui/budgetOpen", open: true }),
        c => c.dispatch({ type: "ui/modal", modal: { type: "help" } }),
        c => c.dispatch({ type: "admin/profile/loaded", profile: { ...OWNER, isAdmin: false } }),
        c => c.dispatch({ type: "auth/context", principal: OTHER, authorization: { role: "user" } }),
        c => c.stop(),
    ];
    for (const navigate of navigations) {
        const fixture = setupWebhooks();
        await mint(fixture); await navigate(fixture.controller);
        assert.equal(fixture.controller.getWebhookCapability(), null);
        assert.equal(fixture.value().capabilityId, null);
        assert.equal(fixture.value().editor, null);
    }
});

test("reused controllers restore capability erasure and reject mismatched mint responses", async () => {
    const fixture = setupWebhooks();
    await mint(fixture); await fixture.controller.stop();
    await mint(fixture);
    assert.ok(fixture.controller.getWebhookCapability());
    fixture.store.dispatch({ type: "ui/budgetOpen", open: true });
    assert.equal(fixture.controller.getWebhookCapability(), null);
    const mismatch = setupWebhooks({ overrides: { createSignalEndpoint: async () => ({
        ...endpoint({ sessionId: "wrong-target" }), token: TEST_TOKEN, url: TEST_URL,
    }) } });
    await mint(mismatch);
    assert.equal(mismatch.controller.getWebhookCapability(), null);
    assert.match(mismatch.value().error, /response was incomplete.*Refresh and revoke/);
});

test("a pending mint prevents duplicate submit and cannot reopen a capability after cancel/navigation", async () => {
    const pending = deferred(); let writes = 0;
    const fixture = setupWebhooks({ overrides: { createSignalEndpoint: () => { writes++; return pending.promise; } } });
    const { controller, value } = fixture;
    await controller.setWebhookTab("endpoints"); controller.openWebhookEditor();
    const saving = controller.submitWebhookEditor(); await drain();
    assert.ok(value().pending);
    await controller.submitWebhookEditor(); assert.equal(writes, 1);
    controller.closeWebhookDialog(); assert.match(value().notice, /may still complete/);
    pending.resolve({ ...endpoint(), token: TEST_TOKEN, url: TEST_URL }); await saving;
    assert.equal(controller.getWebhookCapability(), null);
    assert.equal(value().capabilityId, null);
});

test("endpoint limits/reference validation is shared; ordinary users cannot send an HMAC reference", async () => {
    const fixture = setupWebhooks();
    await fixture.controller.setWebhookTab("endpoints"); fixture.controller.openWebhookEditor();
    fillWebhookForm(fixture.controller, { expiresAt: new Date(Date.now() + 91 * 86400_000).toISOString() });
    await fixture.controller.submitWebhookEditor(); assert.match(fixture.value().editor.error, /90 days/);
    fillWebhookForm(fixture.controller, { expiresAt: "", maxUses: "5", rateLimitPerMinute: "601" });
    await fixture.controller.submitWebhookEditor(); assert.match(fixture.value().editor.error, /600/);
    fillWebhookForm(fixture.controller, { rateLimitPerMinute: "30", hmacSecretRef: "ENDPOINT_HMAC", wake: "false" });
    await fixture.controller.submitWebhookEditor();
    assert.equal(fixture.calls.find(call => call[0] === "createSignalEndpoint")[3].hmacSecretRef, "ENDPOINT_HMAC");
    const ordinary = setupWebhooks({ isAdmin: false });
    await ordinary.controller.setWebhookTab("endpoints"); ordinary.controller.openWebhookEditor();
    assert.equal(ordinary.value().editor.fields.some(field => field.id === "hmacSecretRef"), false);
    fillWebhookForm(ordinary.controller, { hmacSecretRef: "INJECTED" });
    const input = webhookFormInput(ordinary.value().editor, { isAdmin: false });
    assert.equal(input.hmacSecretRef, undefined);
});

test("replay always confirms the exact selected receipt; cancel, fake confirmation and double click never replay", async () => {
    const { controller, calls, value } = setupWebhooks();
    await controller.setWebhookTab("receipts");
    await controller.confirmWebhookAction({ type: "confirm", action: "webhookReplay", extras: { id: "receipt-1", generation: value().generation } });
    assert.equal(calls.some(call => call[0] === "replayWebhookReceipt"), false);
    controller.requestWebhookReplay();
    assert.equal(controller.getState().ui.modal.action, "webhookReplay");
    controller.closeModal(); assert.equal(calls.some(call => call[0] === "replayWebhookReceipt"), false);
    controller.requestWebhookReplay();
    await Promise.all([controller.confirmModal(), controller.confirmModal()]);
    assert.deepEqual(calls.filter(call => call[0] === "replayWebhookReceipt"), [["replayWebhookReceipt", "receipt-1", { confirmed: true }]]);
    assert.match(value().notice, /requested once.*not consumption/);
});

test("all revocations use their own confirmed operation, never a session mutation", async () => {
    for (const [kind, name, id] of [["connectors", "revokeWebhookConnector", "connector-1"], ["bindings", "revokeWebhookBinding", "binding-1"],
        ["templates", "revokeWebhookSessionTemplate", "template-1"], ["endpoints", "revokeSignalEndpoint", "endpoint-1"]]) {
        const { controller, calls } = setupWebhooks();
        await controller.setWebhookTab(kind);
        controller.requestWebhookRevoke();
        assert.match(controller.getState().ui.modal.message, /does not terminate or delete any session/);
        assert.equal(calls.some(call => call[0] === name), false);
        await controller.confirmModal();
        assert.deepEqual(calls.filter(call => call[0] === name), [[name, id]]);
        assert.equal(selectWebhookConsole(controller.getState()).canRevoke, false);
        assert.equal(calls.some(call => /cancelSession|completeSession|deleteSession/u.test(call[0])), false);
    }
});

test("receipt filters, opaque paging, detail timeline, counts, error states and scoped metrics are distinct", async () => {
    const fixtures = Array.from({ length: 5 }, (_, index) => receipt({ receiptId: `opaque-${5 - index}`, status: "dead_lettered", lastErrorCode: "TARGET_DENIED", attempts: 8 }));
    const { controller, calls, value } = setupWebhooks({ rows: { receipts: fixtures } });
    await controller.setWebhookTab("receipts"); controller.openWebhookEditor("receipts");
    fillWebhookForm(controller, { limit: "2", connectorId: "connector-1", sessionId: "s1", status: "dead_lettered" });
    await controller.submitWebhookEditor();
    assert.deepEqual(value().receipts.rows.map(row => row.receiptId), ["opaque-5", "opaque-4"]);
    assert.equal(value().receipts.hasMore, true);
    assert.deepEqual(value().receipts.detail.timeline.map(row => row.status), ["received", "queued"]);
    await controller.pageWebhookReceipts(1);
    assert.deepEqual(value().receipts.query, { connectorId: "connector-1", sessionId: "s1", status: "dead_lettered", limit: 2, before: "opaque-4" });
    assert.deepEqual(value().receipts.rows.map(row => row.receiptId), ["opaque-3", "opaque-2"]);
    await controller.pageWebhookReceipts(1);
    assert.equal(value().receipts.hasMore, false);
    await controller.pageWebhookReceipts(-1);
    assert.deepEqual(value().receipts.rows.map(row => row.receiptId), ["opaque-3", "opaque-2"]);
    await controller.pageWebhookReceipts(0);
    assert.equal(value().receipts.query.before, undefined);
    assert.deepEqual(value().receipts.cursors, []);
    const text = JSON.stringify(buildWebhookConsoleLines(selectWebhookConsole(controller.getState())));
    assert.match(text, /Dead-lettered/); assert.match(text, /TARGET_DENIED/);
    assert.equal(calls.some(call => call[0] === "replayWebhookReceipt"), false, "no automatic replay while inspecting failures");
    await controller.setWebhookTab("health");
    assert.equal(value().health.data.pending, 4); assert.equal(value().health.data.deadLettered, 2);
    assert.equal(value().health.data.oldestDeadLetterAgeSeconds, 75);
});

test("old receipt detail/list responses cannot overwrite a newer selection or query", async () => {
    const slow = deferred(), olderList = deferred();
    const { controller, value, transport } = setupWebhooks({ rows: { receipts: [receipt(), receipt({ receiptId: "receipt-2" })] } });
    await controller.setWebhookTab("receipts");
    transport.getWebhookReceipt = id => id === "receipt-1" ? slow.promise : Promise.resolve(receipt({ receiptId: id, status: "consumed" }));
    const a = controller.loadWebhookReceipt("receipt-1");
    await controller.selectWebhookResource("receipt-2");
    slow.resolve(receipt({ status: "rejected" })); await a;
    assert.equal(value().receipts.detail.receiptId, "receipt-2");
    assert.equal(value().receipts.detail.status, "consumed");
    transport.listWebhookReceipts = query => query.status === "queued" ? olderList.promise : Promise.resolve([]);
    const b = controller._loadWebhookReceipts({ limit: 25, status: "queued" }, []);
    await controller._loadWebhookReceipts({ limit: 25, status: "consumed" }, []);
    olderList.resolve([receipt()]); await b;
    assert.equal(value().receipts.query.status, "consumed"); assert.deepEqual(value().receipts.rows, []);
});

test("clearing the receipt page-size field still sends an explicit bounded paging limit", async () => {
    const { controller, calls, value } = setupWebhooks();
    await controller.setWebhookTab("receipts"); controller.openWebhookEditor("receipts");
    fillWebhookForm(controller, { limit: "" }); await controller.submitWebhookEditor();
    assert.equal(value().receipts.query.limit, 25);
    assert.equal(calls.filter(call => call[0] === "listWebhookReceipts").at(-1)[1].limit, 25);
});

test("read/connection failure clears stale rows and shows errors rather than fabricated empty health", async () => {
    const { controller, value, transport, store } = setupWebhooks();
    await controller.refreshAdminWebhooks();
    transport.listWebhookConnectors = async () => { throw Object.assign(new Error("access revoked"), { status: 403, code: "FORBIDDEN" }); };
    await controller.refreshAdminWebhooks();
    assert.deepEqual(value().connectors.rows, []); assert.match(value().connectors.error, /FORBIDDEN/);
    assert.equal(selectWebhookConsole(store.getState()).canEdit, false);
    transport.getWebhookMetrics = async () => { throw new Error("Connection lost"); };
    store.dispatch({ type: "connection/error", error: "offline" });
    await controller.setWebhookTab("health");
    assert.equal(value().health.data, null); assert.match(value().health.error, /Connection lost/);
    assert.match(selectWebhookConsole(store.getState()).connectionError, /unavailable/);
    delete transport.listWebhookBindings;
    await controller.setWebhookTab("bindings");
    assert.match(value().bindings.error, /not available on this transport/);
});

test("identity changes discard old reads and in-flight edits; server denials have no unsafe fallback", async () => {
    const oldRead = deferred(), failedReplay = deferred(); let replays = 0;
    const { controller, store, value } = setupWebhooks({ overrides: { listWebhookConnectors: () => oldRead.promise,
        replayWebhookReceipt: () => { replays++; return failedReplay.promise; } } });
    const loading = controller.refreshAdminWebhooks();
    store.dispatch({ type: "auth/context", principal: OTHER, authorization: { role: "user" } });
    oldRead.resolve([connector()]); await loading;
    assert.deepEqual(value().connectors.rows, []);
    await controller.setWebhookTab("receipts"); controller.requestWebhookReplay();
    const replaying = controller.confirmModal(); await drain();
    assert.ok(value().pending);
    failedReplay.reject(Object.assign(new Error("Replay denied"), { status: 403, code: "FORBIDDEN" }));
    await replaying; await drain();
    assert.equal(replays, 1); assert.match(value().error, /FORBIDDEN.*Replay denied/);
});

test("mutation timeout remains uncertain and visible, with no retry or late capability disclosure", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const response = deferred(); let writes = 0;
    const fixture = setupWebhooks({ overrides: { createSignalEndpoint: () => { writes++; return response.promise; } } });
    await fixture.controller.setWebhookTab("endpoints"); fixture.controller.openWebhookEditor();
    const saving = fixture.controller.submitWebhookEditor(); await drain();
    t.mock.timers.tick(15_000); await saving;
    assert.match(fixture.value().error, /timed out.*outcome may be unknown.*no automatic retry/);
    assert.equal(fixture.value().pending, null); assert.equal(writes, 1);
    response.resolve({ ...endpoint(), token: TEST_TOKEN, url: TEST_URL }); await drain();
    assert.equal(fixture.controller.getWebhookCapability(), null);
});
