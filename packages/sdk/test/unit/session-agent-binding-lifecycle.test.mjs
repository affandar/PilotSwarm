/**
 * Real SessionManager + ManagedSession handoff/lifecycle, with only the Copilot
 * transport and persistence stubbed. Assertions inspect the emitted SDK config,
 * invoke its composed prompt callbacks, and execute the selected tool handlers.
 * No provider credentials or external database are used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, agentOwnerKey, packageAgentKey } from "../../dist/session-manager.js";

const ALICE = { provider: "test", subject: "alice" };
const BOB = { provider: "test", subject: "bob" };
const named = {
    boundAgentName: "analyst", boundAgentPackageId: "shared-package",
    detachedPackageToolPolicy: "reject", toolNames: ["catalog"],
};
const tool = (name, result = name, description = name) => ({
    name, description, parameters: { type: "object", properties: {} },
    handler: async () => result,
});
const copy = (id, prompt, { owner = null, tools = ["catalog"], version = "1" } = {}) => ({
    prompt, toolNames: tools, kind: "app-agent", packageId: id,
    packageScope: owner ? "user" : "shared", packageOwner: owner,
    descriptor: { layerKind: "agent", layerId: id, name: "analyst", schemaVersion: "3", version, type: "app" },
});

function fixture(t, { owner = ALICE, hydrate = false } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-agent-binding-"));
    const calls = [];
    const handles = [];
    const events = [];
    const defaults = {
        frameworkBasePrompt: "FRAMEWORK", appDefaultPrompt: "APP DEFAULT",
        frameworkBaseToolNames: ["framework_tool"], appDefaultToolNames: ["app_tool"],
        agentPromptLookup: {}, agentMcpServers: {}, baseMcpServers: { base: { type: "http", url: "https://base.example" } },
    };
    const persist = hydrate ? {
        exists: async () => true,
        hydrate: async id => { mkdirSync(join(home, id), { recursive: true }); },
    } : null;
    const manager = new SessionManager(undefined, persist, defaults, home);
    manager._sessionAgentOwnerKey = async () => agentOwnerKey(owner);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }),
    });
    const open = (kind, config) => {
        const handle = { disconnected: false, disconnect: async () => { handle.disconnected = true; } };
        handles.push(handle);
        calls.push({ kind, config, handle });
        mkdirSync(join(home, config.sessionId), { recursive: true });
        return handle;
    };
    manager.ensureClient = async () => ({
        createSession: async config => open("create", config),
        resumeSession: async (id, config) => open("resume", config),
        deleteSession: async () => {},
    });
    function publish({ shared = copy("shared-package", "SHARED INSTRUCTIONS"),
        privateCopy = copy("private-package", "PRIVATE INSTRUCTIONS", { owner: ALICE }),
        sharedTools = [tool("catalog", "shared-handler")],
        privateTools = [tool("catalog", "private-handler")],
        extraStatic = [], sharedMcp = "https://shared.example", privateMcp = "https://private.example",
    } = {}) {
        const copies = [shared, privateCopy].filter(Boolean);
        if (copies.length) defaults.agentPromptLookup.analyst = { ...copies[0], copies };
        else delete defaults.agentPromptLookup.analyst;
        for (const key of Object.keys(defaults.agentMcpServers)) delete defaults.agentMcpServers[key];
        if (shared) defaults.agentMcpServers[packageAgentKey(shared.packageId, "analyst")] = { specialist: { type: "http", url: sharedMcp } };
        if (privateCopy) defaults.agentMcpServers[packageAgentKey(privateCopy.packageId, "analyst")] = { specialist: { type: "http", url: privateMcp } };
        const staticTools = [tool("framework_tool"), tool("app_tool"), ...extraStatic];
        const byPackage = new Map();
        if (shared) byPackage.set(shared.packageId, new Map(sharedTools.map(t => [t.name, t])));
        if (privateCopy) byPackage.set(privateCopy.packageId, new Map(privateTools.map(t => [t.name, t])));
        manager.setToolRegistry(new Map([...staticTools, ...sharedTools, ...privateTools].map(t => [t.name, t])), {
            byPackage, staticNames: new Set(staticTools.map(t => t.name)),
        });
    }
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    publish();
    return { manager, calls, handles, defaults, publish, events };
}
const prompt = sdkConfig => sdkConfig.systemMessage.sections.last_instructions.action("");
const declaration = (sdkConfig, name) => sdkConfig.tools.find(t => t.name === name);
const handler = (managed, name) => managed.config.tools.find(t => t.name === name)?.handler;

for (const mode of ["create", "hydrate"]) {
    test(`${mode}: explicit shared package supplies the actual prompt, descriptor, handler and MCP despite private shadow`, async t => {
        const h = fixture(t, { hydrate: mode === "hydrate" });
        const session = await h.manager.getOrCreate("child", named, { turnIndex: mode === "hydrate" ? 2 : 0 });
        const sdk = h.calls.at(-1).config;
        assert.equal(h.calls[0].kind, mode === "hydrate" ? "resume" : "create");
        assert.match(await prompt(sdk), /SHARED INSTRUCTIONS/);
        assert.doesNotMatch(await prompt(sdk), /PRIVATE INSTRUCTIONS/);
        assert.match(sdk.systemMessage.sections.custom_instructions.content, /shared-package/);
        assert.doesNotMatch(sdk.systemMessage.sections.custom_instructions.content, /private-package/);
        assert.equal(await handler(session, "catalog")(), "shared-handler");
        assert.equal(sdk.mcpServers.specialist.url, "https://shared.example");
        assert.equal(sdk.mcpServers.base.url, "https://base.example");
        assert.ok(declaration(sdk, "framework_tool"));
        assert.ok(declaration(sdk, "app_tool"));
        assert.ok(declaration(sdk, "spawn_agent"));
    });
}

test("private binding rechecks ownership on a different worker; never falls back to the shared copy", async t => {
    const alice = fixture(t);
    const config = { ...named, boundAgentPackageId: "private-package" };
    const session = await alice.manager.getOrCreate("child", config, { turnIndex: 0 });
    assert.match(await prompt(alice.calls[0].config), /PRIVATE INSTRUCTIONS/);
    assert.equal(await handler(session, "catalog")(), "private-handler");
    const bob = fixture(t, { owner: BOB, hydrate: true });
    await assert.rejects(bob.manager.getOrCreate("child", config, { turnIndex: 2 }), { code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
    assert.equal(bob.calls.length, 0);
});

test("same-package handler refresh updates a warm session, retaining explicit application tools and defaults", async t => {
    const h = fixture(t);
    const explicit = tool("application_tool", "explicit-handler");
    h.manager.setConfig("child", { tools: [explicit] });
    const first = await h.manager.getOrCreate("child", named, { turnIndex: 0 });
    assert.equal(await handler(first, "catalog")(), "shared-handler");
    h.publish({ sharedTools: [tool("catalog", "refreshed-handler")] });
    const next = await h.manager.getOrCreate("child", named, { turnIndex: 1 });
    assert.equal(next, first, "identical declarations need no transport reset");
    assert.equal(await handler(next, "catalog")(), "refreshed-handler");
    assert.equal(await handler(next, "application_tool")(), "explicit-handler");
    assert.equal(await handler(next, "framework_tool")(), "framework_tool");
    assert.equal(await handler(next, "app_tool")(), "app_tool");
    assert.equal(h.calls.length, 1);
});

test("refresh snapshots instructions until the next turn and rebinds declarations, descriptor and MCP together", async t => {
    const h = fixture(t);
    const first = await h.manager.getOrCreate("child", named, { turnIndex: 0 });
    const originalSdk = h.calls[0].config;
    h.publish({
        shared: copy("shared-package", "UPDATED INSTRUCTIONS", { tools: ["search_catalog"], version: "2" }),
        sharedTools: [tool("search_catalog", "updated-handler")],
        sharedMcp: "https://updated.example",
    });
    assert.match(await prompt(originalSdk), /SHARED INSTRUCTIONS/, "reload does not change a running turn's instructions");
    assert.equal(await handler(first, "catalog")(), "shared-handler");
    const next = await h.manager.getOrCreate("child", named, { turnIndex: 1 });
    assert.notEqual(next, first);
    assert.equal(h.handles[0].disconnected, true);
    const sdk = h.calls.at(-1).config;
    assert.equal(h.calls.at(-1).kind, "resume");
    assert.match(await prompt(sdk), /UPDATED INSTRUCTIONS/);
    assert.match(sdk.systemMessage.sections.custom_instructions.content, /version=2/);
    assert.equal(sdk.mcpServers.specialist.url, "https://updated.example");
    assert.equal(declaration(sdk, "catalog"), undefined, "old declaration removed");
    assert.equal(handler(next, "catalog"), undefined, "old handler removed");
    assert.equal(await handler(next, "search_catalog")(), "updated-handler");
    assert.ok(declaration(sdk, "framework_tool"));
    assert.ok(declaration(sdk, "app_tool"));
});

test("removing then re-enabling the bound package cannot reuse a stale handler or switch to the private shadow", async t => {
    const h = fixture(t);
    await h.manager.getOrCreate("child", named, { turnIndex: 0 });
    h.publish({ shared: null, sharedTools: [] });
    await assert.rejects(h.manager.getOrCreate("child", named, { turnIndex: 1 }), { code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
    assert.equal(h.manager.get("child"), null);
    assert.equal(h.handles[0].disconnected, true);
    assert.equal(h.calls.length, 1, "no unauthorized SDK session created");
    h.publish({ sharedTools: [tool("catalog", "re-enabled-handler")] });
    const next = await h.manager.getOrCreate("child", named, { turnIndex: 2 });
    assert.equal(await handler(next, "catalog")(), "re-enabled-handler");
    assert.match(await prompt(h.calls.at(-1).config), /SHARED INSTRUCTIONS/);
});

test("named definition with no additional tools removes stale declared tools and keeps worker defaults", async t => {
    const h = fixture(t);
    h.publish({ shared: copy("shared-package", "NO TOOLS", { tools: [] }), sharedTools: [] });
    const session = await h.manager.getOrCreate("child", { ...named, toolNames: ["catalog", "parent_only_tool"] }, { turnIndex: 0 });
    const sdk = h.calls[0].config;
    assert.equal(handler(session, "catalog"), undefined);
    assert.equal(declaration(sdk, "catalog"), undefined);
    assert.equal(declaration(sdk, "parent_only_tool"), undefined);
    assert.ok(declaration(sdk, "framework_tool"));
    assert.ok(declaration(sdk, "app_tool"));
});

test("unnamed delegated child drops package tools but retains ordinary inherited and default tools on every turn", async t => {
    const h = fixture(t);
    h.publish({ extraStatic: [tool("ordinary_tool", "ordinary-v1")] });
    const config = { toolNames: ["catalog", "ordinary_tool"], detachedPackageToolPolicy: "drop" };
    const first = await h.manager.getOrCreate("generic", config, { turnIndex: 0 });
    assert.equal(handler(first, "catalog"), undefined);
    assert.equal(await handler(first, "ordinary_tool")(), "ordinary-v1");
    assert.doesNotMatch(await prompt(h.calls[0].config), /SHARED INSTRUCTIONS|PRIVATE INSTRUCTIONS/);
    assert.equal(h.calls[0].config.mcpServers.specialist, undefined);
    h.publish({ extraStatic: [tool("ordinary_tool", "ordinary-v2")] });
    const second = await h.manager.getOrCreate("generic", config, { turnIndex: 1 });
    assert.equal(handler(second, "catalog"), undefined);
    assert.equal(await handler(second, "ordinary_tool")(), "ordinary-v2");
    assert.ok(handler(second, "framework_tool"));
    assert.ok(handler(second, "app_tool"));
});

test("explicit application tool precedence is preserved without retaining removed registry handlers", async t => {
    const h = fixture(t);
    h.publish({ extraStatic: [tool("application_tool", "registry-version")] });
    h.manager.setConfig("generic", { tools: [tool("application_tool", "caller-version")] });
    const config = { toolNames: ["application_tool"], detachedPackageToolPolicy: "drop" };
    let session = await h.manager.getOrCreate("generic", config, { turnIndex: 0 });
    assert.equal(await handler(session, "application_tool")(), "caller-version");
    h.publish();
    session = await h.manager.getOrCreate("generic", config, { turnIndex: 1 });
    assert.equal(await handler(session, "application_tool")(), "caller-version");
    h.manager.setConfig("generic", { tools: [] });
    session = await h.manager.getOrCreate("generic", config, { turnIndex: 2 });
    assert.equal(handler(session, "application_tool"), undefined);
    assert.equal(declaration(h.calls.at(-1).config, "application_tool"), undefined);
});

test("an explicitly supplied package handler refreshes from its bound package and cannot revive a removed package tool", async t => {
    const h = fixture(t);
    h.manager.setConfig("child", { tools: [tool("catalog", "stale-explicit-package-handler")] });
    let session = await h.manager.getOrCreate("child", named, { turnIndex: 0 });
    assert.equal(await handler(session, "catalog")(), "shared-handler");
    h.publish({ sharedTools: [tool("catalog", "fresh-package-handler")] });
    session = await h.manager.getOrCreate("child", named, { turnIndex: 1 });
    assert.equal(await handler(session, "catalog")(), "fresh-package-handler");
    h.publish({ shared: copy("shared-package", "NO TOOLS", { tools: [] }), sharedTools: [] });
    await assert.rejects(h.manager.getOrCreate("child", named, { turnIndex: 2 }), { code: "PACKAGE_TOOL_REQUIRES_BOUND_AGENT" });
    assert.equal(h.manager.get("child"), null);
});

for (const changed of ["declaration", "mcp"]) {
    test(`${changed}-only refresh recreates the warm SDK handle`, async t => {
        const h = fixture(t);
        const first = await h.manager.getOrCreate("child", named, { turnIndex: 0 });
        h.publish(changed === "declaration"
            ? { sharedTools: [tool("catalog", "updated-handler", "Changed description and semantics")] }
            : { sharedMcp: "https://changed-only.example" });
        const next = await h.manager.getOrCreate("child", named, { turnIndex: 1 });
        assert.notEqual(next, first);
        assert.equal(h.handles[0].disconnected, true);
        assert.equal(h.calls.length, 2);
        const sdk = h.calls.at(-1).config;
        if (changed === "declaration") assert.equal(declaration(sdk, "catalog").description, "Changed description and semantics");
        else assert.equal(sdk.mcpServers.specialist.url, "https://changed-only.example");
        assert.match(await prompt(sdk), /SHARED INSTRUCTIONS/);
    });
}

test("publishing a private shadow does not change an existing shared-package pin", async t => {
    const h = fixture(t);
    h.publish({ privateCopy: null, privateTools: [] });
    const first = await h.manager.getOrCreate("child", named, { turnIndex: 0 });
    h.publish();
    const next = await h.manager.getOrCreate("child", named, { turnIndex: 1 });
    assert.equal(next, first);
    assert.equal(await handler(next, "catalog")(), "shared-handler");
    assert.match(await prompt(h.calls[0].config), /SHARED INSTRUCTIONS/);
    assert.doesNotMatch(await prompt(h.calls[0].config), /PRIVATE INSTRUCTIONS/);
});

test("prompt-layer telemetry records the same private copy as the actual composed prompt", async t => {
    const h = fixture(t);
    h.manager.setSessionCatalog({
        getSession: async () => ({ owner: ALICE }),
        recordEvents: async (_id, events) => { h.events.push(...events); },
    });
    await h.manager.getOrCreate("child", { ...named, boundAgentPackageId: "private-package" }, { turnIndex: 0 });
    assert.match(await prompt(h.calls[0].config), /PRIVATE INSTRUCTIONS/);
    const layers = h.events.find(e => e.eventType === "session.prompt_layers").data.layers;
    assert.deepEqual(layers.map(l => l.layerId), ["private-package"]);
});

test("worker lookup records declared tools, including explicit empty defaults, for every copy", async () => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const lookup = {};
    const worker = {
        _agentPromptLookup: lookup, _loadedSystemAgents: [],
        _rawLoadedAgents: [
            { name: "with-tools", prompt: "WITH", tools: ["catalog"] },
            { name: "omitted", prompt: "OMITTED" },
            { name: "null", prompt: "NULL", tools: null },
            { name: "empty", prompt: "EMPTY", tools: [] },
        ],
    };
    PilotSwarmWorker.prototype._finalizeAgentPromptLookup.call(worker);
    assert.deepEqual(lookup["with-tools"].toolNames, ["catalog"]);
    assert.deepEqual(lookup.omitted.toolNames, []);
    assert.deepEqual(lookup.null.toolNames, []);
    assert.deepEqual(lookup.empty.toolNames, []);
});

test("a no-copy snapshot cannot acquire a newly published agent between authorization and SDK creation", async t => {
    const h = fixture(t, { owner: BOB });
    h.publish({ shared: null, sharedTools: [] });
    const client = h.manager.ensureClient;
    h.manager.ensureClient = async (...args) => {
        // This await boundary is after agent/tool selection and before prompt
        // construction. A default parameter must not re-resolve undefined here.
        h.publish();
        return client(...args);
    };
    await h.manager.getOrCreate("child", {
        boundAgentName: "analyst", detachedPackageToolPolicy: "drop", toolNames: [],
    }, { turnIndex: 0 });
    const sdk = h.calls[0].config;
    assert.doesNotMatch(await prompt(sdk), /SHARED INSTRUCTIONS|PRIVATE INSTRUCTIONS/);
    assert.doesNotMatch(sdk.systemMessage.sections.custom_instructions.content, /shared-package|private-package/);
    assert.equal(sdk.mcpServers.specialist, undefined);
});

for (const release of ["dropWarmSession", "dehydrate"]) {
    test(`${release} releases transient snapshots but keeps explicit application tools for hydration`, async t => {
        const h = fixture(t);
        h.manager.setConfig("child", { tools: [tool("application_tool", "explicit")] });
        await h.manager.getOrCreate("child", named, { turnIndex: 0 });
        await h.manager[release]("child", "test");
        assert.equal(h.manager.sessionAgentCopies.has("child"), false);
        assert.equal(h.manager.sessionBindingFingerprints.has("child"), false);
        assert.equal(h.manager.sessionApplicationTools.has("child"), true);
        const restored = await h.manager.getOrCreate("child", named, { turnIndex: 1 });
        assert.equal(await handler(restored, "application_tool")(), "explicit");
    });
}

test("destroy and shutdown release application tools as well as binding snapshots", async t => {
    const h = fixture(t);
    for (const id of ["one", "two"]) {
        h.manager.setConfig(id, { tools: [tool("application_tool")] });
        await h.manager.getOrCreate(id, named, { turnIndex: 0 });
    }
    await h.manager.destroySession("one");
    for (const map of [h.manager.sessionAgentCopies, h.manager.sessionBindingFingerprints,
        h.manager.sessionApplicationTools, h.manager.sessionConfigs]) assert.equal(map.has("one"), false);
    await h.manager.shutdown();
    for (const map of [h.manager.sessionAgentCopies, h.manager.sessionBindingFingerprints,
        h.manager.sessionApplicationTools, h.manager.sessionConfigs]) assert.equal(map.size, 0);
});

test("exported package tools omitted from the named definition cannot enter through explicit config tools", async t => {
    const h = fixture(t);
    h.publish({ shared: copy("shared-package", "NO EXTRA TOOLS", { tools: [] }) });
    h.manager.setConfig("child", { tools: [tool("catalog", "caller-handler")] });
    await assert.rejects(h.manager.getOrCreate("child", named, { turnIndex: 0 }), { code: "PACKAGE_TOOL_REQUIRES_BOUND_AGENT" });
    assert.equal(h.calls.length, 0);
});

const deploymentCopy = {
    prompt: "DEPLOYMENT INSTRUCTIONS", toolNames: ["deployment_catalog"], kind: "app-agent",
    descriptor: { layerKind: "agent", layerId: "deployment-analyst", name: "analyst", schemaVersion: "3", version: "1", type: "app" },
};
const deploymentBinding = { boundAgentName: "analyst", boundAgentSource: "deployment", detachedPackageToolPolicy: "reject", toolNames: ["deployment_catalog"] };
function addDeployment(h) {
    h.publish({ extraStatic: [tool("deployment_catalog", "deployment-handler")] });
    const entry = h.defaults.agentPromptLookup.analyst;
    h.defaults.agentPromptLookup.analyst = { ...entry, copies: [...entry.copies, deploymentCopy] };
    h.defaults.agentMcpServers.analyst = { specialist: { type: "http", url: "https://deployment.example" } };
}
for (const hydrate of [false, true]) {
    test(`explicit deployment selection survives private/shared shadow on ${hydrate ? "hydrate" : "create"}`, async t => {
        const h = fixture(t, { hydrate });
        addDeployment(h);
        const session = await h.manager.getOrCreate("child", deploymentBinding, { turnIndex: hydrate ? 2 : 0 });
        const sdk = h.calls[0].config;
        assert.match(await prompt(sdk), /DEPLOYMENT INSTRUCTIONS/);
        assert.doesNotMatch(await prompt(sdk), /PRIVATE INSTRUCTIONS|SHARED INSTRUCTIONS/);
        assert.match(sdk.systemMessage.sections.custom_instructions.content, /deployment-analyst/);
        assert.equal(await handler(session, "deployment_catalog")(), "deployment-handler");
        assert.equal(handler(session, "catalog"), undefined);
        assert.equal(sdk.mcpServers.specialist.url, "https://deployment.example");
    });
}

test("removing a deployment definition fails closed instead of adopting a private or shared package", async t => {
    const h = fixture(t);
    addDeployment(h);
    await h.manager.getOrCreate("child", deploymentBinding, { turnIndex: 0 });
    h.publish();
    await assert.rejects(h.manager.getOrCreate("child", deploymentBinding, { turnIndex: 1 }), error => {
        assert.equal(error.code, "BOUND_AGENT_PACKAGE_UNAVAILABLE");
        assert.match(error.message, /bound deployment agent "analyst"/);
        return true;
    });
    assert.equal(h.manager.get("child"), null);
    addDeployment(h);
    const restored = await h.manager.getOrCreate("child", deploymentBinding, { turnIndex: 2 });
    assert.equal(await handler(restored, "deployment_catalog")(), "deployment-handler");
});

test("deployment pin cannot borrow a package tool or coexist with a package pin", async t => {
    const h = fixture(t);
    addDeployment(h);
    await assert.rejects(h.manager.getOrCreate("conflict", {
        ...deploymentBinding, boundAgentPackageId: "private-package",
    }, { turnIndex: 0 }), { code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
    h.defaults.agentPromptLookup.analyst.copies = [{ ...deploymentCopy, toolNames: ["catalog"] }];
    await assert.rejects(h.manager.getOrCreate("borrow", deploymentBinding, { turnIndex: 0 }), { code: "PACKAGE_TOOL_REQUIRES_BOUND_AGENT" });
    assert.equal(h.calls.length, 0);
});

test("legacy unpinned names retain owner precedence and deployment source survives config serialization", async t => {
    const h = fixture(t);
    addDeployment(h);
    const session = await h.manager.getOrCreate("legacy", { boundAgentName: "analyst", toolNames: ["catalog"] }, { turnIndex: 0 });
    assert.match(await prompt(h.calls[0].config), /PRIVATE INSTRUCTIONS/);
    assert.equal(await handler(session, "catalog")(), "private-handler");
    const { projectSerializableSessionConfig } = await import("../../dist/client.js");
    const restored = JSON.parse(JSON.stringify(projectSerializableSessionConfig(deploymentBinding)));
    assert.equal(restored.boundAgentSource, "deployment");
    assert.equal(Object.hasOwn(restored, "boundAgentPackageId"), false);
});

for (const [property, value] of [
    ["skipPermission", true], ["defer", "auto"], ["metadata", { policy: "updated" }],
    ["isTerminal", true], ["overridesBuiltInTool", true],
]) {
    test(`tool ${property} change updates the actual CLI declaration at the next turn`, async t => {
        const h = fixture(t);
        const first = await h.manager.getOrCreate("child", named, { turnIndex: 0 });
        h.publish({ sharedTools: [{ ...tool("catalog", "updated"), [property]: value }] });
        const second = await h.manager.getOrCreate("child", named, { turnIndex: 1 });
        assert.notEqual(second, first);
        assert.deepEqual(declaration(h.calls.at(-1).config, "catalog")[property], value);
    });
}

test("schema fingerprints normalize toJSONSchema, preserving identical reloads and rebinding changed constraints", async t => {
    const h = fixture(t);
    const publishSchema = limit => h.publish({ sharedTools: [{ ...tool("catalog"), parameters: {
        toJSONSchema: () => ({ type: "object", properties: { count: { type: "number", maximum: limit } } }),
    } }] });
    publishSchema(10);
    const first = await h.manager.getOrCreate("child", named, { turnIndex: 0 });
    publishSchema(10);
    assert.equal(await h.manager.getOrCreate("child", named, { turnIndex: 1 }), first);
    publishSchema(20);
    assert.notEqual(await h.manager.getOrCreate("child", named, { turnIndex: 2 }), first);
});

test("deployment source pin preserves explicit ordinary-tool overrides for direct top-level callers", async t => {
    const h = fixture(t);
    addDeployment(h);
    const { detachedPackageToolPolicy: _childPolicy, ...directBinding } = deploymentBinding;
    const config = { ...directBinding, toolNames: ["app_tool"] };
    const first = await h.manager.getOrCreate("direct", config, { turnIndex: 0 });
    assert.equal(handler(first, "deployment_catalog"), undefined);
    assert.ok(handler(first, "app_tool"));
    assert.match(await prompt(h.calls[0].config), /DEPLOYMENT INSTRUCTIONS/);
    const warm = await h.manager.getOrCreate("direct", config, { turnIndex: 1 });
    assert.equal(warm, first);
    assert.equal(handler(warm, "deployment_catalog"), undefined);
});
