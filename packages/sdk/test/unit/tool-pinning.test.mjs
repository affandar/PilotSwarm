// copilot-sdk 1.0.7 tool search defers "excess" tools behind tool_search_tool
// once a session declares more than the threshold (default 30). PilotSwarm
// sessions declare 40+, so without pinning, deferral engages and tools become
// invisible until the model thinks to search — a silent no-op factory for
// workflow-critical tools (the regen-tools lesson).
//
// pinToolsNeverDefer is applied at the single chokepoint where declarations
// reach the CLI (session-manager sessionConfig.tools). These tests pin the
// helper's contract; the wiring is one visible line at the chokepoint.
//
// Run: node --test test/unit/tool-pinning.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pinToolsNeverDefer } from "../../dist/tool-pinning.js";
import { ManagedSession } from "../../dist/managed-session.js";

test("tools without an explicit defer are pinned to never", () => {
    const tools = [
        { name: "spawn_agent", handler: async () => "ok" },
        { name: "store_fact", description: "d", parameters: {}, handler: async () => "ok" },
    ];
    const pinned = pinToolsNeverDefer(tools);
    assert.equal(pinned.length, 2);
    for (const tool of pinned) assert.equal(tool.defer, "never", tool.name);
});

test("an explicit defer on the definition is respected (phase-2 opt-out)", () => {
    const pinned = pinToolsNeverDefer([
        { name: "graph_stats", defer: "auto", handler: async () => "ok" },
        { name: "spawn_agent", handler: async () => "ok" },
    ]);
    assert.equal(pinned[0].defer, "auto", "definition-site defer must win");
    assert.equal(pinned[1].defer, "never");
});

test("pinning copies — shared tool definitions are never mutated", () => {
    const shared = [{ name: "wait", handler: async () => "ok" }];
    const pinned = pinToolsNeverDefer(shared);
    assert.equal(shared[0].defer, undefined, "source definition must stay untouched");
    assert.notEqual(pinned[0], shared[0], "must be a copy, not the same object");
});

test("handler identity and other fields survive the pin", () => {
    const handler = async () => "ok";
    const [pinned] = pinToolsNeverDefer([{
        name: "ask_user",
        description: "ask",
        parameters: { type: "object" },
        skipPermission: true,
        handler,
    }]);
    assert.equal(pinned.handler, handler);
    assert.equal(pinned.skipPermission, true);
    assert.equal(pinned.description, "ask");
    assert.deepEqual(pinned.parameters, { type: "object" });
});

test("empty and missing input degrade to an empty array", () => {
    assert.deepEqual(pinToolsNeverDefer([]), []);
    assert.deepEqual(pinToolsNeverDefer(undefined), []);
});

// The real tool sets are large enough that deferral WOULD engage without the
// pin — this documents that the threat is live, not hypothetical, and fails
// if the toolset ever shrinks below the threshold in a way that would make
// the pinning moot without anyone noticing.
test("system + sub-agent tool defs alone approach the deferral threshold", () => {
    const system = ManagedSession.systemToolDefs();
    const subAgent = ManagedSession.subAgentToolDefs();
    const count = system.length + subAgent.length;
    assert.ok(count >= 15, `expected a large toolset, saw ${count}`);
    const pinned = pinToolsNeverDefer([...system, ...subAgent]);
    for (const tool of pinned) assert.equal(tool.defer, "never", tool.name);
});
