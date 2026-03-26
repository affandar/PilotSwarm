/**
 * Sub-agent test: Spawn a custom sub-agent via task prompt.
 *
 * Run: npx vitest run test/local/sub-agents/spawn-custom.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertNotNull, assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog, validateSessionAfterTurn } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testSpawnCustomSubAgent(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();

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
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Spawn Custom", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Spawn Custom Sub-Agent", { timeout: TIMEOUT * 2 }, async () => {
        await testSpawnCustomSubAgent(getEnv());
    });
});
