import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolveTopLevelAgentConfig } from "../../dist/orchestration/runtime.js";
import { createSessionManagerProxy, registerActivities } from "../../dist/session-proxy.js";
import { AGENT_HANDOFF_CAPABILITY } from "../../dist/activity-routing.js";
const { OrchestrationContext } = createRequire(import.meta.url)("duroxide");
const alice = { provider: "fixture", subject: "alice" };
const shared = { name: "analyst", id: "analyst", tools: ["shared_tool"], prompt: "SHARED",
    initialRequiredTool: "shared_tool", packageId: "pkg-shared", packageScope: "shared" };
const personal = { ...shared, prompt: "PRIVATE", tools: ["private_tool"], initialRequiredTool: "private_tool",
    packageId: "pkg-alice", packageScope: "user", packageOwner: alice };
const deployment = { name: "analyst", id: "analyst", tools: ["deployment_tool"], prompt: "DEPLOYMENT", initialRequiredTool: "deployment_tool" };

async function resolve(config, definitions, owner = alice) {
    const handlers = new Map();
    const catalog = { getSession: async id => ({ sessionId: id, owner, parentSessionId: null }) };
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) }, {}, null,
        undefined, catalog, undefined, undefined, undefined, undefined, [], null, [], definitions);
    const native = new OrchestrationContext({ instanceId: "top", executionId: "1", orchestrationName: "test", orchestrationVersion: "1.0.75" });
    const ctx = { traceInfo() {}, scheduleActivity: native.scheduleActivity.bind(native), scheduleActivityOnSession: native.scheduleActivityOnSession.bind(native) };
    const runtime = { ctx, input: { sessionId: "top", agentId: "analyst" }, options: { isSystem: false },
        state: { iteration: 0, config: { ...config }, affinityKey: "top-affinity" },
        manager: createSessionManagerProxy(ctx, "agent-handoff-v2") };
    const generator = resolveTopLevelAgentConfig(runtime);
    const scheduled = generator.next().value;
    assert.equal(scheduled.name, "resolveAgentConfigV2");
    assert.equal(scheduled.tag, AGENT_HANDOFF_CAPABILITY);
    const selected = await handlers.get(scheduled.name)({}, JSON.parse(scheduled.input));
    assert.equal(generator.next(selected).done, true);
    return { runtime, selected, scheduled: JSON.parse(scheduled.input) };
}

test("top-level shared package binding survives the owner's private shadow", async () => {
    const { runtime, selected, scheduled } = await resolve({ boundAgentName: "analyst", boundAgentPackageId: "pkg-shared" }, [personal, shared, deployment]);
    assert.deepEqual(scheduled.binding, { packageId: "pkg-shared" });
    assert.equal(selected.prompt, "SHARED");
    assert.equal(runtime.state.config.boundAgentPackageId, "pkg-shared");
    assert.equal(runtime.state.config.boundAgentSource, undefined);
    assert.deepEqual(runtime.state.config.toolNames, ["shared_tool"]);
    assert.equal(runtime.state.pendingRequiredTool, "shared_tool");
});

test("top-level deployment binding survives same-name private and shared packages", async () => {
    const { runtime, selected, scheduled } = await resolve({ boundAgentName: "analyst", boundAgentSource: "deployment" }, [personal, shared, deployment]);
    assert.deepEqual(scheduled.binding, { source: "deployment" });
    assert.equal(selected.prompt, "DEPLOYMENT");
    assert.equal(runtime.state.config.boundAgentSource, "deployment");
    assert.equal(runtime.state.config.boundAgentPackageId, undefined);
    assert.deepEqual(runtime.state.config.toolNames, ["deployment_tool"]);
    assert.equal(runtime.state.pendingRequiredTool, "deployment_tool");
});

for (const config of [
    { boundAgentName: "analyst", boundAgentPackageId: "pkg-removed" },
    { boundAgentName: "analyst", boundAgentSource: "deployment" },
    { boundAgentName: "analyst", boundAgentPackageId: "pkg-shared", boundAgentSource: "deployment" },
]) {
    test(`missing/conflicting top-level binding stays pinned without fallback: ${JSON.stringify(config)}`, async () => {
        const { runtime, selected } = await resolve(config, [personal, shared]);
        assert.equal(selected, null);
        assert.deepEqual(runtime.state.config, config, "SessionManager will reject this binding; never replace it with another copy");
        assert.equal(runtime.state.pendingRequiredTool, undefined);
    });
}

test("a package pin does not bypass caller ownership", async () => {
    const config = { boundAgentName: "analyst", boundAgentPackageId: "pkg-alice" };
    const { selected, runtime } = await resolve(config, [personal, shared], { provider: "fixture", subject: "bob" });
    assert.equal(selected, null);
    assert.deepEqual(runtime.state.config, config);
});

test("unbound top-level lookup retains ordinary private-shadow selection and legacy optional-input shape", async () => {
    const { runtime, selected, scheduled } = await resolve({}, [deployment, shared, personal]);
    assert.equal(Object.hasOwn(scheduled, "binding"), false);
    assert.equal(selected.prompt, "PRIVATE");
    assert.equal(runtime.state.config.boundAgentPackageId, "pkg-alice");
});
