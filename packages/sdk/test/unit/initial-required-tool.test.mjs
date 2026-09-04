import assert from "node:assert/strict";
import test from "node:test";

import { resolveTopLevelAgentConfig } from "../../dist/orchestration/runtime.js";
import { createSessionManagerProxy } from "../../dist/session-proxy.js";

test("top-level named-agent resolution translates metadata into the pending turn contract", () => {
    const runtime = {
        ctx: { traceInfo: () => {} },
        input: { sessionId: "top-level", agentId: "catalog-analyst" },
        options: { isSystem: false },
        state: { iteration: 0, config: { toolNames: ["caller_tool"] }, pendingRequiredTool: undefined },
        manager: {
            resolveAgentConfig: () => ({ activity: "resolveAgentConfig" }),
        },
        session: null,
    };
    const generator = resolveTopLevelAgentConfig(runtime);

    assert.deepEqual(generator.next().value, { activity: "resolveAgentConfig" });
    assert.equal(generator.next({
        name: "catalog-analyst",
        tools: ["package_catalog"],
        initialRequiredTool: "package_catalog",
    }).done, true);
    assert.deepEqual(runtime.state.config.toolNames, ["package_catalog", "caller_tool"]);
    assert.equal(runtime.state.pendingRequiredTool, "package_catalog");
    assert.equal(Object.hasOwn(runtime.state.config, "initialRequiredTool"), false);
});

test("an explicit pending turn requirement wins over named-agent startup metadata", () => {
    const runtime = {
        ctx: { traceInfo: () => {} },
        input: { sessionId: "top-level", agentId: "catalog-analyst" },
        options: { isSystem: false },
        state: { iteration: 0, config: {}, pendingRequiredTool: "user_selected_tool" },
        manager: { resolveAgentConfig: () => ({ activity: "resolveAgentConfig" }) },
        session: null,
    };
    const generator = resolveTopLevelAgentConfig(runtime);

    assert.deepEqual(generator.next().value, { activity: "resolveAgentConfig" });
    assert.equal(generator.next({ initialRequiredTool: "package_catalog" }).done, true);
    assert.equal(runtime.state.pendingRequiredTool, "user_selected_tool");
});

test("legacy child activity payloads remain byte-shape compatible", () => {
    const scheduled = [];
    const manager = createSessionManagerProxy({
        scheduleActivity(name, input) {
            scheduled.push({ name, input });
            return { name, input };
        },
    });

    manager.spawnChildSession("parent", {}, "task", 1, false);
    manager.spawnChildSession("parent", {}, "task", 1, false, undefined, undefined, undefined, undefined, "package_catalog");

    assert.equal(Object.hasOwn(scheduled[0].input, "requiredTool"), false);
    assert.equal(scheduled[1].input.requiredTool, "package_catalog");
});
