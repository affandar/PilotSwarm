/**
 * Sub-agent regression: child stays alive after completing its task.
 *
 * v1.0.49 changed the sub-agent lifecycle: non-system children no longer
 * auto-terminate after emitting a final assistant message. They stay alive
 * idle and only end when the parent calls complete_agent / cancel_agent /
 * delete_agent.
 *
 * This test:
 *   1. Spawns one named child ("echoer") that replies with a single ECHO line
 *      and then has nothing more to say.
 *   2. Waits for that final assistant.message to appear in CMS.
 *   3. Sleeps a few seconds and verifies the child session row is NOT in a
 *      terminal CMS state (i.e. it is still alive, idle, ready for follow-up).
 *   4. Asks the parent to send a follow-up via message_agent and verifies the
 *      child produces a SECOND assistant.message in response — proving the
 *      child was genuinely alive, not just lingering in CMS.
 *
 * Run: npx vitest run test/local/sub-agents/keep-alive-after-task.test.js
 */

import { describe, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertNotNull, assertGreaterOrEqual, assertEqual } from "../../helpers/assertions.js";
import { createCatalog, getEvents, waitForEventCount } from "../../helpers/cms-helpers.js";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../../fixtures/sub-agent-lifecycle-plugin");

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "deleted"]);

async function testChildStaysAliveAfterTask(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, {
            worker: { pluginDirs: [PLUGIN_DIR] },
        }, async (client) => {
            const session = await client.createSession({
                agentId: "lifecycle-coordinator",
            });

            // Step 1: spawn a single echoer child via the parent's LLM.
            console.log("  Spawning echoer child via parent LLM...");
            await session.sendAndWait(
                "Use spawn_agent to spawn one sub-agent with agent_name='echoer' and the task " +
                "exactly: 'TOKEN=ALPHA'. After the spawn_agent tool returns, reply with " +
                "exactly the single word DONE and stop. Do NOT call complete_agent, " +
                "cancel_agent, delete_agent, message_agent, wait_for_agents, or check_agents.",
                TIMEOUT,
            );

            // Step 2: locate the child in CMS.
            let children = [];
            const childDeadline = Date.now() + 30_000;
            while (Date.now() < childDeadline) {
                const allSessions = await catalog.listSessions();
                children = allSessions.filter((row) => row.parentSessionId === session.sessionId);
                if (children.length >= 1) break;
                await new Promise((r) => setTimeout(r, 500));
            }
            assertGreaterOrEqual(children.length, 1, "parent should have spawned exactly one child");
            const child = children[0];
            console.log(`  child sessionId=${child.sessionId.slice(0, 8)} agentId=${child.agentId}`);
            assertEqual(child.agentId, "echoer", "child agentId should be echoer");

            // Step 3: wait for the child to emit its first assistant.message
            // (the ECHO: ALPHA reply that historically would auto-terminate it).
            await waitForEventCount(catalog, child.sessionId, "assistant.message", 1, 60_000);

            // Step 4: sleep and verify the child is STILL alive.
            console.log("  child finished its task; sleeping 8s and confirming it is still alive...");
            await new Promise((r) => setTimeout(r, 8_000));

            const childRow = await catalog.getSession(child.sessionId);
            assertNotNull(childRow, "child session should still be present in CMS");
            console.log(`  child CMS state after task: ${childRow.state}`);
            if (TERMINAL_STATES.has(childRow.state)) {
                throw new Error(
                    `Sub-agent regressed to v<=1.0.48 behavior: state=${childRow.state} after a single completed task. ` +
                    `Expected the child to remain alive and idle until the parent closes it.`,
                );
            }

            // Step 5: send a follow-up via message_agent and verify the child
            // wakes up and emits a SECOND assistant.message.
            console.log("  asking parent to send a follow-up via message_agent...");
            await session.sendAndWait(
                "Use message_agent to send the message exactly: 'TOKEN=BETA' to the sub-agent " +
                `with agent_id='${child.sessionId}'. After message_agent returns, reply with the ` +
                "single word OK and stop. Do NOT call any other tools.",
                TIMEOUT,
            );

            await waitForEventCount(catalog, child.sessionId, "assistant.message", 2, 90_000);

            const events = await getEvents(catalog, child.sessionId);
            const replies = events
                .filter((e) => e.eventType === "assistant.message")
                .map((e) => e.data?.content ?? "");
            console.log(`  child assistant replies: ${JSON.stringify(replies)}`);
            assertGreaterOrEqual(
                replies.length,
                2,
                "child must emit a second assistant message after the parent's follow-up",
            );

            // Final cleanup: parent gracefully completes the child.
            console.log("  asking parent to gracefully complete the child...");
            await session.sendAndWait(
                `Use complete_agent with agent_id='${child.sessionId}'. After it returns, reply ` +
                "with the single word CLOSED and stop.",
                TIMEOUT,
            );
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Keep alive after task (v1.0.49)", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("non-system child stays alive and replies to follow-up message_agent", { timeout: TIMEOUT * 2 }, async () => {
        await testChildStaysAliveAfterTask(getEnv());
    });
});
