/**
 * parseAgentSourceLink — the one-link Add-package contract: a browser URL to
 * plugin.json (or its folder) yields {kind, repoUrl, ref, path}.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentSourceLink } from "../src/index.js";

test("github blob links to plugin.json parse fully", () => {
    const parsed = parseAgentSourceLink("https://github.com/acme/agents/blob/main/packages/my-agents/plugin.json");
    assert.deepEqual(parsed, {
        kind: "github",
        repoUrl: "https://github.com/acme/agents",
        ref: "main",
        path: "/packages/my-agents/plugin.json",
    });
});

test("github tree (folder) links and bare repos parse", () => {
    assert.deepEqual(parseAgentSourceLink("https://github.com/acme/agents/tree/release-1.2/kits/demo"), {
        kind: "github", repoUrl: "https://github.com/acme/agents", ref: "release-1.2", path: "/kits/demo",
    });
    assert.deepEqual(parseAgentSourceLink("https://github.com/acme/agents.git"), {
        kind: "github", repoUrl: "https://github.com/acme/agents", ref: null, path: null,
    });
});

test("azure devops ?path=&version= links parse (GB/GT prefixes stripped)", () => {
    const parsed = parseAgentSourceLink(
        "https://dev.azure.com/msdata/Database%20Systems/_git/my-repo?path=/packages/my-agents/plugin.json&version=GBmain");
    assert.equal(parsed.kind, "ado");
    assert.equal(parsed.repoUrl, "https://dev.azure.com/msdata/Database%20Systems/_git/my-repo");
    assert.equal(parsed.ref, "main");
    assert.equal(parsed.path, "/packages/my-agents/plugin.json");

    const bare = parseAgentSourceLink("https://dev.azure.com/org/proj/_git/repo");
    assert.deepEqual(bare, { kind: "ado", repoUrl: "https://dev.azure.com/org/proj/_git/repo", ref: null, path: null });

    const legacy = parseAgentSourceLink("https://acme.visualstudio.com/proj/_git/repo?path=/kits&version=GTv1.2.3");
    assert.equal(legacy.kind, "ado");
    assert.equal(legacy.ref, "v1.2.3");
    assert.equal(legacy.path, "/kits");
});

test("unrecognized links produce guidance, not garbage", () => {
    assert.match(parseAgentSourceLink("").error, /Paste a link/);
    assert.match(parseAgentSourceLink("not a url").error, /does not look like a URL/);
    assert.match(parseAgentSourceLink("https://gitlab.com/org/repo").error, /Only GitHub and Azure DevOps/);
    assert.match(parseAgentSourceLink("https://github.com/only-org").error, /at least github.com\/org\/repo/);
    assert.match(parseAgentSourceLink("https://github.com/o/r/commits/main").error, /blob.*tree|\/blob\//);
    assert.match(parseAgentSourceLink("https://dev.azure.com/org/proj/repo-without-git").error, /_git/);
});
