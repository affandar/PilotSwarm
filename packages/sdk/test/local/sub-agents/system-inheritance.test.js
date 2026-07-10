/**
 * Sub-agent integration test: a child spawned by a SYSTEM session is itself a
 * system session — end to end, across the exact "worker didn't create it"
 * boundary that broke in production.
 *
 * System sessions are ownerless, so a spawned child inherits no owner; its
 * only route to a GitHub Copilot credential is the ownerless SYSTEM identity
 * (the admin-stored System key, resolved only when the row is isSystem AND has
 * no owner). Two regressions had to be fixed for this to work:
 *
 *   1. handleSubAgentAction dropped the parent->child isSystem propagation
 *      (restored in orchestration/agents.ts; unit-guarded in
 *      system-child-propagation.test.js).
 *   2. The orchestration input's isSystem was read from the in-memory
 *      systemSessions set, which a worker restart empties for resumed managed
 *      system agents — so a system session run by a worker that didn't create
 *      it lost isSystem, and its spawned children came out non-system. Fixed
 *      by adopting the authoritative CMS row (client.ts _ensureOrchestrationAndSend).
 *
 * This test exercises both: the session is created by the test client, but the
 * (separate) embedded worker runs the turns — so it only sees the system flag
 * through the CMS row. The child must still be spawned as a system session.
 *
 * Run: npx vitest run test/local/sub-agents/system-inheritance.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assert, assertGreaterOrEqual, assertEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testSystemChildInheritsIsSystem(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const system = await client.createSystemSession({
                systemMessage: "You are a system session. When asked, spawn a sub-agent.",
            });

            console.log("  Spawning sub-agent under a SYSTEM (ownerless) parent...");
            await system.send(
                "Spawn a sub-agent with the task: 'Reply with the single word DONE'",
            );

            let children = [];
            const deadline = Date.now() + TIMEOUT;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const allSessions = await catalog.listSessions();
                children = allSessions.filter(
                    s => s.parentSessionId === system.sessionId,
                );
                if (children.length >= 1) break;
                console.log(`  [poll] children so far: ${children.length}`);
            }
            assertGreaterOrEqual(children.length, 1, "Expected at least 1 child");

            const child = children[0];
            console.log(`  Child ${child.sessionId.slice(0, 8)} isSystem=${child.isSystem} owner=${JSON.stringify(child.owner)}`);

            assertEqual(
                child.isSystem,
                true,
                "Child of a system session must itself be a system session so it can resolve the admin-stored System GHCP key",
            );
            assert(
                !child.owner,
                "A system-session child is ownerless — it inherits the SYSTEM identity, not a user owner",
            );
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: System Inheritance", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("child spawned by a system session is itself a system session (can reach the System GHCP key)", { timeout: TIMEOUT * 2 }, async () => {
        await testSystemChildInheritsIsSystem(getEnv());
    });
});
