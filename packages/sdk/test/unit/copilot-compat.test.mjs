/**
 * Copilot CLI compatibility — Layer A Phase 1 (pure, no database).
 *
 * Pins:
 *   1. `tools:` and `agents:` frontmatter parsing in both inline and multiline forms,
 *      and that the DEFAULT parse (compat off) is unchanged from today.
 *   2. Declared-tool classification, including mcp_conditional WARN-never-FAIL.
 *   3. Disabled-profile parity: no serialized compat key, unchanged tool order.
 *   4. Workspace-binding durability across a turn boundary and subagent inheritance.
 *
 * Run: node --test test/unit/copilot-compat.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFiles, parseAgentFrontmatter } from "../../dist/agent-loader.js";
import { SessionManager, inheritsAppDefaults } from "../../dist/session-manager.js";
import {
    COPILOT_CLI_PROFILE,
    COMPATIBILITY_SCHEMA_VERSION,
    COPILOT_COMPAT_BOUNDS,
    CompatibilityAdapterRegistry,
    applyCompatChildConfig,
    buildCompatSessionConfigFragment,
    clampCompatBound,
    classifyDeclaredTools,
    classifyDesktopOnlyTool,
    createUncreatedWorkspaceBinding,
    isWorkspaceOwner,
    readCompatSessionState,
    workspaceLostForNonOwnerDiagnostic,
} from "../../dist/copilot-compat.js";

const fixtureAgentsDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "copilot-compat-plugin",
    "agents",
);

const COPILOT_TOOL_NAMES = ["execute", "read", "edit", "search", "agent", "todo", "web"];

const fixturePluginDir = path.join(fixtureAgentsDir, "..");

const parityArtifact = JSON.parse(fs.readFileSync(
    path.join(fixtureAgentsDir, "..", "..", "copilot-compat-disabled-parity.json"),
    "utf-8",
));

function readFixture(filename) {
    return fs.readFileSync(path.join(fixtureAgentsDir, filename), "utf-8");
}

function compareVersions(left, right) {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    for (let position = 0; position < Math.max(leftParts.length, rightParts.length); position += 1) {
        const difference = (leftParts[position] ?? 0) - (rightParts[position] ?? 0);
        if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    return 0;
}

async function readLatestGenerationAgentsSource() {
    const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
    return fs.readFileSync(path.join(distDir, "orchestration", "agents.js"), "utf-8");
}

// ─── 1. Frontmatter parsing ─────────────────────────────────────

test("tools: parses in inline [a, b] form", () => {
    const { meta } = parseAgentFrontmatter(readFixture("compat-inline.agent.md"));
    assert.deepEqual(meta.tools, COPILOT_TOOL_NAMES);
});

test("tools: parses in multiline YAML list form", () => {
    const { meta } = parseAgentFrontmatter(readFixture("compat-multiline.agent.md"));
    assert.deepEqual(meta.tools, COPILOT_TOOL_NAMES);
});

test("agents: parses in inline form only when the parse option is enabled", () => {
    const content = readFixture("compat-inline.agent.md");
    assert.deepEqual(parseAgentFrontmatter(content, { parseAgentsKey: true }).meta.agents, ["runner", "reporter"]);
    assert.equal(parseAgentFrontmatter(content).meta.agents, undefined);
});

test("agents: parses in multiline form only when the parse option is enabled", () => {
    const content = readFixture("compat-multiline.agent.md");
    assert.deepEqual(parseAgentFrontmatter(content, { parseAgentsKey: true }).meta.agents, ["runner", "reporter"]);
    assert.equal(parseAgentFrontmatter(content).meta.agents, undefined);
});

test("default parse of an agents:-bearing file is identical to the same file without the key", () => {
    for (const filename of ["compat-inline.agent.md", "compat-multiline.agent.md"]) {
        const withAgentsKey = readFixture(filename);
        const withoutAgentsKey = withAgentsKey
            .replace(/^agents: \[.*\]\r?\n/m, "")
            .replace(/^agents:\r?\n(  - .*\r?\n)+/m, "");
        assert.notEqual(withAgentsKey, withoutAgentsKey, `${filename} must actually declare agents:`);
        assert.deepEqual(
            parseAgentFrontmatter(withAgentsKey),
            parseAgentFrontmatter(withoutAgentsKey),
            `${filename}: default parsing must ignore agents: exactly as current code does`,
        );
    }
});

test("multiline agents: list items never leak into tools/skills/mcpServers by default", () => {
    const { meta } = parseAgentFrontmatter(readFixture("compat-multiline.agent.md"));
    assert.deepEqual(meta.tools, COPILOT_TOOL_NAMES);
    assert.equal(meta.skills, undefined);
    assert.equal(meta.mcpServers, undefined);
});

// ─── 1b. Constructor-supplied parse options ─────────────────────

/**
 * Exercises the real plugin load site (`_loadPluginDir`) with the real field the
 * constructor seeds, without standing up stores or a runtime. A worker built through
 * the constructor reaches the same field before `_loadPlugins()` runs.
 */
