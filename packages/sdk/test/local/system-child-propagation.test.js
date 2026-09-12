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
import { handleSubAgentAction as handleFrozenSubAgentAction } from "../../src/orchestration_1_0_75/agents.ts";
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
            resolveAgentForRequiredTool: (name) => ({ __activity: "resolveAgentForRequiredTool", name }),
            // Signature: (parentSessionId, config, task, nestingLevel, isSystem, ..., requiredTool)
            spawnChildSession: (_parentId, _config, _task, _nesting, spawnIsSystem, _title, _agentId, _splash, _titleIsExplicit, requiredTool) => {
                captured.isSystem = spawnIsSystem;
                captured.requiredTool = requiredTool;
                captured.config = _config;
                return { __activity: "spawnChildSession" };
            },
            recordSessionEvent: () => ({ __activity: "recordSessionEvent" }),
            sendToSession: () => ({ __activity: "sendToSession" }),
        },
    };
    const responders = {
        resolveAgentConfig: () => agentDef,
        resolveAgentForRequiredTool: () => agentDef
            ? { status: "resolved", agent: agentDef, candidates: [agentDef.name] }
            : { status: "not_found", candidates: [] },
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

    it("an ad-hoc child does not inherit its parent's package binding or privileged roles", () => {
        const { runtime, captured, responders } = makeRuntime({ isSystem: false });
        runtime.state.config = {
            boundAgentName: "parent-agent",
            boundAgentPackageId: "parent-package",
            agentIdentity: "parent-agent",
            isCrawler: true,
            isHarvester: true,
            toolNames: ["package_catalog"],
        };
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", task: "Generic child" });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.config.boundAgentName, undefined);
        assertEqual(captured.config.boundAgentPackageId, undefined);
        assertEqual(captured.config.agentIdentity, undefined);
        assertEqual(captured.config.isCrawler, undefined);
        assertEqual(captured.config.isHarvester, undefined);
        assertEqual(captured.config.detachedPackageToolPolicy, "drop");
    });

    it("marks explicit ad-hoc tool names for detached-package rejection", () => {
        const { runtime, captured, responders } = makeRuntime({ isSystem: false });
        const gen = handleSubAgentAction(runtime, {
            type: "spawn_agent",
            task: "Generic child",
            toolNames: ["requested_tool"],
        });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.config.detachedPackageToolPolicy, "reject");
        assertEqual(captured.config.toolNames[0], "requested_tool");
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

    it("passes a named agent's initial required tool to its bootstrap activity", () => {
        const { runtime, captured, responders } = makeRuntime({
            isSystem: false,
            agentDef: {
                name: "catalog-analyst",
                id: "catalog-analyst",
                system: false,
                initialPrompt: "Inspect the catalog.",
                tools: ["package_catalog"],
                initialRequiredTool: "package_catalog",
            },
        });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", agentName: "catalog-analyst" });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.requiredTool, "package_catalog");
    });

    it("binds a named agent's complete definition without inventing a startup requirement", () => {
        const { runtime, captured, responders } = makeRuntime({
            isSystem: false,
            agentDef: {
                name: "catalog-analyst",
                id: "catalog-analyst",
                initialPrompt: "Inspect the catalog.",
                tools: ["package_catalog", "package_history"],
                packageId: "pkg-catalog",
                packageScope: "shared",
            },
        });
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", agentName: "catalog-analyst", task: "Inspect one shard." });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.requiredTool, undefined);
        assertEqual(captured.config.boundAgentName, "catalog-analyst");
        assertEqual(captured.config.toolNames.join(","), "package_catalog,package_history");
        assertEqual(captured.config.boundAgentPackageId, "pkg-catalog");
    });

    it.each([
        { requiredTool: "package_catalog" },
        { requiredTool: "package_catalog", agentName: "catalog-analyst" },
        { requiredTool: "package_catalog", task: "Inspect one shard" },
        { requiredTool: null, task: "Inspect one shard" },
        { requiredTool: "", task: "Inspect one shard" },
        { requiredTool: undefined, task: "Inspect one shard" },
        { required_tool: "package_catalog", task: "Inspect one shard" },
    ])("rejects stale selector action %j without scheduling a resolver or child", (args) => {
        const { runtime, captured, responders } = makeRuntime({ isSystem: false });
        runtime.manager.resolveAgentConfig = () => { throw new Error("must reject before name resolution"); };
        runtime.manager.resolveAgentForRequiredTool = () => { throw new Error("must not select by tool"); };
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", ...args });
        pump(gen, responders, () => Boolean(runtime.state.pendingPrompt));
        assertEqual(captured.isSystem, undefined);
        assertEqual(runtime.state.pendingPrompt.includes("required_tool is no longer supported by spawn_agent"), true);
        assertEqual(runtime.state.pendingPrompt.includes("ps_list_agents"), true);
        assertEqual(runtime.state.pendingPrompt.includes("agent_name"), true);
    });

    it("preserves capability resolution and package startup for frozen 1.0.75 history replay", () => {
        const { runtime, captured, responders } = makeRuntime({
            isSystem: false,
            agentDef: {
                name: "catalog-analyst",
                id: "catalog-analyst",
                initialPrompt: "Inspect the catalog.",
                tools: ["package_catalog", "package_init"],
                initialRequiredTool: "package_init",
                packageId: "pkg-catalog",
                packageScope: "shared",
            },
        });
        const gen = handleFrozenSubAgentAction(runtime, { type: "spawn_agent", requiredTool: "package_catalog" });
        pump(gen, responders, () => captured.isSystem !== undefined);
        assertEqual(captured.config.boundAgentName, "catalog-analyst");
        assertEqual(captured.requiredTool, "package_init");
    });
});
