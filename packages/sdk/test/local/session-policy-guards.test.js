/**
 * Level 10a: Session policy — guard rail tests.
 *
 * Covers: agent namespacing, list agents, client rejects generic/unknown/system,
 * orchestration rejects generic.
 *
 * Run: npx vitest run test/local/session-policy-guards.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertNotNull, assertThrows } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PLUGIN = path.resolve(__dirname, "../fixtures/policy-plugin");

const TIMEOUT = 120_000;

async function testAgentNamespacing(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const agents = worker.loadedAgents;
        const alpha = agents.find(a => a.name === "alpha");
        assertNotNull(alpha, "alpha agent loaded");
        assertEqual(alpha.namespace, "testapp", "alpha namespace");

        const sysAgents = worker.systemAgents;
        const beta = sysAgents.find(a => a.name === "beta");
        assertNotNull(beta, "beta system agent loaded");
        assertEqual(beta.namespace, "testapp", "beta namespace");
    });
}

async function testListAgentsOmitsSystem(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const allowed = worker.allowedAgentNames;
        console.log("  allowedAgentNames:", allowed);
        assert(allowed.includes("alpha"), "alpha in allowed list");
        assert(!allowed.includes("beta"), "beta NOT in allowed list (system)");

        const sysAgents = worker.systemAgents;
        const beta = sysAgents.find(a => a.name === "beta");
        assertNotNull(beta, "beta in system agents list");
    });
}

async function testClientRejectsGeneric(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        await assertThrows(
            () => client.createSession({ systemMessage: { mode: "replace", content: "Hello" } }),
            "policy",
            "generic session rejected by client",
        );
    });
}

async function testClientAllowsNamedAgent(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");
        assertNotNull(session.sessionId, "sessionId exists");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            assertEqual(row.agentId, "alpha", "CMS agentId");
            assertIncludes(row.title, "Alpha:", "CMS title has agent prefix");
        } finally {
            await catalog.close();
        }
    });
}

async function testClientRejectsUnknown(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        await assertThrows(
            () => client.createSessionForAgent("nonexistent"),
            "not found",
            "unknown agent rejected",
        );
    });
}

async function testClientRejectsSystemAgent(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        await assertThrows(
            () => client.createSessionForAgent("beta"),
            "not found",
            "system agent rejected as top-level",
        );
    });
}

async function testDeletionProtectsSystem(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        // Wait for beta system agent to auto-start
        await new Promise(r => setTimeout(r, 3000));

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const betaSession = sessions.find(s => s.agentId === "beta" && s.isSystem);
            assertNotNull(betaSession, "beta system session exists");

            await assertThrows(
                () => client.deleteSession(betaSession.sessionId),
                "system",
                "cannot delete system session",
            );

            // Verify it still exists
            const row = await catalog.getSession(betaSession.sessionId);
            assertNotNull(row, "session still exists after failed delete");
            assertEqual(row.deletedAt, null, "deletedAt still null");
        } finally {
            await catalog.close();
        }
    });
}

async function testOrchRejectsGeneric(env) {
    const { PilotSwarmClient, PilotSwarmWorker } = await import("../../dist/index.js");

    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "test-orch-reject",
        disableManagementAgents: true,
        pluginDirs: [POLICY_PLUGIN],
    });
    await worker.start();

    const rogueClient = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await rogueClient.start();

    try {
        const session = await rogueClient.createSession({
            systemMessage: { mode: "replace", content: "Hello" },
        });

        let response;
        try {
            response = await session.sendAndWait("Say hi", TIMEOUT);
        } catch (err) {
            response = err.message;
        }

        const catalog = await import("../../dist/index.js").then(m => m.PgSessionCatalogProvider);
        const cat = await catalog.create(env.store, env.cmsSchema);
        await cat.initialize();
        try {
            const row = await cat.getSession(session.sessionId);
            console.log(`  CMS state: ${row?.state}, title: ${row?.title}`);
            assertEqual(row?.state, "rejected", "CMS state is rejected");
        } finally {
            await cat.close();
        }
    } finally {
        await rogueClient.stop();
        await worker.stop();
    }
}

describe.concurrent("Level 10a: Session Policy — Guards", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Agent Namespacing", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testAgentNamespacing(env); } finally { await env.cleanup(); }
    });
    it("List Agents Omits System", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testListAgentsOmitsSystem(env); } finally { await env.cleanup(); }
    });
    it("Client Rejects Generic When Disallowed", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testClientRejectsGeneric(env); } finally { await env.cleanup(); }
    });
    it("Client Allows Named Agent", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testClientAllowsNamedAgent(env); } finally { await env.cleanup(); }
    });
    it("Client Rejects Unknown Agent", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testClientRejectsUnknown(env); } finally { await env.cleanup(); }
    });
    it("Client Rejects System Agent", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testClientRejectsSystemAgent(env); } finally { await env.cleanup(); }
    });
    it("Orch Rejects Generic When Disallowed", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testOrchRejectsGeneric(env); } finally { await env.cleanup(); }
    });
    it("Deletion Protects System Sessions", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testDeletionProtectsSystem(env); } finally { await env.cleanup(); }
    });
});
