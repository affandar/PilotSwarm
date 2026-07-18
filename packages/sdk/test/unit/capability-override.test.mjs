/**
 * Session capability overrides — capability-profiles Phases 3/4 (pure).
 *
 * Pins the override model: normalization of untrusted payloads (axis
 * whitelisting, dedupe, catalog validation with drop-and-report), the tools
 * axis resolution (group expansion, individual-beats-group, disable-wins),
 * and the rebind fingerprint's stability.
 *
 * Run: node --test test/unit/capability-override.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizeCapabilityOverride,
    resolveToolAxis,
    expandToolNames,
    fingerprintCapabilityOverride,
    composeToolFilters,
} from "../../dist/capability-override.js";
import { PROTOCOL_FLOOR_TOOLS } from "../../dist/capability-catalog.js";

const GROUPS = {
    facts: ["store_fact", "read_facts", "delete_fact"],
    graph: ["graph_stats", "graph_search_nodes"],
};

test("normalize keeps only known axes and non-empty deduped string lists", () => {
    const { override, dropped } = normalizeCapabilityOverride({
        mcpServers: { enable: ["github", "github", "  ", 42], disable: [] },
        skills: { disable: ["deploy"] },
        tools: { enable: ["facts"] },
        bogusAxis: { enable: ["x"] },
    });
    assert.deepEqual(override, {
        mcpServers: { enable: ["github"] },
        skills: { disable: ["deploy"] },
        tools: { enable: ["facts"] },
    });
    assert.deepEqual(dropped, {});
});

test("normalize returns null for empty or non-object payloads", () => {
    assert.equal(normalizeCapabilityOverride(null).override, null);
    assert.equal(normalizeCapabilityOverride("nope").override, null);
    assert.equal(normalizeCapabilityOverride({ skills: { enable: [] } }).override, null);
});

test("validators drop unknown names and report them per axis", () => {
    const { override, dropped } = normalizeCapabilityOverride(
        {
            mcpServers: { enable: ["github", "unknown-server"] },
            tools: { disable: ["facts", "not-a-tool"] },
        },
        {
            mcpServers: (name) => name === "github",
            tools: (name) => name === "facts" || name === "store_fact",
        },
    );
    assert.deepEqual(override, {
        mcpServers: { enable: ["github"] },
        tools: { disable: ["facts"] },
    });
    assert.deepEqual(dropped, {
        mcpServers: ["unknown-server"],
        tools: ["not-a-tool"],
    });
});

test("expandToolNames expands groups and passes individual names through", () => {
    const expanded = expandToolNames(["facts", "bash"], GROUPS);
    assert.deepEqual([...expanded].sort(), ["bash", "delete_fact", "read_facts", "store_fact"]);
});

test("resolveToolAxis: individual entry overrides its group", () => {
    // Disable the facts group but re-enable store_fact individually.
    const { enabled, disabled } = resolveToolAxis(
        { enable: ["store_fact"], disable: ["facts"] },
        GROUPS,
    );
    assert.ok(!disabled.has("store_fact"), "individually-enabled tool escapes its disabled group");
    assert.ok(disabled.has("read_facts") && disabled.has("delete_fact"), "rest of the group stays disabled");
    assert.ok(enabled.has("store_fact"));
});

test("resolveToolAxis: disable wins at equal specificity", () => {
    const both = resolveToolAxis({ enable: ["bash"], disable: ["bash"] }, GROUPS);
    assert.ok(both.disabled.has("bash") && !both.enabled.has("bash"), "individual vs individual: disable wins");

    const groups = resolveToolAxis({ enable: ["facts"], disable: ["facts"] }, GROUPS);
    assert.ok(groups.disabled.has("store_fact") && !groups.enabled.has("store_fact"), "group vs group: disable wins");
});

const FLOOR = [...PROTOCOL_FLOOR_TOOLS];

test("composeToolFilters: no policy/override yields only the task floor", () => {
    const { excludedTools, availableTools } = composeToolFilters({
        groupMembers: GROUPS, protocolFloor: FLOOR, hasMcpServers: false,
    });
    assert.deepEqual(excludedTools, ["task"]);
    assert.equal(availableTools, undefined);
});

test("composeToolFilters: protocol floor is NEVER excludable (brick guard)", () => {
    // Directly naming a floor tool, and disabling the group that contains it.
    for (const attempt of [
        { tools: { disable: ["report_cycle", "wait", "ask_user"] } },
        { tools: { disable: ["session"] } }, // a group that expands to floor tools
    ]) {
        const { excludedTools } = composeToolFilters({
            agentPolicy: { deny: ["report_cycle"] },
            override: attempt.tools,
            groupMembers: { ...GROUPS, session: ["wait", "ask_user", "report_cycle", "bash"] },
            protocolFloor: FLOOR,
            hasMcpServers: false,
        });
        for (const floorTool of FLOOR) {
            assert.ok(!excludedTools.includes(floorTool), `${floorTool} must never be excluded (attempt ${JSON.stringify(attempt)})`);
        }
    }
});

test("composeToolFilters: bare '*' is never emitted into either list", () => {
    const { excludedTools, availableTools } = composeToolFilters({
        agentPolicy: { allow: ["read_facts"], deny: ["*"] },
        override: { enable: ["*"], disable: ["*"] },
        groupMembers: GROUPS, protocolFloor: FLOOR, hasMcpServers: true,
    });
    assert.ok(!excludedTools.includes("*"));
    assert.ok(!availableTools.includes("*"));
});

test("composeToolFilters: allow-mode retains floor + mcp:* and honors empty allow", () => {
    const empty = composeToolFilters({
        agentPolicy: { allow: [] }, groupMembers: GROUPS, protocolFloor: FLOOR, hasMcpServers: true,
    });
    // Empty allow = "floor only", but still usable: floor + mcp:* present.
    for (const f of FLOOR) assert.ok(empty.availableTools.includes(f), `floor tool ${f} retained in allow-mode`);
    assert.ok(empty.availableTools.includes("mcp:*"), "granted MCP servers retained in allow-mode");

    const noMcp = composeToolFilters({
        agentPolicy: { allow: ["read_facts"] }, groupMembers: GROUPS, protocolFloor: FLOOR, hasMcpServers: false,
    });
    assert.ok(!noMcp.availableTools.includes("mcp:*"), "no mcp:* when no servers granted");
    assert.ok(noMcp.availableTools.includes("read_facts"));
});

test("composeToolFilters: deny-mode excludes non-floor tools, override-enable lifts agent deny", () => {
    const { excludedTools, availableTools } = composeToolFilters({
        agentPolicy: { deny: ["bash", "graph_stats"] },
        override: { enable: ["bash"] },
        groupMembers: GROUPS, protocolFloor: FLOOR, hasMcpServers: false,
    });
    assert.equal(availableTools, undefined, "deny-only stays in deny-mode");
    assert.ok(excludedTools.includes("graph_stats"), "un-lifted agent deny stays excluded");
    assert.ok(!excludedTools.includes("bash"), "override-enable lifts the agent deny");
    assert.ok(excludedTools.includes("task"), "task floor always excluded");
});

test("fingerprint is order-insensitive and empty for no override", () => {
    assert.equal(fingerprintCapabilityOverride(null), "");
    assert.equal(fingerprintCapabilityOverride(undefined), "");
    const a = fingerprintCapabilityOverride({ tools: { disable: ["b", "a"] }, skills: { enable: ["s"] } });
    const b = fingerprintCapabilityOverride({ skills: { enable: ["s"] }, tools: { disable: ["a", "b"] } });
    assert.equal(a, b, "same content, different ordering → same fingerprint");
    const c = fingerprintCapabilityOverride({ tools: { disable: ["a"] } });
    assert.notEqual(a, c);
});

test("migration registry carries 0035 and 0036 in order", async () => {
    const { CMS_MIGRATIONS } = await import("../../dist/cms-migrations.js");
    const versions = CMS_MIGRATIONS("shape_check").map((m) => m.version);
    const i35 = versions.indexOf("0035");
    const i36 = versions.indexOf("0036");
    assert.ok(i35 >= 0 && i36 === i35 + 1, "0036 follows 0035");
    const m36 = CMS_MIGRATIONS("shape_check").find((m) => m.version === "0036");
    assert.match(m36.sql, /capability_override JSONB/);
    assert.match(m36.sql, /cms_get_capability_override/);
});
