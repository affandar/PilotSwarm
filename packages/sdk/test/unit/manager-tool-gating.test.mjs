/**
 * The manager tools reach ONLY manager agents.
 *
 * Two halves have to agree: the DECLARATION (the manager bundle, added by
 * createInspectTools when the agent identity holds it) and the per-turn
 * HANDLER in managed-session. A registered handler is a capability even when
 * the model cannot see the schema, so gating only the declaration would leave
 * every ordinary session one hallucinated tool-name away from deleting
 * sessions. Both now gate on the same list.
 *
 * Run: node --test test/unit/manager-tool-gating.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MANAGER_AGENT_IDS, holdsManagerBundle } from "../../dist/agent-manager-tools.js";
import { createInspectTools } from "../../dist/inspect-tools.js";

/** The tools that must never appear in an ordinary session. */
const MANAGER_ONLY = [
    "create_agent_session",
    "message_agent_session",
    "manage_agent_session",
    "publish_agent_package",
    "stage_agent_package_edit",
    "propose_agent_patch",
    "import_agent_package",
    "set_agent_package_enabled",
    "pin_agent_package_version",
];

const VIEWER = { provider: "test", subject: "alice", isAdmin: false, isSystemPrincipal: false };

function toolNamesFor(agentIdentity) {
    const tools = createInspectTools({
        catalog: {
            async listKnownUsers() { return []; },
            async getAgentPackage() { return null; },
            async listSessions() { return []; },
        },
        agentIdentity,
        resolveViewer: async () => VIEWER,
        artifactStore: null,
        sessionId: "sess-gating",
    });
    return new Set(tools.map((t) => t.name));
}

test("holdsManagerBundle matches exactly the manager ids", () => {
    assert.equal(holdsManagerBundle("agent-manager"), true);
    assert.equal(holdsManagerBundle("agent-tuner"), true);
    for (const other of ["default", "generic-crawler", "sweeper", "resourcemgr", "", null, undefined]) {
        assert.equal(holdsManagerBundle(other), false, `${other} must not hold the bundle`);
    }
    // Guard the list itself: silently growing it widens who can delete
    // sessions fleet-wide.
    assert.deepEqual([...MANAGER_AGENT_IDS].sort(), ["agent-manager", "agent-tuner"]);
});

test("an ordinary agent gets NONE of the manager tools", () => {
    const names = toolNamesFor("default");
    for (const tool of MANAGER_ONLY) {
        assert.ok(!names.has(tool), `"default" must not have ${tool}`);
    }
});

test("the crawler — a non-manager package agent — gets none of them either", () => {
    const names = toolNamesFor("generic-crawler");
    for (const tool of MANAGER_ONLY) {
        assert.ok(!names.has(tool), `crawler must not have ${tool}`);
    }
});

test("a session with no agent identity at all gets none of them", () => {
    const names = toolNamesFor(undefined);
    for (const tool of MANAGER_ONLY) {
        assert.ok(!names.has(tool), `identity-less session must not have ${tool}`);
    }
});

test("the agent manager DOES get them", () => {
    const names = toolNamesFor("agent-manager");
    for (const tool of MANAGER_ONLY) {
        assert.ok(names.has(tool), `agent-manager is missing ${tool}`);
    }
});
