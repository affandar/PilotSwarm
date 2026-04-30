/**
 * Sub-agent regression: same-name agent_name duplicates are allowed.
 *
 * v1.0.49 removed the spawn_agent dedup guard that previously rejected a
 * second `spawn_agent(agent_name="X", ...)` while another instance with the
 * same agent_name was running. Concurrent same-name children are now legal
 * (capped only by the global MAX_SUB_AGENTS and nesting-depth limits).
 *
 * This test asks the parent to spawn TWO instances of the same named agent
 * (`echoer`) with two different tasks, then verifies the durable CMS result
 * directly instead of depending on a final parent response:
 *
 *   1. Both child sessions exist in CMS as distinct rows under the same parent.
 *   2. Both children share the same agentId ("echoer").
 *   3. The parent never received a `[SYSTEM: Agent "echoer" is already running
 *      as sub-agent ...` rejection.
 *
 * Run: npx vitest run test/local/sub-agents/allow-duplicate-named-agents.test.js
 */

import { describe, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertEqual, assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog, getEvents, waitForEventCount } from "../../helpers/cms-helpers.js";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../../fixtures/sub-agent-lifecycle-plugin");

async function testDuplicateNamedAgentsAllowed(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, {
            worker: { pluginDirs: [PLUGIN_DIR] },
        }, async (client) => {
            const session = await client.createSession({
                agentId: "lifecycle-coordinator",
            });

            console.log("  Asking parent to spawn TWO concurrent echoer instances...");
            await session.send(
                "Spawn two sub-agents in parallel using spawn_agent. Both must use " +
                "agent_name='echoer'. The first sub-agent's task is exactly: 'TOKEN=ONE'. " +
                "The second sub-agent's task is exactly: 'TOKEN=TWO'. Do NOT spawn them " +
                "sequentially across separate turns; emit both spawn_agent tool calls in " +
                "this turn. After both spawn_agent calls return, reply with exactly the " +
                "single word DONE and stop. Do NOT call complete_agent, cancel_agent, " +
                "delete_agent, message_agent, wait_for_agents, or check_agents.",
            );

            // Step 2: confirm two distinct child rows in CMS.
            let children = [];
            const childDeadline = Date.now() + TIMEOUT;
            while (Date.now() < childDeadline) {
                const allSessions = await catalog.listSessions();
                children = allSessions.filter((row) => row.parentSessionId === session.sessionId);
                if (children.length >= 2) break;
                await new Promise((r) => setTimeout(r, 500));
            }

            console.log(`  child sessions found: ${children.length}`);
            for (const child of children) {
                console.log(`    - ${child.sessionId.slice(0, 8)} agentId=${child.agentId}`);
            }
            assertGreaterOrEqual(
                children.length,
                2,
                "parent should have spawned two concurrent echoer children",
            );

            const echoers = children.filter((row) => row.agentId === "echoer");
            assertGreaterOrEqual(
                echoers.length,
                2,
                "both children should share agentId='echoer'",
            );

            const ids = new Set(echoers.map((row) => row.sessionId));
            assertEqual(ids.size, echoers.length, "child sessionIds must be distinct");

            // Step 3: verify the parent never received the legacy dedup rejection.
            const parentEvents = await getEvents(catalog, session.sessionId);
            const dedupRejection = parentEvents.find((event) => {
                const text = String(event?.data?.content || event?.data?.message || "");
                return text.includes('Agent "echoer" is already running as sub-agent');
            });
            if (dedupRejection) {
                throw new Error(
                    `Sub-agent regressed to v<=1.0.48 behavior: parent saw a same-name dedup rejection. ` +
                    `Event: ${JSON.stringify(dedupRejection).slice(0, 300)}`,
                );
            }

            // Sanity: each child eventually emits its ECHO reply, proving they
            // ran concurrently and were not collapsed into a single instance.
            for (const child of echoers) {
                await waitForEventCount(catalog, child.sessionId, "assistant.message", 1, 60_000);
            }
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Allow duplicate named agents (v1.0.49)", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("two concurrent spawn_agent(agent_name='echoer') calls both succeed", { timeout: TIMEOUT * 2 }, async () => {
        await testDuplicateNamedAgentsAllowed(getEnv());
    });
});
