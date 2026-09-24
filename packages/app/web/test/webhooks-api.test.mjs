import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import express from "express";
import { WebhookRuntime, WEBHOOK_MAX_BODY_BYTES, PilotSwarmManagementClient } from "../../../sdk/dist/index.js";
import { createWebhookRouter, webhookRequestContext } from "../api/webhooks.js";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";
import { webhookHostConfig, authorizeWebhookTemplate } from "../../tui/src/webhook-host.js";

const secret = "local-only-synthetic-hook-secret";
const connectorId = "whc_00000000-0000-4000-8000-000000000001";
const actor = { provider: "test", subject: "owner" };
const config = { enabled: true, allowLoopbackHttp: true, trustedProxyIps: [] };
const fixtureBody = '{\n"repository":{"id":123},"action":"completed","workflow_run":{"id":456,"status":"completed","conclusion":"success"}\n}';
const sign = raw => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

async function serverFor(app) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function ingressFixture(options = {}) {
    const accepted = [], counters = [];
    const store = {
        preflight: async () => true, originRate: async () => true,
        ingressConfig: async () => ({ id: connectorId, revision: 1, provider: "github",
            source: { repositoryId: "123" }, auth: { mode: "github-hmac-sha256", secretRef: "FIXTURE" } }),
        ingressFailure: async (_id, outcome) => { counters.push(outcome); },
        accept: async (...args) => { accepted.push(args); return { accepted: true }; },
    };
    const backend = new WebhookRuntime(store, { client: {}, secretResolver: async () => secret, allowLoopbackHttp: true, ...options.backend });
    const app = express();
    app.set("trust proxy", true);
    app.use("/hooks", createWebhookRouter({
        runtime: { getWebhookRuntime: async () => backend }, config: { ...config, ...options.config },
        onError: code => counters.push(code),
    }));
    // Mirrors production: the shared JSON parser must never touch hook bodies.
    app.use(express.json());
    const server = await serverFor(app);
    const post = (body = fixtureBody, headers = {}) => fetch(`${server.base}/hooks/c/${connectorId}`, {
        method: "POST", body,
        headers: { "content-type": "application/json", "x-github-event": "workflow_run",
            "x-github-delivery": "local-delivery", "x-hub-signature-256": sign(body), ...headers },
    });
    return { ...server, post, accepted, counters };
}

test("public ingress authenticates exact bytes before normalization and accepts without routing", async () => {
    const fixture = await ingressFixture();
    try {
        const response = await fixture.post();
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { accepted: true });
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(fixture.accepted.length, 1);
        assert.equal(fixture.accepted[0][5].buildId, "456");
        assert.equal(fixture.accepted[0][5].conclusion, "success");
        assert.equal(fixture.accepted[0][5].provider, "github");
        const altered = JSON.stringify(JSON.parse(fixtureBody));
        const rejected = await fixture.post(altered, { "x-hub-signature-256": sign(fixtureBody) });
        assert.equal(rejected.status, 401);
        assert.equal(fixture.accepted.length, 1);
    } finally { await fixture.close(); }
});

test("signed GitHub setup ping is normalized without treating it as a PR/build event", async () => {
    const fixture = await ingressFixture();
    try {
        const response = await fixture.post('{"zen":"setup","repository":{"id":123},"hook_id":99}', { "x-github-event": "ping" });
        assert.equal(response.status, 202);
        assert.deepEqual(fixture.accepted[0][5], { version: 1, provider: "github", repositoryId: "123", eventType: "ping", action: "ping" });
    } finally { await fixture.close(); }
});

test("compressed, oversized and wrong-content-type requests fail before any durable acceptance", async () => {
    const fixture = await ingressFixture();
    try {
        for (const [body, headers, status] of [
            [fixtureBody, { "content-encoding": "gzip" }, 415],
            ["x".repeat(WEBHOOK_MAX_BODY_BYTES + 1), {}, 413],
            [fixtureBody, { "content-type": "text/plain" }, 415],
        ]) {
            const response = await fixture.post(body, headers);
            assert.equal(response.status, status);
            assert.equal((await response.json()).ok, false);
        }
        assert.equal(fixture.accepted.length, 0);
    } finally { await fixture.close(); }
});

test("disabled ingress and unknown hook paths do not reflect bearer capability strings", async () => {
    const fixture = await ingressFixture({ config: { enabled: false } });
    try {
        const response = await fixture.post();
        assert.equal(response.status, 404);
        assert.equal(fixture.accepted.length, 0);
        const token = "sensitive-capability-do-not-echo";
        const unknown = await fetch(`${fixture.base}/hooks/s/${token}`);
        assert.equal(unknown.status, 404);
        assert.ok(!(await unknown.text()).includes(token));
    } finally { await fixture.close(); }
});

