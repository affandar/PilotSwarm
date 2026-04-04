/**
 * Sub-agent regression: parent/child back-and-forth without cron.
 *
 * Verifies that a parent agent can spawn a child, observe the child's
 * blocking question, answer it via message_agent, and then wait for the child
 * to complete using the default worker model.
 *
 * Run: npx vitest run test/local/sub-agents/parent-child-roundtrip.test.js
 */

import { describe, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertIncludes, assertNotNull, assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog, getEvents, waitForEventCount } from "../../helpers/cms-helpers.js";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../../fixtures/parent-child-roundtrip-plugin");

async function testParentChildRoundtrip(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, {
            worker: { pluginDirs: [PLUGIN_DIR] },
        }, async (client, worker) => {
            console.log(`  Worker default model: ${worker.modelProviders?.defaultModel}`);

            const session = await client.createSession({
                agentId: "coordinator",
            });

            // Single autonomous prompt: the coordinator handles the full workflow.
            // This avoids timing issues from multi-step human-in-the-loop orchestration.
            console.log("  Sending autonomous roundtrip prompt...");
            const response = await session.sendAndWait(
                "Using only PilotSwarm tools, do these steps IN ORDER:\n" +
                "1. Spawn the named agent 'questioner'\n" +
                "2. Call wait(seconds=15, reason='letting child start') to give the child time to start\n" +
                "3. After the wait completes, send exactly 'ANSWER: BLUE' to the questioner child using message_agent\n" +
                "4. Call wait_for_agents to wait for the questioner to finish\n" +
                "5. Reply with the child's final output\n\n" +
                "CRITICAL: You MUST call wait(15) between spawning and sending the message. " +
                "Do NOT skip the wait or send the message immediately after spawning.",
                TIMEOUT,
            );

            console.log(`  Response: ${JSON.stringify(response)}`);
            assertNotNull(response, "parent session should return a response");
            // The parent relays the child's result. Depending on the model,
            // it may echo the full "CHILD FINAL: BLUE" or just the token "BLUE".
            assertIncludes(response, "BLUE", "parent should return the child final answer token");

            // Verify a child session was created
            const allSessions = await catalog.listSessions();
            const children = allSessions.filter((row) => row.parentSessionId === session.sessionId);
            assertGreaterOrEqual(children.length, 1, "coordinator should spawn at least one child session");

            const questioner = children.find((row) => row.agentId === "questioner");
            assertNotNull(questioner, "questioner child session should exist");

            // Verify child received the answer and produced the final output
            await waitForEventCount(catalog, questioner.sessionId, "assistant.message", 2, 60_000);

            const childEvents = await getEvents(catalog, questioner.sessionId);
            const assistantMessages = childEvents
                .filter((event) => event.eventType === "assistant.message")
                .map((event) => event.data?.content ?? JSON.stringify(event.data));

            console.log(`  Child assistant messages: ${JSON.stringify(assistantMessages)}`);
            assertIncludes(
                assistantMessages.join("\n"),
                "CHILD FINAL: BLUE",
                "child should finish after the parent reply",
            );
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Parent Child Roundtrip", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("parent answers child question and child completes", { timeout: TIMEOUT * 2 }, async () => {
        await testParentChildRoundtrip(getEnv());
    });
});