async function loadPluginAgentsWithParseOptions(agentFrontmatterParseOptions) {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const worker = Object.create(PilotSwarmWorker.prototype);

    worker.agentFrontmatterParseOptions = { ...(agentFrontmatterParseOptions ?? {}) };
    worker._loadedSkillDirs = [];
    worker._loadedSkills = new Map();
    worker._rawLoadedAgents = [];
    worker._loadedAgents = [];
    worker._loadedSystemAgents = [];
    worker._loadedMcpServers = {};
    worker._agentMcpServers = {};
    worker._defaultMcpServerNames = [];
    worker._baseAgentMcpDecl = { refs: [], inherit: false };
    worker._agentPromptLookup = {};
    worker._availableBundledAgents = new Map();
    worker.config = {};

    worker._loadPluginDir(fixturePluginDir, "app");
    return worker._rawLoadedAgents;
}

test("constructor-supplied parse options reach startup plugin loading", async () => {
    const optedIn = await loadPluginAgentsWithParseOptions({ parseAgentsKey: true });
    assert.ok(optedIn.length > 0, "fixture plugin must contribute agents");
    for (const agent of optedIn) {
        assert.deepEqual(agent.agents, ["runner", "reporter"]);
    }

    const defaulted = await loadPluginAgentsWithParseOptions(undefined);
    assert.equal(defaulted.length, optedIn.length);
    for (const agent of defaulted) {
        assert.equal(agent.agents, undefined);
    }
});

test("PilotSwarmWorkerOptions seeds the parse options before plugins load", () => {
    const workerSource = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "worker.js"),
        "utf-8",
    );

    const seedIndex = workerSource.search(
        /this\.agentFrontmatterParseOptions\s*=\s*\{\s*\.\.\.\(options\.agentFrontmatterParseOptions/,
    );
    const loadIndex = workerSource.indexOf("this._loadPlugins()");

    assert.ok(seedIndex >= 0, "constructor must seed agentFrontmatterParseOptions from options");
    assert.ok(loadIndex >= 0, "constructor must call this._loadPlugins()");
    assert.ok(seedIndex < loadIndex, "parse options must be seeded before this._loadPlugins() runs");
});

test("the post-construction setter refuses to pretend it can affect loaded plugins", async () => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const worker = Object.create(PilotSwarmWorker.prototype);

    worker._startupPluginsLoaded = false;
    worker.setAgentFrontmatterParseOptions({ parseAgentsKey: true });
    assert.deepEqual(worker.agentFrontmatterParseOptions, { parseAgentsKey: true });

    worker._startupPluginsLoaded = true;
    assert.throws(
        () => worker.setAgentFrontmatterParseOptions({ parseAgentsKey: true }),
        /cannot affect already-loaded startup plugins/,
    );
});

test("loadAgentFiles defaults to today's behavior and opts in explicitly", () => {
    const defaultLoaded = loadAgentFiles(fixtureAgentsDir);
    for (const agent of defaultLoaded) {
        assert.equal(agent.agents, undefined);
        assert.deepEqual(agent.tools, COPILOT_TOOL_NAMES);
    }

    const optedIn = loadAgentFiles(fixtureAgentsDir, { parseAgentsKey: true });
    for (const agent of optedIn) {
        assert.deepEqual(agent.agents, ["runner", "reporter"]);
    }
});

// ─── 2. Classification ──────────────────────────────────────────

const classificationEnvironment = {
    resolvableToolNames: ["read", "write_file"],
    adapterToolNames: ["execute", "search"],
    unconfiguredMcpToolProviders: { firecrawl_scrape: "firecrawl", kusto_query: "fabric-rti" },
    verifiedUnsupportedToolNames: ["definitely_unsupported"],
};

