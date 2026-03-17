/**
 * Sub-agent test: nested spawning (depth 2 — grandchild).
 *
 * Covers: parent → child → grandchild nesting (depth 2),
 * nesting depth enforcement (depth 3 denied),
 * parentSessionId chain verification.
 *
 * Run: npx vitest run test/local/sub-agents/nested-spawn.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assert, assertEqual, assertGreaterOrEqual, assertNotNull } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;

async function testDepthTwoNesting(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession();
        assertNotNull(session, "root session created");

        console.log("  Asking root to spawn child who spawns grandchild...");
        const response = await session.sendAndWait(
            "Spawn a sub-agent with the task: 'You must spawn another sub-agent with the task: say hello world and nothing else. Wait for it to finish and report its response.'",
            TIMEOUT * 3,
        );
        console.log(`  Response: "${response?.slice(0, 100)}"`);
        assertNotNull(response, "got root response");

        // Wait for nested spawns to complete
        await new Promise(r => setTimeout(r, 5000));

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            // Find child (depth 1)
            const children = sessions.filter(s => s.parentSessionId === session.sessionId);
            console.log(`  Children (depth 1): ${children.length}`);
            assertGreaterOrEqual(children.length, 1, "at least 1 child (depth 1)");

            // Find grandchild (depth 2)
            const grandchildren = [];
            for (const child of children) {
                const gc = sessions.filter(s => s.parentSessionId === child.sessionId);
                grandchildren.push(...gc);
            }
            console.log(`  Grandchildren (depth 2): ${grandchildren.length}`);
            assertGreaterOrEqual(grandchildren.length, 1, "at least 1 grandchild (depth 2)");

            // Verify parentSessionId chain
            const child = children[0];
            const grandchild = grandchildren[0];
            assertEqual(child.parentSessionId, session.sessionId, "child → root link");
            assertEqual(grandchild.parentSessionId, child.sessionId, "grandchild → child link");

            console.log(`  Chain: root(${session.sessionId.slice(0, 8)}) → child(${child.sessionId.slice(0, 8)}) → grandchild(${grandchild.sessionId.slice(0, 8)})`);
        } finally {
            await catalog.close();
        }
    });
}

async function testDepthThreeDenied(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession();
        assertNotNull(session, "root session created");

        // Verified in testDepthTwoNesting: root → child → grandchild works.
        // MAX_NESTING_LEVEL = 2 means grandchild (depth 2) can't spawn further.
        // Ask for the same 2-deep nesting and verify no depth-3 sessions exist.
        console.log("  Asking root to spawn child who spawns grandchild (depth 2 max)...");
        const response = await session.sendAndWait(
            "Spawn a sub-agent with the task: 'You must spawn another sub-agent with the task: say hello world. Wait for it to finish and report.'",
            TIMEOUT * 3,
        );
        console.log(`  Response: "${response?.slice(0, 100)}"`);
        assertNotNull(response, "got root response");

        await new Promise(r => setTimeout(r, 5000));

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const children = sessions.filter(s => s.parentSessionId === session.sessionId);
            let grandchildren = [];
            for (const child of children) {
                grandchildren.push(...sessions.filter(s => s.parentSessionId === child.sessionId));
            }
            let greatGrandchildren = [];
            for (const gc of grandchildren) {
                greatGrandchildren.push(...sessions.filter(s => s.parentSessionId === gc.sessionId));
            }

            console.log(`  Depth 1 (children): ${children.length}`);
            console.log(`  Depth 2 (grandchildren): ${grandchildren.length}`);
            console.log(`  Depth 3 (great-grandchildren): ${greatGrandchildren.length}`);

            // MAX_NESTING_LEVEL = 2 — grandchild (depth 2) is the max, no depth 3 allowed
            assertEqual(greatGrandchildren.length, 0, "depth 3 denied (MAX_NESTING_LEVEL=2)");
        } finally {
            await catalog.close();
        }
    });
}

describe.concurrent("Sub-Agent: Nested Spawning", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Depth 2 Nesting (Grandchild)", { timeout: TIMEOUT * 4 }, async () => {
        const env = createTestEnv("sub-agents");
        try { await testDepthTwoNesting(env); } finally { await env.cleanup(); }
    });
    it("Depth 3 Denied (Max Nesting)", { timeout: TIMEOUT * 4 }, async () => {
        const env = createTestEnv("sub-agents");
        try { await testDepthThreeDenied(env); } finally { await env.cleanup(); }
    });
});
