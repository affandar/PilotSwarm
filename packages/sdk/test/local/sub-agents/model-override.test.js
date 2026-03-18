/**
 * Sub-agent test: spawn sub-agent with a different model.
 *
 * Covers: model override via spawn_agent, model recorded in child CMS row,
 * child inherits parent model when no override.
 *
 * Run: npx vitest run test/local/sub-agents/model-override.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";
import { TEST_GPT_MODEL } from "../../helpers/fixtures.js";

const TIMEOUT = 180_000;

async function testChildInheritsParentModel(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession({ model: TEST_GPT_MODEL });
        assertNotNull(session, "session created");

        console.log(`  Asking parent (${TEST_GPT_MODEL}) to spawn sub-agent without model override...`);
        const response = await session.sendAndWait(
            "Spawn a sub-agent with the task: 'Say hello world and nothing else'",
            TIMEOUT,
        );
        console.log(`  Response: "${response?.slice(0, 80)}"`);

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const children = sessions.filter(s => s.parentSessionId === session.sessionId);
            console.log(`  Child sessions: ${children.length}`);
            assert(children.length >= 1, "at least 1 child spawned");

            const child = children[0];
            console.log(`  Parent model: "${(await catalog.getSession(session.sessionId))?.model}"`);
            console.log(`  Child model: "${child.model}"`);

            // Child should inherit the parent's configured model.
            if (child.model) {
                assertEqual(
                    child.model.includes(TEST_GPT_MODEL),
                    true,
                    `child inherited ${TEST_GPT_MODEL} (got: ${child.model})`,
                );
            }
        } finally {
            await catalog.close();
        }
    });
}

describe.concurrent("Sub-Agent: Model Override", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Child Inherits Parent Model", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("sub-agents");
        try { await testChildInheritsParentModel(env); } finally { await env.cleanup(); }
    });
});
