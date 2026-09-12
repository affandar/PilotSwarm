import test from "node:test";
import assert from "node:assert/strict";
import { assertNativeEvaluationSetup } from "../lib/native-delegation-setup.mjs";
import { delegationCatalogDefinitions } from "../lib/native-delegation-catalog.mjs";

const enabled = { featureEnabled: true, canAdmitNativeTask: true, agentNames: ["swarm-explore", "swarm-task"] };
const disabled = { featureEnabled: false, canAdmitNativeTask: false, agentNames: [] };

test("evaluation verifies real native admission and SDK profiles for both flag states", () => {
    assertNativeEvaluationSetup("sync", enabled);
    assertNativeEvaluationSetup("off", disabled);
});
test("missing feature policy cannot silently turn an ON evaluation into another OFF run", () => {
    assert.throws(() => assertNativeEvaluationSetup("sync", disabled), /Feature cache/);
    assert.throws(() => assertNativeEvaluationSetup("sync", { ...enabled, canAdmitNativeTask: false }), /Managed session/);
    assert.throws(() => assertNativeEvaluationSetup("sync", { ...enabled, agentNames: [] }), /SDK profile/);
});
test("OFF runs and partial native catalogs fail closed on leaked profiles", () => {
    assert.throws(() => assertNativeEvaluationSetup("off", enabled));
    assert.throws(() => assertNativeEvaluationSetup("off", { ...disabled, agentNames: ["swarm-task"] }), /SDK profile/);
    assert.throws(() => assertNativeEvaluationSetup("sync", { ...enabled, agentNames: ["swarm-task"] }), /SDK profile/);
    assert.throws(() => assertNativeEvaluationSetup("sync", { ...enabled, agentNames: [...enabled.agentNames, "swarm-rubber-duck"] }), /Deferred critic/);
});
test("selection fixtures use real static and published package scope shapes", () => {
    const definitions = delegationCatalogDefinitions("specialists");
    assert.ok(definitions.some(agent => !agent.packageId));
    assert.ok(definitions.some(agent => agent.packageScope === "shared"));
    assert.ok(definitions.some(agent => agent.packageScope === "user"));
    for (const agent of definitions) {
        if (agent.packageId) assert.ok(["shared", "user"].includes(agent.packageScope));
        else assert.equal(agent.packageScope, undefined);
        if (agent.packageScope === "user") assert.ok(agent.packageOwner?.provider && agent.packageOwner?.subject);
    }
});
