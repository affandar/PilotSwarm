import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSessionCreationMetadataFromPluginDirs } from "../src/node-sdk-transport.js";

function makePluginDir(policy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-cli-policy-"));
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "test-plugin" }, null, 2));
    fs.writeFileSync(path.join(dir, "session-policy.json"), JSON.stringify(policy, null, 2));
    return dir;
}

test("remote metadata expands opted-in bundled default agents", () => {
    const dir = makePluginDir({
        version: 1,
        creation: {
            mode: "open",
            allowGeneric: true,
            bundledAgents: ["generic-crawler"],
        },
    });

    const metadata = loadSessionCreationMetadataFromPluginDirs([dir]);

    assert.deepEqual(metadata.sessionPolicy.creation.bundledAgents, ["generic-crawler"]);
    assert(metadata.allowedAgentNames.includes("generic-crawler"));
    const crawler = metadata.creatableAgents.find((agent) => agent.name === "generic-crawler");
    assert.equal(crawler?.title, "Generic Crawler");
});

test("remote metadata rejects defaultAgent for unopted bundled default agent", () => {
    const dir = makePluginDir({
        version: 1,
        creation: {
            mode: "allowlist",
            allowGeneric: false,
            defaultAgent: "generic-crawler",
        },
    });

    assert.throws(
        () => loadSessionCreationMetadataFromPluginDirs([dir]),
        /defaultAgent=.*generic-crawler.*bundled/i,
    );
});

test("remote metadata rejects unknown bundled default agents", () => {
    const dir = makePluginDir({
        version: 1,
        creation: {
            mode: "open",
            allowGeneric: true,
            bundledAgents: ["not-a-bundled-agent"],
        },
    });

    assert.throws(
        () => loadSessionCreationMetadataFromPluginDirs([dir]),
        /unknown bundled agent.*not-a-bundled-agent/i,
    );
});

test("creatable agents carry BOTH splash and splashMobile", () => {
    // Regression: normalizeCreatableAgent forwarded `splash` but dropped
    // `splashMobile`, so the session-agent picker persisted only the desktop
    // art and the mobile portal had nothing to swap to on narrow screens.
    const dir = makePluginDir({
        version: 1,
        creation: { mode: "open", allowGeneric: true },
    });
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(
        path.join(dir, "agents", "splashy.agent.md"),
        [
            "---",
            "name: splashy",
            "description: splash fixture",
            "splash: |",
            "  DESKTOP-ART-WIDE",
            "splashMobile: |",
            "  MOBILE-ART",
            "---",
            "You are a fixture agent.",
            "",
        ].join("\n"),
    );

    const metadata = loadSessionCreationMetadataFromPluginDirs([dir]);
    const agent = metadata.creatableAgents.find((a) => a.name === "splashy");
    assert.ok(agent, "fixture agent should be creatable");
    assert.match(agent.splash, /DESKTOP-ART-WIDE/);
    assert.match(agent.splashMobile, /MOBILE-ART/, "splashMobile must survive normalizeCreatableAgent");
});
test("creatable agents carry capability metadata (skills, MCP names, restrictions)", () => {
    // Regression (capability-profiles Phase 2): normalizeCreatableAgent
    // forwarded `tools` but silently dropped `skills` — and needs to expose
    // the new capability fields as NAMES ONLY (never resolved MCP configs,
    // which can carry expanded credentials).
    const dir = makePluginDir({
        version: 1,
        creation: { mode: "open", allowGeneric: true },
    });
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(
        path.join(dir, "agents", "capable.agent.md"),
        [
            "---",
            "schemaVersion: 2",
            "version: 1.0.0",
            "name: capable",
            "description: capability fixture",
            "skills:",
            "  - deploy-runbook",
            "mcpServers:",
            "  - github",
            "allowedSkills:",
            "  - deploy-runbook",
            "toolPolicy:",
            "  deny:",
            "    - bash",
            "---",
            "You are a fixture agent.",
            "",
        ].join("\n"),
    );

    const metadata = loadSessionCreationMetadataFromPluginDirs([dir]);
    const agent = metadata.creatableAgents.find((a) => a.name === "capable");
    assert.ok(agent, "fixture agent should be creatable");
    assert.deepEqual(agent.skills, ["deploy-runbook"], "skills must survive normalizeCreatableAgent");
    assert.deepEqual(agent.mcpServers, ["github"], "MCP servers surface as names");
    assert.deepEqual(agent.allowedSkills, ["deploy-runbook"]);
    assert.deepEqual(agent.toolPolicy, { deny: ["bash"] });

    // A resolved-map shape (embedded-mode agents) must flatten to names.
    const serialized = JSON.stringify(agent);
    assert.ok(!serialized.includes("url"), "no server config fields on the client surface");
});
