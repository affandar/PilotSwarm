import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig } from "../../dist/mcp-loader.js";

test("stdio servers anchor to the owning plugin dir (packaged MCP servers)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cwd-test-"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
        "no-cwd": { command: "node", args: ["./mcp-servers/a.js"], tools: ["*"] },
        "rel-cwd": { command: "node", args: ["b.js"], cwd: "./mcp-servers", tools: ["*"] },
        "abs-cwd": { command: "node", args: ["c.js"], cwd: "/opt/fixed", tools: ["*"] },
        "remote": { type: "http", url: "https://example.com/mcp", tools: ["*"] },
    }));
    const servers = loadMcpConfig(dir);
    const abs = path.resolve(dir);
    assert.equal(servers["no-cwd"].cwd, abs, "missing cwd defaults to the plugin dir");
    assert.equal(servers["rel-cwd"].cwd, path.join(abs, "mcp-servers"), "relative cwd resolves against the plugin dir");
    assert.equal(servers["abs-cwd"].cwd, "/opt/fixed", "absolute cwd untouched");
    assert.equal(servers["remote"].cwd, undefined, "remote servers get no cwd");
});