test("malformed capability paths never reach Express's reflective error page", async () => {
    const fixture = await ingressFixture();
    try {
        const token = `pswh_${"x".repeat(43)}`;
        const response = await fetch(`${fixture.base}/hooks/s/${token}%ED%A0%80`, { method: "POST" });
        assert.equal(response.status, 400);
        assert.match(response.headers.get("content-type"), /application\/json/);
        assert.ok(!(await response.text()).includes(token));
        assert.equal(fixture.accepted.length, 0);
    } finally { await fixture.close(); }
});

test("webhook TLS uses socket state or explicitly trusted peers, not Express proxy trust", () => {
    const req = { socket: { remoteAddress: "::ffff:127.0.0.1" },
        rawHeaders: ["X-Forwarded-Proto", "https", "X-Forwarded-For", "203.0.113.1"] };
    assert.equal(webhookRequestContext(req).secure, false);
    assert.equal(webhookRequestContext(req).peerAddress, "127.0.0.1");
    assert.equal(webhookRequestContext(req, ["127.0.0.1"]).secure, true);
    assert.equal(webhookRequestContext({ ...req, rawHeaders: ["X-Forwarded-Proto", "https,http"] }, ["127.0.0.1"]).secure, false);
    assert.equal(webhookRequestContext({ ...req, rawHeaders: ["X-Forwarded-Proto", "https", "x-forwarded-proto", "https"] }, ["127.0.0.1"]).secure, false);
    assert.equal(webhookRequestContext({ socket: { encrypted: true, remoteAddress: "203.0.113.1" }, rawHeaders: [] }).secure, true);
    assert.throws(() => webhookRequestContext({ ...req, rawHeaders: ["X-GitHub-Delivery", "a", "x-github-delivery", "b"] }), /headers/);
});

test("server config refuses permissive proxy wildcards and non-HTTPS public origins", () => {
    assert.deepEqual(webhookHostConfig({}), { enabled: false, allowLoopbackHttp: false, publicOrigin: undefined, trustedProxyIps: [] });
    assert.equal(webhookHostConfig({ PILOTSWARM_WEBHOOK_PUBLIC_ORIGIN: "https://hooks.example.invalid/" }).publicOrigin, "https://hooks.example.invalid");
    assert.throws(() => webhookHostConfig({ PILOTSWARM_WEBHOOKS_ENABLED: "yes" }), /true or false/);
    assert.throws(() => webhookHostConfig({ PILOTSWARM_WEBHOOK_TRUSTED_PROXY_IPS: "*" }), /explicit IP/);
    assert.throws(() => webhookHostConfig({ PILOTSWARM_WEBHOOK_PUBLIC_ORIGIN: "http://example.invalid" }), /HTTPS/);
    assert.throws(() => webhookHostConfig({ PILOTSWARM_WEBHOOK_PUBLIC_ORIGIN: "https://example.invalid/hooks" }), /HTTPS/);
});

test("template placement rechecks current agent, namespace and generic-creation policy", async () => {
    let calls = 0;
    const transport = { getSessionCreationPolicy: () => ({ creation: { mode: "allowlist", allowGeneric: false } }),
        listCreatableAgents: async () => [{ name: "reviewer", source: "package", packageName: "devops" },
            { name: "internal", source: "builtin", supportsDirectStart: false }],
        _authorizePackageAgentCreate: async () => { calls++; } };
    const template = input => ({ source: { repositoryId: "123" }, config: input });
    assert.equal(await authorizeWebhookTemplate(transport, template({ namespace: "app" }), actor), false);
    assert.equal(await authorizeWebhookTemplate(transport, template({ agentName: "reviewer", namespace: "app" }), actor), false);
    assert.equal(await authorizeWebhookTemplate(transport, template({ agentName: "internal", namespace: "app" }), actor), false);
    assert.equal(await authorizeWebhookTemplate(transport, template({ agentName: "reviewer", namespace: "devops" }), actor), true);
    assert.equal(calls, 1);
    transport.listCreatableAgents = async () => [];
    assert.equal(await authorizeWebhookTemplate(transport, template({ agentName: "reviewer", namespace: "devops" }), actor), false);
});

