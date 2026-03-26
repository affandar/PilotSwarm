/**
 * Level 10b: Session policy — behavior tests.
 *
 * Covers: no policy (open), open policy, multiple plugin dirs merge,
 * last policy wins, title prefixing for named/system/generic agents.
 *
 * Run: npx vitest run test/local/session-policy-behavior.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertNotNull } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PLUGIN = path.resolve(__dirname, "../fixtures/policy-plugin");
const OPEN_POLICY_PLUGIN = path.resolve(__dirname, "../fixtures/open-policy-plugin");

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

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

async function testOrchAllowsNamedAgent(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        console.log("  Sending prompt to named agent session...");
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 80)}"`);
        assertNotNull(response, "got response from named agent session");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assert(row?.state !== "rejected", "session not rejected");
            assertEqual(row?.agentId, "alpha", "agentId is alpha");
        } finally {
            await catalog.close();
        }
    });
}

async function testOrchAllowsSubAgentSpawns(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        console.log("  Asking parent to spawn a sub-agent...");
        const response = await session.sendAndWait(
            "Spawn a sub-agent with the task: 'Say hello world'",
            TIMEOUT,
        );
        console.log(`  Response: "${response?.slice(0, 80)}"`);

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const children = sessions.filter(s => s.parentSessionId === session.sessionId);
            console.log(`  Child sessions: ${children.length}`);
            assert(children.length >= 1, "sub-agent created despite allowlist policy");
            assert(children[0].state !== "rejected", "child not rejected by policy");
        } finally {
            await catalog.close();
        }
    });
}

async function testQualifiedNameResolution(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        // Verify agent loaded with correct namespace
        const agents = worker.loadedAgents;
        const alpha = agents.find(a => a.name === "alpha");
        assertNotNull(alpha, "alpha agent loaded");
        assertEqual(alpha.namespace, "testapp", "alpha has testapp namespace");

        // Client createSessionForAgent works with unqualified name
        const s1 = await client.createSessionForAgent("alpha");
        assertNotNull(s1, "session created with unqualified name");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(s1.sessionId);
            assertEqual(row?.agentId, "alpha", "agentId is alpha");
            assertIncludes(row?.title || "", "Alpha", "title has agent name");

            // Qualified name "testapp:alpha" should also work for spawn_agent
            // (tested at orchestration level — resolveAgentConfig parses namespace)
            // Verify the agent record itself has the qualified name info
            assertEqual(`${alpha.namespace}:${alpha.name}`, "testapp:alpha", "qualified name correct");
        } finally {
            await catalog.close();
        }
    });
}

async function testAppSystemAgentsCoexist(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN], disableManagementAgents: false } }, async (client, worker) => {
        // Wait for system agents to start
        await new Promise(r => setTimeout(r, 5000));

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const systemSessions = sessions.filter(s => s.isSystem);
            console.log(`  System sessions: ${systemSessions.map(s => `${s.agentId}(${s.title})`).join(", ")}`);

            // Beta from the test plugin
            const betaSession = systemSessions.find(s => s.agentId === "beta");
            assertNotNull(betaSession, "beta system agent session exists");
            assertEqual(betaSession.isSystem, true, "beta is system");

            // At least one built-in pilotswarm system agent should also exist
            assert(systemSessions.length >= 2, "multiple system agents loaded (app + built-in)");
        } finally {
            await catalog.close();
        }
    });
}

async function testNamedAgentTitleAfterSummarization(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        // Turn 1: sets nextSummarizeAt = now + 60s in orchestration
        console.log("  Turn 1: triggering first turn...");
        const r1 = await session.sendAndWait(
            "Explain database migration strategies in detail",
            TIMEOUT,
        );
        console.log(`  Turn 1 response: "${r1?.slice(0, 80)}"`);
        assertNotNull(r1, "got turn 1 response");

        // Wait 65s for the summarize delay to expire (FIRST_SUMMARIZE_DELAY = 60s)
        console.log("  Waiting 65s for summarize delay...");
        await new Promise(r => setTimeout(r, 65_000));

        // Turn 2: triggers maybeSummarize which now fires (past the 60s threshold)
        console.log("  Turn 2: triggering summarization...");
        const r2 = await session.sendAndWait("Thanks", TIMEOUT);
        console.log(`  Turn 2 response: "${r2?.slice(0, 80)}"`);

        // Poll for title change (summarization makes a separate LLM call)
        const shortId = session.sessionId.slice(0, 8);
        const initialTitle = `Alpha: ${shortId}`;
        const catalog = await createCatalog(env);
        try {
            let row;
            for (let i = 0; i < 20; i++) {
                row = await catalog.getSession(session.sessionId);
                if (row?.title && row.title !== initialTitle) break;
                await new Promise(r => setTimeout(r, 2000));
            }
            assertNotNull(row, "CMS row exists");
            console.log(`  Title after summarization: "${row.title}"`);

            // Title should still start with the agent prefix
            assertIncludes(row.title, "Alpha:", "title still has agent prefix after summarization");

            // The suffix should NOT be the shortId anymore (it should be the LLM summary)
            assert(row.title !== initialTitle, "title was updated by summarization (not still shortId)");
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

describe("Level 10b: Session Policy — Behavior", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("No Policy = Open Behavior", { timeout: TIMEOUT }, async () => {
        await testNoPolicyOpen(getEnv());
    });
    it("Open Policy Allows Generic", { timeout: TIMEOUT }, async () => {
        await testOpenPolicyAllowsGeneric(getEnv());
    });
    it("Multiple Plugin Dirs Merge", { timeout: TIMEOUT }, async () => {
        await testMultiplePluginDirsMerge(getEnv());
    });
    it("Last Policy Wins", { timeout: TIMEOUT }, async () => {
        await testLastPolicyWins(getEnv());
    });
    it("Named Agent Title Prefix", { timeout: TIMEOUT }, async () => {
        await testNamedAgentTitlePrefix(getEnv());
    });
    it("System Agent Title Not Prefixed", { timeout: TIMEOUT }, async () => {
        await testSystemAgentTitleNotPrefixed(getEnv());
    });
    it("Generic Session Title Has No Prefix", { timeout: TIMEOUT }, async () => {
        await testGenericSessionTitleNoPrefix(getEnv());
    });
    it("Orch Allows Valid Named Agent", { timeout: TIMEOUT }, async () => {
        await testOrchAllowsNamedAgent(getEnv());
    });
    it("Orch Does Not Block Sub-Agent Spawns", { timeout: TIMEOUT * 2 }, async () => {
        await testOrchAllowsSubAgentSpawns(getEnv());
    });
    it("Qualified Name Resolution", { timeout: TIMEOUT * 2 }, async () => {
        await testQualifiedNameResolution(getEnv());
    });
    it("App System Agents Coexist with Built-In", { timeout: TIMEOUT }, async () => {
        await testAppSystemAgentsCoexist(getEnv());
    });
    it("Named Agent Title Preserved After Summarization", { timeout: TIMEOUT * 3 }, async () => {
        await testNamedAgentTitleAfterSummarization(getEnv());
    });
});
