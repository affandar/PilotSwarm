/**
 * Sub-agent test: Child session CMS metadata (parentSessionId, agentId, descendants).
 *
 * Run: npx vitest run test/local/sub-agents/child-metadata.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assert, assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testChildSessionMetadata(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();

            console.log("  Spawning sub-agent...");
            await session.sendAndWait(
                "Spawn a sub-agent with the task: 'Count to 3 and report back'",
                TIMEOUT,
            );

            // Find child sessions
            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            assertGreaterOrEqual(children.length, 1, "Expected at least 1 child");

            const child = children[0];
            console.log(`  Child parentSessionId: ${child.parentSessionId?.slice(0, 8)}`);
            console.log(`  Child state: ${child.state}`);

            // Verify parent-child link
            assert(
                child.parentSessionId === session.sessionId,
                `Child parentSessionId (${child.parentSessionId}) doesn't match parent (${session.sessionId})`,
            );

            // Verify descendant lookup works
            const descendants = await catalog.getDescendantSessionIds(session.sessionId);
            console.log(`  Descendants of parent: ${descendants.length}`);
            assert(descendants.includes(child.sessionId), "Child not in descendants list");
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Child Metadata", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Child Session CMS Metadata", { timeout: TIMEOUT * 2 }, async () => {
        await testChildSessionMetadata(getEnv());
    });
});
