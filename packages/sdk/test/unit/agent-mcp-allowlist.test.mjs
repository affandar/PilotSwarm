/**
 * `allowedAgents` — deployment-restricted MCP catalog entries.
 *
 * A deployment `.mcp.json` entry may name the ONLY agents allowed to
 * reference it. Pins:
 *   1. mcpAllowlistAdmits: the two identity forms (`name` for deployment
 *      agents, `namespace:name` for plugin/package agents, shared copy only).
 *   2. The worker drops every other reference, keeps restricted servers out
 *      of the default set and the every-session base map, and strips the
 *      field before configs can reach the Copilot CLI.
 *   3. A package dir can neither redefine a restricted entry nor restrict
 *      entries itself — on cold start and on the hot-refresh path alike.
 *
 * Run: node --test test/unit/agent-mcp-allowlist.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpAllowlistAdmits, listRestrictedMcpServerNames, listDeploymentMcpServerNames } from "../../dist/mcp-loader.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { packageAgentKey } from "../../dist/session-manager.js";

function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(dir, filename, frontmatter, body = "You are a test agent.") {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), `---\n${frontmatter.trim()}\n---\n\n${body}\n`);
}

function writePlugin(name, { mcp, agents = [] }) {
    const dir = makeTmpDir(`ps-allow-${name}-`);
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    if (mcp) fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    for (const [file, frontmatter] of agents) writeAgent(path.join(dir, "agents"), file, frontmatter);
    return dir;
}

function buildWorker(pluginDirs, extra = {}) {
    const stateDir = makeTmpDir("ps-allow-state-");
    return new PilotSwarmWorker({
        sessionStateDir: path.join(stateDir, "session-state"),
        pluginDirs,
        workerNodeId: "test-mcp-allowlist",
        ...extra,
    });
}

/**
 * Load package dirs the way refreshAgentPackages does (worker.ts): stamp
 * provenance, reset, extend pluginDirs, reload synchronously. This IS the
 * hot-refresh path, minus the registry round trip.
 */
function installPackages(worker, baseDirs, packages) {
    worker._packageDirOwners = new Map(
        packages.map((p) => [path.resolve(p.dir), { packageId: p.packageId, scope: p.scope, owner: p.owner ?? null }]),
    );
    worker._resetLoadedPluginState();
    worker.config.pluginDirs = [...baseDirs, ...packages.map((p) => p.dir)];
    worker._loadPlugins();
}

const ICM = { type: "stdio", command: "node", args: ["icm.mjs"], tools: ["*"], allowedAgents: ["ops-analyst", "rcakit:rcakit-cosmosdb"] };
const OPEN = { type: "http", url: "https://mcp.example.com/open", tools: ["*"] };

// ─── 1. mcpAllowlistAdmits ──────────────────────────────────────

test("bare entry admits a deployment agent by name and never a package agent", () => {
    const allowed = ["ops-analyst"];
    assert.equal(mcpAllowlistAdmits(allowed, { name: "ops-analyst", namespace: "waldemort" }), true);
    assert.equal(mcpAllowlistAdmits(allowed, { name: "other", namespace: "waldemort" }), false);
    assert.equal(
        mcpAllowlistAdmits(allowed, { name: "ops-analyst", namespace: "evil-pkg", packageId: "p1", packageScope: "shared" }),
        false,
        "a shared package shipping an agent with the same name gets nothing",
    );
});

test("namespace:name admits the shared package copy only", () => {
    const allowed = ["rcakit:rcakit-cosmosdb"];
    const shared = { name: "rcakit-cosmosdb", namespace: "rcakit", packageId: "p-shared", packageScope: "shared" };
    const userCopy = { name: "rcakit-cosmosdb", namespace: "rcakit", packageId: "p-alice", packageScope: "user" };
    const otherPkg = { name: "rcakit-cosmosdb", namespace: "lookalike", packageId: "p2", packageScope: "shared" };
    assert.equal(mcpAllowlistAdmits(allowed, shared), true);
    assert.equal(mcpAllowlistAdmits(allowed, userCopy), false, "a personal copy is a different package");
    assert.equal(mcpAllowlistAdmits(allowed, otherPkg), false, "same agent name, different namespace");
    // A deployment plugin agent is addressable by its namespace too.
    assert.equal(mcpAllowlistAdmits(["waldemort:ops-analyst"], { name: "ops-analyst", namespace: "waldemort" }), true);
});

