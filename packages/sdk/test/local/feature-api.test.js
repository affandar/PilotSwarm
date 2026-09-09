import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import express from "express";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { ApiClient } from "../../api/src/api-client.js";
import { OPERATIONS } from "../../api/src/protocol.js";
import { FEATURE_OPERATION_SPECS } from "../../src/feature-tools.ts";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { createApiRouter } from "../../../app/web/api/router.js";

const key = "copilot.native_tasks";
const schema = `ps_test_feature_api_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
let catalog, server, clients, aliceId, bobId, runtime;
const pool = new pg.Pool({ connectionString: url });
beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema); await catalog.initialize();
    for (const subject of ["admin", "alice", "bob"]) await catalog.setUserProfileSettings({ provider: "test", subject }, {});
    const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
    const users = await catalog.features.users(admin);
    aliceId = users.find(u => u.subject === "alice").userId; bobId = users.find(u => u.subject === "bob").userId;
    const mgmt = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
    mgmt._catalog = catalog; mgmt._started = true;
    runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {}; runtime.transport = { mgmt };
    const app = express(); app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth: (req, res, next) => {
        const subject = req.headers["x-test-actor"];
        if (!["admin", "alice", "bob"].includes(subject)) return res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
        req.auth = { principal: { provider: "test", subject }, authorization: { role: subject === "admin" ? "admin" : "user" } }; next();
    } }));
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    clients = Object.fromEntries(["admin", "alice", "bob"].map(subject => [subject, new ApiClient({ apiUrl: `http://127.0.0.1:${server.address().port}`, fetchImpl: (uri, options) => fetch(uri, { ...options, headers: { ...options.headers, "x-test-actor": subject } }) })]));
});
beforeEach(async () => {
    await pool.query(`DELETE FROM "${schema}".feature_flag_settings`);
    await pool.query(`UPDATE "${schema}".feature_flags SET revision = 1`);
    await pool.query(`DELETE FROM "${schema}".authz_audit WHERE action LIKE 'feature_flag.%'`);
});
afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
});
const change = (revision, extra = {}) => ({ featureKey: key, expectedRevision: revision, requestId: randomUUID(), ...extra });

describe("feature flags through HTTP router, authenticated runtime and real store", () => {
    it("exposes every management/tool operation with an access classification", () => {
        for (const spec of FEATURE_OPERATION_SPECS) expect(OPERATIONS.find(op => op.name === spec.method)).toMatchObject({ access: expect.any(String) });
    });
    it("enforces admin versus self, and ignores spoofed actor fields", async () => {
        for (const name of ["setClusterFeatureFlag", "resetClusterFeatureFlag", "getUserFeatureFlags", "setUserFeatureFlag", "unsetUserFeatureFlag", "listFeatureFlagChanges", "listFeatureFlagUsers"]) {
            await expect(clients.alice.call(name, { ...change("1", { enabled: true, allowUserOverride: true }), userId: String(bobId), isAdmin: true, principal: { provider: "test", subject: "admin" } })).rejects.toMatchObject({ status: 403 });
        }
        // Send forged fields literally; ApiClient intentionally strips unknown
        // fields, which would make this trust-boundary test vacuous.
        const forged = { ...change("1", { enabled: true }), userId: bobId, isAdmin: true, principal: { provider: "test", subject: "bob" } };
        const response = await fetch(`${clients.alice.apiUrl}/api/v1/management/users/me/features/${key}`, {
            method: "PUT", headers: { "content-type": "application/json", "x-test-actor": "alice" }, body: JSON.stringify(forged),
        });
        expect(response.status).toBe(200);
        // Also exercise the shared legacy-RPC dispatcher, without the HTTP
        // router's parameter allowlist, to prove identity is derived there.
        await expect(runtime.call("setClusterFeatureFlag", { ...forged, allowUserOverride: true }, {
            principal: { provider: "test", subject: "alice" }, authorization: { role: "user" },
        })).rejects.toMatchObject({ status: 403 });
        expect((await clients.alice.call("getMyFeatureFlags")).flags[0]).toMatchObject({ effective: false, user: { userId: aliceId, enabled: true }, userOverrideIgnored: true });
        expect((await clients.bob.call("getMyFeatureFlags")).flags[0].user).toBeNull();
        await runtime.call("setMyFeatureFlag", { ...forged, expectedRevision: "2", requestId: randomUUID(), enabled: false }, {
            principal: { provider: "test", subject: "alice" }, authorization: { role: "user" },
        });
        expect((await clients.alice.call("getMyFeatureFlags")).flags[0].user).toMatchObject({ userId: aliceId, enabled: false });
        expect((await clients.bob.call("getMyFeatureFlags")).flags[0].user).toBeNull();
    });
    it("roundtrips cluster/user changes, reset/unset, revisions and retry envelopes", async () => {
        await clients.alice.call("setMyFeatureFlag", change("1", { enabled: true }));
        const initial = (await clients.admin.call("listFeatureFlags")).flags[0].revision;
        const request = change(initial, { enabled: false, allowUserOverride: true });
        const saved = await clients.admin.call("setClusterFeatureFlag", request);
        expect(await clients.admin.call("setClusterFeatureFlag", request)).toEqual(saved);
        expect((await clients.alice.call("getMyFeatureFlags")).flags[0].effective).toBe(true);
        await expect(clients.admin.call("setClusterFeatureFlag", change(initial, { enabled: true, allowUserOverride: false }))).rejects.toMatchObject({ status: 409, code: "FEATURE_CONFLICT" });
        const user = await clients.admin.call("setUserFeatureFlag", { ...change(saved.revision, { enabled: false }), userId: String(aliceId) });
        expect((await clients.admin.call("getUserFeatureFlags", { userId: String(aliceId) })).flags[0].effective).toBe(false);
        const unset = await clients.admin.call("unsetUserFeatureFlag", { ...change(user.revision), userId: String(aliceId) });
        const reset = await clients.admin.call("resetClusterFeatureFlag", change(unset.revision));
        expect((await clients.admin.call("getClusterFeatureFlags")).flags[0]).toMatchObject({ cluster: null, effective: false, revision: reset.revision });
        const mine = await clients.alice.call("setMyFeatureFlag", change(reset.revision, { enabled: false }));
        await clients.alice.call("unsetMyFeatureFlag", change(mine.revision));
        expect((await clients.admin.call("listFeatureFlagUsers", { query: "alice" })).map(u => u.userId)).toEqual([aliceId]);
        expect((await clients.admin.call("listFeatureFlagChanges")).length).toBeGreaterThanOrEqual(6);
    });
    it("maps invalid and missing-key errors through the wire", async () => {
        await expect(clients.admin.call("setClusterFeatureFlag", change("0", { enabled: true, allowUserOverride: false }))).rejects.toMatchObject({ status: 400, code: "FEATURE_INVALID" });
        await expect(clients.admin.call("resetClusterFeatureFlag", { ...change("1"), featureKey: "missing.flag" })).rejects.toMatchObject({ status: 404, code: "FEATURE_NOT_FOUND" });
        await expect(clients.admin.call("getUserFeatureFlags", { userId: "not-a-user" })).rejects.toMatchObject({ status: 400 });
    });
});
