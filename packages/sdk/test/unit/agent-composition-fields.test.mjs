/**
 * `startedBy` and `supportsDirectStart` — a package's shape, declared.
 *
 * The picker groups agents into a section per package and nests sub-agents
 * under whichever agent creates them. That needs two things the frontmatter
 * did not carry: who spawns an agent, and whether a person may start it cold.
 *
 * Both ride the MANIFEST, for the same reason splash and initialPrompt do: the
 * picker reads the catalog, never the package's agent files. A field parsed but
 * dropped at manifest time is a field that does not exist as far as the UI is
 * concerned — that is exactly how package agents lost their splash art once.
 *
 * The defaults are the compatibility contract: a package declaring neither
 * field must behave precisely as it did before either existed.
 *
 * Run: node --test test/unit/agent-composition-fields.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadAgentFiles, agentSupportsDirectStart } from "../../dist/agent-loader.js";
import { validateAgentPackageDir } from "../../dist/agent-package-format.js";

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-composition-"));
}

function writeAgent(dir, name, frontmatter) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.agent.md`), [
        "---",
        `name: ${name}`,
        ...frontmatter,
        "---",
        "",
        "Body.",
    ].join("\n"));
}

test("startedBy parses as a YAML list and as an inline array", () => {
    const dir = path.join(tmpdir(), "agents");
    writeAgent(dir, "block", ["startedBy:", "  - lead", "  - deputy"]);
    writeAgent(dir, "inline", ["startedBy: [lead, deputy]"]);

    const byName = new Map(loadAgentFiles(dir).map((a) => [a.name, a]));
    assert.deepEqual(byName.get("block").startedBy, ["lead", "deputy"]);
    assert.deepEqual(byName.get("inline").startedBy, ["lead", "deputy"]);
});

test("an agent that declares nothing is an entry point and is startable", () => {
    // The compatibility case: every package written before these fields.
    const dir = path.join(tmpdir(), "agents");
    writeAgent(dir, "plain", ["description: Plain"]);

    const [agent] = loadAgentFiles(dir);
    assert.equal(agent.startedBy, undefined);
    assert.equal(agent.supportsDirectStart, undefined, "left undefined so the default stays derivable");
    assert.equal(agentSupportsDirectStart(agent), true);
});

test("declaring startedBy makes an agent called-only by default", () => {
    const dir = path.join(tmpdir(), "agents");
    writeAgent(dir, "helper", ["startedBy: [lead]"]);

    const [agent] = loadAgentFiles(dir);
    assert.equal(agentSupportsDirectStart(agent), false);
});

test("an explicit supportsDirectStart overrides the default in both directions", () => {
    const dir = path.join(tmpdir(), "agents");
    writeAgent(dir, "dual", ["startedBy: [lead]", "supportsDirectStart: true"]);
    writeAgent(dir, "hidden", ["supportsDirectStart: false"]);

    const byName = new Map(loadAgentFiles(dir).map((a) => [a.name, a]));
    assert.equal(agentSupportsDirectStart(byName.get("dual")), true, "a sub-agent can also be useful alone");
    assert.equal(agentSupportsDirectStart(byName.get("hidden")), false, "and an entry point can be hidden");
});

test("a bare supportsDirectStart: stays undeclared rather than becoming false", () => {
    // `value === "true"` on an empty value yields false, which would silently
    // drop an entry point out of the startable set over a missing word. The
    // field is a tri-state: true, false, or not declared.
    const dir = path.join(tmpdir(), "agents");
    writeAgent(dir, "bare", ["supportsDirectStart:"]);
    writeAgent(dir, "junk", ["supportsDirectStart: yes"]);

    const byName = new Map(loadAgentFiles(dir).map((a) => [a.name, a]));
    assert.equal(byName.get("bare").supportsDirectStart, undefined);
    assert.equal(agentSupportsDirectStart(byName.get("bare")), true, "the default still applies");
    assert.equal(byName.get("junk").supportsDirectStart, undefined, "and an unparseable value is not a false");
});

test("startedBy does not swallow the list items of the key that follows it", () => {
    // The frontmatter parser routes "- item" lines by the last-seen key. A new
    // list key that forgets to register itself silently steals the next key's
    // items, which is a whole class of quiet breakage.
    const dir = path.join(tmpdir(), "agents");
    writeAgent(dir, "mixed", [
        "startedBy:",
        "  - lead",
        "tools:",
        "  - view",
        "  - grep",
    ]);

    const [agent] = loadAgentFiles(dir);
    assert.deepEqual(agent.startedBy, ["lead"]);
    assert.deepEqual(agent.tools, ["view", "grep"]);
});

test("both fields survive into the package manifest", async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "editorial-desk",
        version: "0.2.0",
        title: "Editorial Desk",
        description: "Test package",
    }));
    writeAgent(path.join(dir, "agents"), "lead", ["description: Entry point"]);
    writeAgent(path.join(dir, "agents"), "helper", ["description: Called", "startedBy: [lead]"]);

    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.ok(result.ok, JSON.stringify(result.errors));

    const agents = new Map(result.manifest.agents.map((a) => [a.name, a]));
    assert.deepEqual(agents.get("helper").startedBy, ["lead"]);
    assert.equal(agents.get("lead").startedBy, undefined);
    assert.equal(agents.get("helper").supportsDirectStart, undefined, "the default is derived, not baked in");
});

test("schema 3 preserves an initial required tool in the agent and package manifest", async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "catalog-analyst",
        version: "1.0.0",
        description: "Test package",
    }));
    writeAgent(path.join(dir, "agents"), "analyst", [
        "description: Catalog analyst",
        "schemaVersion: 3",
        "version: 1.0.0",
        "tools:",
        "  - package_catalog",
        "initialRequiredTool: package_catalog",
    ]);

    const [agent] = loadAgentFiles(path.join(dir, "agents"));
    assert.equal(agent.initialRequiredTool, "package_catalog");

    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.equal(result.manifest.agents[0].initialRequiredTool, "package_catalog");
});

test("initial required tools require schema 3 and a matching declared tool", async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "broken-analyst",
        version: "1.0.0",
        description: "Test package",
    }));
    writeAgent(path.join(dir, "agents"), "analyst", [
        "description: Broken analyst",
        "schemaVersion: 2",
        "version: 1.0.0",
        "tools:",
        "  - other_tool",
        "initialRequiredTool: package_catalog",
    ]);

    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.equal(result.ok, false);
    assert.deepEqual(
        result.errors.map((error) => error.code).sort(),
        ["initial_required_tool_not_declared", "initial_required_tool_schema"],
    );
});

test("the runtime loader skips invalid initial required tool definitions", () => {
    const dir = path.join(tmpdir(), "agents");
    writeAgent(dir, "old-schema", [
        "schemaVersion: 2",
        "version: 1.0.0",
        "tools: [package_catalog]",
        "initialRequiredTool: package_catalog",
    ]);
    writeAgent(dir, "undeclared", [
        "schemaVersion: 3",
        "version: 1.0.0",
        "tools: [other_tool]",
        "initialRequiredTool: package_catalog",
    ]);

    assert.deepEqual(loadAgentFiles(dir), []);
});

test("plugin.json title becomes the package's display name", async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "editorial-desk",
        version: "0.2.0",
        title: "  Editorial Desk  ",
    }));
    writeAgent(path.join(dir, "agents"), "lead", ["description: Entry point"]);

    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.equal(result.manifest.title, "Editorial Desk");
});

test("a package without a title leaves it unset, so the name can be the fallback", async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "pg-toolkit",
        version: "0.3.1",
    }));
    writeAgent(path.join(dir, "agents"), "lead", ["description: Entry point"]);

    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.equal(result.manifest.title, undefined);
});
