/**
 * Sub-agent test: Agent prompt says "you have no tools" — framework should win.
 *
 * Repro for a real bug where an app agent's prompt contained
 * "You do not have tools" which caused the model to ignore the
 * framework base prompt's spawn_agent instructions entirely.
 *
 * The framework base prompt has highest priority ("If any later section
 * conflicts with this section, follow this section."), so spawn_agent
 * should still work regardless of what the agent prompt says.
 *
 * Two test cases:
 *   1. Explicit: user says "use spawn_agent" — model should comply
 *   2. Implicit: user says "delegate this task" — model should decide
 *      to use spawn_agent on its own based on framework instructions
 *
 * Run: npx vitest run test/local/sub-agents/no-tools-override.test.js
 */

import { describe, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnv, preflightChecks } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assertGreaterOrEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../../fixtures/no-tools-agent-plugin");

async function testExplicitSpawn(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, {
            worker: { pluginDirs: [PLUGIN_DIR] },
        }, async (client) => {
            const session = await client.createSession({
                agentId: "coordinator",
            });

            // Explicit: user tells the agent to use spawn_agent
            console.log("  [explicit] Sending: Use spawn_agent to spawn a sub-agent");
            const response = await session.sendAndWait(
                'Use spawn_agent to spawn a sub-agent with the task: "Say hello world and nothing else."',
                TIMEOUT,
            );
            console.log(`  [explicit] Response: "${response?.slice(0, 120)}"`);

            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            console.log(`  [explicit] Child sessions found: ${children.length}`);

            assertGreaterOrEqual(
                children.length,
                1,
                "[explicit] Agent whose prompt says 'you have no tools' should " +
                "still use spawn_agent when explicitly asked.",
            );
            console.log("  ✓ [explicit] Framework base prompt overrode 'no tools' claim");
        });
    } finally {
        await catalog.close();
    }
}

async function testImplicitSpawn(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, {
            worker: { pluginDirs: [PLUGIN_DIR] },
        }, async (client) => {
            const session = await client.createSession({
                agentId: "coordinator",
            });

            // Implicit: user just asks to delegate — the agent should decide
            // on its own to use spawn_agent based on its role + framework
            console.log("  [implicit] Sending: Delegate a task to a sub-agent");
            const response = await session.sendAndWait(
                'I need you to delegate this task to a sub-agent: have it write a short haiku about databases. Do not do it yourself — spawn a sub-agent.',
                TIMEOUT,
            );
            console.log(`  [implicit] Response: "${response?.slice(0, 120)}"`);

            const allSessions = await catalog.listSessions();
            const children = allSessions.filter(
                s => s.parentSessionId === session.sessionId,
            );
            console.log(`  [implicit] Child sessions found: ${children.length}`);

            assertGreaterOrEqual(
                children.length,
                1,
                "[implicit] Agent whose prompt says 'you have no tools' should " +
                "still use spawn_agent to delegate. Zero children means the " +
                "framework prompt priority is not strong enough to overcome " +
                "the agent-level 'no tools' claim.",
            );
            console.log("  ✓ [implicit] Framework base prompt overrode 'no tools' claim");
        });
    } finally {
        await catalog.close();
    }
}

describe.concurrent("Sub-Agent: No-Tools Override", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("explicit: agent uses spawn_agent when told to", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("sub-agents");
        try { await testExplicitSpawn(env); } finally { await env.cleanup(); }
    });

    it("implicit: agent decides to use spawn_agent on its own", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("sub-agents");
        try { await testImplicitSpawn(env); } finally { await env.cleanup(); }
    });
});
