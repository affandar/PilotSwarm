/**
 * Sub-agent test: Spawn a custom sub-agent via task prompt.
 *
 * Run: npx vitest run test/local/sub-agents/spawn-custom.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertNotNull, assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testSpawnCustomSubAgent(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();

            console.log("  Sending: Spawn a sub-agent with the task 'Say hello world and nothing else'");
            await session.send(
                "Spawn a sub-agent with the task: 'Say hello world and nothing else'",
            );

            // Poll CMS until child session appears
            let children;
            const deadline = Date.now() + TIMEOUT;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const allSessions = await catalog.listSessions();
                children = allSessions.filter(
                    s => s.parentSessionId === session.sessionId,
                );
                if (children.length >= 1) break;
                console.log(`  [poll] children so far: ${children.length}`);
            }

            // Verify a child session was created in CMS
            const parentRow = await catalog.getSession(session.sessionId);
            assertNotNull(parentRow, "Parent session should exist in CMS");

            console.log(`  Child sessions found: ${children.length}`);
            assertGreaterOrEqual(children.length, 1, "Expected at least 1 child session");

            const child = children[0];
            console.log(`  Child session: ${child.sessionId.slice(0, 8)}, state: ${child.state}`);
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
