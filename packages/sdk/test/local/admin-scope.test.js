/** Real catalog/service/portal handlers; synthetic identities, no LLM or production data. */
import { describe, it, beforeAll, beforeEach, afterAll, expect } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { createInspectTools } from "../../dist/inspect-tools.js";
import { createAgentManagerTools } from "../../dist/agent-manager-tools.js";
import { createProviderTools } from "../../dist/provider-tools.js";
import { join } from "node:path";
import express from "express";
import { createApiRouter } from "../../../app/web/api/router.js";
import { authenticateToken } from "../../../app/web/auth/index.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const ALICE = { provider: "dev", subject: "alice", email: "alice@dev.local", displayName: "Alice" };
const ADMIN = { provider: "dev", subject: "admin", email: "admin@dev.local", displayName: "Admin" };
const READER = { provider: "dev", subject: "reader", email: "reader@dev.local" };
const auth = (principal, role = "user") => ({ principal, authorization: { role, allowed: true } });
const CANARY = "private-content-canary-75";
const b64 = (value) => Buffer.from(value).toString("base64");
const files = (name, version = "1.0.0") => [
    { path: "plugin.json", contentBase64: b64(JSON.stringify({ name, version, description: CANARY })) },
    { path: `agents/${name}.agent.md`, contentBase64: b64(`---\nname: ${name}\ndescription: Test agent\nschemaVersion: 1\nversion: ${version}\n---\n${CANARY}`) },
];

