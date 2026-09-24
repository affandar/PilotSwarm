import { randomUUID, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmClient } from "../../src/client.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { webhooksMigration } from "../../src/migrations/webhooks-0081.ts";
import { WebhookRuntime } from "../../src/webhook-runtime.ts";
import { createInspectTools } from "../../src/inspect-tools.ts";
import { webhookHash } from "../../src/webhook-validation.ts";
import { assert } from "../helpers/assertions.js";
import { durableSessionOrchestration_1_0_80 } from "../../src/orchestration/index.ts";
import { SIGNAL_ACTIVITY_NAMES, AGENT_HANDOFF_CAPABILITY, HANDOFF_ACTIVITY_NAMES } from "../../src/activity-routing.ts";
import { SIGNAL_ACTIVITY_CAPABILITY } from "../../src/session-signals.ts";
import { createWebhookRouter } from "../../../app/web/api/webhooks.js";

const url = process.env.PS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10000 });
afterAll(async () => { await pool.end(); });
const alice = { principal: { provider: "test", subject: "webhook-alice" }, isAdmin: false };
const bob = { principal: { provider: "test", subject: "webhook-bob" }, isAdmin: false };
const admin = { principal: { provider: "test", subject: "webhook-admin" }, isAdmin: true };
const source = { repositoryId: "123" };
const secret = "synthetic-webhook-storage-fixture";
const sign = body => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const request = (body, headers = {}, transport = {}) => ({
    rawBody: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    headers: { "content-type": "application/json", ...headers }, peerAddress: "127.0.0.1", secure: true, ...transport,
});
const event = (id = "delivery", overrides = {}) => {
    const body = { action: "opened", number: 7, repository: { id: 123 },
        pull_request: { state: "open", title: "A bounded PR fixture", html_url: "https://example.invalid/pr/7" }, ...overrides };
    const result = request(body, { "x-github-delivery": id, "x-github-event": "pull_request" });
    result.headers["x-hub-signature-256"] = sign(result.rawBody);
    return result;
};

