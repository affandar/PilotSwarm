/**
 * System agent lifecycle tests.
 *
 * Purpose: verify that the worker bootstraps the PilotSwarm management
 * system sessions directly on worker start, including the permanent child
 * agents under PilotSwarm, with correct titles, splash screens, and parent
 * links in CMS.
 *
 * These tests explicitly enable management agents (most other suites
 * disable them for speed).
 *
 * Cases covered:
 *   - pilotswarm root system agent is created on worker start
 *   - worker bootstraps pilotswarm child system agents directly
 *   - child sessions have correct titles
 *   - child sessions have splash banners in CMS
 *   - child sessions are marked isSystem with correct agentId
 *   - parent-child CMS links are correct
 *
 * Run: node --env-file=../../.env test/local/system-agents.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { PilotSwarmWorker, PilotSwarmClient } from "../helpers/local-workers.js";
import {
    assert,
    assertEqual,
    assertNotNull,
    assertGreaterOrEqual,
    assertIncludes,
} from "../helpers/assertions.js";
import {
    createCatalog,
    waitForSessionState,
    validateSessionAfterTurn,
} from "../helpers/cms-helpers.js";
import { systemAgentUUID, systemChildAgentUUID } from "../../src/index.ts";

const TIMEOUT = 180_000; // System agent flows need time for LLM tool calls

/**
 * Start a worker with management agents enabled.
 * Returns the worker — caller is responsible for stopping it.
 */
function createWorkerWithSystemAgents(env, nodeId = "test-sysagent") {
    return new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: nodeId,
        disableManagementAgents: false,
    });
}

// ─── Test: Pilotswarm Root Agent Created ─────────────────────────