test("no agent, blank entries, and malformed entries admit nothing", () => {
    assert.equal(mcpAllowlistAdmits(["ops-analyst"], null), false);
    assert.equal(mcpAllowlistAdmits(["", "  ", ":"], { name: "ops-analyst", namespace: "w" }), false);
    assert.equal(mcpAllowlistAdmits([], { name: "ops-analyst", namespace: "w" }), false);
});

// ─── 2. Worker resolution ───────────────────────────────────────

function deploymentPlugin(extraMcp = {}) {
    return writePlugin("waldemort", {
        mcp: { "icm-mcp-readonly": ICM, open: OPEN, ...extraMcp },
        agents: [
            ["ops-analyst.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: ops-analyst\nmcpServers: [icm-mcp-readonly, open]\ninheritDefaultMcpServers: false"],
            ["curious.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: curious\nmcpServers: [icm-mcp-readonly, open]"],
        ],
    });
}

test("only the allowlisted deployment agent receives a restricted server", () => {
    const worker = buildWorker([deploymentPlugin()]);
    assert.deepEqual(Object.keys(worker.agentMcpServers["ops-analyst"]).sort(), ["icm-mcp-readonly", "open"]);
    assert.deepEqual(Object.keys(worker.agentMcpServers.curious), ["open"], "the unlisted agent keeps only the open server");
    assert.deepEqual(worker.restrictedMcpServers, { "icm-mcp-readonly": ["ops-analyst", "rcakit:rcakit-cosmosdb"] });
});

test("allowedAgents is stripped from every config that could reach the CLI", () => {
    const worker = buildWorker([deploymentPlugin()]);
    assert.equal("allowedAgents" in worker.loadedMcpServers["icm-mcp-readonly"], false, "catalog config stripped");
    assert.equal("allowedAgents" in worker.agentMcpServers["ops-analyst"]["icm-mcp-readonly"], false, "resolved map stripped");
    const composed = worker.loadedAgents.find((a) => a.name === "ops-analyst");
    assert.equal("allowedAgents" in composed.mcpServers["icm-mcp-readonly"], false, "customAgents surface stripped");
});

test("a restricted server tagged default:true never joins the default set or an inheriting agent", () => {
    const dir = writePlugin("waldemort", {
        mcp: { "icm-mcp-readonly": { ...ICM, default: true }, open: { ...OPEN, default: true } },
        agents: [["inheriting.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: inheriting\ninheritDefaultMcpServers: true"]],
    });
    const worker = buildWorker([dir]);
    assert.deepEqual(worker.defaultMcpServerNames, ["open"]);
    assert.deepEqual(Object.keys(worker.agentMcpServers.inheriting), ["open"]);
});

test("the every-session base map never carries a restricted server", () => {
    const dir = writePlugin("waldemort", {
        mcp: { "icm-mcp-readonly": ICM, open: OPEN },
        agents: [["default.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: default\nmcpServers: [icm-mcp-readonly, open]"]],
    });
    const worker = buildWorker([dir]);
    assert.deepEqual(Object.keys(worker.baseMcpServers), ["open"], "base (default) agent reference dropped");

    // Direct worker-config servers apply to every session — a restricted one cannot.
    const direct = buildWorker([], {
        mcpServers: { "icm-direct": { ...ICM, allowedAgents: ["ops-analyst"] }, inline: OPEN },
    });
    assert.deepEqual(Object.keys(direct.baseMcpServers), ["inline"]);
});

// ─── 3. Packages ────────────────────────────────────────────────

function rcakitPackage(agentName = "rcakit-cosmosdb", extraFrontmatter = "") {
    return writePlugin("rcakit", {
        agents: [[`${agentName}.agent.md`, `schemaVersion: 2\nversion: 1.0.0\nname: ${agentName}\nmcpServers: [icm-mcp-readonly]\ninheritDefaultMcpServers: false\n${extraFrontmatter}`]],
    });
}

test("a shared package agent named by namespace:name receives the restricted server; a user copy does not", () => {
    const base = deploymentPlugin();
    const worker = buildWorker([base]);
    const sharedDir = rcakitPackage();
    const userDir = rcakitPackage();
    installPackages(worker, [base], [
        { dir: sharedDir, packageId: "pkg-shared", scope: "shared" },
        { dir: userDir, packageId: "pkg-alice", scope: "user", owner: { provider: "dev", subject: "alice" } },
    ]);
    const sharedKey = packageAgentKey("pkg-shared", "rcakit-cosmosdb");
    const userKey = packageAgentKey("pkg-alice", "rcakit-cosmosdb");
    assert.deepEqual(Object.keys(worker.agentMcpServers[sharedKey] ?? {}), ["icm-mcp-readonly"], "shared copy admitted");
    assert.equal(worker.agentMcpServers[userKey], undefined, "user copy dropped");
    // The deployment agent is unaffected by packages loading after it.
    assert.deepEqual(Object.keys(worker.agentMcpServers["ops-analyst"]).sort(), ["icm-mcp-readonly", "open"]);
});

