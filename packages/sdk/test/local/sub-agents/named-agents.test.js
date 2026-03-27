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
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertNotNull, assertEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
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

            // Send both spawn requests. We use send() (not sendAndWait) because
            // the model may legitimately call wait_for_agents after spawning,
            // putting the orchestration into "waiting" state. We only care that
            // the child CMS rows appear with correct metadata.
            console.log("  Spawning sweeper and resourcemgr by agent_name...");
            await session.send(
                'Spawn two agents: first spawn_agent(agent_name="sweeper"), then spawn_agent(agent_name="resourcemgr").',
            );

            // Poll CMS until both children appear (or timeout)
            const deadline = Date.now() + TIMEOUT;
            let sweeper, resourcemgr;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const allSessions = await catalog.listSessions();
                const children = allSessions.filter(
                    s => s.parentSessionId === session.sessionId,
                );
                sweeper = children.find(c => c.agentId === "sweeper");
                resourcemgr = children.find(c => c.agentId === "resourcemgr");
                if (sweeper && resourcemgr) break;
                console.log(`  [poll] children so far: ${children.map(c => c.agentId).join(", ") || "none"}`);
            }

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

describe("Sub-Agent: Named Agents", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Spawn Named Agents by agent_name", { timeout: TIMEOUT * 2 }, async () => {
        await testSpawnNamedAgents(getEnv());
    });
});
