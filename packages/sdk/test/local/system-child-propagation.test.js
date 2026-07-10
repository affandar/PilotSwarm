/**
 * Unit tests: what isSystem a spawned child gets from handleSubAgentAction.
 *
 * Contract (post effective-owner-inheritance fix):
 *   - a SYSTEM parent does NOT make its ad-hoc children system — they stay
 *     ordinary deletable sessions and inherit the SYSTEM user as their OWNER
 *     instead (resolveEffectiveSpawnOwner inside the spawnChildSession
 *     activity), which is how they reach the admin-stored System GHCP key;
 *   - the agent DEFINITION's own `system` flag still drives isSystem (the
 *     worker-managed system agents bootstrap through this and must keep
 *     their protected is_system rows).
 *
 * Run: npx vitest run test/local/system-child-propagation.test.js
 */

import { describe, it } from "vitest";
import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { assertEqual } from "../helpers/assertions.js";

// Pump the generator, answering each yielded manager-activity marker via
// `responders` until the spawn is captured (or the generator finishes).
function pump(gen, responders, isDone) {
    let step = gen.next();
    let guard = 0;
    while (!step.done && !isDone() && guard++ < 100) {
        const tag = step.value?.__activity;
        const responder = tag ? responders[tag] : undefined;
        step = gen.next(responder ? responder(step.value) : undefined);
    }
}

function makeRuntime({ isSystem, agentDef = null }) {
    const captured = {};
    const runtime = {
        ctx: { traceInfo: () => {} },
        state: { subAgents: [], config: {} },
        options: { isSystem, nestingLevel: 0 },
        input: { sessionId: "parent-session" },
        manager: {
            resolveAgentConfig: (name) => ({ __activity: "resolveAgentConfig", name }),
            // Signature: (parentSessionId, config, task, nestingLevel, isSystem, ...)
            spawnChildSession: (_parentId, _config, _task, _nesting, spawnIsSystem) => {
                captured.isSystem = spawnIsSystem;
                return { __activity: "spawnChildSession" };
            },
            recordSessionEvent: () => ({ __activity: "recordSessionEvent" }),
            sendToSession: () => ({ __activity: "sendToSession" }),
        },
    };
    const responders = {
        resolveAgentConfig: () => agentDef,
        spawnChildSession: () => "mock-child-session-id",
    };
    return { runtime, captured, responders };
}

describe("sub-agent isSystem contract", () => {
    it("a SYSTEM parent's ad-hoc child is NOT a system session", () => {
        const { runtime, captured, responders } = makeRuntime({ isSystem: true });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", task: "Reply with DONE" });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(
            captured.isSystem,
            false,
            "children of system sessions stay ordinary deletable sessions (they inherit the System OWNER instead)",
        );
    });

    it("a non-system parent's ad-hoc child is not a system session either", () => {
        const { runtime, captured, responders } = makeRuntime({ isSystem: false });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", task: "Reply with DONE" });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.isSystem, false);
    });

    it("an agent DEFINITION with system:true still spawns a system child (worker-managed agents)", () => {
        const { runtime, captured, responders } = makeRuntime({
            isSystem: false,
            agentDef: { name: "managed-sys", id: "managed-sys", system: true, title: "Managed", initialPrompt: "Go." },
        });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", agentName: "managed-sys" });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.isSystem, true, "definition-driven system flag is preserved");
    });

    it("a SYSTEM parent spawning a NON-system agent definition does not upgrade it to system", () => {
        const { runtime, captured, responders } = makeRuntime({
            isSystem: true,
            agentDef: { name: "helper", id: "helper", system: false, title: "Helper", initialPrompt: "Go." },
        });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", agentName: "helper" });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.isSystem, false, "parent system-ness must not leak into definition-driven children");
    });
});
