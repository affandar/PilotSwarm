// In-process fixtures only: no database, credentials, HTTP, LLM or provider calls.
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";

export const OWNER = { provider: "test", subject: "operator" };
export const OTHER = { provider: "test", subject: "other" };
export const TEST_TOKEN = `pswh_${"A".repeat(40)}-_A`;
export const TEST_URL = `/hooks/s/${TEST_TOKEN}`;
const AT = "2026-09-23T10:00:00.000Z";
const clone = value => structuredClone(value);
const resource = (id, extra = {}) => ({ id, label: id, owner: OWNER, state: "active", revision: 3, createdAt: AT, updatedAt: AT, ...extra });
export const connector = (extra = {}) => resource("connector-1", { provider: "github", source: { repositoryId: "repo-1" },
    auth: { mode: "github-hmac-sha256", configured: true }, rateLimitPerMinute: 60, ...extra });
export const binding = (extra = {}) => resource("binding-1", { connectorId: "connector-1", filters: { eventType: "pull_request.lifecycle" },
    action: { type: "raise_signal", sessionId: "s1", signalName: "ready", wake: false }, rateLimitPerMinute: 60, ...extra });
export const template = (extra = {}) => resource("template-1", { source: { repositoryId: "repo-1" }, config: { namespace: "app", agentName: "reviewer" },
    prompt: { instruction: "Review event data.", fields: ["title"] }, approvedBy: OWNER, ...extra });
export const endpoint = (extra = {}) => ({ endpointId: "endpoint-1", sessionId: "s1", signalName: "ready", label: "Review signal", owner: OWNER,
    wake: false, hmacConfigured: false, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), maxUses: null, useCount: 0,
    revokedAt: null, createdAt: AT, rateLimitPerMinute: 60, ...extra });
export const receipt = (extra = {}) => ({ receiptId: "receipt-1", connectorId: "connector-1", bindingId: "binding-1", deliveryId: "delivery-1",
    status: "queued", eventType: "pull_request.lifecycle", action: "raise_signal", sessionId: "s1", signalId: "signal-1",
    attempts: 1, duplicateCount: 2, replayCount: 0, receivedAt: AT, updatedAt: AT,
    payloadRetained: true, replayAvailable: ["routing_failed", "dead_lettered", "disabled", "expired", "target_terminal"].includes(extra.status),
    timeline: [{ status: "queued", at: "2026-09-23T10:00:02.000Z" }, { status: "received", at: AT }], ...extra });
export function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
export const drain = () => new Promise(resolve => setImmediate(resolve));