function categoryOf(result, toolName) {
    return result.classifications.find((entry) => entry.toolName === toolName)?.category;
}

test("each classification category is produced with the design's diagnostic text", () => {
    const result = classifyDeclaredTools(
        ["read", "execute", "firecrawl_scrape", "vscode/installExtension", "definitely_unsupported", "made_up_tool"],
        classificationEnvironment,
    );

    assert.equal(categoryOf(result, "read"), "native_supported");
    assert.equal(categoryOf(result, "execute"), "adapter_registered");
    assert.equal(categoryOf(result, "firecrawl_scrape"), "mcp_conditional");
    assert.equal(categoryOf(result, "vscode/installExtension"), "optional_unsupported_desktop");
    assert.equal(categoryOf(result, "definitely_unsupported"), "verified_unsupported");
    assert.equal(categoryOf(result, "made_up_tool"), "unverified_unsupported");

    assert.equal(
        result.classifications.find((entry) => entry.toolName === "vscode/installExtension").diagnostic.text,
        "[copilot-compat][WARN][optional_unsupported_desktop] tool=vscode/installExtension category=extension-management action=ignored detail=Desktop-only Copilot CLI tool is unavailable in Waldemort remote sessions.",
    );
});

test("a native tool wins over a registered adapter of the same name", () => {
    const result = classifyDeclaredTools(["read"], {
        resolvableToolNames: ["read"],
        adapterToolNames: ["read"],
    });
    assert.equal(categoryOf(result, "read"), "native_supported");
});

test("mcp_conditional warns and never hard-fails", () => {
    const result = classifyDeclaredTools(["firecrawl_scrape", "kusto_query"], classificationEnvironment);
    for (const entry of result.classifications) {
        assert.equal(entry.category, "mcp_conditional");
        assert.equal(entry.severity, "WARN");
        assert.equal(entry.diagnostic.text.includes("[FAIL]"), false);
    }
    assert.deepEqual(result.fatalToolNames, []);
});

test("an MCP-conditional name is never reclassified as verified unsupported", () => {
    const result = classifyDeclaredTools(["firecrawl_scrape"], {
        ...classificationEnvironment,
        verifiedUnsupportedToolNames: ["firecrawl_scrape"],
    });
    assert.equal(categoryOf(result, "firecrawl_scrape"), "mcp_conditional");
    assert.deepEqual(result.fatalToolNames, []);
});

test("only verified-unsupported names are fatal; optional and unverified names are not", () => {
    const result = classifyDeclaredTools(
        ["definitely_unsupported", "notebook/runCell", "made_up_tool"],
        classificationEnvironment,
    );
    assert.deepEqual(result.fatalToolNames, ["definitely_unsupported"]);
    assert.equal(categoryOf(result, "notebook/runCell"), "optional_unsupported_desktop");
    assert.equal(categoryOf(result, "made_up_tool"), "unverified_unsupported");
});

test("classification never materializes a tool for an unresolved name", () => {
    const result = classifyDeclaredTools(["made_up_tool"], classificationEnvironment);
    assert.equal(Object.hasOwn(result.classifications[0], "tool"), false);
});

test("desktop-only precedence: row 1 beats vscode/*", () => {
    assert.equal(classifyDesktopOnlyTool("vscode/installExtension"), "extension-management");
    assert.equal(classifyDesktopOnlyTool("vscode/openFile"), "vscode-ui");
    assert.equal(classifyDesktopOnlyTool("terminal/getSelection"), "terminal-selection");
    assert.equal(classifyDesktopOnlyTool("desktop/browser/click"), "browser-ui-automation");
    assert.equal(classifyDesktopOnlyTool("jupyter/exec"), "notebook-editing");
    assert.equal(classifyDesktopOnlyTool("read"), null);
});

test("pattern matching is case-sensitive and * does not cross a slash", () => {
    assert.equal(classifyDesktopOnlyTool("VSCode/openFile"), null);
    assert.equal(classifyDesktopOnlyTool("vscode/ui/openFile"), null);
});

// ─── 3. Adapter registry ────────────────────────────────────────

test("adapters register per profile and are keyed by name", () => {
    const registry = new CompatibilityAdapterRegistry();
    assert.equal(registry.has(COPILOT_CLI_PROFILE), false);
    registry.register(COPILOT_CLI_PROFILE, [{ name: "execute" }, { name: "read" }]);
    assert.deepEqual(registry.names(COPILOT_CLI_PROFILE).sort(), ["execute", "read"]);
    assert.deepEqual(registry.get(COPILOT_CLI_PROFILE, "execute"), { name: "execute" });
    assert.equal(registry.get(COPILOT_CLI_PROFILE, "missing"), undefined);
});

