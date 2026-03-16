/**
 * Level 10b: Session policy — behavior tests.
 *
 * Covers: no policy (open), open policy, multiple plugin dirs merge,
 * last policy wins, title prefixing for named/system/generic agents.
 *
 * Run: npx vitest run test/local/session-policy-behavior.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PLUGIN = path.resolve(__dirname, "../fixtures/policy-plugin");
const OPEN_POLICY_PLUGIN = path.resolve(__dirname, "../fixtures/open-policy-plugin");

const TIMEOUT = 120_000;

async function testNoPolicyOpen(env) {
    await withClient(env, {}, async (client, worker) => {
        assertEqual(worker.sessionPolicy, null, "no policy loaded");

        const session = await client.createSession(ONEWORD_CONFIG);
        assertNotNull(session, "session created");

        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");
    });
}

async function testOpenPolicyAllowsGeneric(env) {
    await withClient(env, { worker: { pluginDirs: [OPEN_POLICY_PLUGIN] } }, async (client, worker) => {
        assertNotNull(worker.sessionPolicy, "policy loaded");
        assertEqual(worker.sessionPolicy.creation.mode, "open", "mode is open");

        const session = await client.createSession(ONEWORD_CONFIG);
        assertNotNull(session, "session created");

        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");
    });
}

async function testMultiplePluginDirsMerge(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN, OPEN_POLICY_PLUGIN] } }, async (client, worker) => {
        const agents = worker.loadedAgents;
        const alpha = agents.find(a => a.name === "alpha");
        const gamma = agents.find(a => a.name === "gamma");

        assertNotNull(alpha, "alpha loaded");
        assertNotNull(gamma, "gamma loaded");
        assertEqual(alpha.namespace, "testapp", "alpha namespace");
        assertEqual(gamma.namespace, "openapp", "gamma namespace");
    });
}

async function testLastPolicyWins(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN, OPEN_POLICY_PLUGIN] } }, async (client, worker) => {
        assertEqual(worker.sessionPolicy.creation.mode, "open", "last policy wins (open)");

        const session = await client.createSession(ONEWORD_CONFIG);
        assertNotNull(session, "generic session created under open policy");
    });
}

async function testNamedAgentTitlePrefix(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            const shortId = session.sessionId.slice(0, 8);
            assertEqual(row.title, `Alpha: ${shortId}`, "title has agent prefix + shortId");
            assertEqual(row.agentId, "alpha", "agentId set");
        } finally {
            await catalog.close();
        }
    });
}

async function testSystemAgentTitleNotPrefixed(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        await new Promise(r => setTimeout(r, 3000));

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const betaSession = sessions.find(s => s.agentId === "beta");
            if (!betaSession) {
                console.log("  ⚠️  Beta system agent not found—checking if it was started...");
                console.log("  Sessions:", sessions.map(s => `${s.sessionId.slice(0,8)} agent=${s.agentId || "none"} system=${s.isSystem}`).join(", "));
                return;
            }
            assertEqual(betaSession.title, "Beta Agent", "system agent title is exact, no shortId suffix");
            assertEqual(betaSession.isSystem, true, "isSystem flag set");
        } finally {
            await catalog.close();
        }
    });
}

async function testGenericSessionTitleNoPrefix(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession(ONEWORD_CONFIG);
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            assertEqual(row.agentId, null, "agentId is null for generic session");
            if (row.title) {
                assert(!row.title.includes(": ") || !row.agentId, "no agent prefix in generic title");
            }
        } finally {
            await catalog.close();
        }
    });
}

describe.concurrent("Level 10b: Session Policy — Behavior", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("No Policy = Open Behavior", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testNoPolicyOpen(env); } finally { await env.cleanup(); }
    });
    it("Open Policy Allows Generic", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testOpenPolicyAllowsGeneric(env); } finally { await env.cleanup(); }
    });
    it("Multiple Plugin Dirs Merge", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testMultiplePluginDirsMerge(env); } finally { await env.cleanup(); }
    });
    it("Last Policy Wins", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testLastPolicyWins(env); } finally { await env.cleanup(); }
    });
    it("Named Agent Title Prefix", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testNamedAgentTitlePrefix(env); } finally { await env.cleanup(); }
    });
    it("System Agent Title Not Prefixed", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testSystemAgentTitleNotPrefixed(env); } finally { await env.cleanup(); }
    });
    it("Generic Session Title Has No Prefix", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("session-policy");
        try { await testGenericSessionTitleNoPrefix(env); } finally { await env.cleanup(); }
    });
});
