import assert from "node:assert/strict";
import test from "node:test";

import { consumeInitialRequiredTool } from "../../dist/orchestration/queue.js";
import { resolveTopLevelAgentConfig } from "../../dist/orchestration/runtime.js";
import { createSessionManagerProxy } from "../../dist/session-proxy.js";

test("the first prompt consumes a named agent's initial required tool", () => {
    const state = { config: { initialRequiredTool: "package_catalog" } };

    assert.equal(consumeInitialRequiredTool(state), "package_catalog");
    assert.equal(state.config.initialRequiredTool, undefined);
    assert.equal(consumeInitialRequiredTool(state), undefined, "later turns must not re-enforce startup");
});

test("an explicit turn requirement wins while startup metadata is still consumed", () => {
    const state = { config: { initialRequiredTool: "package_catalog" } };

    assert.equal(consumeInitialRequiredTool(state, "user_selected_tool"), "user_selected_tool");
    assert.equal(state.config.initialRequiredTool, undefined);
});

test("top-level named-agent resolution binds its initial required tool", () => {
    const runtime = {
        ctx: { traceInfo: () => {} },
        input: { sessionId: "top-level", agentId: "catalog-analyst" },
        options: { isSystem: false },
        state: { iteration: 0, config: { toolNames: ["caller_tool"] } },
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
    assert.equal(runtime.state.config.initialRequiredTool, "package_catalog");
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

    assert.equal(Object.hasOwn(scheduled[0].input, "initialRequiredTool"), false);
    assert.equal(scheduled[1].input.initialRequiredTool, "package_catalog");
});