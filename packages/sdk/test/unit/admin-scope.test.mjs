import test from "node:test";
import { ApiClient } from "../../api/src/api-client.js";
import assert from "node:assert/strict";

test("admin-scope: revocation fences an in-flight snapshot even for a live-only subscriber", async () => {
    class Socket extends EventTarget {
        static OPEN = 1;
        readyState = 1;
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
        send() {}
        close() {}
    }
    const client = new ApiClient({ apiUrl: "http://example.invalid", WebSocketImpl: Socket });
    const key = "private\u0000turn";
    const delivered = [];
    client.liveSubscribers.set(key, new Set([message => delivered.push(message)]));
    const socket = await client.ensureSocket();
    await client.handleLiveMessage({ kind: "snapshot", sessionId: "private", topic: "turn", seq: 1, data: { text: "before" } });
    let finish;
    client.call = () => new Promise(resolve => { finish = resolve; });
    const pending = client.handleLiveMessage({ kind: "patch", sessionId: "private", topic: "turn", seq: 3, data: { text: "gap" } });
    assert.ok(client.liveRefetches.has(key));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", code: "ACCESS_REVOKED", sessionId: "private" }) }));
    assert.equal(client.liveRefetches.has(key), false);
    assert.equal(client.liveSequences.has(key), false);
    finish([{ topic: "turn", seq: 3, payload: { text: "LATE_PRIVATE_CANARY" } }]);
    await pending;
    assert.equal(client.liveValues.has(key), false);
    assert.ok(delivered.some(message => message.kind === "unavailable" && message.accessRevoked));
    assert.ok(!JSON.stringify(delivered).includes("LATE_PRIVATE_CANARY"));
    client.stop();
});
import { loadAdminScope, validateAdminScope, adminCapabilities } from "../../api/src/admin-scope.js";
import { evaluateSessionAccess, evaluateArchiveAccess, relationFor } from "../../api/src/session-authz.js";
import { projectUserAccounting, projectFleetAccounting, projectWorker } from "../../api/src/admin-diagnostics.js";
import { loadAuthzConfig } from "../../../app/web/authz.js";
import { SessionManager } from "../../dist/session-manager.js";

const snapshot = (patch = {}) => ({ rootSessionId: "root", isSystem: false, visibility: "private",
    owner: { provider: "test", subject: "owner" }, viewerIsOwner: false, viewerShareAccess: null, ...patch });
const env = { AUTHZ_ADMIN_SCOPE: "cluster", AUTHZ_ENFORCE_OWNERSHIP: "true", PORTAL_AUTH_PROVIDER: "entra" };

test("admin-scope: operator configuration is explicit, compatible by default, and fail-closed", () => {
    assert.equal(loadAdminScope({}), "unrestricted");
    assert.equal(validateAdminScope(env, { authenticationEnabled: true }), "cluster");
    for (const value of ["all", "", "clusters"]) assert.throws(() => loadAdminScope({ AUTHZ_ADMIN_SCOPE: value }));
    assert.throws(() => validateAdminScope({ AUTHZ_ADMIN_SCOPE: "cluster" }), /OWNERSHIP/);
    assert.throws(() => loadAuthzConfig({ ...env, PORTAL_AUTH_PROVIDER: "none" }), /authentication/);
    assert.throws(() => loadAuthzConfig({ ...env, PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "true" }), /authentication/);
    assert.equal(loadAuthzConfig(env).adminScope, "cluster");
    assert.deepEqual(adminCapabilities(true, "cluster"), {
        clusterManagement: true, fleetAccounting: true, userResourceBypass: false, systemSessionAdmin: true,
    });
});

