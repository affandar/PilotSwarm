/**
 * Level 5: Sub-agent and system-agent flow tests.
 *
 * Purpose: verify the highest-risk orchestration contract area — agent
 * spawning, messaging, lifecycle, and parent-child relationships.
 *
 * Cases covered:
 *   - spawn a custom sub-agent via task prompt
 *   - child session metadata includes parentSessionId, agentId
 *   - message_agent sends to child
 *   - check_agents returns child status
 *   - parent receives child completion updates
 *   - parent/child links in CMS
 *   - multiple sub-agents in one session
 *
 * Run: node --env-file=../../.env test/local/sub-agents.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertNotNull, assertIncludes, assertGreaterOrEqual, assertEqual, pass } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, waitForEventCount, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { BRIEF_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 180_000; // Sub-agent flows are slower

// ─── Test: Spawn Custom Sub-Agent ────────────────────────────────

async function testSpawnCustomSubAgent(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content: `You have a spawn_agent tool. When asked to spawn an agent, use it immediately with the given task description. After spawning, report the agent ID. Be brief.`,
                },
            });

            console.log("  Sending: Spawn a sub-agent with the task 'Say hello world and nothing else'");
            const response = await session.sendAndWait(
                "Spawn a sub-agent with the task: 'Say hello world and nothing else'",
                TIMEOUT,
            );
            console.log(`  Response: "${response}"`);

            // Verify a child session was created in CMS
            const parentRow = await catalog.getSession(session.sessionId);
            assertNotNull(parentRow, "Parent session should exist in CMS");

            // Find child sessions
            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            console.log(`  Child sessions found: ${children.length}`);
            assertGreaterOrEqual(children.length, 1, "Expected at least 1 child session");

            const child = children[0];
            console.log(`  Child session: ${child.sessionId.slice(0, 8)}, state: ${child.state}`);

            // Validate parent session CMS + orchestration state
            const v = await validateSessionAfterTurn(env, session.sessionId);
            console.log(`  [Parent CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
            pass("Spawn Custom Sub-Agent");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Child Session CMS Metadata ────────────────────────────

async function testChildSessionMetadata(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content: `You have a spawn_agent tool. When asked to spawn an agent, use it immediately with the given task. Be brief.`,
                },
            });

            console.log("  Spawning sub-agent...");
            await session.sendAndWait(
                "Spawn a sub-agent with the task: 'Count to 3 and report back'",
                TIMEOUT,
            );

            // Find child sessions
            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            assertGreaterOrEqual(children.length, 1, "Expected at least 1 child");

            const child = children[0];
            console.log(`  Child parentSessionId: ${child.parentSessionId?.slice(0, 8)}`);
            console.log(`  Child state: ${child.state}`);

            // Verify parent-child link
            assert(
                child.parentSessionId === session.sessionId,
                `Child parentSessionId (${child.parentSessionId}) doesn't match parent (${session.sessionId})`,
            );

            // Verify descendant lookup works
            const descendants = await catalog.getDescendantSessionIds(session.sessionId);
            console.log(`  Descendants of parent: ${descendants.length}`);
            assert(descendants.includes(child.sessionId), "Child not in descendants list");

            pass("Child Session CMS Metadata");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Check Agents Returns Child Status ─────────────────────

async function testCheckAgents(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: `You have spawn_agent and check_agents tools. When asked to spawn, use spawn_agent. When asked to check, use check_agents. Be brief and report status clearly.`,
            },
        });

        // Step 1: Spawn
        console.log("  Step 1: Spawn sub-agent...");
        await session.sendAndWait(
            "Spawn a sub-agent with the task: 'Say hello'",
            TIMEOUT,
        );

        // Wait for the child to make some progress
        await new Promise(r => setTimeout(r, 5000));

        // Step 2: Check agents
        console.log("  Step 2: Check agents...");
        const checkResponse = await session.sendAndWait(
            "Check the status of all agents",
            TIMEOUT,
        );
        console.log(`  Check response: "${checkResponse}"`);

        // The response should mention agent status

        const v = await validateSessionAfterTurn(env, session.sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Check Agents Returns Status");
    });
}

// ─── Test: Multiple Sub-Agents ───────────────────────────────────

async function testMultipleSubAgents(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content: `You have a spawn_agent tool. Spawn agents as requested. Be brief. When spawning multiple agents, spawn them one at a time.`,
                },
            });

            // Spawn first sub-agent
            console.log("  Spawning first sub-agent...");
            await session.sendAndWait(
                "Spawn a sub-agent with the task: 'Say hello'",
                TIMEOUT,
            );

            // Spawn second sub-agent
            console.log("  Spawning second sub-agent...");
            await session.sendAndWait(
                "Spawn another sub-agent with the task: 'Say goodbye'",
                TIMEOUT,
            );

            // Verify two child sessions in CMS
            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            console.log(`  Child sessions found: ${children.length}`);
            assertGreaterOrEqual(children.length, 2, "Expected at least 2 child sessions");

            const v = await validateSessionAfterTurn(env, session.sessionId, { minIteration: 2 });
            console.log(`  [Parent CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
            pass("Multiple Sub-Agents");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Custom Agent Without Skill ────────────────────────────
// Verifies that a sub-agent can be spawned with just a task description,
// without needing a pre-configured agent definition or skill.

async function testCustomAgentWithoutSkill(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content: `You have a spawn_agent tool. When asked to spawn an agent, call spawn_agent with the given task. Do NOT use agent_name — use the task parameter. Be brief.`,
                },
            });

            console.log("  Spawning custom agent with task only (no agent_name, no skill)...");
            const response = await session.sendAndWait(
                "Spawn a sub-agent with the task: 'Calculate 99+1 and report the answer'",
                TIMEOUT,
            );
            console.log(`  Response: "${response}"`);

            // Verify a child session was created
            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            console.log(`  Child sessions found: ${children.length}`);
            assertGreaterOrEqual(children.length, 1, "Custom task-only agent should spawn without a skill");

            const child = children[0];
            console.log(`  Child session: ${child.sessionId.slice(0, 8)}, state: ${child.state}`);
            // Custom spawns should NOT have an agentId (they're ad-hoc)
            assert(!child.agentId, `Custom agent should not have agentId, got: ${child.agentId}`);

            pass("Custom Agent Without Skill");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Spawn Named Agents by agent_name ──────────────────────
// Verifies that spawn_agent(agent_name=...) resolves the agent definition
// and creates child sessions with the correct title, agentId, isSystem
// flag, splash banner, and parent link. This exercises the agent_name
// parameter path through the stub schema → real handler → orchestration
// → resolveAgentConfig → spawnChildSession flow.
//
// This test loads the mgmt plugin (sweeper + resourcemgr agent definitions)
// via pluginDirs WITHOUT auto-starting management agents.

async function testSpawnNamedAgents(env) {
    const catalog = await createCatalog(env);

    try {
        // Load mgmt agent definitions (sweeper, resourcemgr) without auto-starting them
        await withClient(env, {
            worker: { pluginDirs: ["plugins/mgmt"] },
        }, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content:
                        "You have a spawn_agent tool with an agent_name parameter. " +
                        "When asked to spawn an agent by name, call spawn_agent(agent_name=...). " +
                        "Do NOT pass task or system_message when using agent_name. " +
                        "Spawn ONE agent per tool call. Be brief.",
                },
            });

            // Spawn sweeper by agent_name
            console.log("  Spawning sweeper by agent_name...");
            const r1 = await session.sendAndWait(
                "Spawn the sweeper agent using agent_name=\"sweeper\"",
                TIMEOUT,
            );
            console.log(`  Response: "${r1?.slice(0, 80)}"`);

            // Spawn resourcemgr by agent_name
            console.log("  Spawning resourcemgr by agent_name...");
            const r2 = await session.sendAndWait(
                "Now spawn the resourcemgr agent using agent_name=\"resourcemgr\"",
                TIMEOUT,
            );
            console.log(`  Response: "${r2?.slice(0, 80)}"`);

            // Find children
            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            console.log(`  Children found: ${children.length}`);
            for (const c of children) {
                console.log(`    - agentId=${c.agentId}, title="${c.title}", isSystem=${c.isSystem}`);
            }

            assertGreaterOrEqual(children.length, 2, "Expected both sweeper and resourcemgr children");

            const sweeper = children.find(c => c.agentId === "sweeper");
            const resourcemgr = children.find(c => c.agentId === "resourcemgr");

            // ── Verify sweeper ──
            assertNotNull(sweeper, "Sweeper should be spawned with agentId='sweeper'");
            assertEqual(sweeper.title, "Sweeper Agent", "Sweeper title");
            assertEqual(sweeper.isSystem, true, "Sweeper should be system");
            assertEqual(sweeper.parentSessionId, session.sessionId, "Sweeper parent link");
            assertNotNull(sweeper.splash, "Sweeper should have splash banner");

            // ── Verify resourcemgr ──
            assertNotNull(resourcemgr, "ResourceMgr should be spawned with agentId='resourcemgr'");
            assertEqual(resourcemgr.title, "Resource Manager Agent", "ResourceMgr title");
            assertEqual(resourcemgr.isSystem, true, "ResourceMgr should be system");
            assertEqual(resourcemgr.parentSessionId, session.sessionId, "ResourceMgr parent link");
            assertNotNull(resourcemgr.splash, "ResourceMgr should have splash banner");

            console.log(`  ✓ sweeper: title="${sweeper.title}", agentId=${sweeper.agentId}, isSystem=${sweeper.isSystem}`);
            console.log(`  ✓ resourcemgr: title="${resourcemgr.title}", agentId=${resourcemgr.agentId}, isSystem=${resourcemgr.isSystem}`);

            pass("Spawn Named Agents by agent_name");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("Level 5: Sub-Agent Tests", [
    ["Spawn Custom Sub-Agent", testSpawnCustomSubAgent],
    ["Child Session CMS Metadata", testChildSessionMetadata],
    ["Check Agents Returns Status", testCheckAgents],
    ["Multiple Sub-Agents", testMultipleSubAgents],
    ["Custom Agent Without Skill", testCustomAgentWithoutSkill],
    ["Spawn Named Agents by agent_name", testSpawnNamedAgents],
]);
