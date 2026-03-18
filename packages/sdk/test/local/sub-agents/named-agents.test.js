/**
 * Sub-agent test: Spawn named agents by agent_name (sweeper, resourcemgr).
 *
 * Verifies that spawn_agent(agent_name=...) resolves the agent definition
 * and creates child sessions with the correct title, agentId, isSystem
 * flag, splash banner, and parent link.
 *
 * Run: npx vitest run test/local/sub-agents/named-agents.test.js
 */

import { describe, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnv, preflightChecks } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertNotNull, assertGreaterOrEqual, assertEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MGMT_PLUGIN_DIR = path.resolve(__dirname, "../../../plugins/mgmt");

async function testSpawnNamedAgents(env) {
    const catalog = await createCatalog(env);

    try {
        // Load mgmt agent definitions (sweeper, resourcemgr) without auto-starting them
        await withClient(env, {
            worker: { pluginDirs: [MGMT_PLUGIN_DIR] },
        }, async (client) => {
            const session = await client.createSession();

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
        });
    } finally {
        await catalog.close();
    }
}

describe.concurrent("Sub-Agent: Named Agents", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Spawn Named Agents by agent_name", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("sub-agents");
        try { await testSpawnNamedAgents(env); } finally { await env.cleanup(); }
    });
});
