/**
 * Sub-agent test: Multiple sub-agents in one session.
 *
 * Run: npx vitest run test/local/sub-agents/multiple-agents.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testMultipleSubAgents(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();

            // Send both spawn requests in one prompt
            console.log("  Spawning two sub-agents...");
            await session.send(
                "Spawn two sub-agents: first with the task 'Say hello', then another with the task 'Say goodbye'.",
            );

            // Poll CMS until both child sessions appear
            let children;
            const deadline = Date.now() + TIMEOUT;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const allSessions = await catalog.listSessions();
                children = allSessions.filter(
                    s => s.parentSessionId === session.sessionId,
                );
                if (children.length >= 2) break;
                console.log(`  [poll] children so far: ${children.length}`);
            }

            // Verify two child sessions in CMS
            console.log(`  Child sessions found: ${children.length}`);
            assertGreaterOrEqual(children.length, 2, "Expected at least 2 child sessions");
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Multiple Agents", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Multiple Sub-Agents", { timeout: TIMEOUT * 2 }, async () => {
        await testMultipleSubAgents(getEnv());
    });
});
