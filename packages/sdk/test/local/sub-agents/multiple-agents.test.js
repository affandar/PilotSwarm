/**
 * Sub-agent test: Multiple sub-agents in one session.
 *
 * Run: npx vitest run test/local/sub-agents/multiple-agents.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog, validateSessionAfterTurn } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testMultipleSubAgents(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();

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