export function setupWebhooks({ isAdmin = true, authDisabled = false, overrides = {}, rows = {} } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const profile = { ...OWNER, displayName: "Test operator", isAdmin };
    store.dispatch({ type: "admin/profile/loaded", profile });
    store.dispatch({ type: "auth/context", principal: authDisabled ? null : OWNER, authorization: { role: authDisabled ? "anonymous" : isAdmin ? "admin" : "user" } });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "s1", title: "Review session", status: "waiting", owner: OWNER,
            signalWait: { waitId: "wait-1", names: ["ready"], reason: "Review", startedAt: AT, mode: "any" } },
        { sessionId: "s2", title: "Other visible session", status: "idle", owner: OTHER },
        { sessionId: "system", title: "System", isSystem: true, status: "idle" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "connection/ready" });
    store.dispatch({ type: "admin/visibility", visible: true });
    store.dispatch({ type: "admin/section", section: "webhooks" });
    const catalog = {
        connectors: rows.connectors || [connector()], bindings: rows.bindings || [binding()],
        templates: rows.templates || [template()], endpoints: rows.endpoints || [endpoint()],
        receipts: rows.receipts || [receipt()],
    };
    const calls = [];
    let retentionPolicy = { revision: 1, receiptRetentionDays: 30, replayRetentionDays: 30, updatedAt: AT };
    const capture = (name, fn) => async (...args) => { calls.push([name, ...clone(args)]); return fn(...args); };
    const transport = {
        getCurrentUserProfile: async () => profile,
        stop: async () => {},
        listSignalEndpoints: capture("listSignalEndpoints", sessionId => clone(catalog.endpoints.filter(row => row.sessionId === sessionId))),
        createSignalEndpoint: capture("createSignalEndpoint", (sessionId, signalName, options) => {
            const row = endpoint({ ...options, endpointId: `endpoint-${catalog.endpoints.length + 1}`, sessionId, signalName });
            catalog.endpoints.push(row); return { ...clone(row), token: TEST_TOKEN, url: TEST_URL };
        }),
        revokeSignalEndpoint: capture("revokeSignalEndpoint", id => { catalog.endpoints.find(row => row.endpointId === id).revokedAt = AT; }),
        getSessionSignalState: capture("getSessionSignalState", () => ({ version: 1, interrupted: false,
            pendingWait: { waitId: "wait-1", names: ["ready"], reason: "Review", startedAt: AT, mode: "any" },
            buffered: [{ signalId: "sig-buffered", name: "other", raisedAt: AT, wake: false, payloadRef: "https://example.invalid/do-not-open",
                dataBytes: 12, data: { private: "DO_NOT_RETAIN_SIGNAL_PAYLOAD" } }] })),
        raiseSignal: capture("raiseSignal", (_, name, options) => ({ name, signalId: options.signalId || "manual-1", status: "queued", raisedAt: AT })),
        listWebhookReceipts: capture("listWebhookReceipts", query => {
            let list = catalog.receipts.filter(row => ["connectorId", "endpointId", "sessionId", "status"].every(key => !query[key] || row[key] === query[key]));
            if (query.before) list = list.slice(list.findIndex(row => row.receiptId === query.before) + 1);
            return clone(list.slice(0, query.limit || 25));
        }),
        getWebhookReceipt: capture("getWebhookReceipt", id => clone(catalog.receipts.find(row => row.receiptId === id))),
        replayWebhookReceipt: capture("replayWebhookReceipt", id => { catalog.receipts.find(row => row.receiptId === id).replayCount++; return { replayed: true }; }),
        testWebhookBinding: capture("testWebhookBinding", (_, { event }) => ({ matches: true, authorized: true, action: "raise_signal", authorizationScope: "persisted_policy", event })),
        getWebhookMetrics: capture("getWebhookMetrics", () => ({ pending: 4, deadLettered: 2, oldestPendingAgeSeconds: 25, oldestDeadLetterAgeSeconds: 75,
            retention: { policy: clone(retentionPolicy), lastSweepAt: AT, nextSweepAt: AT, receiptsDeleted: 5, payloadsDeleted: 7 },
            receipts: [{ provider: "github", status: "queued", count: 4 }, { provider: "generic", status: "dead_lettered", count: 2 }] })),
        updateWebhookRetentionPolicy: capture("updateWebhookRetentionPolicy", patch => {
            if (patch.expectedRevision !== retentionPolicy.revision) throw Object.assign(new Error("Retention policy changed"), { code: "WEBHOOK_CONFLICT", status: 409 });
            retentionPolicy = { revision: retentionPolicy.revision + 1, receiptRetentionDays: patch.receiptRetentionDays,
                replayRetentionDays: patch.replayRetentionDays, updatedAt: AT };
            return clone(retentionPolicy);
        }),
    };
    for (const [kind, suffix, factory] of [["connectors", "Connector", connector], ["bindings", "Binding", binding], ["templates", "SessionTemplate", template]]) {
        transport[`listWebhook${suffix}s`] = capture(`listWebhook${suffix}s`, () => clone(catalog[kind]));
        transport[`createWebhook${suffix}`] = capture(`createWebhook${suffix}`, input => {
            const row = factory({ ...input, id: `${kind}-new`, revision: 1 });
            if (kind === "connectors") row.auth = { mode: input.auth.mode, configured: true };
            catalog[kind].push(row); return clone(row);
        });
        transport[`updateWebhook${suffix}`] = capture(`updateWebhook${suffix}`, (id, patch) => {
            const row = catalog[kind].find(row => row.id === id);
            if (row.revision !== patch.expectedRevision) throw Object.assign(new Error("Resource revision changed"), { code: "STALE_REVISION", status: 409 });
            const { expectedRevision, ...values } = patch;
            Object.assign(row, values, { revision: row.revision + 1 });
            if (kind === "connectors" && patch.auth) row.auth = { mode: patch.auth.mode, configured: true };
            return clone(row);
        });
        transport[`revokeWebhook${suffix}`] = capture(`revokeWebhook${suffix}`, id => { catalog[kind].find(row => row.id === id).state = "revoked"; });
    }
    Object.assign(transport, overrides);
    const controller = new PilotSwarmUiController({ store, transport });
    return { store, controller, transport, calls, catalog, profile, value: () => store.getState().admin.webhooks };
}

export function fillWebhookForm(controller, fields) {
    for (const [name, value] of Object.entries(fields)) controller.setWebhookEditorField(name, typeof value === "string" ? value : JSON.stringify(value));
}