describe("admin-scope catalog and portal integration", () => {
    let env, runtime, catalog, adminId, aliceId, server, apiUrl;
    const saved = {};
    const setEnv = (key, value) => {
        saved[key] = process.env[key];
        if (value == null) delete process.env[key]; else process.env[key] = value;
    };
    const call = (method, params = {}, who = ADMIN, role = "admin") => runtime.call(method, params, auth(who, role));
    beforeAll(async () => {
        env = createTestEnv("admin_scope");
        for (const [key, value] of Object.entries({
            PILOTSWARM_CMS_SCHEMA: env.cmsSchema, PILOTSWARM_DUROXIDE_SCHEMA: env.duroxideSchema,
            PILOTSWARM_FACTS_SCHEMA: env.factsSchema, HORIZON_FACTS_SCHEMA: env.factsSchema,
            ARTIFACT_DIR: join(env.baseDir, "artifacts"), AZURE_STORAGE_CONNECTION_STRING: null,
            AZURE_STORAGE_ACCOUNT_URL: null,
            PORTAL_AUTH_PROVIDER: "dev", PORTAL_AUTH_DEV_ALLOW: "true", PORTAL_AUTH_DEV_USERS: "admin:admin,alice:user,reader:user",
            AUTHZ_ADMIN_SCOPE: "cluster", AUTHZ_ENFORCE_OWNERSHIP: "true", SESSIONS_SYSTEM_VISIBILITY: "admin",
            PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
        })) setEnv(key, value);
        for (const key of Object.keys(process.env).filter((key) => key.startsWith("PORTAL_AUTH_ENTRA_"))) setEnv(key, null);
        runtime = new PortalRuntime({ store: env.store, mode: "remote" });
        runtime.authz = { adminScope: "cluster", enforce: true, defaultVisibility: "private", systemVisibility: "admin" };
        await runtime.transport.mgmt.start();
        runtime.started = true;
        catalog = runtime.transport.mgmt._catalog;
        for (const [id, opts] of [
            ["foreign", { owner: ALICE, title: CANARY }],
            ["child", { owner: ALICE, parentSessionId: "foreign" }],
            ["own", { owner: ADMIN }],
            ["shared", { owner: ALICE, visibility: "shared_read" }],
            ["system", { isSystem: true }],
        ]) await catalog.createSession(id, { model: "test:model", ...opts });
        await catalog.updateSession("foreign", { title: CANARY });
        adminId = await catalog.providers.lookupUserId(ADMIN);
        aliceId = await catalog.providers.lookupUserId(ALICE);
        await runtime.transport.uploadAgentPackage(files("private-kit"), "user", ALICE, false);
        await runtime.transport.uploadAgentPackage(files("shared-kit"), "shared", ALICE, false);
        await runtime.transport.uploadAgentPackage(files("own-kit"), "user", ADMIN, false);
        const app = express();
        app.use(express.json());
        app.use("/api/v1", createApiRouter({ runtime, requireAuth: async (req, res, next) => {
            const result = await authenticateToken(req.headers.authorization?.replace(/^Bearer /, ""), req);
            if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
            req.auth = result;
            next();
        } }));
        server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
        apiUrl = `http://127.0.0.1:${server.address().port}`;
    }, 180_000);
    beforeEach(async () => {
        runtime.authz.adminScope = "cluster";
        await catalog.revokeSessionShare("foreign", ADMIN);
    });
    afterAll(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        try { await runtime?.transport.mgmt.stop(); }
        finally {
            await env?.cleanup();
            for (const [key, value] of Object.entries(saved)) {
                if (value == null) delete process.env[key]; else process.env[key] = value;
            }
        }
    }, 180_000);

    it("private session trees are absent from paginated lists and cannot be reached by guessed IDs", async () => {
        const rows = await call("listSessions");
        expect(rows.map((r) => r.sessionId).sort()).toEqual(["own", "shared", "system"]);
        const ids = [];
        let cursor;
        do {
            const page = await call("listSessionsPage", { limit: 1, cursor });
            ids.push(...page.sessions.map((r) => r.sessionId));
            cursor = page.nextCursor;
        } while (cursor);
        expect(ids.sort()).toEqual(["own", "shared", "system"]);
        for (const sessionId of ["foreign", "child", "nonexistent"]) {
            for (const method of ["getSession", "getSessionEvents", "getExecutionHistory", "getSessionAccess", "listArtifacts", "getCanvasLive"]) {
                await expect(call(method, { sessionId })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
            }
        }
        for (const method of ["sendMessage", "cancelSession", "deleteSession", "renameSession"]) {
            await expect(call(method, { sessionId: "foreign", prompt: "x", title: "x" })).rejects.toMatchObject({ status: 404 });
        }
        await expect(runtime.downloadArtifactBinary("foreign", "secret.txt", auth(ADMIN, "admin"))).rejects.toMatchObject({ status: 404 });
        await expect(runtime.authorizeSessionSubscribe("foreign", auth(ADMIN, "admin"))).rejects.toMatchObject({ status: 404 });
    });

    it("shares grant ordinary rights, preserve sender attribution, and revocation applies without restarting", async () => {
        await catalog.grantSessionShare("foreign", ADMIN, "write", ALICE);
        const access = await call("getSessionAccess", { sessionId: "child" });
        expect(access).toMatchObject({ canWrite: true, canManage: false, relation: "collaborator" });
        await runtime.authorizeSessionSubscribe("foreign", auth(ADMIN, "admin"));
        await expect(call("renameSession", { sessionId: "child", title: "hijack" })).rejects.toMatchObject({ status: 403 });
        await expect(call("getCanvasShareLink", { sessionId: "foreign", slot: 0 })).rejects.toMatchObject({ status: 403 });
        await catalog.revokeSessionShare("foreign", ADMIN);
        await expect(call("getSessionAccess", { sessionId: "foreign" })).rejects.toMatchObject({ status: 404 });
    });

    it("system sessions retain admin access even with system visibility set to admin", async () => {
        expect(await call("getSessionAccess", { sessionId: "system" })).toMatchObject({ canWrite: true, canManage: true, isSystem: true });
        await runtime.authorizeSessionSubscribe("system", auth(ADMIN, "admin"));
        await expect(call("getSessionAccess", { sessionId: "system" }, ALICE, "user")).rejects.toMatchObject({ status: 404 });
        const worker = createInspectTools({ catalog, sessionId: "system", agentIdentity: "agent-manager",
            resolveViewer: () => ({ provider: "system", subject: "system", isAdmin: false, isSystemPrincipal: true, adminScope: "unrestricted" }) });
        const result = await worker.find((t) => t.name === "read_session_info").handler({ session_id: "foreign" });
        expect(JSON.stringify(result)).toContain(CANARY); // accepted phase-1 system-mediated route
    });

    it("private packages and all mutation paths do not inherit the admin role", async () => {
        expect((await call("listAgentPackages")).map((p) => p.name).sort()).toEqual(["own-kit", "shared-kit"]);
        expect(await call("getAgentPackage", { name: "private-kit", scope: "user", ownerProvider: "dev", ownerSubject: "alice", isAdmin: true, adminScope: "unrestricted" })).toBeNull();
        for (const method of ["getAgentPackageTree", "getAgentPackageFile"]) {
            await expect(call(method, { name: "private-kit", filePath: "plugin.json", semver: "1.0.0" })).rejects.toBeDefined();
        }
        await expect(runtime.downloadAgentPackageBinary("private-kit", "1.0.0", auth(ADMIN, "admin"))).rejects.toBeDefined();
        for (const [method, params] of [
            ["pinAgentPackageVersion", { semver: "1.0.0" }],
            ["setAgentPackageEnabled", { enabled: false }],
            ["setAgentPackageScope", { scope: "user" }],
            ["deleteAgentPackage", {}],
            ["grantAgentPackageEditor", { user: READER }],
        ]) await expect(call(method, { name: "shared-kit", ...params })).rejects.toBeDefined();
        // Same-content/no-op publication must authorize before returning success.
        await expect(call("uploadAgentPackage", { files: files("shared-kit"), scope: "shared" })).rejects.toBeDefined();
        await catalog.grantAgentPackageEditor("shared-kit", ADMIN, ALICE, false);
        await call("setAgentPackageEnabled", { name: "shared-kit", enabled: false });
        await call("setAgentPackageEnabled", { name: "shared-kit", enabled: true });
        await expect(call("deleteAgentPackage", { name: "shared-kit" })).rejects.toBeDefined();
        await catalog.revokeAgentPackageEditor("shared-kit", ADMIN, ALICE, false);
        await expect(call("setAgentPackageEnabled", { name: "shared-kit", enabled: false })).rejects.toBeDefined();
        expect((await catalog.getAgentPackage("shared-kit", ALICE, false)).enabled).toBe(true);
    });

    it("staged publication rechecks editor revocation and cannot retain an old owner bypass", async () => {
        const viewer = { ...ADMIN, isAdmin: true, isSystemPrincipal: false, adminScope: "cluster" };
        const tools = createAgentManagerTools({ catalog, artifactStore: runtime.transport.artifactStore, sessionId: "own", resolveViewer: async () => viewer });
        const stage = tools.find((t) => t.name === "stage_agent_package_edit").handler;
        const publish = tools.find((t) => t.name === "publish_agent_package").handler;
        const stagedFiles = (name) => ({ ...Object.fromEntries(files(name, "1.0.1").map((f) => [f.path, Buffer.from(f.contentBase64, "base64").toString()])), "CHANGELOG.md": "## 1.0.1\nUpdated by Agent Manager." });
        await catalog.grantAgentPackageEditor("shared-kit", ADMIN, ALICE, false);
        expect(await stage({ package: "shared-kit", from_package: "__shared:shared-kit", files: stagedFiles("shared-kit"), reset: true })).not.toHaveProperty("error");
        await catalog.revokeAgentPackageEditor("shared-kit", ADMIN, ALICE, false);
        const before = await catalog.getAgentPackage("shared-kit", ALICE, false);
        const store = runtime.transport.artifactStore;
        const originalUpload = store.uploadArtifactFromFile;
        let uploaded = 0;
        store.uploadArtifactFromFile = (...args) => { uploaded++; return originalUpload.apply(store, args); };
        try {
            expect(await publish({ package: "shared-kit", semver: "1.0.1", scope: "shared", approved_by: "synthetic test" })).toHaveProperty("error");
            expect(uploaded).toBe(0, "forbidden publish must not write package blobs");
        } finally { store.uploadArtifactFromFile = originalUpload; }
        expect(await catalog.getAgentPackage("shared-kit", ALICE, false)).toEqual(before);
        viewer.adminScope = "unrestricted";
        expect(await stage({ package: "private-kit", from_package: "alice:private-kit", files: stagedFiles("private-kit"), reset: true })).not.toHaveProperty("error");
        viewer.adminScope = "cluster";
        expect(await publish({ package: "private-kit", semver: "1.0.1", scope: "user", approved_by: "synthetic test" })).toMatchObject({ error: expect.stringContaining("no longer have permission") });
        expect(await catalog.getAgentPackage("private-kit", ADMIN, false)).toBeNull();
    });

    it("facts and artifact source/destination gates cannot be bypassed with private IDs", async () => {
        await call("storeFact", { input: { key: "scope/secret", value: { text: CANARY }, sessionId: "foreign", shared: false } }, ALICE, "user");
        await expect(call("storeFact", { input: { key: "scope/secret", value: { text: "overwrite" }, sessionId: "foreign", shared: false } })).rejects.toMatchObject({ status: 404 });
        expect(JSON.stringify(await call("readFacts", { scope: "session", sessionId: "foreign", keyPattern: "%" }).catch((e) => ({ status: e.status })))).not.toContain(CANARY);
        await expect(call("readFacts", { sessionId: "foreign", keyPattern: "%" })).rejects.toMatchObject({ status: 404 });
        expect(JSON.stringify(await call("readFacts", { scopeKeys: ["session:foreign:scope/secret"], admin: true, unrestricted: true }))).not.toContain(CANARY);
        expect(JSON.stringify(await call("readFacts", { sessionId: "foreign", keyPattern: "scope/%" }, ALICE, "user"))).toContain(CANARY);
        await call("uploadArtifact", { sessionId: "foreign", filename: "secret.txt", content: CANARY, contentType: "text/plain" }, ALICE, "user");
        for (const [fromSessionId, toSessionId] of [["foreign", "own"], ["own", "foreign"]]) {
            await expect(call("copyArtifact", { fromSessionId, toSessionId, fromFilename: "secret.txt", toFilename: "copied.txt" })).rejects.toMatchObject({ status: 404 });
        }
        expect((await call("listArtifacts", { sessionId: "own" })).some((f) => f.filename === "copied.txt")).toBe(false);
    });

    it("cluster configuration and budgets remain admin-only while foreign folders do not", async () => {
        const group = await call("createSessionGroup", { input: { title: "Private folder" } }, ALICE, "user");
        const groupId = group.groupId ?? group;
        await expect(call("updateSessionGroup", { groupId, patch: { title: "hijack" } })).rejects.toMatchObject({ status: 404 });
        await expect(call("deleteSessionGroup", { groupId })).rejects.toMatchObject({ status: 404 });
        await call("createProvider", { name: "scope-test-provider", type: "github-copilot", credentials: { githubToken: "synthetic-key" } });
        for (const [method, params] of [
            ["setProviderLimit", { name: "scope-test-provider", period: "day", tokens: 10000 }],
            ["setProviderAllowance", { name: "scope-test-provider", pct: 50 }],
            ["setProviderHold", { name: "scope-test-provider", untilUtc: new Date(Date.now() + 60000).toISOString() }],
        ]) {
            await call(method, params);
            await expect(call(method, params, ALICE, "user")).rejects.toBeDefined();
        }
    });

    it("ordinary and recurring admin agents receive the same restrictions, with one batch list check", async () => {
        const viewer = { ...ADMIN, isAdmin: true, isSystemPrincipal: false, adminScope: "cluster" };
        const tools = createInspectTools({ catalog, sessionId: "own", agentIdentity: "agent-manager", resolveViewer: () => viewer });
        expect(await tools.find((t) => t.name === "read_session_info").handler({ session_id: "foreign" })).toHaveProperty("error");
        const original = catalog.pool.query.bind(catalog.pool);
        let calls = 0;
        catalog.pool.query = (...args) => { calls++; return original(...args); };
        try {
            expect((await catalog.filterVisibleSessionIds(["foreign", "child", "own", "shared", "system"], ADMIN, true)).sort()).toEqual(["own", "shared", "system"]);
            expect(calls).toBe(1);
            calls = 0;
            const listed = await tools.find((t) => t.name === "list_all_sessions").handler({});
            expect(listed.sessions.map((s) => s.sessionId).sort()).toEqual(["own", "shared", "system"]);
            expect(calls).toBe(1, "authorized paged listing has no per-row authorization queries");
        } finally { catalog.pool.query = original; }
        const packages = createAgentManagerTools({ catalog, sessionId: "own", resolveViewer: async () => viewer });
        expect(JSON.stringify(await packages.find((t) => t.name === "list_agent_packages").handler({}))).not.toContain("private-kit");
        expect(await packages.find((t) => t.name === "read_agent_package").handler({ package: "alice:private-kit" })).toHaveProperty("error");
    });

    it("all provider types count private spend exactly, but no private labels or session drill-downs leak", async () => {
        const types = ["github-copilot", "openai", "azure", "openai-proxy", "anthropic", "anthropic-wif"];
        for (const [i, type] of types.entries()) {
            await catalog.providers.settleTurn({ sessionId: "foreign", turnIndex: i, providerName: type,
                modelQualified: `${type}:model`, ownerUserId: aliceId, agentId: CANARY, chargeClass: "user",
                tokensInput: 100, tokensOutput: 10, tokensCacheRead: 30, tokensCacheWrite: 5 });
        }
        await catalog.providers.settleTurn({ sessionId: "system", turnIndex: 0, providerName: "github-copilot",
            modelQualified: "github-copilot:model", ownerUserId: null, agentId: "system", chargeClass: "system", tokensInput: 50, tokensOutput: 5 });
        for (const dimension of ["user", "provider", "model", "session", "agent"]) {
            const report = await call("getProviderUsage", { dimension });
            expect(report.totals).toMatchObject({ tokensTotal: 715, turns: 7, sessions: 2 });
            expect(report.daily[0]).toMatchObject({ tokensInput: 650, tokensOutput: 65, tokensCacheRead: 180, tokensCacheWrite: 30 });
            expect(report.breakdown.reduce((sum, row) => sum + row.tokensTotal, 0)).toBe(715);
            expect(JSON.stringify(report)).not.toContain(CANARY);
            if (dimension === "session") expect(report.breakdown.map((r) => r.key).sort()).toEqual(["(private sessions)", "system"]);
        }
        const agents = await call("getProviderUsageAgents");
        expect(JSON.stringify(agents)).not.toContain(CANARY);
        expect(agents.agents.reduce((sum, row) => sum + row.total, 0)).toBe(715);
        const tool = createProviderTools({ catalog, resolveViewer: () => ({ userId: adminId, isAdmin: true, adminScope: "cluster" }) });
        const report = await tool.find((t) => t.name === "get_provider_usage").handler({ dimension: "agent" });
        expect(report.totals.tokensTotal).toBe(715);
        expect(JSON.stringify(report)).not.toContain(CANARY);
        const user = await call("getProviderUsage", {}, ADMIN, "user");
        expect(user.totals.tokensTotal).toBe(0);
        await catalog.grantSessionShare("foreign", ADMIN, "read", ALICE);
        expect((await call("getProviderUsage")).totals.tokensTotal).toBe(715);
        await catalog.revokeSessionShare("foreign", ADMIN);
    });

    it("operator rollback to unrestricted restores direct access without changing owners or grants", async () => {
        runtime.authz.adminScope = "unrestricted";
        try {
            expect((await call("getSessionAccess", { sessionId: "foreign" })).canWrite).toBe(true);
            expect((await call("listAgentPackages")).some((p) => p.name === "private-kit")).toBe(true);
        } finally { runtime.authz.adminScope = "cluster"; }
        expect((await catalog.getSession("foreign")).owner.subject).toBe("alice");
        expect((await catalog.listSessionShares("foreign")).length).toBe(0);
    });

    it("authenticated REST and real Web-mode MCP agree, including a warm client's policy transition", async () => {
        const read = (path, persona) => fetch(`${apiUrl}/api/v1${path}`, { headers: { authorization: `Bearer dev:${persona}` } });
        expect((await fetch(`${apiUrl}/api/v1/sessions/foreign`)).status).toBe(401);
        expect((await read("/sessions/foreign", "admin")).status).toBe(404);
        expect((await read("/sessions/foreign", "alice")).status).toBe(200);
        expect((await read("/sessions/system", "admin")).status).toBe(200);
        expect((await read("/sessions/system", "alice")).status).toBe(404);
        const root = fileURLToPath(new URL("../../../../", import.meta.url));
        const transport = new StdioClientTransport({ command: "node", cwd: root,
            args: [join(root, "packages/app/mcp/dist/bin/pilotswarm-mcp.js"), "--api-url", apiUrl, "--transport", "stdio", "--log-level", "error"],
            env: { ...process.env, PILOTSWARM_API_TOKEN: "dev:admin" }, stderr: "pipe" });
        const client = new McpClient({ name: "admin-scope-test", version: "1" }, { capabilities: {} });
        try {
            await client.connect(transport);
            const packages = await client.callTool({ name: "list_agent_packages", arguments: {} });
            expect(packages.isError).not.toBe(true);
            expect(JSON.stringify(packages)).not.toContain("private-kit");
            const denied = await client.callTool({ name: "get_agent_package", arguments: { name: "private-kit" } });
            expect(JSON.stringify(denied)).not.toContain(CANARY);
            runtime.authz.adminScope = "unrestricted";
            expect(JSON.stringify(await client.callTool({ name: "list_agent_packages", arguments: {} }))).toContain("private-kit");
            runtime.authz.adminScope = "cluster";
            expect(JSON.stringify(await client.callTool({ name: "list_agent_packages", arguments: {} }))).not.toContain("private-kit");
        } finally { runtime.authz.adminScope = "cluster"; await client.close(); }
    }, 60_000);
});
