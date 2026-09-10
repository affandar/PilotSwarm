import test from "node:test";
import assert from "node:assert/strict";
import { findReservedPackageToolName } from "../../dist/reserved-tool-names.js";

test("Copilot-native and PilotSwarm control names are reserved", () => {
    assert.equal(findReservedPackageToolName(["domain_tool", "read_agent"], [], []), "read_agent");
    assert.equal(findReservedPackageToolName(["spawn_agent"], ["spawn_agent"], []), "spawn_agent");
});

test("deployment tool names are reserved", () => {
    assert.equal(findReservedPackageToolName(["domain_tool"], [], ["domain_tool"]), "domain_tool");
});

test("domain-specific package names remain available", () => {
    assert.equal(findReservedPackageToolName(["domain_catalog"], ["spawn_agent"], ["app_tool"]), null);
});
