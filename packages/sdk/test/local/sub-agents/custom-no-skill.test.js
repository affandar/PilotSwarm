/**
 * Sub-agent test: Custom agent spawned with task only (no agent_name, no skill).
 *
 * Run: npx vitest run test/local/sub-agents/custom-no-skill.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assert, assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function waitForDirectChildren(catalog, parentSessionId, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const allSessions = await catalog.listSessions();
        const children = allSessions.filter(
            s => s.parentSessionId === parentSessionId,
        );
        if (children.length > 0) return children;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return [];
}

async function testCustomAgentWithoutSkill(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();

            console.log("  Spawning custom agent with task only (no agent_name, no skill)...");
            await session.send(
                "Use the spawn_agent tool now with task='Calculate 99+1 and report the answer'. Do not pass agent_name or skill. After the tool call succeeds, you may finish with a short acknowledgement.",
            );

            // Verify a child session was created
            const children = await waitForDirectChildren(catalog, session.sessionId);
            console.log(`  Child sessions found: ${children.length}`);
            if (children.length === 0) {
                const row = await catalog.getSession(session.sessionId);
                console.log("  Parent row:", row);
                const events = await catalog.getSessionEvents(session.sessionId, undefined, 20);
                console.log("  Parent events:", events.map((event) => ({
                    type: event.eventType,
                    data: event.data,
                })));
            }
            assertGreaterOrEqual(children.length, 1, "Custom task-only agent should spawn without a skill");

            const child = children[0];
            console.log(`  Child session: ${child.sessionId.slice(0, 8)}, state: ${child.state}`);
            // Custom spawns should NOT have an agentId (they're ad-hoc)
            assert(!child.agentId, `Custom agent should not have agentId, got: ${child.agentId}`);
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Custom No Skill", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Custom Agent Without Skill", { timeout: TIMEOUT * 2 }, async () => {
        await testCustomAgentWithoutSkill(getEnv());
    });
});