async function fixture(run) {
    if (!url) throw new Error("Webhook storage tests require an explicit isolated PS_TEST_DATABASE_URL (or the normal suite DATABASE_URL).");
    const schema = `ps_test_webhooks_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(url, schema);
    const management = new PilotSwarmManagementClient({ store: "sqlite::memory:", webhookPublicOrigin: "https://hooks.example.invalid" });
    try {
        await catalog.initialize();
        for (const viewer of [alice, bob, admin]) await catalog.setUserRole(viewer.principal, viewer.isAdmin ? "admin" : "user");
        management._catalog = catalog;
        management._started = true;
        // This fixture exercises the real SDK + PostgreSQL contract, with only
        // the durable-queue boundary replaced. It does not invoke an LLM/provider.
        const starts = new Map();
        const queued = [];
        const native = {
            getStatus: async id => ({ status: starts.has(id) ? "Running" : "NotFound", customStatusVersion: 0 }),
            getInstanceInfo: async id => ({ status: starts.has(id) ? "Running" : "Unknown", orchestrationVersion: "1.0.80" }),
            startOrchestrationVersioned: async (id, _name, input, version) => { starts.set(id, { input, version }); },
            enqueueEvent: async (id, queue, payload) => { queued.push({ id, queue, payload: JSON.parse(payload) }); },
        };
        const freshClient = (provider = catalog) => {
            const facade = { webhooks: provider.webhooks };
            for (const method of ["getSession", "getSessionCreationConfig", "createSession", "updateSession", "recordEvents"]) {
                facade[method] = provider[method].bind(provider);
            }
            return PilotSwarmClient._fromRuntime({
                store: "sqlite::memory:", allowedAgentNames: ["reviewer"],
                sessionPolicy: { creation: { mode: "allowlist", allowGeneric: false } },
            }, facade, native);
        };
        const client = freshClient();
        const credentials = new Map([["GITHUB_TEST", secret], ["ADO_USER", "fixture-user"], ["ADO_PASS", "fixture-password"]]);
        const options = {
            client, secretResolver: async ref => {
                if (!credentials.has(ref)) throw Object.assign(new Error("Missing fixture credential"), { code: "WEBHOOK_SECRET_UNAVAILABLE" });
                return credentials.get(ref);
            },
            authorizeTemplate: async template => template.config.namespace === "app",
            onError: code => { throw new Error(`Unexpected pump failure: ${code}`); },
        };
        const runtime = management.createWebhookRuntime(options);
        const target = `target_${randomUUID()}`;
        await catalog.createSession(target, { owner: alice.principal });
        const connector = () => management.createWebhookConnector({
            label: "GitHub fixture", provider: "github", source, auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_TEST" }, owner: alice.principal,
        }, admin);
        const template = () => management.createWebhookSessionTemplate({
            label: "Approved reviewer", owner: alice.principal, source,
            config: { agentName: "reviewer", namespace: "app", visibility: "private" },
            prompt: { instruction: "Review the recorded PR.", fields: ["repositoryId", "pullRequestNumber", "title"] },
        }, admin);
        await run({ schema, catalog, management, store: catalog.webhooks, client, freshClient, runtime, options, queued, starts, native, credentials, target, connector, template });
    } finally {
        if (management._catalog) await management.stop();
        else await catalog.close();
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
}

describe.concurrent("durable webhook PostgreSQL and public SDK backend", () => {
    it.each(["raise_signal", "enqueue_prompt", "signal_endpoint"])("routes an authenticated HTTP %s through PostgreSQL and native Duroxide to a waiting session", { timeout: 45_000 }, actionType => fixture(async f => {
        const { SqliteProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");
        const provider = await SqliteProvider.inMemory();
        const native = new Client(provider);
        const runtime = new Runtime(provider, { workerNodeId: f.target, dispatcherPollIntervalMs: 10, logLevel: "error",
            workerTagFilter: { defaultAnd: [AGENT_HANDOFF_CAPABILITY, SIGNAL_ACTIVITY_CAPABILITY] },
            orchestrationConcurrency: 4, workerConcurrency: 4 });
        const turns = [];
        runtime.registerOrchestrationVersioned("durable-session-v2", "1.0.80", durableSessionOrchestration_1_0_80);
        for (const name of ["recordSessionEvent", "updateCmsState", "loadKnowledgeIndex", "getWorkerSessionPolicy",
            "getOrchestrationStats", HANDOFF_ACTIVITY_NAMES.listChildSessions, ...Object.values(SIGNAL_ACTIVITY_NAMES)]) {
            runtime.registerActivity(name, async (_ctx, input) => {
                if (name === "recordSessionEvent") { await f.catalog.recordEvents(input.sessionId, input.events); return null; }
                if (name === "updateCmsState") { await f.catalog.updateSession(input.sessionId, { state: input.state }); return null; }
                if (name === "getWorkerSessionPolicy") return { policy: null, allowedAgentNames: [] };
                if (name === "getOrchestrationStats") return { historySizeBytes: 0 };
                if (name === HANDOFF_ACTIVITY_NAMES.listChildSessions) return [];
                if (Object.values(SIGNAL_ACTIVITY_NAMES).includes(name)) {
                    turns.push(input);
                    return turns.length === 1
                        ? { type: "signal-wait", action: "wait", names: ["pr_ready"], reason: "Native webhook test", snapshotVersion: 1 }
                        : { type: "completed", content: "Fixture resumed", snapshotVersion: 2 };
                }
                return null;
            });
        }
        const facade = {};
        for (const method of ["getSession", "getSessionCreationConfig", "createSession", "updateSession", "recordEvents"]) {
            facade[method] = f.catalog[method].bind(f.catalog);
        }
        const sdk = PilotSwarmClient._fromRuntime({ store: "sqlite::memory:", waitThreshold: 30 }, facade, native);
        const ingress = f.management.createWebhookRuntime({ ...f.options, client: sdk, allowLoopbackHttp: true });
        const capability = actionType === "signal_endpoint"
            ? await f.management.createSignalEndpoint(f.target, "pr_ready", {}, alice) : null;
        const connector = capability ? null : await f.connector();
        if (connector) {
            await f.management.createWebhookBinding({ label: "Native route", connectorId: connector.id, filters: { action: "opened" },
                action: actionType === "raise_signal"
                    ? { type: actionType, sessionId: f.target, signalName: "pr_ready" }
                    : { type: actionType, sessionId: f.target, prompt: { instruction: "Inspect this PR.", fields: ["pullRequestNumber"] } },
            }, alice);
        }
        const app = express();
        app.use("/hooks", createWebhookRouter({ runtime: { getWebhookRuntime: async () => ingress },
            config: { enabled: true, trustedProxyIps: [] } }));
        const server = http.createServer(app);
        const instance = `session-${f.target}`;
        const waitFor = async predicate => {
            const deadline = Date.now() + 20_000;
            let status = await native.getStatus(instance);
            while (!predicate(status.customStatus ? JSON.parse(status.customStatus) : {})) {
                if (status.status === "Failed") throw new Error(status.error);
                if (Date.now() >= deadline) throw new Error("Native webhook progression timed out");
                status = await native.waitForStatusChange(instance, status.customStatusVersion ?? 0, 20, deadline - Date.now());
            }
        };
        try {
            await runtime.start();
            await native.startOrchestrationVersioned(instance, "durable-session-v2", {
                sessionId: f.target, config: {}, isSystem: true, blobEnabled: false, idleTimeout: -1, prompt: "Wait for a PR",
            }, "1.0.80");
            await waitFor(status => status.status === "waiting" && status.signalWait);
            await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
            const delivery = capability
                ? request({ pullRequestNumber: 7 }, { "idempotency-key": "native-http" })
                : event("native-http");
            const base = `http://127.0.0.1:${server.address().port}`;
            const endpoint = `${base}/hooks/${capability ? `s/${capability.token}` : `c/${connector.id}`}`;
            for (let repeat = 0; repeat < 2; repeat++) {
                const response = await fetch(endpoint, { method: "POST", headers: delivery.headers, body: delivery.rawBody });
                expect(response.status).toBe(202);
            }
            const invalid = await fetch(capability ? `${base}/hooks/s/pswh_${"0".repeat(43)}` : endpoint, { method: "POST",
                headers: { ...delivery.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: delivery.rawBody });
            expect(invalid.status).toBe(capability ? 404 : 401);
            await ingress.runOnce();
            await waitFor(status => status.responseVersion >= 1 && turns.length === 2);
            const [receipt] = await f.management.listWebhookReceipts(
                capability ? { endpointId: capability.endpointId } : { connectorId: connector.id }, alice);
            expect(receipt).toMatchObject({ status: "consumed", duplicateCount: 1, sessionId: f.target });
            expect(turns).toHaveLength(2);
            if (actionType !== "enqueue_prompt") expect(turns[1].prompt).toContain('"receiptId"');
            else expect(turns[1].prompt).toContain("Inspect this PR.");
            expect(turns[1].prompt).toMatch(/"pullRequestNumber":\s*7\b/);
            console.log("  Authenticated local HTTP delivery -> PostgreSQL outbox -> native durable wait -> consumed receipt; one duplicate suppressed.");
        } finally {
            await new Promise((resolve, reject) => server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
            await runtime.shutdown(3000);
        }
    }));

    it("atomically accepts capability deliveries, hashes tokens, deduplicates use caps and correlates consumption", () => fixture(async f => {
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", { maxUses: 1 }, alice);
        expect(endpoint.url).toBe(`https://hooks.example.invalid/hooks/s/${endpoint.token}`);
        expect(endpoint.token).toMatch(/^pswh_[A-Za-z0-9_-]{43}$/);
        expect(Date.parse(endpoint.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400000);
        expect(Date.parse(endpoint.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 86400000);
        const { rows: secrets } = await pool.query(`SELECT token_hash FROM "${f.schema}".signal_endpoints`);
        expect(secrets[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(secrets[0].token_hash).not.toBe(endpoint.token);
        const listed = await f.management.listSignalEndpoints(f.target, alice);
        expect(JSON.stringify(listed)).not.toContain(endpoint.token);
        expect(listed[0]).not.toHaveProperty("token");
        expect(await f.management.listSignalEndpoints(f.target, bob)).toEqual([]);
        await expect(f.management.revokeSignalEndpoint(endpoint.endpointId, bob)).rejects.toMatchObject({ status: 404 });
        await expect(f.runtime.acceptSignalEndpoint(endpoint.token, request('{"text":"\\u0000"}')))
            .rejects.toMatchObject({ code: "WEBHOOK_INVALID", status: 400 });
        expect((await f.management.listSignalEndpoints(f.target, alice))[0].useCount).toBe(0);
        const payload = { status: "done", sessionId: "not-a-routing-target", type: "cmd" };
        const accepted = await Promise.all(Array.from({ length: 8 }, () =>
            f.runtime.acceptSignalEndpoint(endpoint.token, request(payload, { "idempotency-key": "same-key" }))));
        expect(accepted.every(result => result.status === 202)).toBe(true);
        expect(f.queued).toHaveLength(0);
        expect((await f.management.listSignalEndpoints(f.target, alice))[0].useCount).toBe(1);
        await expect(f.runtime.acceptSignalEndpoint(endpoint.token, request(payload, { "idempotency-key": "another-key" }))).rejects.toMatchObject({ code: "WEBHOOK_NOT_FOUND", status: 404 });
        expect(await f.runtime.runOnce()).toBe(1);
        const [receipt] = await f.management.listWebhookReceipts({}, alice);
        expect(receipt).toMatchObject({ status: "queued", duplicateCount: 7, sessionId: f.target });
        expect(JSON.stringify(receipt)).not.toContain("not-a-routing-target");
        const signal = f.queued[0].payload.signal;
        expect(signal).toMatchObject({ name: "ready", data: payload, source: { kind: "webhook", receiptId: receipt.receiptId } });
        expect(await f.store.recordSignalDisposition({ receiptId: receipt.receiptId, sessionId: "foreign", signalId: signal.signalId, disposition: "consumed" })).toBe(false);
        expect(await f.store.recordSignalDisposition({ receiptId: receipt.receiptId, sessionId: f.target, signalId: "forged", disposition: "consumed" })).toBe(false);
        expect(await f.store.recordSignalDisposition({ receiptId: receipt.receiptId, sessionId: f.target, signalId: signal.signalId, disposition: "consumed" })).toBe(true);
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice)).status).toBe("consumed");
        await expect(f.management.getWebhookReceipt(receipt.receiptId, bob)).rejects.toMatchObject({ status: 404 });
        await f.management.revokeSignalEndpoint(endpoint.endpointId, alice);
        await expect(f.runtime.acceptSignalEndpoint(endpoint.token, request(payload))).rejects.toMatchObject({ code: "WEBHOOK_NOT_FOUND", status: 404 });
        await expect(f.runtime.acceptSignalEndpoint("x".repeat(43), request(payload))).rejects.toMatchObject({ code: "WEBHOOK_NOT_FOUND", status: 404 });
        console.log("  Capability receipt reached consumed; eight retries used one capability use and one queue entry.");
    }));

    it("enforces endpoint expiry, optional exact-body HMAC, membership and destination grant revocation", () => fixture(async f => {
        await expect(f.management.createSignalEndpoint(f.target, "ready", { hmacSecretRef: "GITHUB_TEST" }, alice)).rejects.toMatchObject({ status: 403 });
        await expect(f.management.createSignalEndpoint(f.target, "ready", { expiresAt: new Date(Date.now() + 91 * 86400000).toISOString() }, alice)).rejects.toMatchObject({ code: "WEBHOOK_INVALID" });
        await expect(f.management.createSignalEndpoint(f.target, "ready", { hmacSecretRef: "GITHUB_TEST" }, admin)).rejects.toMatchObject({ status: 403 });
        await f.catalog.grantSessionShare(f.target, admin.principal, "write", alice.principal);
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", { hmacSecretRef: "GITHUB_TEST" }, admin);
        await expect(f.runtime.acceptSignalEndpoint(endpoint.token, request({ ok: true }))).rejects.toMatchObject({ code: "WEBHOOK_AUTH_FAILED" });
        const signed = request({ ok: true });
        signed.headers["x-signature-256"] = sign(signed.rawBody);
        await f.runtime.acceptSignalEndpoint(endpoint.token, signed);
        await pool.query(`UPDATE "${f.schema}".signal_endpoints SET expires_at=now()-interval '1 second' WHERE endpoint_id=$1`, [endpoint.endpointId]);
        await expect(f.runtime.acceptSignalEndpoint(endpoint.token, signed)).rejects.toMatchObject({ code: "WEBHOOK_NOT_FOUND" });
        await f.runtime.runOnce();
        expect((await f.management.listWebhookReceipts({}, admin))[0].status).toBe("expired");
        const other = `other_${randomUUID()}`;
        await f.catalog.createSession(other, { owner: bob.principal });
        await f.catalog.grantSessionShare(other, alice.principal, "write", bob.principal);
        const shared = await f.management.createSignalEndpoint(other, "shared_ready", {}, alice);
        await f.runtime.acceptSignalEndpoint(shared.token, request(null, { "idempotency-key": "shared-event" }));
        await f.catalog.revokeSessionShare(other, alice.principal);
        await f.runtime.runOnce();
        expect((await f.management.listWebhookReceipts({ endpointId: shared.endpointId }, alice))[0].status).toBe("rejected");
        expect(f.queued).toHaveLength(0);
        await f.catalog.setUserRole(alice.principal, null);
        await expect(f.management.listSignalEndpoints(other, alice)).rejects.toMatchObject({ status: 403 });
    }));

    it("acknowledges signed setup pings without routing even through an unfiltered binding", () => fixture(async f => {
        const connector = await f.connector();
        const binding = await f.management.createWebhookBinding({
            label: "Any approved event", connectorId: connector.id, filters: {},
            action: { type: "raise_signal", sessionId: f.target, signalName: "ready" },
        }, alice);
        const ping = request({ repository: { id: 123 }, hook_id: 5, zen: "Fixture ping" },
            { "x-github-event": "ping", "x-github-delivery": "signed-ping" });
        ping.headers["x-hub-signature-256"] = sign(ping.rawBody);
        await expect(f.runtime.acceptConnector(connector.id, ping)).resolves.toMatchObject({ status: 202 });
        expect(await f.runtime.runOnce()).toBe(0);
        expect(f.queued).toEqual([]);
        expect((await f.management.listWebhookReceipts({ connectorId: connector.id }, alice))[0]).toMatchObject({ eventType: "ping", status: "unmatched" });
        expect((await f.management.testWebhookBinding(binding.id, { event: {
            version: 1, provider: "github", repositoryId: "123", eventType: "ping", action: "ping",
        } }, alice)).matches).toBe(false);
        const invalid = { ...ping, headers: { ...ping.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` } };
        await expect(f.runtime.acceptConnector(connector.id, invalid)).rejects.toMatchObject({ status: 401 });
    }));

    it("cluster administrators can approve their own policies but cannot inspect other owners' webhook resources", () => fixture(async f => {
        const clusterAdmin = { ...admin, adminScope: "cluster" };
        const other = await f.connector();
        expect(await f.management.listWebhookConnectors(clusterAdmin)).toEqual([]);
        await expect(f.management.revokeWebhookConnector(other.id, clusterAdmin)).rejects.toMatchObject({ status: 404 });
        const own = await f.management.createWebhookConnector({
            label: "Cluster admin's own", provider: "github", source, owner: admin.principal,
            auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_TEST" },
        }, clusterAdmin);
        await expect(f.management.createWebhookConnector({
            label: "Another owner", provider: "github", source, owner: alice.principal,
            auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_TEST" },
        }, clusterAdmin)).rejects.toMatchObject({ status: 403 });
        expect((await f.management.listWebhookConnectors(clusterAdmin)).map(row => row.id)).toEqual([own.id]);
        await f.management.updateWebhookConnector(own.id, {
            expectedRevision: own.revision, auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_TEST" },
        }, clusterAdmin);
        await expect(f.management.createSignalEndpoint(f.target, "ready", {}, clusterAdmin)).rejects.toMatchObject({ status: 403 });
    }));

    it("authenticates and normalizes GitHub deliveries before durable matching without retaining raw provider bodies", () => fixture(async f => {
        const connector = await f.connector();
        const binding = await f.management.createWebhookBinding({
            label: "PR ready", connectorId: connector.id, filters: { eventType: "pull_request.lifecycle", action: ["opened", "reopened"] },
            action: { type: "raise_signal", sessionId: f.target, signalName: "pr_ready" },
        }, alice);
        const masked = JSON.stringify(await f.management.listWebhookConnectors(alice));
        expect(masked).not.toContain("GITHUB_TEST");
        expect(masked).not.toContain(secret);
        expect(await f.management.listWebhookBindings(bob)).toEqual([]);
        const delivery = event("github-1", { sender: { privateData: "raw-provider-body-must-not-persist" } });
        const invalid = { ...delivery, rawBody: Buffer.from(`${delivery.rawBody}\n`) };
        await expect(f.runtime.acceptConnector(connector.id, invalid)).rejects.toMatchObject({ code: "WEBHOOK_AUTH_FAILED" });
        await f.runtime.acceptConnector(connector.id, delivery);
        await f.runtime.acceptConnector(connector.id, delivery);
        await f.runtime.runOnce();
        const [receipt] = await f.management.listWebhookReceipts({ connectorId: connector.id }, alice);
        expect(receipt).toMatchObject({ status: "queued", bindingId: binding.id, duplicateCount: 1, sessionId: f.target });
        expect(f.queued[0].payload.signal.data).toMatchObject({ provider: "github", repositoryId: "123", pullRequestNumber: 7 });
        const { rows } = await pool.query(`SELECT data FROM "${f.schema}".webhook_payloads`);
        expect(JSON.stringify(rows)).not.toContain("raw-provider-body-must-not-persist");
        await f.runtime.acceptConnector(connector.id, event("unmatched", { action: "edited", sender: { privateData: "omit-me" } }));
        expect((await f.management.listWebhookReceipts({ status: "unmatched" }, alice))[0].status).toBe("unmatched");
        expect((await pool.query(`SELECT count(*)::int AS count FROM "${f.schema}".webhook_payloads`)).rows[0].count).toBe(1);
        await expect(f.runtime.acceptConnector(connector.id, event("wrong-scope", { repository: { id: 999 } }))).rejects.toMatchObject({ code: "WEBHOOK_SOURCE_FORBIDDEN" });
        await expect(f.runtime.acceptConnector(connector.id, event("wrong-scope", { repository: { id: 999 } }))).rejects.toMatchObject({ code: "WEBHOOK_SOURCE_FORBIDDEN" });
        await expect(f.runtime.acceptConnector(connector.id, { ...event("push"), headers: { ...event("push").headers, "x-github-event": "push" } })).rejects.toMatchObject({ code: "WEBHOOK_EVENT_UNSUPPORTED" });
        const metrics = await f.management.getWebhookMetrics(admin);
        expect(metrics.receipts.some(row => row.status === "rejected" && row.count > 0)).toBe(true);
        expect(Object.keys(metrics.receipts[0]).sort()).toEqual(["count", "provider", "status"]);
    }));

    it("uses native ADO HTTPS Basic authentication and the approved build-definition mapping", () => fixture(async f => {
        const connector = await f.management.createWebhookConnector({
            label: "ADO CI", provider: "azure-devops",
            source: { repositoryId: "repo-1", projectId: "project-1", buildDefinitionId: "3" },
            auth: { mode: "ado-basic", usernameRef: "ADO_USER", passwordRef: "ADO_PASS" }, owner: alice.principal,
        }, admin);
        await f.management.createWebhookBinding({
            label: "Build completed", connectorId: connector.id, filters: { eventType: "build.completed" },
            action: { type: "raise_signal", sessionId: f.target, signalName: "ci_finished" },
        }, alice);
        const payload = { id: "ado-delivery", eventType: "build.complete", resource: {
            id: 12, project: { id: "project-1" }, definition: { id: 3 }, status: "completed", result: "succeeded",
        } };
        const authorization = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
        await expect(f.runtime.acceptConnector(connector.id, request(payload, { authorization, "x-forwarded-proto": "https" },
            { peerAddress: "203.0.113.8", secure: false }))).rejects.toMatchObject({ code: "WEBHOOK_HTTPS_REQUIRED" });
        await expect(f.runtime.acceptConnector(connector.id, request(payload, { "x-hub-signature-256": sign(Buffer.from(JSON.stringify(payload))) }))).rejects.toMatchObject({ code: "WEBHOOK_AUTH_FAILED" });
        await f.runtime.acceptConnector(connector.id, request(payload, { authorization }));
        await f.runtime.runOnce();
        expect(f.queued[0].payload.signal.data).toMatchObject({ provider: "azure-devops", eventType: "build.completed", repositoryId: "repo-1", buildDefinitionId: "3" });
        f.credentials.set("ADO_PASS", "rotated-password");
        await expect(f.runtime.acceptConnector(connector.id, request({ ...payload, id: "ado-rotated" }, { authorization }))).rejects.toMatchObject({ code: "WEBHOOK_AUTH_FAILED" });
        const fresh = `Basic ${Buffer.from("fixture-user:rotated-password").toString("base64")}`;
        await f.runtime.acceptConnector(connector.id, request({ ...payload, id: "ado-rotated" }, { authorization: fresh }));
        assert((await f.management.listWebhookReceipts({}, alice)).length === 2, "Native ADO receipts should deduplicate by event id");
    }));

    it("creates named sessions through public policy with a reserved identity across a crash and a fresh SDK client", () => fixture(async f => {
        const connector = await f.connector();
        const template = await f.template();
        await expect(f.management.createWebhookSessionTemplate({
            label: "Unapproved", source, config: { agentName: "reviewer", namespace: "app" },
            prompt: { instruction: "No privilege escalation.", fields: [] },
        }, alice)).rejects.toMatchObject({ status: 403 });
        const binding = await f.management.createWebhookBinding({
            label: "Start review", connectorId: connector.id, filters: { action: "opened" },
            action: { type: "create_session", templateId: template.id },
        }, alice);
        await Promise.all(Array.from({ length: 10 }, () => f.runtime.acceptConnector(connector.id, event("create-once"))));
        const [lease] = await f.store.claim();
        const context = await f.store.routeContext(lease.receiptId, lease.leaseToken);
        expect(context.sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
        await f.client.createSessionForAgent("reviewer", {
            sessionId: context.sessionId, idempotencyKey: `webhook:${context.receiptId}`, owner: alice.principal,
        });
        const original = await f.catalog.getSessionCreationConfig(context.sessionId);
        await f.catalog.updateSession(context.sessionId, { title: "Human renamed this between attempts" });
        await pool.query(`UPDATE "${f.schema}".webhook_outbox SET leased_until=now()-interval '1 second' WHERE receipt_id=$1`, [context.receiptId]);
        const reopenedCatalog = await PgSessionCatalog.create(url, f.schema);
        try {
            await reopenedCatalog.initialize();
            const otherRuntime = new WebhookRuntime(reopenedCatalog.webhooks, { ...f.options, client: f.freshClient(reopenedCatalog) });
            await otherRuntime.runOnce();
            await otherRuntime.stop();
        } finally { await reopenedCatalog.close(); }
        expect((await f.management.getWebhookReceipt(context.receiptId, alice)).status).toBe("queued");
        expect((await f.catalog.getSession(context.sessionId)).title).toBe("Human renamed this between attempts");
        expect(await f.catalog.getSessionCreationConfig(context.sessionId)).toEqual(original);
        const { rows } = await pool.query(`SELECT session_id FROM "${f.schema}".session_creation_keys`);
        expect(rows).toEqual([{ session_id: context.sessionId }]);
        expect(f.queued).toHaveLength(1);
        expect(f.queued[0].payload).toMatchObject({ bootstrap: true, clientMessageIds: [`webhook:${context.receiptId}`] });
        expect(f.starts.get(`session-${context.sessionId}`).input.config.boundAgentName).toBe("reviewer");
        await expect(f.client.createSessionForAgent("not-approved", {
            sessionId: context.sessionId, idempotencyKey: "other-key", owner: alice.principal,
        })).rejects.toThrow(/not found|allowed/);
        await expect(f.client.createSessionForAgent("reviewer", {
            sessionId: context.sessionId, idempotencyKey: `webhook:${context.receiptId}`, owner: bob.principal,
        })).rejects.toMatchObject({ code: "WEBHOOK_CONFLICT" });
        await f.runtime.acceptConnector(connector.id, event("new-delivery"));
        await f.runtime.runOnce();
        const receipts = await f.management.listWebhookReceipts({}, alice);
        expect(new Set(receipts.map(receipt => receipt.sessionId)).size).toBe(2);
        expect(receipts.every(receipt => receipt.bindingId === binding.id)).toBe(true);
        console.log("  Recovered an interrupted named-session create without rewriting metadata or allocating a second session.");
    }));

    it("coalesces only explicitly and rechecks host namespace authorization before every routing attempt", () => fixture(async f => {
        const connector = await f.connector();
        const template = await f.template();
        const binding = await f.management.createWebhookBinding({
            label: "Explicit PR coalescing", connectorId: connector.id, filters: { eventType: "pull_request.lifecycle" },
            action: { type: "create_session", templateId: template.id,
                coalescing: { key: "repository_pull_request", onMatch: { type: "raise_signal", signalName: "pr_updated" } } },
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("coalesce-first"));
        await f.runtime.runOnce();
        await f.runtime.acceptConnector(connector.id, event("coalesce-second", { action: "synchronize" }));
        await f.runtime.runOnce();
        const receipts = await f.management.listWebhookReceipts({}, alice);
        expect(new Set(receipts.map(receipt => receipt.sessionId)).size).toBe(1);
        expect(f.queued).toHaveLength(2);
        expect(f.queued[1].payload.signal.name).toBe("pr_updated");
        const denied = f.management.createWebhookRuntime({ ...f.options, authorizeTemplate: async () => false });
        await f.runtime.acceptConnector(connector.id, event("coalesce-forbidden", { action: "edited" }));
        await denied.runOnce();
        expect((await f.management.listWebhookReceipts({ status: "rejected" }, alice))).toHaveLength(1);
        expect(f.queued).toHaveLength(2);
        const dryRun = await f.management.testWebhookBinding(binding.id, { event: {
            version: 1, provider: "github", eventType: "pull_request.lifecycle", action: "opened", repositoryId: "123", pullRequestNumber: 7,
        } }, alice);
        expect(dryRun).toMatchObject({ authorized: true, matches: true, action: "create_session" });
        expect((await f.management.listWebhookReceipts({}, alice))).toHaveLength(3);
    }));

    it("persists lease retries/dead letters, requires confirmed replay, and refuses changed bindings", () => fixture(async f => {
        const connector = await f.connector();
        const binding = await f.management.createWebhookBinding({
            label: "Retry fixture", connectorId: connector.id, filters: {},
            action: { type: "raise_signal", sessionId: f.target, signalName: "ready" },
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("retry-event"));
        const [receipt] = await f.management.listWebhookReceipts({}, alice);
        for (let attempt = 0; attempt < 8; attempt++) {
            const [claim] = await f.store.claim();
            expect(claim.receiptId).toBe(receipt.receiptId);
            await f.store.routeContext(claim.receiptId, claim.leaseToken);
            await f.store.finish(claim.receiptId, claim.leaseToken, "routing_failed", "SYNTHETIC_TRANSIENT", true);
            await pool.query(`UPDATE "${f.schema}".webhook_outbox SET next_attempt_at=now() WHERE receipt_id=$1`, [receipt.receiptId]);
        }
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice))).toMatchObject({ status: "dead_lettered", attempts: 8 });
        await expect(async () => f.management.replayWebhookReceipt(receipt.receiptId, { confirmed: false }, alice)).rejects.toMatchObject({ code: "WEBHOOK_CONFIRMATION_REQUIRED" });
        await expect(f.management.replayWebhookReceipt(receipt.receiptId, { confirmed: true }, bob)).rejects.toMatchObject({ status: 404 });
        await f.management.replayWebhookReceipt(receipt.receiptId, { confirmed: true }, alice);
        await f.runtime.runOnce();
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice))).toMatchObject({ status: "queued", replayCount: 1 });
        await f.runtime.acceptConnector(connector.id, event("before-quarantine"));
        const changed = await f.management.updateWebhookBinding(binding.id, { expectedRevision: binding.revision, state: "quarantined" }, alice);
        await f.runtime.runOnce();
        const [disabled] = await f.management.listWebhookReceipts({ status: "disabled" }, alice);
        expect(disabled).toBeDefined();
        await f.management.updateWebhookBinding(binding.id, { expectedRevision: changed.revision, state: "active" }, alice);
        await expect(f.management.replayWebhookReceipt(disabled.receiptId, { confirmed: true }, alice)).rejects.toMatchObject({ code: "WEBHOOK_DISABLED" });
        const { rows: audit } = await pool.query(`SELECT action FROM "${f.schema}".authz_audit WHERE action LIKE 'webhook.%'`);
        expect(audit.map(row => row.action)).toContain("webhook.receipt.replay");
    }));

    it("starts a new coalesced session after hard deletion without resurrecting the previous identity", () => fixture(async f => {
        const connector = await f.connector();
        const template = await f.template();
        await f.management.createWebhookBinding({
            label: "Live PR sessions", connectorId: connector.id, filters: {},
            action: { type: "create_session", templateId: template.id,
                coalescing: { key: "repository_pull_request", onMatch: { type: "raise_signal", signalName: "ready" } } },
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("first-live-session"));
        await f.runtime.runOnce();
        const [first] = await f.management.listWebhookReceipts({}, alice);
        await pool.query(`DELETE FROM "${f.schema}".sessions WHERE session_id=$1`, [first.sessionId]);
        await f.runtime.acceptConnector(connector.id, event("after-hard-delete"));
        await f.runtime.runOnce();
        const [next] = await f.management.listWebhookReceipts({}, alice);
        expect(next).toMatchObject({ status: "queued", deliveryId: "after-hard-delete" });
        expect(next.sessionId).not.toBe(first.sessionId);
        expect(await f.catalog.getSession(first.sessionId)).toBeNull();
        expect(await f.catalog.getSession(next.sessionId)).not.toBeNull();
        expect(f.queued[1].payload.bootstrap).toBe(true);
    }));

    it("enforces persistent rate limits across SDK instances, terminal targets and consumption-before-ack", () => fixture(async f => {
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", { rateLimitPerMinute: 3 }, alice);
        const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
            f.runtime.acceptSignalEndpoint(endpoint.token, request({ value: i }, { "idempotency-key": `rate-${i}` }))));
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(3);
        expect(results.filter(result => result.status === "rejected").every(result => result.reason.status === 429)).toBe(true);
        const another = f.management.createWebhookRuntime(f.options);
        await expect(another.acceptSignalEndpoint(endpoint.token, request({ value: 20 }))).rejects.toMatchObject({ status: 429 });
        const [claim] = await f.store.claim();
        const context = await f.store.routeContext(claim.receiptId, claim.leaseToken);
        await f.store.recordSignalDisposition({ receiptId: context.receiptId, sessionId: f.target, signalId: context.signalId, disposition: "consumed" });
        await f.store.finish(claim.receiptId, claim.leaseToken, "queued", null, false);
        expect((await f.management.getWebhookReceipt(claim.receiptId, alice)).status).toBe("consumed");
        await f.catalog.updateSession(f.target, { state: "completed" });
        await f.runtime.runOnce();
        expect((await f.management.listWebhookReceipts({ status: "target_terminal" }, alice))).toHaveLength(2);
        expect(f.queued).toHaveLength(0);
    }));

    it("applies binding/source/global limits before acceptance and preserves a retryable provider delivery", () => fixture(async f => {
        const connector = await f.connector();
        const binding = await f.management.createWebhookBinding({
            label: "Bounded binding", connectorId: connector.id, filters: {},
            action: { type: "raise_signal", sessionId: f.target, signalName: "ready" }, rateLimitPerMinute: 1,
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("limited-first"));
        await expect(f.runtime.acceptConnector(connector.id, event("limited-second"))).rejects.toMatchObject({ status: 429 });
        expect(await f.management.listWebhookReceipts({}, alice)).toHaveLength(1);
        // Advance only the isolated fixture's quota window; no sleep or retry hides a failure.
        await pool.query(`UPDATE "${f.schema}".webhook_rate_windows SET minute=now()-interval '2 minutes' WHERE bucket=$1`, [`binding:${binding.id}`]);
        await f.runtime.acceptConnector(connector.id, event("limited-second"));
        expect(await f.management.listWebhookReceipts({}, alice)).toHaveLength(2);
        await pool.query(`UPDATE "${f.schema}".webhook_rate_windows SET uses=600,minute=date_trunc('minute',now()) WHERE bucket='global'`);
        await expect(f.runtime.acceptConnector(connector.id, event("global-denied"))).rejects.toMatchObject({ status: 429 });
        await pool.query(`UPDATE "${f.schema}".webhook_rate_windows SET uses=0 WHERE bucket='global'`);
        await pool.query(`UPDATE "${f.schema}".webhook_rate_windows SET uses=120,minute=date_trunc('minute',now()) WHERE bucket LIKE 'source:%'`);
        await expect(f.runtime.acceptConnector(connector.id, event("source-denied"))).rejects.toMatchObject({ status: 429 });
    }));

    it("queues only the server-owned prompt and exposes explicit no-op coalescing without extra turns", () => fixture(async f => {
        const connector = await f.connector();
        const promptBinding = await f.management.createWebhookBinding({
            label: "Prompt fixture", connectorId: connector.id, filters: { action: "edited" },
            action: { type: "enqueue_prompt", sessionId: f.target, prompt: {
                instruction: "Inspect the new title.", fields: ["title"],
            } },
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("prompt-event", {
            action: "edited", sessionId: "payload-must-not-route", pull_request: { title: "``` end fence <script>" },
        }));
        await f.runtime.runOnce();
        expect(f.queued[0].id).toBe(`session-${f.target}`);
        expect(f.queued[0].payload.prompt).toContain("Inspect the new title.");
        expect(f.queued[0].payload.prompt).not.toContain("payload-must-not-route");
        expect(f.queued[0].payload.prompt.match(/```/g)).toHaveLength(2);
        expect((await f.management.listWebhookReceipts({}, alice))[0].bindingId).toBe(promptBinding.id);
        const template = await f.template();
        await f.management.createWebhookBinding({
            label: "Explicit no-op", connectorId: connector.id, filters: { action: "opened" },
            action: { type: "create_session", templateId: template.id,
                coalescing: { key: "repository_pull_request", onMatch: { type: "noop" } } },
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("noop-first"));
        await f.runtime.runOnce();
        await f.runtime.acceptConnector(connector.id, event("noop-next"));
        await f.runtime.runOnce();
        expect(f.queued).toHaveLength(2);
        expect(await f.management.listWebhookReceipts({ status: "routed" }, alice)).toHaveLength(1);
        expect((await f.management.getWebhookMetrics(alice)).pending).toBe(0);
    }));

    it("refuses a prompt when the native execution is terminal even if CMS still says running", () => fixture(async f => {
        const connector = await f.connector();
        await f.management.createWebhookBinding({
            label: "Terminal prompt", connectorId: connector.id, filters: {},
            action: { type: "enqueue_prompt", sessionId: f.target, prompt: { instruction: "Handle event.", fields: [] } },
        }, alice);
        await f.catalog.updateSession(f.target, { state: "running", orchestrationId: `session-${f.target}` });
        f.native.getStatus = async () => ({ status: "Completed" });
        await f.runtime.acceptConnector(connector.id, event("terminal-runtime"));
        await f.runtime.runOnce();
        expect((await f.management.listWebhookReceipts({}, alice))[0].status).toBe("target_terminal");
        expect(f.queued).toHaveLength(0);
    }));

    it("requires the same 1.0.80 floor for both webhook signals and approved prompts", () => fixture(async f => {
        f.native.getStatus = async () => ({ status: "Running" });
        f.native.getInstanceInfo = async () => ({ status: "Running", orchestrationVersion: "1.0.79" });
        await expect(f.client._raiseSignal(f.target, "ready")).rejects.toMatchObject({ code: "SIGNALS_UNSUPPORTED" });
        await expect(f.client._enqueueWebhookPrompt(f.target, "Approved prompt", "webhook:test"))
            .rejects.toMatchObject({ code: "WEBHOOK_SESSION_VERSION_UNSUPPORTED" });
        expect(f.queued).toHaveLength(0);
        f.native.getInstanceInfo = async () => ({ status: "Running", orchestrationVersion: "1.0.80" });
        await f.client._raiseSignal(f.target, "ready");
        await f.client._enqueueWebhookPrompt(f.target, "Approved prompt", "webhook:test");
        expect(f.queued).toHaveLength(2);
        expect(f.queued[0].payload.signal.name).toBe("ready");
        expect(f.queued[1].payload.prompt).toBe("Approved prompt");
    }));

    it("fails closed after destination ownership changes even if the prior owner retains a write share", () => fixture(async f => {
        const connector = await f.connector();
        await f.management.createWebhookBinding({
            label: "Fixed owner", connectorId: connector.id, filters: {},
            action: { type: "raise_signal", sessionId: f.target, signalName: "ready" },
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("ownership-event"));
        await pool.query(`UPDATE "${f.schema}".session_owners SET user_id=(SELECT user_id FROM "${f.schema}".users WHERE provider=$1 AND subject=$2) WHERE session_id=$3`,
            [bob.principal.provider, bob.principal.subject, f.target]);
        await f.catalog.grantSessionShare(f.target, alice.principal, "write", bob.principal);
        await f.runtime.runOnce();
        expect((await f.management.listWebhookReceipts({}, alice))[0]).toMatchObject({ status: "rejected", lastErrorCode: "WEBHOOK_FORBIDDEN" });
        expect(f.queued).toHaveLength(0);
        await expect(f.store.createSessionOnce({
            sessionId: "unauthorized-model", key: "model-claim", owner: alice.principal, agentId: "reviewer",
            config: { model: "unavailable-personal-provider:unavailable-model" }, metadata: { modelResolutionSource: "requested" },
        })).rejects.toMatchObject({ code: "WEBHOOK_FORBIDDEN" });
        expect(await f.catalog.getSession("unauthorized-model")).toBeNull();
    }));

    it("audits secret-reference rotation and only allows confirmed replay after connector reauthorization", () => fixture(async f => {
        const connector = await f.connector();
        await f.management.createWebhookBinding({
            label: "Rotation fixture", connectorId: connector.id, filters: {},
            action: { type: "raise_signal", sessionId: f.target, signalName: "ready" },
        }, alice);
        await f.runtime.acceptConnector(connector.id, event("before-rotation"));
        await expect(f.management.updateWebhookConnector(connector.id, {
            expectedRevision: connector.revision, auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_NEW" },
        }, alice)).rejects.toMatchObject({ status: 403 });
        const rotated = await f.management.updateWebhookConnector(connector.id, {
            expectedRevision: connector.revision, auth: { mode: "github-hmac-sha256", secretRef: "GITHUB_NEW" },
        }, admin);
        expect(JSON.stringify(rotated)).not.toContain("GITHUB_NEW");
        await f.runtime.runOnce();
        const [receipt] = await f.management.listWebhookReceipts({}, alice);
        expect(receipt.status).toBe("disabled");
        await f.management.replayWebhookReceipt(receipt.receiptId, { confirmed: true }, alice);
        await f.runtime.runOnce();
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice)).status).toBe("queued");
        const { rows } = await pool.query(`SELECT action FROM "${f.schema}".authz_audit WHERE action='webhook.connector.rotate_secret'`);
        expect(rows).toHaveLength(1);
        await expect(f.management.updateWebhookConnector(connector.id, { expectedRevision: 1, state: "disabled" }, admin)).rejects.toMatchObject({ code: "WEBHOOK_CONFLICT" });
        await expect(f.runtime.acceptConnector(connector.id, event("missing-new-secret"))).rejects.toMatchObject({ code: "WEBHOOK_SECRET_UNAVAILABLE" });
    }));

    it("retains create tombstones after hard deletion and reapplies the migration idempotently", () => fixture(async f => {
        const sessionId = `reserved_${randomUUID()}`;
        const key = "persistent-creation-key";
        await f.client.createSessionForAgent("reviewer", { sessionId, idempotencyKey: key, owner: alice.principal });
        await pool.query(`DELETE FROM "${f.schema}".sessions WHERE session_id=$1`, [sessionId]);
        await expect(f.client.createSessionForAgent("reviewer", { sessionId, idempotencyKey: key, owner: alice.principal })).rejects.toMatchObject({ code: "WEBHOOK_TARGET_TERMINAL" });
        await pool.query(webhooksMigration(f.schema));
        const { rows } = await pool.query(`SELECT version FROM "${f.schema}".schema_migrations WHERE version='0081'`);
        expect(rows).toHaveLength(1);
    }));

    it("correlates late consumption after a lost acknowledgement and removes obsolete outbox work", () => fixture(async f => {
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", {}, alice);
        await f.runtime.acceptSignalEndpoint(endpoint.token, request({ status: "done" }));
        const [claim] = await f.store.claim();
        const context = await f.store.routeContext(claim.receiptId, claim.leaseToken);
        await f.store.finish(claim.receiptId, claim.leaseToken, "dead_lettered", "SYNTHETIC_ACK_LOST", false);
        await f.management.replayWebhookReceipt(context.receiptId, { confirmed: true }, alice);
        expect((await f.management.getWebhookMetrics(alice)).pending).toBe(1);
        expect(await f.store.recordSignalDisposition({
            receiptId: context.receiptId, sessionId: context.sessionId, signalId: context.signalId, disposition: "consumed",
        })).toBe(true);
        expect((await f.management.getWebhookReceipt(context.receiptId, alice)).status).toBe("consumed");
        expect((await f.management.getWebhookMetrics(alice)).pending).toBe(0);
        expect(await f.store.claim()).toEqual([]);
    }));

    it("updates receipts in the same transaction as durable signal events, including older worker recorders", () => fixture(async f => {
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", {}, alice);
        await f.runtime.acceptSignalEndpoint(endpoint.token, request({ ok: true }));
        await f.runtime.runOnce();
        const [receipt] = await f.management.listWebhookReceipts({}, alice);
        const data = { signalId: receipt.signalId, source: { kind: "webhook", receiptId: receipt.receiptId } };
        const foreignSession = `foreign_${randomUUID()}`;
        await f.catalog.createSession(foreignSession, { owner: bob.principal });
        await f.catalog.recordEvents(foreignSession, [{ eventType: "session.signal_consumed", data }]);
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice)).status).toBe("queued");
        await f.catalog.recordEvents(f.target, [{ eventType: "session.signal_consumed", data: { ...data, source: { ...data.source, kind: "api" } } }]);
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice)).status).toBe("queued");
        const connection = await pool.connect();
        try {
            await connection.query("BEGIN");
            await connection.query(`SELECT "${f.schema}".cms_record_events($1,$2::jsonb,NULL)`,
                [f.target, JSON.stringify([{ eventType: "session.signal_consumed", data }])]);
            const { rows } = await connection.query(`SELECT status FROM "${f.schema}".webhook_receipts WHERE receipt_id=$1`, [receipt.receiptId]);
            expect(rows[0].status).toBe("consumed");
            await connection.query("ROLLBACK");
        } finally { connection.release(); }
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice)).status).toBe("queued");
        await f.catalog.recordEvents(f.target, [{ eventType: "session.signal_consumed", data }]);
        expect((await f.management.getWebhookReceipt(receipt.receiptId, alice)).status).toBe("consumed");
        expect(await f.store.recordSignalDisposition({ ...data.source, sessionId: f.target, signalId: receipt.signalId, disposition: "consumed" })).toBe(true);
    }));

    it("does not let revoked history hide still-actionable resources in bounded owner lists", () => fixture(async f => {
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", {}, alice);
        const connector = await f.connector();
        await pool.query(`INSERT INTO "${f.schema}".signal_endpoints(
            endpoint_id,token_hash,owner_id,session_id,target_owner_id,signal_name,label,expires_at,revoked_at,created_at)
            SELECT 'revoked_'||n,repeat(md5(n::text),2),e.owner_id,e.session_id,e.target_owner_id,e.signal_name,'Revoked fixture',
                e.expires_at,now(),now()+make_interval(secs=>n)
            FROM "${f.schema}".signal_endpoints e CROSS JOIN generate_series(1,105) n WHERE e.endpoint_id=$1`, [endpoint.endpointId]);
        await pool.query(`INSERT INTO "${f.schema}".webhook_resources(resource_id,kind,owner_id,label,state,spec,created_at)
            SELECT 'revoked_'||n,r.kind,r.owner_id,'Revoked fixture','revoked',r.spec,now()+make_interval(secs=>n)
            FROM "${f.schema}".webhook_resources r CROSS JOIN generate_series(1,105) n WHERE r.resource_id=$1`, [connector.id]);
        const endpoints = await f.management.listSignalEndpoints(f.target, alice);
        const connectors = await f.management.listWebhookConnectors(alice);
        expect(endpoints).toHaveLength(100);
        expect(connectors).toHaveLength(100);
        expect(endpoints[0].endpointId).toBe(endpoint.endpointId);
        expect(connectors[0].id).toBe(connector.id);
    }));

    it("scopes tuner webhook inspection to the current owner or system reader without granting mutations", () => fixture(async f => {
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", {}, alice);
        await f.runtime.acceptSignalEndpoint(endpoint.token, request({ privateBody: "not-an-inspection-field" }));
        const [receipt] = await f.management.listWebhookReceipts({}, alice);
        let viewer = { ...alice.principal, isAdmin: false, isSystemPrincipal: false };
        const tools = createInspectTools({ catalog: f.catalog, agentIdentity: "agent-tuner", resolveViewer: async () => viewer });
        const invoke = (name, args = {}) => tools.find(tool => tool.name === name).handler(args);
        const visible = await invoke("read_webhook_receipts");
        expect(visible.map(row => row.receiptId)).toEqual([receipt.receiptId]);
        expect(JSON.stringify(visible)).not.toContain("not-an-inspection-field");
        expect(JSON.stringify(visible)).not.toContain(endpoint.token);
        expect((await invoke("read_webhook_metrics")).pending).toBe(1);

        viewer = { ...bob.principal, isAdmin: false, isSystemPrincipal: false };
        expect(await invoke("read_webhook_receipts")).toEqual([]);
        expect(await invoke("read_webhook_receipt", { receipt_id: receipt.receiptId })).toMatchObject({ code: "WEBHOOK_NOT_FOUND" });
        viewer = { ...admin.principal, isAdmin: true, isSystemPrincipal: false, adminScope: "cluster" };
        expect(await invoke("read_webhook_receipts")).toEqual([]);
        expect((await invoke("read_webhook_metrics")).pending).toBe(0);

        await pool.query(`INSERT INTO "${f.schema}".users(provider,subject) VALUES('system','system')
            ON CONFLICT(provider,subject) DO UPDATE SET role=NULL`);
        viewer = { provider: "system", subject: "system", isAdmin: false, isSystemPrincipal: true };
        expect((await invoke("read_webhook_receipts")).map(row => row.receiptId)).toEqual([receipt.receiptId]);
        expect((await invoke("read_webhook_metrics")).pending).toBe(1);
        await expect(f.management.revokeSignalEndpoint(endpoint.endpointId, {
            principal: { provider: "system", subject: "system" }, isAdmin: true,
        })).rejects.toMatchObject({ code: "WEBHOOK_FORBIDDEN" });
        expect(createInspectTools({ catalog: f.catalog, agentIdentity: "ordinary-agent" })
            .some(tool => tool.name.startsWith("read_webhook"))).toBe(false);
    }));

    it("carries bounded acceptance trace links through a fresh routing claim without exposing them in receipts", () => fixture(async f => {
        const endpoint = await f.management.createSignalEndpoint(f.target, "ready", {}, alice);
        const traceContext = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
        await f.store.accept("endpoint", endpoint.endpointId, undefined, "trace-link", webhookHash("{}"), {}, traceContext);
        const [claim] = await f.store.claim();
        expect((await f.store.routeContext(claim.receiptId, claim.leaseToken)).traceContext).toEqual(traceContext);
        const receipt = await f.management.getWebhookReceipt(claim.receiptId, alice);
        expect(receipt).not.toHaveProperty("traceContext");
        expect(JSON.stringify(receipt)).not.toContain(traceContext.traceId);
        expect(JSON.stringify(await f.management.getWebhookMetrics(alice))).not.toContain(traceContext.traceId);
    }));
});
