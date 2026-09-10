import test from "node:test";
import assert from "node:assert/strict";
import { defineTool, SessionManager } from "../../dist/index.js";

const tool = (name) => defineTool(name, {
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    handler: async () => ({ ok: true }),
});

test("delegated custom sessions reject explicit or drop inherited detached package tools", () => {
    const manager = new SessionManager(undefined, null, {});
    const packageTool = tool("package_catalog");
    const staticTool = tool("deployment_tool");
    manager.setToolRegistry(
        new Map([["package_catalog", packageTool], ["deployment_tool", staticTool]]),
        {
            byPackage: new Map([["package-one", new Map([["package_catalog", packageTool]])]]),
            staticNames: new Set(["deployment_tool"]),
        },
    );

    assert.throws(
        () => manager._resolveTools(undefined, {
            toolNames: ["package_catalog"], detachedPackageToolPolicy: "reject",
        }),
        (error) => error?.code === "PACKAGE_TOOL_REQUIRES_BOUND_AGENT"
            && error?.toolName === "package_catalog",
    );
    assert.deepEqual(
        manager._resolveTools(undefined, {
            toolNames: ["package_catalog", "deployment_tool"], detachedPackageToolPolicy: "drop",
        }).map((item) => item.name),
        ["deployment_tool"],
    );
    assert.deepEqual(
        manager._resolveTools({ tools: [packageTool, staticTool] }, {
            detachedPackageToolPolicy: "drop",
        }).map((item) => item.name),
        ["deployment_tool"],
    );
    assert.deepEqual(
        manager._resolveTools(undefined, { toolNames: ["package_catalog"] }).map((item) => item.name),
        ["package_catalog"],
        "legacy direct SDK callers retain their existing unbound behavior",
    );
});

test("a package-bound session gets only its selected package handler", () => {
    const manager = new SessionManager(undefined, null, {});
    const first = tool("package_catalog");
    const second = tool("package_catalog");
    manager.setToolRegistry(new Map([["package_catalog", second]]), {
        byPackage: new Map([
            ["package-one", new Map([["package_catalog", first]])],
            ["package-two", new Map([["package_catalog", second]])],
        ]),
        staticNames: new Set(),
    });

    assert.equal(
        manager._resolveTools(undefined, { toolNames: ["package_catalog"] }, "package-one")[0],
        first,
    );
});