async function testPilotswarmRootCreated(env) {
    const catalog = await createCatalog(env);
    const worker = createWorkerWithSystemAgents(env);
    await worker.start();

    try {
        const pilotswarmId = systemAgentUUID("pilotswarm");
        console.log(`  Expected pilotswarm session: ${pilotswarmId.slice(0, 8)}`);

        // Wait for the pilotswarm session to appear in CMS
        const row = await waitForSessionState(catalog, pilotswarmId, ["running", "idle"], 60_000);
        assertNotNull(row, "Pilotswarm session should exist");
        console.log(`  State: ${row.state}, isSystem: ${row.isSystem}, agentId: ${row.agentId}`);

        assertEqual(row.isSystem, true, "pilotswarm should be a system session");
        assertEqual(row.agentId, "pilotswarm", "agentId should be 'pilotswarm'");
        assertEqual(row.title, "PilotSwarm Agent", "title should be 'PilotSwarm Agent'");

        // Splash should be present
        assertNotNull(row.splash, "pilotswarm should have a splash banner");
        assertIncludes(row.splash, "Cluster Orchestrator", "splash should contain 'Cluster Orchestrator'");

        ("Pilotswarm Root Agent Created");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}

const EXPECTED_CHILD_AGENT_IDS = ["sweeper", "resourcemgr", "facts-manager", "agent-tuner"];

// ─── Test: Child System Agents Spawned ───────────────────────────

async function testChildAgentsSpawned(env) {
    const catalog = await createCatalog(env);
    const worker = createWorkerWithSystemAgents(env);
    await worker.start();

    try {
        const pilotswarmId = systemAgentUUID("pilotswarm");

        // Wait for pilotswarm to be running
        await waitForSessionState(catalog, pilotswarmId, ["running", "idle"], 60_000);

        // Child system agents are worker-bootstrapped directly.
        console.log("  Waiting for child system agents to be bootstrapped...");

        let children = [];
        const deadline = Date.now() + TIMEOUT;

        while (Date.now() < deadline) {
            const allSessions = await catalog.listSessions();
            children = allSessions.filter(
                s => s.parentSessionId === pilotswarmId && s.isSystem,
            );
            if (children.length >= EXPECTED_CHILD_AGENT_IDS.length) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        console.log(`  Child system agents found: ${children.length}`);
        for (const c of children) {
            console.log(`    - ${c.agentId} | title="${c.title}" | state=${c.state}`);
        }

        assertGreaterOrEqual(children.length, EXPECTED_CHILD_AGENT_IDS.length, "Expected all permanent system children");

        // Verify all expected agents are present
        const agentIds = children.map(c => c.agentId);
        for (const agentId of EXPECTED_CHILD_AGENT_IDS) {
            assert(agentIds.includes(agentId), `Missing ${agentId} child agent`);
        }

        for (const child of children.filter(c => c.agentId)) {
            const expectedSessionId = systemChildAgentUUID(pilotswarmId, child.agentId);
            assertEqual(child.sessionId, expectedSessionId, `${child.agentId} deterministic child session id`);
        }

        ("Child System Agents Spawned");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}

// ─── Test: Child Agent Titles ────────────────────────────────────

async function testChildAgentTitles(env) {
    const catalog = await createCatalog(env);
    const worker = createWorkerWithSystemAgents(env);
    await worker.start();

    try {
        const pilotswarmId = systemAgentUUID("pilotswarm");
        await waitForSessionState(catalog, pilotswarmId, ["running", "idle"], 60_000);

        // Wait for children
        let children = [];
        const deadline = Date.now() + TIMEOUT;
        while (Date.now() < deadline) {
            const allSessions = await catalog.listSessions();
            children = allSessions.filter(
                s => s.parentSessionId === pilotswarmId && s.isSystem,
            );
            if (children.length >= EXPECTED_CHILD_AGENT_IDS.length) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, EXPECTED_CHILD_AGENT_IDS.length, "Expected all permanent system children");

        const sweeper = children.find(c => c.agentId === "sweeper");
        const resourcemgr = children.find(c => c.agentId === "resourcemgr");
        const factsManager = children.find(c => c.agentId === "facts-manager");

        assertNotNull(sweeper, "Sweeper child should exist");
        assertNotNull(resourcemgr, "Resource Manager child should exist");
        assertNotNull(factsManager, "Facts Manager child should exist");

        // Title: set in the agent .md frontmatter
        assertEqual(sweeper.title, "Sweeper Agent", "Sweeper title");
        assertEqual(resourcemgr.title, "Resource Manager Agent", "Resource Manager title");
        assertEqual(factsManager.title, "Facts Manager", "Facts Manager title");

        console.log(`  ✓ Sweeper title: "${sweeper.title}"`);
        console.log(`  ✓ Resource Manager title: "${resourcemgr.title}"`);
        console.log(`  ✓ Facts Manager title: "${factsManager.title}"`);

        ("Child Agent Titles");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}

// ─── Test: Child Agent Splash Screens ────────────────────────────

async function testChildAgentSplash(env) {
    const catalog = await createCatalog(env);
    const worker = createWorkerWithSystemAgents(env);
    await worker.start();

    try {
        const pilotswarmId = systemAgentUUID("pilotswarm");
        await waitForSessionState(catalog, pilotswarmId, ["running", "idle"], 60_000);

        // Wait for children
        let children = [];
        const deadline = Date.now() + TIMEOUT;
        while (Date.now() < deadline) {
            const allSessions = await catalog.listSessions();
            children = allSessions.filter(
                s => s.parentSessionId === pilotswarmId && s.isSystem,
            );
            if (children.length >= EXPECTED_CHILD_AGENT_IDS.length) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, EXPECTED_CHILD_AGENT_IDS.length, "Expected all permanent system children");

        const sweeper = children.find(c => c.agentId === "sweeper");
        const resourcemgr = children.find(c => c.agentId === "resourcemgr");
        const factsManager = children.find(c => c.agentId === "facts-manager");

        assertNotNull(sweeper, "Sweeper child should exist");
        assertNotNull(resourcemgr, "Resource Manager child should exist");
        assertNotNull(factsManager, "Facts Manager child should exist");

        // Splash banners should be present and contain identifying text
        assertNotNull(sweeper.splash, "Sweeper should have a splash banner");
        assertIncludes(sweeper.splash, "System Maintenance Agent", "Sweeper splash should contain 'System Maintenance Agent'");

        assertNotNull(resourcemgr.splash, "Resource Manager should have a splash banner");
        assertIncludes(resourcemgr.splash, "Resource Manager", "ResourceManager splash should contain 'Resource Manager'");
        assertNotNull(factsManager.splash, "Facts Manager should have a splash banner");
        assertIncludes(factsManager.splash, "Knowledge Curator", "Facts Manager splash should contain 'Knowledge Curator'");

        console.log(`  ✓ Sweeper splash: ${sweeper.splash.split("\n").length} lines`);
        console.log(`  ✓ ResourceManager splash: ${resourcemgr.splash.split("\n").length} lines`);
        console.log(`  ✓ FactsManager splash: ${factsManager.splash.split("\n").length} lines`);

        ("Child Agent Splash Screens");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}

// ─── Test: Child Agent CMS Metadata ──────────────────────────────

async function testChildAgentCmsMetadata(env) {
    const catalog = await createCatalog(env);
    const worker = createWorkerWithSystemAgents(env);
    await worker.start();

    try {
        const pilotswarmId = systemAgentUUID("pilotswarm");
        await waitForSessionState(catalog, pilotswarmId, ["running", "idle"], 60_000);

        // Wait for children
        let children = [];
        const deadline = Date.now() + TIMEOUT;
        while (Date.now() < deadline) {
            const allSessions = await catalog.listSessions();
            children = allSessions.filter(
                s => s.parentSessionId === pilotswarmId && s.isSystem,
            );
            if (children.length >= EXPECTED_CHILD_AGENT_IDS.length) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, EXPECTED_CHILD_AGENT_IDS.length, "Expected all permanent system children");

        for (const child of children) {
            console.log(`  Checking ${child.agentId}...`);

            // isSystem flag
            assertEqual(child.isSystem, true, `${child.agentId} should be system`);

            // Parent link
            assertEqual(
                child.parentSessionId,
                pilotswarmId,
                `${child.agentId} parentSessionId should be pilotswarm`,
            );

            // agentId is set
            assertNotNull(child.agentId, `${child.agentId} agentId should be set`);

            // orchestrationId link
            assertNotNull(child.orchestrationId, `${child.agentId} should have orchestrationId`);

            console.log(`    isSystem=${child.isSystem}, parent=${child.parentSessionId?.slice(0, 8)}, agentId=${child.agentId}`);
        }

        // Validate duroxide + CMS integrity for parent
        await validateSessionAfterTurn(env, pilotswarmId, {
            expectedCmsStates: ["running", "idle", "waiting"],
            minIteration: 1,
            requiredEventTypes: ["session.turn_started"],
            expectResponse: false,
        });

        ("Child Agent CMS Metadata");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}

// ─── Test: Parent-Child Descendant Links ─────────────────────────

async function testDescendantLinks(env) {
    const catalog = await createCatalog(env);
    const worker = createWorkerWithSystemAgents(env);
    await worker.start();

    try {
        const pilotswarmId = systemAgentUUID("pilotswarm");
        await waitForSessionState(catalog, pilotswarmId, ["running", "idle"], 60_000);

        // Wait for children
        let children = [];
        const deadline = Date.now() + TIMEOUT;
        while (Date.now() < deadline) {
            const allSessions = await catalog.listSessions();
            children = allSessions.filter(
                s => s.parentSessionId === pilotswarmId && s.isSystem,
            );
            if (children.length >= EXPECTED_CHILD_AGENT_IDS.length) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, EXPECTED_CHILD_AGENT_IDS.length, "Expected all permanent system children");

        // getDescendantSessionIds should return both children
        const descendants = await catalog.getDescendantSessionIds(pilotswarmId);
        console.log(`  Descendants of pilotswarm: ${descendants.length}`);

        for (const child of children) {
            assert(
                descendants.includes(child.sessionId),
                `${child.agentId} (${child.sessionId.slice(0, 8)}) should be in descendants`,
            );
        }

        ("Parent-Child Descendant Links");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}


// ─── Runner ──────────────────────────────────────────────────────

describe("System Agent Lifecycle Tests", () => {
    let env;
    beforeAll(async () => {
        await preflightChecks();
        env = createTestEnv("system-agents");
    });
    afterAll(async () => { await env?.cleanup(); });

    it("Pilotswarm Root Agent Created", { timeout: TIMEOUT }, async () => {
        await testPilotswarmRootCreated(env);
    });
    it("Child System Agents Spawned", { timeout: TIMEOUT }, async () => {
        await testChildAgentsSpawned(env);
    });
    it("Child Agent Titles", { timeout: TIMEOUT }, async () => {
        await testChildAgentTitles(env);
    });
    it("Child Agent Splash Screens", { timeout: TIMEOUT }, async () => {
        await testChildAgentSplash(env);
    });
    it("Child Agent CMS Metadata", { timeout: TIMEOUT }, async () => {
        await testChildAgentCmsMetadata(env);
    });
    it("Parent-Child Descendant Links", { timeout: TIMEOUT }, async () => {
        await testDescendantLinks(env);
    });
});
