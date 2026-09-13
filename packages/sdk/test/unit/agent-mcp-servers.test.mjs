/**
 * Per-agent MCP servers — capability-profiles Phase 1 (pure, no database).
 *
 * Pins the three layers of the feature:
 *   1. agent-loader parses `mcpServers:` (named catalog references) and
 *      `inheritDefaultMcpServers:` frontmatter, and accepts schemaVersion 2.
 *   2. The worker resolves each agent's references against the merged
 *      .mcp.json catalog at load time: `"default": true` servers form the
 *      deployment default set (granted only via inheritDefaultMcpServers),
 *      unknown references are dropped, and the `default` tag is stripped
 *      before configs can reach the Copilot CLI.
 *   3. The composed customAgents surface (worker.loadedAgents) carries the
 *      RESOLVED server map — not the frontmatter's name list, and not the
 *      inherit flag.
 *
 * Run: node --test test/unit/agent-mcp-servers.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAgentFiles } from "../../dist/agent-loader.js";
import { PilotSwarmWorker } from "../../dist/worker.js";

function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(dir, filename, frontmatter, body = "You are a test agent.") {
    fs.writeFileSync(path.join(dir, filename), `---\n${frontmatter.trim()}\n---\n\n${body}\n`);
}

// ─── 1. Frontmatter parsing ─────────────────────────────────────

test("parses mcpServers block list and inheritDefaultMcpServers", () => {
    const dir = makeTmpDir("ps-agent-mcp-");
    writeAgent(dir, "researcher.agent.md", `
schemaVersion: 2
version: 1.0.0
name: researcher
mcpServers:
  - github
  - jira
inheritDefaultMcpServers: true
`);
    const [agent] = loadAgentFiles(dir);
    assert.ok(agent, "agent should load");
    assert.deepEqual(agent.mcpServers, ["github", "jira"]);
    assert.equal(agent.inheritDefaultMcpServers, true);
});

test("parses inline-array mcpServers form", () => {
    const dir = makeTmpDir("ps-agent-mcp-");
    writeAgent(dir, "inline.agent.md", `
schemaVersion: 2
version: 1.0.0
name: inline
mcpServers: [github, jira]
`);
    const [agent] = loadAgentFiles(dir);
    assert.deepEqual(agent.mcpServers, ["github", "jira"]);
});

test("agents without MCP frontmatter carry no MCP fields", () => {
    const dir = makeTmpDir("ps-agent-mcp-");
    writeAgent(dir, "plain.agent.md", `
schemaVersion: 1
version: 1.0.0
name: plain
`);
    const [agent] = loadAgentFiles(dir);
    assert.equal(agent.mcpServers, undefined);
    assert.equal(agent.inheritDefaultMcpServers, undefined);
});

test("inheritDefaultMcpServers: false parses (and YAML comments are tolerated)", () => {
    const dir = makeTmpDir("ps-agent-mcp-");
    writeAgent(dir, "optout.agent.md", `
schemaVersion: 1
version: 1.0.0
name: optout
# comment with a colon: still fine
inheritDefaultMcpServers: false
tools:
  - bash
`);
    const [agent] = loadAgentFiles(dir);
    assert.equal(agent.inheritDefaultMcpServers, false);
    assert.deepEqual(agent.tools, ["bash"]);
});

test("schemaVersions 2, 3 and 4 load; unknown versions are skipped", () => {
    const dir = makeTmpDir("ps-agent-mcp-");
    writeAgent(dir, "v2.agent.md", `
schemaVersion: 2
version: 1.0.0
name: v2
`);
    writeAgent(dir, "v3.agent.md", `
schemaVersion: 3
version: 1.0.0
name: v3
`);
    writeAgent(dir, "v4.agent.md", `
schemaVersion: 4
version: 1.0.0
name: v4
`);
    writeAgent(dir, "future.agent.md", `
schemaVersion: 5
version: 1.0.0
name: future
`);
    const agents = loadAgentFiles(dir);
    assert.deepEqual(agents.map((a) => a.name), ["v2", "v3", "v4"]);
});

// ─── 2 + 3. Worker-side catalog resolution ──────────────────────

function buildFixturePlugin() {
    const pluginDir = makeTmpDir("ps-mcp-plugin-");
    fs.writeFileSync(path.join(pluginDir, ".mcp.json"), JSON.stringify({
        github: { type: "http", url: "https://mcp.example.com/github", tools: ["*"], default: true },
        jira: { type: "http", url: "https://mcp.example.com/jira", tools: ["*"] },
    }, null, 2));
    const agentsDir = path.join(pluginDir, "agents");
    fs.mkdirSync(agentsDir);
    writeAgent(agentsDir, "withref.agent.md", `
schemaVersion: 2
version: 1.0.0
name: withref
mcpServers:
  - jira
`);
    writeAgent(agentsDir, "inheriting.agent.md", `
schemaVersion: 2
version: 1.0.0
name: inheriting
inheritDefaultMcpServers: true
`);
    writeAgent(agentsDir, "both.agent.md", `
schemaVersion: 2
version: 1.0.0
name: both
inheritDefaultMcpServers: true
mcpServers:
  - jira
`);
    writeAgent(agentsDir, "badref.agent.md", `
schemaVersion: 2
version: 1.0.0
name: badref
mcpServers:
  - nonexistent
`);
    writeAgent(agentsDir, "plain.agent.md", `
schemaVersion: 1
version: 1.0.0
name: plainagent
`);
    return pluginDir;
}

function buildWorker(pluginDirs) {
    const stateDir = makeTmpDir("ps-mcp-state-");
    return new PilotSwarmWorker({
        sessionStateDir: path.join(stateDir, "session-state"),
        pluginDirs: Array.isArray(pluginDirs) ? pluginDirs : [pluginDirs],
        workerNodeId: "test-agent-mcp",
    });
}

test("worker resolves per-agent MCP maps against the catalog", () => {
    const worker = buildWorker(buildFixturePlugin());

    // Default set = servers tagged "default": true.
    assert.deepEqual(worker.defaultMcpServerNames, ["github"]);

    const maps = worker.agentMcpServers;
    assert.deepEqual(Object.keys(maps.withref), ["jira"]);
    assert.deepEqual(Object.keys(maps.inheriting), ["github"]);
    assert.deepEqual(Object.keys(maps.both).sort(), ["github", "jira"]);
    assert.equal(maps.badref, undefined, "unknown reference resolves to no map");
    assert.equal(maps.plainagent, undefined, "undeclared agent gets no map");
});

test("the default tag is stripped from catalog configs before session use", () => {
    const worker = buildWorker(buildFixturePlugin());
    assert.ok(worker.loadedMcpServers.github, "github stays in the catalog");
    assert.equal("default" in worker.loadedMcpServers.github, false, "default tag stripped");
    const inheritedGithub = worker.agentMcpServers.inheriting.github;
    assert.equal("default" in inheritedGithub, false, "resolved maps carry no default tag");
    assert.equal(inheritedGithub.url, "https://mcp.example.com/github");
});

test("loadedAgents (customAgents surface) carries resolved maps, not name lists", () => {
    const worker = buildWorker(buildFixturePlugin());
    const byName = Object.fromEntries(worker.loadedAgents.map((a) => [a.name, a]));

    assert.equal(typeof byName.withref.mcpServers, "object");
    assert.ok(!Array.isArray(byName.withref.mcpServers), "resolved map is an object, not the frontmatter name list");
    assert.equal(byName.withref.mcpServers.jira.url, "https://mcp.example.com/jira");
    assert.equal("inheritDefaultMcpServers" in byName.inheriting, false, "inherit flag never reaches the SDK surface");
    assert.equal(byName.plainagent.mcpServers, undefined);
    assert.equal(byName.badref.mcpServers, undefined);
});

// ─── Review-driven regressions ──────────────────────────────────

test("same-name static namespaces retain their own prompt, declarations and MCP through refresh", () => {
    const pluginA = buildFixturePlugin();
    const pluginB = makeTmpDir("ps-mcp-plugin-b-");
    fs.mkdirSync(path.join(pluginB, "agents"));
    writeAgent(path.join(pluginB, "agents"), "withref.agent.md", `
schemaVersion: 4
version: 2.0.0
name: withref
tools: [security_tool]
nativeTaskTools:
  swarm-explore: [security_tool]
`, "SECURITY SECOND NAMESPACE");
    const worker = buildWorker([pluginA, pluginB]);
    const namespaceA = path.basename(pluginA);
    const namespaceB = path.basename(pluginB);
    const keyA = `${namespaceA}:withref`;
    const keyB = `${namespaceB}:withref`;
    const lookup = worker._agentPromptLookup;
    const maps = worker.agentMcpServers;
    assert.match(lookup[keyB].prompt, /SECURITY SECOND NAMESPACE/);
    assert.deepEqual(lookup[keyB].toolNames, ["security_tool"]);
    assert.equal(lookup[keyB].descriptor.layerId, keyB);
    assert.deepEqual(lookup[keyB].nativeTaskTools, {"swarm-explore": ["security_tool"]});
    assert.equal(lookup[keyA].nativeTaskTools, undefined);
    assert.equal(lookup.withref.prompt, lookup[keyA].prompt, "legacy bare prompt retains first static definition");
    assert.deepEqual(Object.keys(maps.withref), ["jira"], "bare MCP follows the same static default as its prompt");
    assert.deepEqual(Object.keys(maps[keyA]), ["jira"]);
    assert.equal(maps[keyB], undefined, "the second static definition cannot inherit the first's MCP grants");
    const first = worker.loadedAgents.find(a => a.name === "withref" && a.namespace === namespaceA);
    const second = worker.loadedAgents.find(a => a.name === "withref" && a.namespace === namespaceB);
    assert.deepEqual(Object.keys(first.mcpServers), ["jira"]);
    assert.equal(second.mcpServers, undefined);

    writeAgent(path.join(pluginB, "agents"), "withref.agent.md", `
schemaVersion: 4
version: 2.1.0
name: withref
tools: [security_tool_v2]
nativeTaskTools:
  swarm-explore: []
mcpServers: [github]
`, "SECURITY SECOND NAMESPACE V2");
    worker._resetLoadedPluginState();
    worker._loadPlugins();
    assert.equal(worker._agentPromptLookup, lookup, "live SessionManager lookup observes in-place refresh");
    assert.equal(worker.agentMcpServers, maps);
    assert.match(lookup[keyB].prompt, /SECURITY SECOND NAMESPACE V2/);
    assert.deepEqual(lookup[keyB].toolNames, ["security_tool_v2"]);
    assert.equal(lookup[keyB].descriptor.version, "2.1.0");
    assert.deepEqual(lookup[keyB].nativeTaskTools, {"swarm-explore": []});
    assert.deepEqual(Object.keys(maps[keyB]), ["github"]);
    assert.deepEqual(Object.keys(maps[keyA]), ["jira"]);
    assert.deepEqual(Object.keys(maps.withref), ["jira"]);
    assert.doesNotMatch(lookup.withref.prompt, /SECURITY SECOND/);
});

test("comments between mcpServers: and its list items do not orphan the refs", () => {
    const dir = makeTmpDir("ps-agent-mcp-");
    writeAgent(dir, "commented.agent.md", `
schemaVersion: 2
version: 1.0.0
name: commented
mcpServers:
  # note: github is needed for issue sync
  - "github"
  - 'jira'
`);
    const [agent] = loadAgentFiles(dir);
    assert.deepEqual(agent.mcpServers, ["github", "jira"], "comment skipped, quoted items unquoted");
});

test("an app base (default) agent's opt-in resolves into the every-session base map", () => {
    const pluginDir = buildFixturePlugin();
    fs.writeFileSync(path.join(pluginDir, "agents", "default.agent.md"), `---
schemaVersion: 2
version: 1.0.0
name: default
inheritDefaultMcpServers: true
mcpServers:
  - jira
---

App base overlay.
`);
    const worker = buildWorker(pluginDir);
    assert.deepEqual(Object.keys(worker.baseMcpServers).sort(), ["github", "jira"]);
});

test("direct worker-config mcpServers keep every-session semantics via the base map", () => {
    const stateDir = makeTmpDir("ps-mcp-state-");
    const worker = new PilotSwarmWorker({
        sessionStateDir: path.join(stateDir, "session-state"),
        workerNodeId: "test-direct-mcp",
        mcpServers: {
            inline: { type: "http", url: "https://mcp.example.com/inline", tools: ["*"] },
        },
    });
    assert.deepEqual(Object.keys(worker.baseMcpServers), ["inline"]);
    assert.ok(worker.loadedMcpServers.inline, "direct servers also join the catalog");
});
