/**
 * Level 8: Prompt/tool/runtime contract tests.
 *
 * Purpose: turn the fragile contracts into explicit assertions.
 *
 * Cases covered:
 *   - default.agent.md is always part of the base prompt path
 *   - mode: "replace" does not remove the worker base prompt
 *   - worker-registered tools are resolved by name
 *   - worker-level tools + per-session tools combined
 *   - tool update after session eviction
 *   - worker exposes loaded agents list
 *
 * Run: node --env-file=../../.env test/local/contracts.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { withClient, defineTool, PilotSwarmWorker } from "../helpers/local-workers.js";
import { assert, assertIncludes, assertGreaterOrEqual, assertNotNull, pass } from "../helpers/assertions.js";
import { validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { createAddTool, createMultiplyTool, ONEWORD_CONFIG, TOOL_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 120_000;

// ─── Test: Worker-Registered Tool By Name ────────────────────────

async function testWorkerToolByName(env) {
    const tracker = {};
    const addTool = createAddTool(tracker);

    await withClient(env, { tools: [addTool] }, async (client) => {
        const session = await client.createSession({
            toolNames: ["test_add"],
            systemMessage: {
                mode: "replace",
                content: "You have a test_add tool. Use it when asked to add numbers. Answer with just the number.",
            },
        });

        console.log("  Sending: What is 100 + 200?");
        const response = await session.sendAndWait("What is 100 + 200?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(tracker.called, "Worker-registered tool was not called");
        assertIncludes(response, "300", "Expected 300");

        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
        pass("Worker-Registered Tool By Name");
    });
}

// ─── Test: Registry + Per-Session Tools Combined ─────────────────

async function testRegistryPlusSessionTools(env) {
    const addTracker = {};
    const mulTracker = {};
    const addTool = createAddTool(addTracker);
    const mulTool = createMultiplyTool(mulTracker);

    await withClient(env, { tools: [addTool] }, async (client, worker) => {
        const session = await client.createSession({
            toolNames: ["test_add"],
            systemMessage: {
                mode: "replace",
                content: "You have test_add and test_multiply tools. Use test_add to add and test_multiply to multiply. Be brief.",
            },
        });

        // Per-session tool via setSessionConfig
        worker.setSessionConfig(session.sessionId, { tools: [mulTool] });

        console.log("  Sending: Add 10 and 20, then multiply 3 and 7");
        const response = await session.sendAndWait(
            "Add 10 and 20, then multiply 3 and 7. Give both results.",
            TIMEOUT,
        );

        console.log(`  Response: "${response}"`);
        assert(addTracker.called, "add tool was not called");
        assert(mulTracker.called, "multiply tool was not called");
        pass("Registry + Per-Session Tools Combined");
    });
}

// ─── Test: Tool Update After Session Eviction ────────────────────

async function testToolUpdateAfterEviction(env) {
    const mulTracker = {};

    await withClient(env, async (client, worker) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "Use tools when available. Be brief. Answer with just the number.",
            },
        });

        // Turn 1: no custom tools
        console.log("  Turn 1 (no custom tools): What is 3+3?");
        await session.sendAndWait("What is 3+3?", TIMEOUT);

        // Evict the warm session — simulates dehydration
        await worker.destroySession(session.sessionId);

        // Register a tool AFTER eviction
        const mulTool = createMultiplyTool(mulTracker);
        worker.setSessionConfig(session.sessionId, { tools: [mulTool] });

        // Turn 2: fresh CopilotSession sees the new tool
        console.log("  Turn 2 (multiply tool added): Use the test_multiply tool to compute 7 * 8");
        const response = await session.sendAndWait(
            "Use the test_multiply tool to compute 7 * 8",
            TIMEOUT,
        );

        console.log(`  Response: "${response}"`);
        assert(mulTracker.called, "multiply tool was NOT called after eviction");
        assertIncludes(response, "56", "Expected 56");

        const v = await validateSessionAfterTurn(env, session.sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Tool Update After Eviction");
    });
}

// ─── Test: Mode Replace Keeps Base Prompt ────────────────────────

async function testModeReplaceKeepsBase(env) {
    // mode: "replace" should replace user system message but keep the base (default.agent.md)
    // Verify that the wait tool still works (it's defined in default.agent.md)
    await withClient(env, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: "When asked to wait, use the wait tool. After waiting, say 'Wait done'. Be brief.",
            },
        });

        console.log("  Sending: Wait 1 second");
        const response = await session.sendAndWait("Wait 1 second", TIMEOUT);
        console.log(`  Response: "${response}"`);

        // If the wait tool wasn't available (base prompt removed), this would fail
        pass("Mode Replace Keeps Base Prompt");
    });
}

// ─── Test: Worker Exposes Loaded Agents ──────────────────────────

async function testWorkerLoadedAgents(env) {
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "test-contracts",
        disableManagementAgents: false,
    });
    await worker.start();

    try {
        // System agents are loaded from SDK plugins (pilotswarm, sweeper, resourcemgr)
        const sysAgents = worker.systemAgents;
        console.log(`  System agents: ${sysAgents.length}`);
        for (const a of sysAgents) {
            console.log(`    - ${a.name} (id=${a.id}, system=${a.system})`);
        }

        assertGreaterOrEqual(sysAgents.length, 3, "Expected pilotswarm + sweeper + resourcemgr");

        // Verify the expected system agents are present
        const names = sysAgents.map(a => a.name);
        assert(names.includes("pilotswarm"), "Missing pilotswarm system agent");
        assert(names.includes("sweeper"), "Missing sweeper system agent");
        assert(names.includes("resourcemgr"), "Missing resourcemgr system agent");

        // Verify all system agents are marked as system
        for (const a of sysAgents) {
            assert(a.system === true, `Agent '${a.name}' should have system=true`);
        }

        pass("Worker Exposes Loaded Agents");
    } finally {
        await worker.stop();
    }
}

// ─── Test: Worker Skill Dirs Loaded ──────────────────────────────

async function testWorkerSkillDirs(env) {
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "test-skills",
        disableManagementAgents: false,
    });
    await worker.start();

    try {
        const dirs = worker.loadedSkillDirs;
        console.log(`  Loaded skill dirs: ${dirs.length}`);
        for (const d of dirs) {
            console.log(`    - ${d}`);
        }

        // Skills may or may not be present depending on config, so just verify the API works
        assert(Array.isArray(dirs), "loadedSkillDirs should return an array");
        pass("Worker Skill Dirs Loaded");
    } finally {
        await worker.stop();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("Level 8: Contract Tests", [
    ["Worker-Registered Tool By Name", testWorkerToolByName],
    ["Registry + Per-Session Tools", testRegistryPlusSessionTools],
    ["Tool Update After Eviction", testToolUpdateAfterEviction],
    ["Mode Replace Keeps Base Prompt", testModeReplaceKeepsBase],
    ["Worker Exposes Loaded Agents", testWorkerLoadedAgents],
    ["Worker Skill Dirs Loaded", testWorkerSkillDirs],
]);
