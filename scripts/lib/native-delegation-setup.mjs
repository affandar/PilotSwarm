import assert from "node:assert/strict";

/** Abort before inference if a nominal ON/OFF run exercises the wrong policy. */
export function assertNativeEvaluationSetup(mode, { featureEnabled, canAdmitNativeTask, agentNames }) {
    assert.ok(["sync", "off"].includes(mode), "Unsupported native evaluation mode");
    const expected = mode === "sync";
    assert.equal(featureEnabled, expected, "Feature cache disagrees with requested evaluation mode");
    assert.equal(canAdmitNativeTask, expected, "Managed session disagrees with requested native evaluation mode");
    assert.ok(Array.isArray(agentNames), "SDK agent catalog is unavailable");
    for (const name of ["swarm-explore", "swarm-task"]) {
        assert.equal(agentNames.includes(name), expected, `SDK profile ${name} disagrees with requested native evaluation mode`);
    }
    assert.equal(agentNames.includes("swarm-rubber-duck"), false, "Deferred critic must stay unavailable");
}
