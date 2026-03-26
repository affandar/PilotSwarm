/**
 * Sub-agent test: check_agents returns child status.
 *
 * Run: npx vitest run test/local/sub-agents/check-agents.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { validateSessionAfterTurn } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testCheckAgents(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession();

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

        const v = await validateSessionAfterTurn(env, session.sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
    });
}

describe("Sub-Agent: Check Agents", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Check Agents Returns Status", { timeout: TIMEOUT * 2 }, async () => {
        await testCheckAgents(getEnv());
    });
});
