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