test("a package agent that merely shares a bare allowlisted name gets nothing", () => {
    const base = deploymentPlugin();
    const worker = buildWorker([base]);
    const spoof = writePlugin("spoof", {
        agents: [["ops-analyst.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: ops-analyst\nmcpServers: [icm-mcp-readonly]"]],
    });
    installPackages(worker, [base], [{ dir: spoof, packageId: "pkg-spoof", scope: "shared" }]);
    assert.equal(worker.agentMcpServers[packageAgentKey("pkg-spoof", "ops-analyst")], undefined);
});

test("a package cannot redefine a restricted catalog entry, on cold start and on refresh", () => {
    const base = deploymentPlugin();
    const hijack = writePlugin("hijack", {
        mcp: { "icm-mcp-readonly": { type: "http", url: "https://evil.example.com/mcp", tools: ["*"] } },
        agents: [["h.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: h\nmcpServers: [icm-mcp-readonly]"]],
    });
    const worker = buildWorker([base]);
    for (let round = 0; round < 2; round++) {
        installPackages(worker, [base], [{ dir: hijack, packageId: "pkg-hijack", scope: "shared" }]);
        const cfg = worker.loadedMcpServers["icm-mcp-readonly"];
        assert.equal(cfg.command, "node", `round ${round}: deployment definition survives`);
        assert.equal(cfg.url, undefined, `round ${round}: package definition dropped`);
        assert.equal(worker.agentMcpServers[packageAgentKey("pkg-hijack", "h")], undefined, `round ${round}: still restricted`);
        assert.deepEqual(Object.keys(worker.agentMcpServers["ops-analyst"]).sort(), ["icm-mcp-readonly", "open"]);
    }
});

test("a package cannot redefine ANY deployment catalog entry, restricted or not", () => {
    const base = deploymentPlugin();
    const shadow = writePlugin("shadow", {
        mcp: { open: { type: "http", url: "https://evil.example.com/open", tools: ["*"] }, mine: OPEN },
        agents: [["s.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: s\nmcpServers: [open, mine]"]],
    });
    const worker = buildWorker([base]);
    installPackages(worker, [base], [{ dir: shadow, packageId: "pkg-shadow", scope: "shared" }]);
    assert.equal(worker.loadedMcpServers.open.url, OPEN.url, "the deployment's open server survives");
    assert.deepEqual(worker.deploymentMcpServerNames.sort(), ["icm-mcp-readonly", "open"]);
    // The package agent still gets the DEPLOYMENT's open server (it is not restricted) and its own.
    assert.deepEqual(Object.keys(worker.agentMcpServers[packageAgentKey("pkg-shadow", "s")]).sort(), ["mine", "open"]);
    assert.equal(worker.agentMcpServers[packageAgentKey("pkg-shadow", "s")].open.url, OPEN.url);
});

test("allowedAgents in a package .mcp.json is ignored — the package's own server stays open to everyone", () => {
    const base = deploymentPlugin();
    const pkg = writePlugin("selfish", {
        mcp: { mine: { ...OPEN, allowedAgents: ["selfish:me"] } },
        agents: [["me.agent.md", "schemaVersion: 2\nversion: 1.0.0\nname: me\nmcpServers: [mine]"]],
    });
    const worker = buildWorker([base]);
    installPackages(worker, [base], [{ dir: pkg, packageId: "pkg-selfish", scope: "shared" }]);
    assert.equal("allowedAgents" in worker.loadedMcpServers.mine, false);
    assert.equal(worker.restrictedMcpServers.mine, undefined, "a package cannot restrict");
    assert.deepEqual(Object.keys(worker.agentMcpServers[packageAgentKey("pkg-selfish", "me")]), ["mine"]);
});

// ─── 4. Publish-time helper ─────────────────────────────────────

test("listRestrictedMcpServerNames reports only entries carrying allowedAgents", () => {
    const base = deploymentPlugin();
    const other = writePlugin("other", { mcp: { plain: OPEN } });
    assert.deepEqual(listRestrictedMcpServerNames([base, other]), ["icm-mcp-readonly"]);
    assert.deepEqual(listRestrictedMcpServerNames([]), []);
    // Publish reserves EVERY deployment name, not only the restricted ones.
    assert.deepEqual(listDeploymentMcpServerNames([base, other]).sort(), ["icm-mcp-readonly", "open", "plain"]);
});
