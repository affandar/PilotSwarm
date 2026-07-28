/**
 * Per-agent opt-out of the app default layer (pure, no database).
 *
 * An app deployment's `default.agent.md` is normally force-merged into every
 * session — both its prompt (as `guidelines`) and its `tools:`. `inheritAppDefaults: false`
 * lets a single agent be authored on a clean slate without changing anything
 * for the other agents in the same deployment.
 *
 * Pins the four layers of the feature:
 *   1. agent-loader parses `inheritAppDefaults:` and leaves it undefined when absent.
 *   2. The worker carries the flag into the agent prompt lookup and composes
 *      subagent (CustomAgentConfig) prompts without the app default when it is false.
 *   3. The session-side resolver `inheritsAppDefaults()` — which gates the session
 *      prompt, the app-default tool merge, and the prompt layer manifest — honors it,
 *      defaults to inheriting, and keeps PilotSwarm system agents opted out.
 *   4. The flag is a PilotSwarm-only layering field and never reaches Copilot's
 *      CustomAgentConfig.
 *
 * Run: node --test test/unit/agent-inherit-app-defaults.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAgentFiles } from "../../dist/agent-loader.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { inheritsAppDefaults } from "../../dist/session-manager.js";
import { buildPromptLayerSections } from "../../dist/prompt-layering.js";

function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(dir, filename, frontmatter, body = "You are a test agent.") {
    fs.writeFileSync(path.join(dir, filename), `---\n${frontmatter.trim()}\n---\n\n${body}\n`);
}

// ─── 1. Frontmatter parsing ─────────────────────────────────────

test("parses inheritAppDefaults: false", () => {
    const dir = makeTmpDir("ps-agent-inherit-");
    writeAgent(dir, "clean.agent.md", `
version: 1.0.0
name: clean
inheritAppDefaults: false
`);
    const [agent] = loadAgentFiles(dir);
    assert.equal(agent.inheritAppDefaults, false);
});

test("parses explicit inheritAppDefaults: true", () => {
    const dir = makeTmpDir("ps-agent-inherit-");
    writeAgent(dir, "explicit.agent.md", `
version: 1.0.0
name: explicit
inheritAppDefaults: true
`);
    const [agent] = loadAgentFiles(dir);
    assert.equal(agent.inheritAppDefaults, true);
});

test("omitting inheritAppDefaults leaves it undefined (inherit by default)", () => {
    const dir = makeTmpDir("ps-agent-inherit-");
    writeAgent(dir, "legacy.agent.md", `
version: 1.0.0
name: legacy
`);
    const [agent] = loadAgentFiles(dir);
    assert.equal(agent.inheritAppDefaults, undefined);
});

// ─── 2 + 4. Worker-side prompt composition ──────────────────────

const APP_DEFAULT_MARKER = "APP_DEFAULT_POLICY_MARKER";
const CLEAN_BODY_MARKER = "CLEAN_AGENT_BODY_MARKER";

function buildFixturePlugin() {
    const pluginDir = makeTmpDir("ps-inherit-plugin-");
    const agentsDir = path.join(pluginDir, "agents");
    fs.mkdirSync(agentsDir);
    writeAgent(agentsDir, "default.agent.md", `
version: 1.0.0
name: default
tools:
  - app_default_tool
`, APP_DEFAULT_MARKER);
    writeAgent(agentsDir, "clean.agent.md", `
version: 1.0.0
name: clean
inheritAppDefaults: false
`, CLEAN_BODY_MARKER);
    writeAgent(agentsDir, "legacy.agent.md", `
version: 1.0.0
name: legacy
`, "LEGACY_AGENT_BODY_MARKER");
    return pluginDir;
}

function buildWorker(pluginDirs) {
    const stateDir = makeTmpDir("ps-inherit-state-");
    return new PilotSwarmWorker({
        sessionStateDir: path.join(stateDir, "session-state"),
        pluginDirs: Array.isArray(pluginDirs) ? pluginDirs : [pluginDirs],
        workerNodeId: "test-agent-inherit-app-defaults",
    });
}

test("opted-out agent's composed prompt omits the app default", () => {
    const worker = buildWorker(buildFixturePlugin());
    const clean = worker.loadedAgents.find((a) => a.name === "clean");
    assert.ok(clean, "clean agent should load");
    assert.ok(
        clean.prompt.includes(CLEAN_BODY_MARKER),
        "the agent's own instructions must still be present",
    );
    assert.ok(
        !clean.prompt.includes(APP_DEFAULT_MARKER),
        "the app default must not be layered into an opted-out agent",
    );
});

test("agents that say nothing still inherit the app default", () => {
    const worker = buildWorker(buildFixturePlugin());
    const legacy = worker.loadedAgents.find((a) => a.name === "legacy");
    assert.ok(legacy, "legacy agent should load");
    assert.ok(
        legacy.prompt.includes(APP_DEFAULT_MARKER),
        "omitting the flag must preserve today's inheriting behavior",
    );
});

test("inheritAppDefaults never reaches Copilot's CustomAgentConfig", () => {
    const worker = buildWorker(buildFixturePlugin());
    for (const agent of worker.loadedAgents) {
        assert.equal(
            Object.hasOwn(agent, "inheritAppDefaults"),
            false,
            `${agent.name} must not carry the PilotSwarm-only layering flag`,
        );
    }
});

// ─── 3. Session-side resolution ─────────────────────────────────

const workerDefaults = {
    agentPromptLookup: {
        clean: { prompt: "c", kind: "app-agent", inheritAppDefaults: false },
        explicit: { prompt: "e", kind: "app-agent", inheritAppDefaults: true },
        legacy: { prompt: "l", kind: "app-agent" },
    },
};

test("session resolver honors an opted-out bound agent", () => {
    assert.equal(inheritsAppDefaults(workerDefaults, { boundAgentName: "clean" }), false);
});

test("session resolver inherits for explicit-true and silent agents", () => {
    assert.equal(inheritsAppDefaults(workerDefaults, { boundAgentName: "explicit" }), true);
    assert.equal(inheritsAppDefaults(workerDefaults, { boundAgentName: "legacy" }), true);
});

test("session resolver inherits for unbound and unknown agents", () => {
    assert.equal(inheritsAppDefaults(workerDefaults, {}), true);
    assert.equal(inheritsAppDefaults(workerDefaults, { boundAgentName: "nonexistent" }), true);
});

test("PilotSwarm system agents stay opted out regardless of the flag", () => {
    const config = {
        boundAgentName: "explicit",
        promptLayering: { kind: "pilotswarm-system-agent" },
    };
    assert.equal(inheritsAppDefaults(workerDefaults, config), false);
});

test("prompt layering drops the guidelines section when opted out", () => {
    const withDefault = buildPromptLayerSections({
        frameworkBase: "FRAMEWORK",
        appDefault: APP_DEFAULT_MARKER,
        activeAgentPrompt: CLEAN_BODY_MARKER,
    });
    assert.ok(withDefault.guidelines, "sanity: app default normally lands in guidelines");

    const withoutDefault = buildPromptLayerSections({
        frameworkBase: "FRAMEWORK",
        appDefault: APP_DEFAULT_MARKER,
        activeAgentPrompt: CLEAN_BODY_MARKER,
        includeAppDefault: false,
    });
    assert.equal(withoutDefault.guidelines, undefined);
    assert.ok(withoutDefault.custom_instructions, "framework base is unaffected");
    assert.ok(withoutDefault.last_instructions, "agent prompt is unaffected");
});