test("HTTP/RPC management stamps trusted viewer identity and requires a committed current role", async () => {
    const calls = [], roles = [];
    const runtime = Object.create(PortalRuntime.prototype);
    Object.assign(runtime, {
        started: true, start: async () => {},
        authz: { enforce: true, systemVisibility: "read", defaultVisibility: "private", adminScope: "unrestricted" },
        _breakGlassSeen: new Map(),
        transport: {
            recordUserRole: async (principal, role) => roles.push({ principal, role }),
            mgmt: {
                createWebhookBinding: async (...args) => { calls.push(args); return { id: "binding" }; },
                listWebhookConnectors: async viewer => { calls.push(viewer); return []; },
                replayWebhookReceipt: async (...args) => { calls.push(args); return { status: "matched" }; },
            },
        },
    });
    const auth = { principal: actor, authorization: { allowed: true, role: "user" } };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth: (req, _res, next) => { req.auth = auth; next(); } }));
    const server = await serverFor(app);
    try {
        const input = { label: "Fixed binding", connectorId, filters: { action: "opened" },
            action: { type: "raise_signal", sessionId: "target", signalName: "ready" } };
        const response = await fetch(`${server.base}/api/v1/webhooks/bindings`, { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ input, viewer: { isAdmin: true, principal: { subject: "forged" } } }) });
        assert.equal(response.status, 200);
        assert.deepEqual(calls[0][0], input);
        assert.equal(calls[0][1].isAdmin, false);
        assert.equal(calls[0][1].principal.subject, actor.subject);
        assert.equal(roles[0].role, "user");
        const forbidden = await fetch(`${server.base}/api/v1/webhooks/connectors`, { method: "POST",
            headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(forbidden.status, 403);
        const deniedRetention = await fetch(`${server.base}/api/v1/webhooks/retention`, { method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ patch: { expectedRevision: 1, receiptRetentionDays: 90, replayRetentionDays: 7 } }) });
        assert.equal(deniedRetention.status, 403);
        runtime.transport.recordUserRole = async () => { throw new Error("role store failed"); };
        await assert.rejects(runtime.call("listWebhookConnectors", {}, auth), /role store/);
        assert.equal(calls.length, 1);
    } finally { await server.close(); }
});

test("all webhook management methods round-trip through the public web client and generated HTTP routes", async () => {
    const calls = [];
    const runtime = { call: async (method, params) => { calls.push({ method, params }); return { method, params }; } };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth: (req, _res, next) => {
        req.auth = { principal: actor, authorization: { allowed: true, role: "admin" } };
        next();
    } }));
    const server = await serverFor(app);
    const client = new PilotSwarmManagementClient({ apiUrl: server.base });
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const viewer = { principal: { provider: "forged", subject: "forged" }, isAdmin: true };
    const patch = { expectedRevision: 1, state: "disabled" };
    const cases = [
        ["createSignalEndpoint", [sessionId, "ready", { maxUses: 1 }, viewer], { sessionId, signalName: "ready", options: { maxUses: 1 } }],
        ["listSignalEndpoints", [sessionId, viewer], { sessionId }],
        ["revokeSignalEndpoint", ["sgep_fixture", viewer], { endpointId: "sgep_fixture" }],
        ...[["Connector", "connectorId"], ["Binding", "bindingId"], ["SessionTemplate", "templateId"]].flatMap(([kind, field]) => [
            [`createWebhook${kind}`, [{ label: kind }, viewer], { input: { label: kind } }],
            [`listWebhook${kind}s`, [viewer], {}],
            [`updateWebhook${kind}`, ["fixture", patch, viewer], { [field]: "fixture", patch }],
            [`revokeWebhook${kind}`, ["fixture", viewer], { [field]: "fixture" }],
        ]),
        ["testWebhookBinding", ["fixture", { event: { version: 1 } }, viewer], { bindingId: "fixture", event: { version: 1 } }],
        ["listWebhookReceipts", [{ status: "dead_lettered", limit: 10, before: "whr_before" }, viewer],
            { query: { status: "dead_lettered", limit: 10, before: "whr_before" } }],
        ["getWebhookReceipt", ["whr_fixture", viewer], { receiptId: "whr_fixture" }],
        ["replayWebhookReceipt", ["whr_fixture", { confirmed: true }, viewer], { receiptId: "whr_fixture", confirmed: true }],
        ["getWebhookMetrics", [viewer], {}],
        ["updateWebhookRetentionPolicy", [{ expectedRevision: 1, receiptRetentionDays: 90, replayRetentionDays: 7 }, viewer],
            { patch: { expectedRevision: 1, receiptRetentionDays: 90, replayRetentionDays: 7 } }],
    ];
    try {
        for (const [method, args, params] of cases) {
            const result = await client[method](...args);
            assert.deepEqual(result, { method, params }, method);
        }
        assert.equal(calls.length, 21);
        assert.ok(!JSON.stringify(calls).includes("forged"));
    } finally {
        await client.stop();
        await server.close();
    }
});
