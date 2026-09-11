import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createSessionManagerProxy, createSessionProxy } from "../../dist/session-proxy.js";
import { routeHandoffActivity, AGENT_HANDOFF_CAPABILITY } from "../../dist/activity-routing.js";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
const { OrchestrationContext } = createRequire(import.meta.url)("duroxide");
const context = () => new OrchestrationContext({ instanceId: "parent", executionId: "1", orchestrationName: "test", orchestrationVersion: "1.0.74" });
const wire = (value) => JSON.parse(JSON.stringify(value));

// Immutable snapshot of the shipped 1.0.74 generator tree. The only change
// from the former live tree was pinning its own version constant, as with
// all earlier freezes. This catches edits to helpers as well as the entrypoint.
const frozenHashes = {
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "lifecycle.ts": "aaa0da323b81a5b2c962fa95f062c505907f8ab16522fbce46ce94a0d94b75f5",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "agents.ts": "47b860ff73690c6c82aaf04f11700074259cb6792bbf4e79c8d68ef63f4ba8df",
    "runtime.ts": "e40cfcbacecdde9a9a50ea6cf620eebc16d9f800ae212723239365282c1d67a8",
    "index.ts": "f83f7d0895e9090eeed6462034f6c1ba37cc7a717a1bb4c154cd639c09b01ab0",
    "turn.ts": "a120114106a14e6c92c188181b3b4e9bc646c8c354bd4eeec3529cffd02ffed4",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b"
};
for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.74 ${name} remains unchanged`, () => {
        const bytes = readFileSync(new URL(`../../src/orchestration_1_0_74/${name}`, import.meta.url));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
    });
}

// The last selector-capable version must preserve its historical scheduling.
const selectorFreezeHashes = {
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "lifecycle.ts": "498dfe9c73253058929cfdd5d14185ca16347920ddba42c26c16dd9548a12d42",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "agents.ts": "e563f1a251f9fc487dc38446c7ebb857844f9eae72dfb08611a80e9a7434395c",
    "runtime.ts": "140a23c4d8bd688afbe6a7da3238f83f5bed7b42c9a959aa5af07ffc08edf7a2",
    "index.ts": "f8eb4413b1cbbee437bd8b867555e9ad7f1f60a02fadf4e17bf8143c1367e2eb",
    "turn.ts": "17f997507c7b94c4e4524a12a63dfa60c573be21125b6ad9cb35b46fab749c01",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b"
};
for (const [name, hash] of Object.entries(selectorFreezeHashes)) {
    test(`frozen 1.0.75 ${name} remains unchanged`, () => {
        const bytes = readFileSync(new URL(`../../src/orchestration_1_0_75/${name}`, import.meta.url));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
    });
}

test("registry retains 1.0.74, 1.0.75 and 1.0.76 separately and activates 1.0.77", () => {
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, "1.0.77");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.76").handler.name, "durableSessionOrchestration_1_0_76");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.74").handler.name, "durableSessionOrchestration_1_0_74");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.75").handler.name, "durableSessionOrchestration_1_0_75");
});

test("legacy proxy descriptors retain their serialized names, inputs and affinity, without tags", () => {
    const ctx = context();
    const manager = createSessionManagerProxy(ctx);
    const proxy = createSessionProxy(ctx, "child", "affinity", { model: "test" });
    assert.deepEqual(wire(manager.resolveAgentConfig("analyst")), {
        type: "activity", name: "resolveAgentConfig", input: '{"agentName":"analyst","callerSessionId":"parent"}',
    });
    assert.deepEqual(wire(manager.resolveAgentForRequiredTool("lookup")), {
        type: "activity", name: "resolveAgentForRequiredTool", input: '{"requiredTool":"lookup","callerSessionId":"parent"}',
    });
    assert.deepEqual(wire(manager.spawnChildSession("parent", {}, "work", 1, false)), {
        type: "activity", name: "spawnChildSession", input: '{"parentSessionId":"parent","config":{},"task":"work","nestingLevel":1,"isSystem":false}',
    });
    assert.deepEqual(wire(proxy.runTurn("work", false, 2)), {
        type: "activity", name: "runTurn", input: '{"sessionId":"child","prompt":"work","config":{"model":"test"},"turnIndex":2}', sessionId: "affinity",
    });
    assert.deepEqual(wire(proxy.runTurn("work", true, 0, { epochStart: true, requiredTool: "initialize" })), {
        type: "activity", name: "runTurn2", input: '{"sessionId":"child","prompt":"work","config":{"model":"test"},"bootstrap":true,"turnIndex":0,"requiredTool":"initialize","epochStart":true}', sessionId: "affinity",
    });
});

test("new handoff proxies route every critical activity with the capability tag", () => {
    const ctx = context();
    const manager = createSessionManagerProxy(ctx, "agent-handoff-v2");
    const proxy = createSessionProxy(ctx, "child", "affinity", {}, "agent-handoff-v2");
    const tasks = [manager.resolveAgentConfig("analyst"), manager.resolveAgentForRequiredTool("lookup"), manager.spawnChildSession("parent", {}, "work"), proxy.runTurn("work"), proxy.runTurn("work", true, 0, { epochStart: true })];
    assert.deepEqual(tasks.map(t => t.name), ["resolveAgentConfigV2", "resolveAgentForRequiredToolV2", "spawnChildSessionV2", "runTurnV3", "runTurnEpochV3"]);
    for (const task of tasks) assert.equal(task.tag, AGENT_HANDOFF_CAPABILITY);
    assert.equal(tasks[3].sessionId, "affinity");
    assert.equal(tasks[4].sessionId, "affinity");
    assert.equal(manager.listModels().tag, undefined, "unrelated activities retain their existing routing");
});

test("routing fails closed if the SDK cannot express capability tags", () => {
    const descriptor = { type: "activity", name: "turn" };
    assert.equal(routeHandoffActivity(descriptor), descriptor, "legacy descriptors need no new SDK API");
    assert.throws(() => routeHandoffActivity(descriptor, "agent-handoff-v2"), /tag routing support/);
});

// Frozen from checkpoint 4c2ce252 before cleanup notification changes.
const cleanupFreezeHashes = {
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "lifecycle.ts": "498dfe9c73253058929cfdd5d14185ca16347920ddba42c26c16dd9548a12d42",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "agents.ts": "137267e3336ca750d8b7752ed33169aecfd6c7ad196f5f8f74a2058a0a457f66",
    "runtime.ts": "c4195ca97362ee536e4d9970a67825dc12839532ea60aaf9d61686ef89c6a43f",
    "index.ts": "9013b0cb988fdfd3a9641418bffcd07d694d665230a0d3592fe1784d294d15db",
    "turn.ts": "17f997507c7b94c4e4524a12a63dfa60c573be21125b6ad9cb35b46fab749c01",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b"
};
for (const [name, hash] of Object.entries(cleanupFreezeHashes)) {
    test(`frozen 1.0.76 ${name} remains unchanged`, () => {
        const bytes = readFileSync(new URL(`../../src/orchestration_1_0_76/${name}`, import.meta.url));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
    });
}
