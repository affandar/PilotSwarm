/**
 * Per-agent skill/tool restrictions + deployment capability catalog —
 * capability-profiles Phase 2 (pure, no database).
 *
 * Pins:
 *   1. Frontmatter parsing of `allowedSkills:` and the nested `toolPolicy:`
 *      block (allow/deny, list + inline forms, comment tolerance).
 *   2. Worker-side resolution: allowedSkills complements against the loaded
 *      skill catalog into per-agent DISABLED lists; toolPolicy is carried
 *      per agent; later same-name definitions override (never inherit).
 *   3. buildCapabilityCatalog(): names + metadata only — resolved MCP
 *      configs (credential-bearing) must never appear; tool groups come
 *      from the SDK manifest merged with session-policy toolGroups.
 *   4. Drift guard: every defineTool name in the factory modules appears in
 *      DEFAULT_TOOL_GROUPS, so new tools cannot silently ship ungrouped.
 *
 * Run: node --test test/unit/capability-catalog.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFiles } from "../../dist/agent-loader.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { DEFAULT_TOOL_GROUPS, resolveToolGroups, toolTier } from "../../dist/capability-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(dir, filename, frontmatter, body = "You are a test agent.") {
    fs.writeFileSync(path.join(dir, filename), `---\n${frontmatter.trim()}\n---\n\n${body}\n`);
}

function writeSkill(skillsDir, name, description) {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill body.\n`);
}

// ─── 1. Frontmatter parsing ─────────────────────────────────────

test("parses allowedSkills (block, inline, and explicitly empty forms)", () => {
    const dir = makeTmpDir("ps-cap-");
    writeAgent(dir, "block.agent.md", `
schemaVersion: 2
version: 1.0.0
name: block
allowedSkills:
  - deploy
  - "review"
`);
    writeAgent(dir, "inline.agent.md", `
schemaVersion: 2
version: 1.0.0
name: inline
allowedSkills: [deploy, review]
`);
    writeAgent(dir, "none.agent.md", `
schemaVersion: 2
version: 1.0.0
name: none
allowedSkills:
`);
    const byName = Object.fromEntries(loadAgentFiles(dir).map((a) => [a.name, a]));
    assert.deepEqual(byName.block.allowedSkills, ["deploy", "review"]);
    assert.deepEqual(byName.inline.allowedSkills, ["deploy", "review"]);
    assert.deepEqual(byName.none.allowedSkills, [], "empty allowedSkills is a valid no-skills restriction");
});

test("parses nested toolPolicy with deny list and allow inline array", () => {
    const dir = makeTmpDir("ps-cap-");
    writeAgent(dir, "deny.agent.md", `
schemaVersion: 2
version: 1.0.0
name: denyagent
toolPolicy:
  # keep this agent away from shell + spawning
  deny:
    - bash
    - spawn_agent
`);
    writeAgent(dir, "allow.agent.md", `
schemaVersion: 2
version: 1.0.0
name: allowagent
toolPolicy:
  allow: ["read_facts", "store_fact"]
`);
    writeAgent(dir, "after.agent.md", `
schemaVersion: 2
version: 1.0.0
name: afteragent
toolPolicy:
  deny: [bash]
title: After Block
`);
    const byName = Object.fromEntries(loadAgentFiles(dir).map((a) => [a.name, a]));
    assert.deepEqual(byName.denyagent.toolPolicy, { deny: ["bash", "spawn_agent"] });
    assert.deepEqual(byName.allowagent.toolPolicy, { allow: ["read_facts", "store_fact"] });
    assert.deepEqual(byName.afteragent.toolPolicy, { deny: ["bash"] });
    assert.equal(byName.afteragent.title, "After Block", "top-level key after the nested block still parses");
});

test("toolPolicy survives trailing comments, flow-map form, and empty allow (review regressions)", () => {
    const dir = makeTmpDir("ps-cap-");
    writeAgent(dir, "trailing.agent.md", `
schemaVersion: 2
version: 1.0.0
name: trailing
toolPolicy: # keep this agent read-only
  deny:
    - bash
`);
    writeAgent(dir, "flowmap.agent.md", `
schemaVersion: 2
version: 1.0.0
name: flowmap
toolPolicy: { allow: [view, "grep"], deny: [bash] }
`);
    writeAgent(dir, "emptyallow.agent.md", `
schemaVersion: 2
version: 1.0.0
name: emptyallow
toolPolicy:
  allow: []
`);
    const byName = Object.fromEntries(loadAgentFiles(dir).map((a) => [a.name, a]));
    assert.deepEqual(byName.trailing.toolPolicy, { deny: ["bash"] }, "trailing comment must not fail the restriction open");
    assert.deepEqual(byName.flowmap.toolPolicy, { allow: ["view", "grep"], deny: ["bash"] }, "flow-map spelling parses");
    assert.deepEqual(byName.emptyallow.toolPolicy, { allow: [] }, "explicit empty allow = floor-only restriction, kept");
});

// ─── 2. Worker-side resolution ──────────────────────────────────

function buildFixturePlugin() {
    const pluginDir = makeTmpDir("ps-cap-plugin-");
    fs.writeFileSync(path.join(pluginDir, ".mcp.json"), JSON.stringify({
        github: { type: "http", url: "https://mcp.example.com/github", tools: ["*"], headers: { Authorization: "Bearer super-secret-token" }, default: true },
    }, null, 2));
    const skillsDir = path.join(pluginDir, "skills");
    writeSkill(skillsDir, "deploy", "Deploys things");
    writeSkill(skillsDir, "review", "Reviews things");
    writeSkill(skillsDir, "audit", "Audits things");
    const agentsDir = path.join(pluginDir, "agents");
    fs.mkdirSync(agentsDir);
    writeAgent(agentsDir, "restricted.agent.md", `
schemaVersion: 2
version: 1.0.0
name: restricted
inheritDefaultMcpServers: true
allowedSkills:
  - deploy
toolPolicy:
  deny:
    - bash
`);
    writeAgent(agentsDir, "noskills.agent.md", `
schemaVersion: 2
version: 1.0.0
name: noskills
allowedSkills:
`);
    writeAgent(agentsDir, "open.agent.md", `
schemaVersion: 1
version: 1.0.0
name: open
`);
    return pluginDir;
}

function buildWorker(pluginDirs) {
    const stateDir = makeTmpDir("ps-cap-state-");
    return new PilotSwarmWorker({
        sessionStateDir: path.join(stateDir, "session-state"),
        pluginDirs: Array.isArray(pluginDirs) ? pluginDirs : [pluginDirs],
        workerNodeId: "test-capability-catalog",
    });
}

test("allowedSkills complements into per-agent disabled lists", () => {
    // The skill catalog = fixture skills + the SDK's bundled system-plugin
    // skills (sweeper, resourcemgr, …), so assert set relationships rather
    // than exact lists.
    const worker = buildWorker(buildFixturePlugin());
    assert.deepEqual(worker.agentAllowedSkills.restricted, ["deploy"]);
    const disabled = worker.agentDisabledSkills.restricted;
    assert.ok(!disabled.includes("deploy"), "allowed skill is not disabled");
    assert.ok(disabled.includes("audit") && disabled.includes("review"), "unallowed fixture skills are disabled");
    const allDisabled = worker.agentDisabledSkills.noskills;
    for (const name of ["audit", "deploy", "review"]) {
        assert.ok(allDisabled.includes(name), `empty allowedSkills disables ${name}`);
    }
    assert.equal(worker.agentDisabledSkills.open, undefined, "unrestricted agent has no disabled list");
    assert.deepEqual(worker.agentToolPolicy.restricted, { deny: ["bash"] });
    assert.equal(worker.agentToolPolicy.open, undefined);
});

test("worker scrubs bare-wildcard toolPolicy entries and keeps empty allow", () => {
    const pluginDir = makeTmpDir("ps-cap-plugin-w-");
    fs.mkdirSync(path.join(pluginDir, "agents"));
    writeAgent(path.join(pluginDir, "agents"), "wild.agent.md", `
schemaVersion: 2
version: 1.0.0
name: wild
toolPolicy:
  deny: ["*", bash]
`);
    writeAgent(path.join(pluginDir, "agents"), "flooronly.agent.md", `
schemaVersion: 2
version: 1.0.0
name: flooronly
toolPolicy:
  allow: []
`);
    const worker = buildWorker(pluginDir);
    assert.deepEqual(worker.agentToolPolicy.wild, { deny: ["bash"] }, "bare * dropped (SDK rejects it), rest kept");
    assert.deepEqual(worker.agentToolPolicy.flooronly, { allow: [] }, "empty allow survives resolution");
});

test("a later same-name definition without restrictions clears shadowed ones", () => {
    const pluginA = buildFixturePlugin();
    const pluginB = makeTmpDir("ps-cap-plugin-b-");
    fs.mkdirSync(path.join(pluginB, "agents"));
    writeAgent(path.join(pluginB, "agents"), "restricted.agent.md", `
schemaVersion: 2
version: 2.0.0
name: restricted
`, "Unrestricted override.");
    const worker = buildWorker([pluginA, pluginB]);
    assert.equal(worker.agentDisabledSkills.restricted, undefined, "override cleared the skill restriction");
    assert.equal(worker.agentToolPolicy.restricted, undefined, "override cleared the tool policy");
});

// ─── 3. Capability catalog ──────────────────────────────────────

test("buildCapabilityCatalog reports names and metadata only — no credentials", () => {
    const worker = buildWorker(buildFixturePlugin());
    const catalog = worker.buildCapabilityCatalog();

    assert.deepEqual(catalog.mcpServers, [{ name: "github", isDefault: true, tier: "default" }]);
    const skillNames = catalog.skills.map((s) => s.name);
    for (const name of ["audit", "deploy", "review"]) {
        assert.ok(skillNames.includes(name), `catalog lists fixture skill ${name}`);
    }
    assert.equal(catalog.skills.find((s) => s.name === "deploy").description, "Deploys things");

    const serialized = JSON.stringify(catalog);
    assert.ok(!serialized.includes("super-secret-token"), "resolved server configs must never reach the catalog");
    assert.ok(!serialized.includes("mcp.example.com"), "server URLs must never reach the catalog");

    const toolsByName = Object.fromEntries(catalog.tools.map((t) => [t.name, t]));
    assert.equal(toolsByName.store_fact.group, "facts");
    assert.equal(toolsByName.spawn_agent.group, "sub-agents");
    assert.equal(toolsByName.write_artifact.group, "artifacts");

    assert.deepEqual(catalog.agentDefaults.restricted, {
        mcpServers: ["github"],
        skills: ["deploy"],
        tools: [],
        toolPolicy: { deny: ["bash"] },
    });
    assert.equal(catalog.agentDefaults.open.skills, null, "unrestricted agent reports null (all skills)");
});

test("catalog marks durable-floor tools locked and carries skill requiredTools", () => {
    // Bundled system skills declare tools.json (sweeper/resourcemgr); the
    // worker also loads the fixture skills. Assert the shape rather than a
    // fixed set.
    const worker = buildWorker(buildFixturePlugin());
    const catalog = worker.buildCapabilityCatalog();
    const toolsByName = Object.fromEntries(catalog.tools.map((t) => [t.name, t]));

    for (const floor of ["wait", "wait_on_worker", "report_cycle", "ask_user", "update_session_summary"]) {
        assert.equal(toolsByName[floor]?.locked, true, `${floor} must be a locked base tool`);
    }
    assert.ok(!toolsByName.bash?.locked, "bash is a normal removable tool, not locked");
    assert.ok(!toolsByName.spawn_agent?.locked, "sub-agent tools are default-on but removable, not locked");

    // A skill with a tools.json exposes requiredTools; one without omits it.
    const sweeper = catalog.skills.find((s) => s.name === "sweeper");
    assert.ok(Array.isArray(sweeper?.requiredTools) && sweeper.requiredTools.includes("scan_completed_sessions"),
        "sweeper skill carries its required tools");
    const deploy = catalog.skills.find((s) => s.name === "deploy");
    assert.equal(deploy?.requiredTools, undefined, "a skill with no tools.json omits requiredTools");
});

test("toolTier: floor→base, graph→extended, observability/maintenance→system, rest→default", () => {
    assert.equal(toolTier("wait", "session"), "base", "floor tool is base regardless of group");
    assert.equal(toolTier("graph_stats", "graph"), "extended");
    assert.equal(toolTier("read_fleet_stats", "observability"), "system");
    assert.equal(toolTier("compact_database", "maintenance"), "system");
    assert.equal(toolTier("store_fact", "facts"), "default");
    assert.equal(toolTier("bash", "session"), "default", "non-floor session tool is default");
    assert.equal(toolTier("unknown_tool", undefined), "default");
});

test("buildCapabilityCatalog assigns a tier to every tool, MCP server, and tiered skill", () => {
    const worker = buildWorker(buildFixturePlugin());
    const catalog = worker.buildCapabilityCatalog();

    const tools = Object.fromEntries(catalog.tools.map((t) => [t.name, t]));
    assert.equal(tools.wait.tier, "base");
    assert.equal(tools.wait.locked, true, "base tools keep the locked alias");
    assert.equal(tools.store_fact.tier, "default");
    assert.equal(tools.graph_stats.tier, "extended");
    assert.equal(tools.read_fleet_stats.tier, "system");
    assert.equal(tools.compact_database.tier, "system");

    // MCP: the fixture's github server is default:true → "default" tier.
    const github = catalog.mcpServers.find((s) => s.name === "github");
    assert.equal(github.tier, "default");

    // Skills carry frontmatter group + tier; sweeper/resourcemgr are system.
    const sweeper = catalog.skills.find((s) => s.name === "sweeper");
    assert.equal(sweeper?.tier, "system");
    assert.equal(sweeper?.group, "System playbooks");
    const durable = catalog.skills.find((s) => s.name === "durable-timers");
    assert.equal(durable?.group, "Durable execution");
    assert.equal(durable?.tier, undefined, "default-tier skills omit the tier field");
});

test("session-policy toolGroups extends and overrides the SDK manifest", () => {
    const pluginDir = buildFixturePlugin();
    fs.writeFileSync(path.join(pluginDir, "session-policy.json"), JSON.stringify({
        version: 1,
        creation: { mode: "open", allowGeneric: true },
        toolGroups: { custom: ["my_app_tool"], relocated: ["store_fact"] },
    }, null, 2));
    const worker = buildWorker(pluginDir);
    const catalog = worker.buildCapabilityCatalog();
    const toolsByName = Object.fromEntries(catalog.tools.map((t) => [t.name, t]));
    assert.equal(toolsByName.my_app_tool.group, "custom", "policy can group app tools");
    assert.equal(toolsByName.store_fact.group, "relocated", "policy wins over the SDK manifest");
});

// ─── 4. Drift guard: manifest vs factory defineTool names ───────

test("every factory defineTool name is grouped in DEFAULT_TOOL_GROUPS", () => {
    const factoryModules = [
        "managed-session.ts", "facts-tools.ts", "graph-tools.ts",
        "inspect-tools.ts", "artifact-tools.ts", "sweeper-tools.ts",
        "resourcemgr-tools.ts",
    ];
    const srcDir = path.resolve(__dirname, "../../src");
    const declared = new Set();
    for (const module of factoryModules) {
        const source = fs.readFileSync(path.join(srcDir, module), "utf-8");
        for (const match of source.matchAll(/defineTool[<(][^,"]*"([a-z_]+)"/g)) {
            declared.add(match[1]);
        }
    }
    assert.ok(declared.size > 50, `sanity: expected a substantial tool set, saw ${declared.size}`);
    const ungrouped = [...declared].filter((name) => !DEFAULT_TOOL_GROUPS[name]);
    assert.deepEqual(ungrouped, [], `factory tools missing from DEFAULT_TOOL_GROUPS: ${ungrouped.join(", ")}`);
});

test("resolveToolGroups merges policy groups over defaults", () => {
    const merged = resolveToolGroups({ mygroup: ["newtool", "bash"] });
    assert.equal(merged.newtool, "mygroup");
    assert.equal(merged.bash, "mygroup", "policy overrides the default group");
    assert.equal(merged.store_fact, "facts", "unrelated defaults intact");
});
