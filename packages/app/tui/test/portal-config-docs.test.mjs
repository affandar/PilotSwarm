// The agent-authoring guide link is DEPLOYMENT config, not a constant.
//
// A layered app (waldemort) ships its own copy of the guide: the base
// instructions PLUS the skills, tools and MCP servers that exist only on that
// fleet. Pointing every deployment at the public PilotSwarm doc would hand
// authors a guide that omits everything their fleet can actually do — so a
// plugin overrides it the same way it overrides branding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePortalConfigBundleFromPluginDirs } from "../src/plugin-config.js";

const PUBLIC_GUIDE = "https://github.com/affandar/PilotSwarm/blob/main/docs/building-agent-packages.md";

function pluginDirWith(pluginJson) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-plugin-"));
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(pluginJson, null, 2));
    return dir;
}

test("with no plugin, the guide is the public PilotSwarm doc", () => {
    const { portalConfig } = resolvePortalConfigBundleFromPluginDirs([]);
    assert.equal(portalConfig.docs.agentPackageGuideUrl, PUBLIC_GUIDE);
});

test("a plugin that says nothing about docs still gets the public guide", () => {
    const dir = pluginDirWith({ name: "layered", portal: { branding: { title: "Layered" } } });
    const { portalConfig } = resolvePortalConfigBundleFromPluginDirs([dir]);
    assert.equal(portalConfig.branding.title, "Layered");
    assert.equal(portalConfig.docs.agentPackageGuideUrl, PUBLIC_GUIDE);
});

test("a layered app points the guide at its OWN copy", () => {
    const own = "https://msazure.visualstudio.com/One/_git/waldemort?path=/docs/building-agent-packages.md";
    const dir = pluginDirWith({
        name: "waldemort",
        portal: { branding: { title: "Waldemort" }, docs: { agentPackageGuideUrl: own } },
    });
    const { portalConfig } = resolvePortalConfigBundleFromPluginDirs([dir]);
    assert.equal(portalConfig.docs.agentPackageGuideUrl, own);
});

test("the flatter portal.agentPackageGuideUrl spelling works too", () => {
    // portal.branding.title and portal.title are both accepted for branding;
    // docs follows the same shape so a plugin author can guess either.
    const own = "https://example.test/guide.md";
    const dir = pluginDirWith({ name: "flat", portal: { agentPackageGuideUrl: own } });
    const { portalConfig } = resolvePortalConfigBundleFromPluginDirs([dir]);
    assert.equal(portalConfig.docs.agentPackageGuideUrl, own);
});
