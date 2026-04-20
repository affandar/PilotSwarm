/**
 * Regression: PilotSwarm-registered tools must not collide with
 * Copilot SDK built-in tools. The SDK validator (`validateExternalToolOverrides`
 * in @github/copilot/app.js) throws
 *
 *     External tool "<name>" conflicts with a built-in tool of the same name.
 *     Set overridesBuiltInTool: true to explicitly override it.
 *
 * for any external tool whose name shadows a built-in unless `overridesBuiltInTool`
 * is set on that tool. PilotSwarm intentionally avoids overrides except where the
 * semantics genuinely overlap (currently none).
 *
 * The known SDK 1.0.32 built-in tool names that flow through `cli.toolInit` and
 * end up in the validator's check set are listed below. They were enumerated by
 * grepping `node_modules/@github/copilot/app.js` for `{name:"..."}` literals
 * inside the agent tool subsystem (excluding desktop-automation MCP tools and
 * MCP prompt primitives, which are not in the validator's set).
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 60_000;

const SDK_BUILT_IN_TOOL_NAMES = [
    "bash",
    "create",
    "edit",
    "str_replace_editor",
    "apply_patch",
    "git_apply_patch",
    "task",
    "search_code_subagent",
    "multi_tool_use.parallel",
    "extensions_manage",
    "extensions_reload",
    "reindex",
    "list_agents",
    "session_store_sql",
];

describe.concurrent("Tool name collisions with Copilot SDK built-ins", () => {
    beforeAll(async () => {
        await preflightChecks();
    });

    it(
        "worker tool registry contains no Copilot SDK built-in tool names",
        { timeout: TIMEOUT },
        async () => {
            const env = createTestEnv("tool-collision-registry");
            try {
                await withClient(env, async (_client, worker) => {
                    // Reach into the private registry — this is an internal
                    // invariant test. No public accessor needed.
                    const registry = /** @type {Map<string, any>} */ (worker.toolRegistry);
                    const registeredNames = [...registry.keys()];
                    console.log(`  Worker registered tools: ${registeredNames.join(", ")}`);

                    const collisions = registeredNames.filter((n) =>
                        SDK_BUILT_IN_TOOL_NAMES.includes(n),
                    );
                    assertEqual(
                        collisions.length,
                        0,
                        `PilotSwarm worker tools collide with Copilot SDK built-ins: ${collisions.join(", ")}`,
                    );
                });
            } finally {
                await env.cleanup();
            }
        },
    );

    it(
        "session with all worker tools attached does not trigger SDK collision validator",
        { timeout: TIMEOUT },
        async () => {
            const env = createTestEnv("tool-collision-session");
            try {
                await withClient(env, async (client, worker) => {
                    const registry = /** @type {Map<string, any>} */ (worker.toolRegistry);
                    const toolNames = [...registry.keys()];

                    // Create a session that explicitly attaches every worker
                    // tool. The SDK validator runs as part of the first send().
                    // If any registered name shadows a built-in without the
                    // override flag, send() throws synchronously with
                    // `External tool "<name>" conflicts with a built-in tool`.
                    const session = await client.createSession({ toolNames });

                    console.log(`  Sending hello with ${toolNames.length} attached tools`);
                    const response = await session.sendAndWait(
                        "Reply with the single word: hello",
                        TIMEOUT,
                    );

                    console.log(`  Response: "${response}"`);
                    assert(
                        response && !/conflicts with a built-in tool/i.test(response),
                        "Send must not surface SDK collision error",
                    );
                });
            } finally {
                await env.cleanup();
            }
        },
    );
});
