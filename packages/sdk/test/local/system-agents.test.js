/**
 * System agent lifecycle tests.
 *
 * Purpose: verify that the PilotSwarm management agent auto-starts on
 * worker boot and spawns its two child system agents (Sweeper and Resource
 * Manager) via tool calls, with correct titles and splash screens in CMS.
 *
 * These tests explicitly enable management agents (most other suites
 * disable them for speed).
 *
 * Cases covered:
 *   - pilotswarm root system agent is created on worker start
 *   - pilotswarm agent spawns sweeper and resourcemgr children
 *   - child sessions have correct titles
 *   - child sessions have splash banners in CMS
 *   - child sessions are marked isSystem with correct agentId
 *   - parent-child CMS links are correct
 *
 * Run: node --env-file=../../.env test/local/system-agents.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { PilotSwarmWorker, PilotSwarmClient } from "../helpers/local-workers.js";
import {
    assert,
    assertEqual,
    assertNotNull,
    assertGreaterOrEqual,
    assertIncludes,
    pass,
} from "../helpers/assertions.js";
import {
    createCatalog,
    waitForSessionState,
    validateSessionAfterTurn,
} from "../helpers/cms-helpers.js";
import { systemAgentUUID } from "../../dist/index.js";

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

        pass("Pilotswarm Root Agent Created");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}

// ─── Test: Child System Agents Spawned ───────────────────────────

async function testChildAgentsSpawned(env) {
    const catalog = await createCatalog(env);
    const worker = createWorkerWithSystemAgents(env);
    await worker.start();

    try {
        const pilotswarmId = systemAgentUUID("pilotswarm");

        // Wait for pilotswarm to be running
        await waitForSessionState(catalog, pilotswarmId, ["running", "idle"], 60_000);

        // The pilotswarm agent's initial prompt tells it to spawn sweeper and
        // resourcemgr via tool calls. Wait for children to appear in CMS.
        console.log("  Waiting for child system agents to be spawned...");

        let children = [];
        const deadline = Date.now() + TIMEOUT;

        while (Date.now() < deadline) {
            const allSessions = await catalog.listSessions();
            children = allSessions.filter(
                s => s.parentSessionId === pilotswarmId && s.isSystem,
            );
            if (children.length >= 2) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        console.log(`  Child system agents found: ${children.length}`);
        for (const c of children) {
            console.log(`    - ${c.agentId} | title="${c.title}" | state=${c.state}`);
        }

        assertGreaterOrEqual(children.length, 2, "Expected sweeper + resourcemgr children");

        // Verify both expected agents are present
        const agentIds = children.map(c => c.agentId);
        assert(agentIds.includes("sweeper"), "Missing sweeper child agent");
        assert(agentIds.includes("resourcemgr"), "Missing resourcemgr child agent");

        pass("Child System Agents Spawned");
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
            if (children.length >= 2) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, 2, "Expected 2 children");

        const sweeper = children.find(c => c.agentId === "sweeper");
        const resourcemgr = children.find(c => c.agentId === "resourcemgr");

        assertNotNull(sweeper, "Sweeper child should exist");
        assertNotNull(resourcemgr, "Resource Manager child should exist");

        // Title: set in the agent .md frontmatter
        assertEqual(sweeper.title, "Sweeper Agent", "Sweeper title");
        assertEqual(resourcemgr.title, "Resource Manager Agent", "Resource Manager title");

        console.log(`  ✓ Sweeper title: "${sweeper.title}"`);
        console.log(`  ✓ Resource Manager title: "${resourcemgr.title}"`);

        pass("Child Agent Titles");
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
            if (children.length >= 2) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, 2, "Expected 2 children");

        const sweeper = children.find(c => c.agentId === "sweeper");
        const resourcemgr = children.find(c => c.agentId === "resourcemgr");

        assertNotNull(sweeper, "Sweeper child should exist");
        assertNotNull(resourcemgr, "Resource Manager child should exist");

        // Splash banners should be present and contain identifying text
        assertNotNull(sweeper.splash, "Sweeper should have a splash banner");
        assertIncludes(sweeper.splash, "System Maintenance Agent", "Sweeper splash should contain 'System Maintenance Agent'");

        assertNotNull(resourcemgr.splash, "Resource Manager should have a splash banner");
        assertIncludes(resourcemgr.splash, "Resource Manager", "ResourceManager splash should contain 'Resource Manager'");

        console.log(`  ✓ Sweeper splash: ${sweeper.splash.split("\n").length} lines`);
        console.log(`  ✓ ResourceManager splash: ${resourcemgr.splash.split("\n").length} lines`);

        pass("Child Agent Splash Screens");
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
            if (children.length >= 2) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, 2, "Expected 2 children");

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
            expectResponse: false,
        });

        pass("Child Agent CMS Metadata");
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
            if (children.length >= 2) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        assertGreaterOrEqual(children.length, 2, "Expected 2 children");

        // getDescendantSessionIds should return both children
        const descendants = await catalog.getDescendantSessionIds(pilotswarmId);
        console.log(`  Descendants of pilotswarm: ${descendants.length}`);

        for (const child of children) {
            assert(
                descendants.includes(child.sessionId),
                `${child.agentId} (${child.sessionId.slice(0, 8)}) should be in descendants`,
            );
        }

        pass("Parent-Child Descendant Links");
    } finally {
        await worker.stop();
        await catalog.close();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("System Agent Lifecycle Tests", [
    ["Pilotswarm Root Agent Created", testPilotswarmRootCreated],
    ["Child System Agents Spawned", testChildAgentsSpawned],
    ["Child Agent Titles", testChildAgentTitles],
    ["Child Agent Splash Screens", testChildAgentSplash],
    ["Child Agent CMS Metadata", testChildAgentCmsMetadata],
    ["Parent-Child Descendant Links", testDescendantLinks],
], { sharedEnv: true });
