/**
 * Unit test: handleSubAgentAction propagates a system parent's isSystem to
 * the child it spawns.
 *
 * System sessions are ownerless. A spawned child inherits no owner, so its
 * ONLY route to a GitHub Copilot credential is the ownerless SYSTEM identity
 * (the admin-stored System key, which _resolveSessionGitHubToken resolves
 * only when the row is isSystem AND has no owner). The modular orchestration
 * dropped the parent->child isSystem propagation the pre-modular version had,
 * so a child spawned by a working system session was created ownerless AND
 * non-system and then failed GitHub Copilot turns with "GitHub Copilot key
 * not configured" — even though the parent ran fine on the System key.
 *
 * This drives handleSubAgentAction directly (no worker/LLM) and asserts the
 * child is spawned with isSystem = true whenever the parent runtime is a
 * system session, and inherits the agent-definition's own flag otherwise.
 *
 * Run: npx vitest run test/local/system-child-propagation.test.js
 */

import { describe, it } from "vitest";
import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { assertEqual } from "../helpers/assertions.js";

// Drive the generator far enough that the spawnChildSession activity is
// scheduled (the spy captures its args synchronously on the call). Benign
// mock returns satisfy any follow-on yields; we only care about the spawn.
function driveUntilSpawn(gen, isCaptured) {
    let step = gen.next();
    let guard = 0;
    while (!step.done && !isCaptured() && guard++ < 50) {
        step = gen.next("mock-child-session-id");
    }
}

function makeRuntime(optionsOverrides = {}) {
    const captured = {};
    const runtime = {
        ctx: { traceInfo: () => {} },
        state: { subAgents: [], config: {} },
        options: { isSystem: false, nestingLevel: 0, ...optionsOverrides },
        input: { sessionId: "parent-session" },
        manager: {
            // Signature: (parentSessionId, config, task, nestingLevel, isSystem, ...)
            spawnChildSession: (_parentId, _config, _task, _nesting, isSystem) => {
                captured.isSystem = isSystem;
                return { __activity: "spawnChildSession" };
            },
            // Any other manager methods the post-spawn path might touch are
            // harmless no-op yieldables — we stop at the spawn.
            recordSessionEvent: () => ({ __activity: "recordSessionEvent" }),
            sendToSession: () => ({ __activity: "sendToSession" }),
        },
    };
    return { runtime, captured };
}

describe("sub-agent isSystem propagation", () => {
    it("a system-session parent spawns its child as a system session", () => {
        const { runtime, captured } = makeRuntime({ isSystem: true });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", task: "Reply with DONE" });
        driveUntilSpawn(gen, () => captured.isSystem !== undefined);
        assertEqual(
            captured.isSystem,
            true,
            "child of a system session must be spawned as a system session so it can reach the System GHCP key",
        );
    });

    it("a non-system parent spawns a non-system custom child (no false positives)", () => {
        const { runtime, captured } = makeRuntime({ isSystem: false });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", task: "Reply with DONE" });
        driveUntilSpawn(gen, () => captured.isSystem !== undefined);
        assertEqual(
            captured.isSystem,
            false,
            "a custom child of a non-system session stays non-system (inherits the owner instead)",
        );
    });
});
