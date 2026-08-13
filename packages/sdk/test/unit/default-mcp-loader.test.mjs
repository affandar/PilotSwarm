import assert from "node:assert/strict";
import test from "node:test";
import { loadDefaultMcpConfig } from "../../dist/mcp-loader.js";

// loadDefaultMcpConfig loads the fleet-default MCP servers (DEFAULT_MCP_JSON deploy token):
// remote-only, each marked optional, from an inline JSONC string.

test("loadDefaultMcpConfig: loads a remote server, defaults tools, marks optional", () => {
    const raw = JSON.stringify({
        servers: {
            ado: {
                type: "http",
                url: "https://ado.example.com/mcp",
                headers: { "X-MCP-Toolsets": "core,work-items,search" },
            },
        },
    });
    const servers = loadDefaultMcpConfig(raw);
    assert.deepEqual(Object.keys(servers), ["ado"]);
    assert.equal(servers.ado.url, "https://ado.example.com/mcp");
    assert.deepEqual(servers.ado.tools, ["*"], "missing tools defaults to all");
    assert.equal(servers.ado.optional, true, "fleet defaults are optional (skip, not fast-fail)");
    assert.equal(servers.ado.headers["X-MCP-Toolsets"], "core,work-items,search");
});

test("loadDefaultMcpConfig: empty / undefined / null -> {}", () => {
    assert.deepEqual(loadDefaultMcpConfig(""), {});
    assert.deepEqual(loadDefaultMcpConfig("   "), {});
    assert.deepEqual(loadDefaultMcpConfig(undefined), {});
    assert.deepEqual(loadDefaultMcpConfig(null), {});
});

test("loadDefaultMcpConfig: accepts a flat top-level map (no `servers` wrapper)", () => {
    const raw = JSON.stringify({ ado: { type: "http", url: "https://a.example/mcp" } });
    const servers = loadDefaultMcpConfig(raw);
    assert.deepEqual(Object.keys(servers), ["ado"]);
    assert.equal(servers.ado.optional, true);
});

test("loadDefaultMcpConfig: stdio server skipped (fleet defaults are remote-only)", () => {
    const raw = JSON.stringify({
        servers: {
            remote: { type: "http", url: "https://a.example/mcp" },
            local: { command: "node", args: ["x.js"] },
        },
    });
    const servers = loadDefaultMcpConfig(raw);
    assert.deepEqual(Object.keys(servers), ["remote"], "only the remote server loads");
    assert.equal(servers.local, undefined);
});

test("loadDefaultMcpConfig: url without command counts as remote", () => {
    const raw = JSON.stringify({ servers: { s: { url: "https://a.example/mcp" } } });
    const servers = loadDefaultMcpConfig(raw);
    assert.deepEqual(Object.keys(servers), ["s"]);
    assert.equal(servers.s.optional, true);
});

test("loadDefaultMcpConfig: unresolved ${input}/${command} placeholder skipped", () => {
    const raw = JSON.stringify({
        servers: {
            good: { type: "http", url: "https://a.example/mcp" },
            prompted: { type: "http", url: "https://b.example/mcp", headers: { Authorization: "${input:tok}" } },
        },
    });
    const servers = loadDefaultMcpConfig(raw);
    assert.deepEqual(Object.keys(servers), ["good"], "the prompted server is dropped");
});

test("loadDefaultMcpConfig: JSONC (comments + trailing comma) tolerated", () => {
    const raw = `{
        // fleet default ADO server
        "servers": {
            "ado": { "type": "http", "url": "https://ado.example.com/mcp" },
        }
    }`;
    const servers = loadDefaultMcpConfig(raw);
    assert.equal(servers.ado.url, "https://ado.example.com/mcp");
});

test("loadDefaultMcpConfig: invalid JSON -> {} (no throw)", () => {
    assert.deepEqual(loadDefaultMcpConfig("{ not json"), {});
});

test("loadDefaultMcpConfig: ${env:VAR} and ${VAR} expanded from process.env", () => {
    process.env.DMJ_TEST_ORG = "acme";
    try {
        const raw = JSON.stringify({
            servers: {
                a: { type: "http", url: "https://ado.example.com/${env:DMJ_TEST_ORG}" },
                b: { type: "http", url: "https://ado.example.com/${DMJ_TEST_ORG}" },
            },
        });
        const servers = loadDefaultMcpConfig(raw);
        assert.equal(servers.a.url, "https://ado.example.com/acme");
        assert.equal(servers.b.url, "https://ado.example.com/acme");
    } finally {
        delete process.env.DMJ_TEST_ORG;
    }
});

// Merge precedence (worker assembly): a repo-declared server WINS over a fleet default of
// the same name. This is the `{ ...defaultMcpServers, ...repoMcpServers }` spread in
// git-repo-worker.js; asserted here as a pure object-spread invariant so the precedence
// is regression-guarded without importing the worker example.
test("merge precedence: repo-declared server overrides a same-named fleet default", () => {
    const defaults = loadDefaultMcpConfig(
        JSON.stringify({ servers: { ado: { type: "http", url: "https://default.example/mcp" } } }),
    );
    const repo = { ado: { type: "http", url: "https://repo.example/mcp", tools: ["*"] } };
    const merged = { ...defaults, ...repo };
    assert.equal(merged.ado.url, "https://repo.example/mcp", "repo wins on name clash");
    assert.equal(merged.ado.optional, undefined, "the repo server (strict) replaces the optional default wholesale");
});

test("merge precedence: distinct names coexist (default kept, repo added)", () => {
    const defaults = loadDefaultMcpConfig(
        JSON.stringify({ servers: { ado: { type: "http", url: "https://default.example/mcp" } } }),
    );
    const repo = { repoServer: { type: "http", url: "https://repo-server.example/mcp", tools: ["*"] } };
    const merged = { ...defaults, ...repo };
    assert.deepEqual(Object.keys(merged).sort(), ["ado", "repoServer"]);
    assert.equal(merged.ado.optional, true, "the fleet default keeps its optional tag");
});
