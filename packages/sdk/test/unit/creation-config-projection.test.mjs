/**
 * projectSerializableSessionConfig — the ONE projection from a full in-memory
 * session config to the durable shape (persisted at create as migration
 * 0072's creation_config, rebuilt at orchestration start).
 *
 * Run: node --test test/unit/creation-config-projection.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { projectSerializableSessionConfig } from "../../dist/client.js";

const FULL = {
    model: "azure-openai:gpt-5.4",
    reasoningEffort: "high",
    contextTier: "long_context",
    systemMessage: "custom instructions",
    workingDirectory: "/work",
    waitThreshold: 45,
    boundAgentName: "runbook-marshal",
    promptLayering: { kind: "app-agent" },
    childContract: { wakeOn: "any" },
    toolNames: ["alpha"],
    tools: [{ name: "beta", handler: () => {} }, "gamma", { name: "wait" }, { name: "ask_user" }],
    hooks: { onTurn: () => {} },
};

test("every serializable field rides through; nothing non-serializable does", () => {
    const p = projectSerializableSessionConfig(FULL, 30);
    assert.equal(p.model, FULL.model);
    assert.equal(p.reasoningEffort, "high");
    assert.equal(p.contextTier, "long_context");
    assert.equal(p.systemMessage, "custom instructions");
    assert.equal(p.workingDirectory, "/work");
    assert.equal(p.waitThreshold, 45);
    assert.equal(p.boundAgentName, "runbook-marshal");
    assert.deepEqual(p.promptLayering, { kind: "app-agent" });
    assert.deepEqual(p.childContract, { wakeOn: "any" });
    assert.ok(!("tools" in p), "Tool objects (functions) must not ride durable state");
    assert.ok(!("hooks" in p), "hooks must not ride durable state");
});

test("toolNames merges explicit names with Tool-object names, dedupes, and drops wait/ask_user", () => {
    const p = projectSerializableSessionConfig(
        { toolNames: ["alpha", "beta"], tools: [{ name: "beta" }, "gamma", { name: "wait" }, { name: "ask_user" }] },
        undefined,
    );
    assert.deepEqual(p.toolNames, ["alpha", "beta", "gamma"]);
});

test("waitThreshold falls back to the client default", () => {
    assert.equal(projectSerializableSessionConfig({}, 30).waitThreshold, 30);
    assert.equal(projectSerializableSessionConfig({ waitThreshold: 7 }, 30).waitThreshold, 7);
});

test("an absent config projects to the minimal shape, and JSON round-trips clean", () => {
    const p = projectSerializableSessionConfig(undefined, 30);
    assert.equal(p.boundAgentName, undefined);
    assert.equal(p.toolNames, undefined);
    const clean = JSON.parse(JSON.stringify(p));
    assert.deepEqual(clean, { waitThreshold: 30 }, "undefined fields must strip for clean JSONB");
});

test("the persisted shape and the start shape are the same function output — round-trip identity", () => {
    const stored = JSON.parse(JSON.stringify(projectSerializableSessionConfig(FULL, 30)));
    const rebuilt = projectSerializableSessionConfig(FULL, 30);
    assert.deepEqual(stored, JSON.parse(JSON.stringify(rebuilt)));
});