for (const adminScope of ["cluster", "unrestricted"]) {
    for (const [label, patch, ordinary] of [
        ["owner", { viewerIsOwner: true }, [true, true, true, true, true]],
        ["read collaborator", { viewerShareAccess: "read" }, [true, false, false, false, false]],
        ["write collaborator", { viewerShareAccess: "write" }, [true, true, false, false, false]],
        ["shared read", { visibility: "shared_read" }, [true, false, false, false, false]],
        ["shared write", { visibility: "shared_write" }, [true, true, false, false, false]],
        ["stranger", {}, [false, false, false, false, false]],
    ]) {
        for (const [i, action] of ["read", "write", "manage", "destroy", "share"].entries()) {
            test(`admin-scope: ${adminScope} admin as ${label}: ${action}`, () => {
                const result = evaluateSessionAccess(`session:${action}`, snapshot(patch), { isAdmin: true, adminScope });
                assert.equal(result.allowed, adminScope === "unrestricted" || ordinary[i]);
                if (label === "stranger" && adminScope === "cluster") assert.equal(result.notFound, true);
            });
        }
    }
    test(`admin-scope: ${adminScope} preserves system read/write and ordinary-user visibility`, () => {
        for (const systemReadable of [true, false]) {
            for (const action of ["read", "write"]) {
                assert.equal(evaluateSessionAccess(`session:${action}`, snapshot({ isSystem: true }), { isAdmin: true, adminScope, systemReadable }).allowed, true);
                assert.equal(evaluateSessionAccess(`session:${action}`, snapshot({ isSystem: true }), { isAdmin: false, adminScope, systemReadable }).allowed, action === "read" && systemReadable);
            }
        }
        const opts = { isAdmin: true, adminScope };
        assert.equal(relationFor(snapshot({ viewerShareAccess: "write" }), opts), adminScope === "cluster" ? "collaborator" : "admin");
        assert.equal(evaluateArchiveAccess(snapshot({ viewerShareAccess: "write" }), opts).allowed, adminScope === "unrestricted");
        assert.equal(evaluateArchiveAccess(snapshot({ viewerIsOwner: true }), opts).allowed, true);
    });
}

test("admin-scope: operational projections retain totals without private labels, IDs, paths or errors", () => {
    const canary = "PRIVATE-CANARY";
    const users = { totals: { tokensInput: 100 }, users: [{ owner: { subject: "alice" }, sessionIds: [canary],
        totalTokensInput: 100, byModel: [{ model: "m", sessionIds: [canary], totalTokensInput: 100 }] }] };
    const projected = projectUserAccounting(users);
    assert.equal(projected.users[0].totalTokensInput, 100);
    assert.equal(projected.users[0].owner.subject, "alice");
    assert.ok(!JSON.stringify(projected).includes(canary));
    assert.equal(users.users[0].sessionIds[0], canary, "no mutation of trusted/system views");
    const fleet = projectFleetAccounting({ totals: { n: 2 }, byAgent: [
        { agentId: canary, model: "m", totalTokensInput: 60, totalTokensCacheRead: 20 },
        { agentId: "public", model: "m", totalTokensInput: 40, totalTokensCacheRead: 10 },
    ] });
    assert.equal(fleet.byAgent[0].totalTokensInput, 100);
    assert.equal(fleet.byAgent[0].cacheHitRatio, 0.3);
    assert.ok(!JSON.stringify(fleet).includes(canary));
    const worker = projectWorker({ workerNodeId: "w", health: { rssBytes: 100, secret: canary },
        info: { sdkVersion: "1", authz: { adminScope: "cluster" }, manifest: canary },
        state: { "agent-packages": { installed: { [canary]: { status: "error", error: canary } }, lastError: canary } } });
    assert.equal(worker.health.rssBytes, 100);
    assert.equal(worker.state["agent-packages"].installedCount, 1);
    assert.equal(worker.state["agent-packages"].errorCount, 1);
    assert.ok(!JSON.stringify(worker).includes(canary));
});

test("admin-scope: a forged token-manager name cannot grant service identity", async () => {
    const manager = Object.create(SessionManager.prototype);
    let isSystemSession = false;
    manager._resolveInspectViewer = async () => ({ provider: "dev", subject: "owner", isAdmin: false, isSystemSession, adminScope: "cluster" });
    manager.sessionCatalog = { providers: { lookupUserId: async () => 42 } };
    assert.deepEqual(await manager._resolveProviderViewer("personal-recurring", "token-manager"), { userId: 42, isAdmin: false, adminScope: "cluster" });
    isSystemSession = true;
    assert.deepEqual(await manager._resolveProviderViewer("real-system", "token-manager"), { userId: null, isAdmin: true });
});