test("an adapter without a string name is refused rather than silently dropped", () => {
    const registry = new CompatibilityAdapterRegistry();
    assert.throws(() => registry.register(COPILOT_CLI_PROFILE, [{}]), /missing a string 'name'/);
});

// ─── 4. Disabled-profile parity ─────────────────────────────────

test("disabled compatibility adds no key to the serialized session config", () => {
    const baseConfig = { model: "openai:gpt-5", toolNames: ["read", "write_file"] };
    const withFragment = { ...baseConfig, ...buildCompatSessionConfigFragment(undefined) };

    assert.deepEqual(withFragment, baseConfig);
    assert.deepEqual(Object.keys(withFragment), Object.keys(baseConfig));
    assert.equal(Object.hasOwn(withFragment, "compatibilityProfile"), false);
    assert.equal(Object.hasOwn(withFragment, "workspaceBinding"), false);
    assert.equal(Object.hasOwn(withFragment, "copilotCliTodoState"), false);
    assert.equal(Object.hasOwn(withFragment, "compatibilitySchemaVersion"), false);
    assert.equal(JSON.stringify(withFragment).includes("compat"), false);
});

// Compared against the frozen artifact rather than a locally recomputed expectation, so
// the assertions cannot drift with the code they are meant to pin.
test("disabled-path parsing matches the frozen parity artifact", () => {
    for (const [filename, expectedMeta] of Object.entries(parityArtifact.parsedFrontmatter)) {
        assert.deepEqual(parseAgentFrontmatter(readFixture(filename)).meta, expectedMeta, filename);
    }

    const loaded = loadAgentFiles(fixtureAgentsDir)
        .map((agent) => ({
            name: agent.name,
            tools: agent.tools ?? null,
            agents: agent.agents ?? null,
            skills: agent.skills ?? null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    assert.deepEqual(loaded, parityArtifact.loadedAgents);

    // At least one fixture must carry agents: or the baseline proves nothing.
    assert.ok(readFixture("compat-inline.agent.md").includes("agents:"));
    for (const agent of parityArtifact.loadedAgents) {
        assert.equal(agent.agents, null);
    }
});

test("disabled compatibility serializes exactly the frozen key set", () => {
    const baseConfig = { model: "openai:gpt-5", toolNames: ["read", "write_file"] };
    const withFragment = { ...baseConfig, ...buildCompatSessionConfigFragment(undefined) };

    assert.deepEqual(withFragment, parityArtifact.serializedSessionConfig);
    assert.deepEqual(Object.keys(withFragment), parityArtifact.serializedSessionConfigKeys);
    assert.equal(JSON.stringify(parityArtifact.serializedSessionConfig).includes("compat"), false);
});

test("the real resolver reproduces the frozen tool list and order with compat disabled", () => {
    const frozen = parityArtifact.toolResolution;

    const sessionManager = new SessionManager(undefined, null, {
        frameworkBaseToolNames: frozen.frameworkDefaultToolNames,
        appDefaultToolNames: frozen.appDefaultToolNames,
    });

    const serializableConfig = { toolNames: frozen.agentDeclaredToolNames };
    assert.equal(
        inheritsAppDefaults(
            {
                frameworkBaseToolNames: frozen.frameworkDefaultToolNames,
                appDefaultToolNames: frozen.appDefaultToolNames,
            },
            serializableConfig,
        ),
        frozen.appDefaultsInherited,
    );

    const inheritedToolNames = Array.from(new Set([
        ...frozen.frameworkDefaultToolNames,
        ...(frozen.appDefaultsInherited ? frozen.appDefaultToolNames : []),
        ...frozen.agentDeclaredToolNames,
    ]));
    assert.deepEqual(inheritedToolNames, frozen.inheritedToolNames);

    const toolRegistry = new Map();
    for (const name of inheritedToolNames) toolRegistry.set(name, { name });
    sessionManager.setToolRegistry(toolRegistry);

    const resolved = sessionManager["_resolveTools"](undefined, { toolNames: inheritedToolNames });
    assert.deepEqual(resolved.map((tool) => tool.name), frozen.resolvedToolNamesInOrder);

    // Classification is observational: it must not reorder or remove anything.
    const classification = classifyDeclaredTools(frozen.agentDeclaredToolNames, {
        resolvableToolNames: frozen.resolvedToolNamesInOrder,
    });
    assert.deepEqual(classification.fatalToolNames, []);
    assert.deepEqual(
        sessionManager["_resolveTools"](undefined, { toolNames: inheritedToolNames })
            .map((tool) => tool.name),
        frozen.resolvedToolNamesInOrder,
    );
});

test("a compat-free config yields no compat state and an unknown future field is not fatal", () => {
    assert.equal(readCompatSessionState({ model: "openai:gpt-5" }), undefined);
    assert.equal(readCompatSessionState(undefined), undefined);

    const futureConfig = {
        compatibilityProfile: COPILOT_CLI_PROFILE,
        compatibilitySchemaVersion: COMPATIBILITY_SCHEMA_VERSION,
        someUnknownFutureCompatField: { anything: true },
    };
    const state = readCompatSessionState(futureConfig);
    assert.equal(state.profile, COPILOT_CLI_PROFILE);
    assert.equal(state.workspaceBinding, undefined);
});

// ─── 5. Bounds ──────────────────────────────────────────────────

// Table-driven over the whole table: a bound added without coverage fails here.
test("every declared bound clamps above the maximum and preserves values below it", () => {
    const boundNames = Object.keys(COPILOT_COMPAT_BOUNDS);
    assert.ok(boundNames.length > 0);

    for (const boundName of boundNames) {
        const { default: defaultValue, maximum } = COPILOT_COMPAT_BOUNDS[boundName];
        const expectedFallback = Math.min(defaultValue, maximum);

        assert.equal(clampCompatBound(boundName, maximum + 1), maximum, `${boundName}: above maximum`);
        assert.equal(clampCompatBound(boundName, maximum * 1000), maximum, `${boundName}: far above maximum`);
        assert.equal(clampCompatBound(boundName, maximum), maximum, `${boundName}: at maximum`);

        const belowMaximum = maximum - 1;
        if (belowMaximum > 0) {
            assert.equal(clampCompatBound(boundName, belowMaximum), belowMaximum, `${boundName}: below maximum`);
        }

        for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.equal(
                clampCompatBound(boundName, invalid),
                expectedFallback,
                `${boundName}: ${String(invalid)} must fall back to the default`,
            );
        }
    }
});

// ─── 6. Latest-generation guard ─────────────────────────────────

// Resolved THROUGH the registry, so repointing the latest entry at an unpatched handler,
// or adding a newer generation, fails instead of passing on a stale file grep.
// See d:/git/waldemort/myplans/copilot-cli-compat/copilot-cli-compat-design.md, "D6".
test("the handler registered for the latest version carries the compat child-config patch", async () => {
    const { DURABLE_SESSION_ORCHESTRATION_REGISTRY, DURABLE_SESSION_LATEST_VERSION } =
        await import("../../dist/orchestration-registry.js");

    const latestEntries = DURABLE_SESSION_ORCHESTRATION_REGISTRY
        .filter((entry) => entry.version === DURABLE_SESSION_LATEST_VERSION);
    assert.equal(latestEntries.length, 1, "exactly one registry entry must claim the latest version");

    const latestHandler = latestEntries[0].handler;
    assert.equal(typeof latestHandler, "function");

    // No registered version may sort above the latest.
    for (const entry of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
        assert.ok(
            compareVersions(entry.version, DURABLE_SESSION_LATEST_VERSION) <= 0,
            `registry contains ${entry.version}, newer than DURABLE_SESSION_LATEST_VERSION`,
        );
    }

    // Text-matched against only this resolved handler's own source, never a whole file.
    const handlerSource = latestHandler.toString();
    const spawnSource = handlerSource.includes("applyCompatChildConfig")
        ? handlerSource
        : await readLatestGenerationAgentsSource();
    assert.match(spawnSource, /applyCompatChildConfig\(childConfig\)/);
});

test("the compat child-config patch deep-copies todo state and shares the binding", () => {
    const parentConfig = makeCompatParentConfig();
    const childConfig = applyCompatChildConfig({ ...parentConfig, model: "openai:gpt-5-mini" });

    assert.equal(childConfig.workspaceBinding, parentConfig.workspaceBinding);
    assert.notEqual(childConfig.copilotCliTodoState.items[0], parentConfig.copilotCliTodoState.items[0]);

    childConfig.copilotCliTodoState.items[0].status = "completed";
    assert.equal(parentConfig.copilotCliTodoState.items[0].status, "in_progress");
});

// ─── 7. Workspace binding durability and inheritance ────────────

function makeCompatParentConfig() {
    return {
        model: "openai:gpt-5",
        toolNames: ["read", "execute"],
        ...buildCompatSessionConfigFragment({
            profile: COPILOT_CLI_PROFILE,
            workspaceBinding: {
                ...createUncreatedWorkspaceBinding({
                    workspaceId: "ws-1",
                    ownerSessionId: "session-parent",
                    namespace: "waldemort",
                }),
                podName: "compat-ws-1",
                generation: 1,
                status: "ready",
            },
            todoState: { items: [{ id: "1", title: "Inspect workload output", status: "in_progress" }] },
        }),
    };
}

test("workspace binding and todo state survive a turn boundary round-trip", () => {
    const parentConfig = makeCompatParentConfig();

    // A turn boundary persists config as JSON through duroxide.
    const rehydrated = JSON.parse(JSON.stringify(parentConfig));

    assert.deepEqual(rehydrated.workspaceBinding, parentConfig.workspaceBinding);
    assert.equal(rehydrated.workspaceBinding.generation, 1);
    assert.equal(rehydrated.workspaceBinding.rootPath, "/workspace");
    assert.equal(rehydrated.workspaceBinding.activeDeadlineSeconds, 86400);
    assert.deepEqual(rehydrated.copilotCliTodoState, parentConfig.copilotCliTodoState);
    assert.equal(rehydrated.compatibilitySchemaVersion, COMPATIBILITY_SCHEMA_VERSION);
});

test("a spawned child shares the workspace binding but gets a deep-cloned todo state", () => {
    const parentConfig = makeCompatParentConfig();

    // Mirrors orchestration/agents.ts child construction.
    const childConfig = applyCompatChildConfig({ ...parentConfig, model: "openai:gpt-5-mini" });

    assert.equal(childConfig.workspaceBinding, parentConfig.workspaceBinding);
    assert.notEqual(childConfig.copilotCliTodoState, parentConfig.copilotCliTodoState);
    assert.notEqual(childConfig.copilotCliTodoState.items[0], parentConfig.copilotCliTodoState.items[0]);
    assert.deepEqual(childConfig.copilotCliTodoState, parentConfig.copilotCliTodoState);

    childConfig.copilotCliTodoState.items[0].status = "completed";
    childConfig.copilotCliTodoState.items.push({ id: "2", title: "Child-only item", status: "pending" });
    assert.equal(parentConfig.copilotCliTodoState.items[0].status, "in_progress");
    assert.equal(parentConfig.copilotCliTodoState.items.length, 1);
});

test("the child-config patch is inert for a compat-disabled parent", () => {
    const plainParentConfig = { model: "openai:gpt-5", toolNames: ["read"] };
    const childConfig = applyCompatChildConfig({ ...plainParentConfig });
    assert.deepEqual(childConfig, plainParentConfig);
    assert.deepEqual(Object.keys(childConfig), Object.keys(plainParentConfig));
});

test("a child is a non-owning user and reports loss instead of recreating the workspace", () => {
    const parentConfig = makeCompatParentConfig();
    const childConfig = applyCompatChildConfig({ ...parentConfig });

    assert.equal(isWorkspaceOwner(childConfig.workspaceBinding, "session-child"), false);
    assert.equal(isWorkspaceOwner(childConfig.workspaceBinding, "session-parent"), true);

    const diagnostic = workspaceLostForNonOwnerDiagnostic("execute", childConfig.workspaceBinding);
    assert.equal(diagnostic.severity, "FAIL");
    assert.equal(diagnostic.action, "notify_owner");
    assert.equal(
        diagnostic.text,
        "[copilot-compat][FAIL][workspace_lost] tool=execute workspace=ws-1 owner=session-parent action=notify_owner detail=A child observed loss of a parent-owned workspace and did not recreate it.",
    );
});

// ─── 6. One outcome per declared name, and never a fake success ──

const EVERY_CATEGORY_DECLARATION = [
    "read",                    // native_supported
    "execute",                 // adapter_registered
    "firecrawl_scrape",        // mcp_conditional
    "vscode/installExtension", // optional_unsupported_desktop
    "definitely_unsupported",  // verified_unsupported
    "exceute",                 // unverified_unsupported — a typo, NOT desktop-only
];

test("every declared name yields exactly one classification, in declaration order", () => {
    const result = classifyDeclaredTools(EVERY_CATEGORY_DECLARATION, classificationEnvironment);

    assert.equal(result.classifications.length, EVERY_CATEGORY_DECLARATION.length);
    assert.deepEqual(result.classifications.map((entry) => entry.toolName), EVERY_CATEGORY_DECLARATION);
    assert.equal(result.diagnostics.length, result.classifications.length);
});

test("a duplicated declared name is classified once per declaration, never merged or dropped", () => {
    const result = classifyDeclaredTools(["execute", "execute"], classificationEnvironment);
    assert.deepEqual(result.classifications.map((entry) => entry.category), ["adapter_registered", "adapter_registered"]);
});

/**
 * A typo is unsupported but has no honest desktop category. Reporting one would tell the
 * author to look for a desktop equivalent that does not exist, and FR-CC-010 closes the
 * desktop reason to five categories.
 */
test("an unsupported non-desktop typo warns, is ignored, and carries no desktop category", () => {
    const result = classifyDeclaredTools(["exceute"], classificationEnvironment);
    const entry = result.classifications[0];

    assert.equal(entry.category, "unverified_unsupported");
    assert.equal(entry.severity, "WARN");
    assert.equal(entry.desktopCategory, undefined);
    assert.equal(classifyDesktopOnlyTool("exceute"), null);
    assert.deepEqual(result.fatalToolNames, []);
    assert.equal(entry.diagnostic.text.includes("category="), false);
    assert.equal(entry.diagnostic.action, "ignored");
});

/** FR-CC-011: no unsupported outcome may look like an available tool. */
test("no unsupported outcome carries an available severity, an adapter, or a tool handle", () => {
    const result = classifyDeclaredTools(EVERY_CATEGORY_DECLARATION, classificationEnvironment);
    const availableCategories = new Set(["native_supported", "adapter_registered"]);

    for (const entry of result.classifications) {
        if (availableCategories.has(entry.category)) {
            assert.equal(entry.severity, "INFO");
            continue;
        }
        assert.notEqual(entry.severity, "INFO");
        assert.equal(Object.hasOwn(entry, "tool"), false);
        assert.equal(Object.hasOwn(entry, "handler"), false);
        assert.equal(entry.diagnostic.action === "materialized", false);
    }
});

/** An empty declaration is an empty result, not a default set of tools. */
test("declaring no tools materializes nothing and is not fatal", () => {
    const result = classifyDeclaredTools([], classificationEnvironment);
    assert.deepEqual(result, { classifications: [], diagnostics: [], fatalToolNames: [] });
});

// ─── 7. Published bounds match the approved specification ───────

/**
 * Pinned against the spec's "Published bounds" table rather than recomputed from the
 * source, so lowering a maximum in code cannot silently pass.
 */
test("each published maximum matches the approved specification", () => {
    const specifiedMaximums = {
        executeTimeoutSeconds: 600,
        executeStdoutBytes: 1048576,
        executeStderrBytes: 1048576,
        readMaxBytes: 1048576,
        readLines: 2000,
        editDecodedWriteBytes: 8388608,
        searchTimeoutSeconds: 120,
        searchMaxResults: 500,
        searchLineBytes: 4096,
        searchTotalBytes: 1048576,
        webTimeoutSeconds: 60,
        webBodyBytes: 1048576,
        webRedirects: 5,
        agentWaitTimeoutSeconds: 900,
    };

    for (const [boundName, specifiedMaximum] of Object.entries(specifiedMaximums)) {
        assert.equal(COPILOT_COMPAT_BOUNDS[boundName].maximum, specifiedMaximum, boundName);
        assert.ok(COPILOT_COMPAT_BOUNDS[boundName].default <= specifiedMaximum, boundName);
        assert.equal(clampCompatBound(boundName, specifiedMaximum * 10), specifiedMaximum, boundName);
    }
});

test("a fresh binding starts uncreated so enabling compatibility creates no pod", () => {
    const binding = createUncreatedWorkspaceBinding({
        workspaceId: "ws-2",
        ownerSessionId: "session-parent",
        namespace: "waldemort",
    });
    assert.equal(binding.status, "uncreated");
    assert.equal(binding.generation, 0);
    assert.equal(binding.podName, undefined);
    assert.equal(binding.rootPath, "/workspace");
});
