import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpConfig } from "../../src/mcp-loader.ts";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PLUGIN_DIR = path.resolve(__dirname, "../../../cli/plugins");
const WORKER_DEPLOYMENT = path.resolve(__dirname, "../../../../deploy/k8s/worker-deployment.yaml");
const CONTEXT7_ENDPOINT = "https://mcp.context7.com/mcp";

function parseMcpSse(text) {
    const dataLines = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter(Boolean);
    assert(dataLines.length > 0, `MCP response should contain SSE data lines, got: ${text.slice(0, 500)}`);
    return JSON.parse(dataLines.join("\n"));
}

async function callContext7(payload) {
    const headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    };
    if (process.env.CONTEXT7_API_KEY) {
        headers.CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY;
    }

    const response = await fetch(CONTEXT7_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    assert(response.ok, `Context7 MCP request failed: ${response.status} ${response.statusText} ${text.slice(0, 500)}`);
    return parseMcpSse(text);
}

describe("Context7 MCP default", () => {
    it("loads the official Context7 endpoint from the bundled CLI plugin", () => {
        const mcpConfig = loadMcpConfig(CLI_PLUGIN_DIR);
        assert(mcpConfig.context7, "context7 MCP server should be configured in the default CLI plugin");
        assertEqual(mcpConfig.context7.type, "http", "context7 transport");
        assertEqual(mcpConfig.context7.url, CONTEXT7_ENDPOINT, "context7 endpoint");
        assertEqual(JSON.stringify(mcpConfig.context7.tools), JSON.stringify(["resolve-library-id", "query-docs"]), "context7 tool allowlist");
    });

    it("enables the bundled CLI plugin directory for AKS workers by default", () => {
        const manifest = fs.readFileSync(WORKER_DEPLOYMENT, "utf8");
        assertIncludes(manifest, "name: PLUGIN_DIRS", "worker manifest should set PLUGIN_DIRS");
        assertIncludes(manifest, "value: \"/app/packages/cli/plugins\"", "worker manifest should load bundled CLI plugins");
    });

    it("initializes the public Context7 MCP endpoint and calls resolve-library-id", { timeout: 45_000 }, async () => {
        const initialize = await callContext7({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "pilotswarm-context7-test", version: "0.0.0" },
            },
        });
        assertEqual(initialize.result.serverInfo.name, "Context7", "server name");
        assert(initialize.result.capabilities.tools, "Context7 should advertise tools capability");

        const tools = await callContext7({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const toolNames = tools.result.tools.map((tool) => tool.name);
        assert(toolNames.includes("resolve-library-id"), "Context7 should expose resolve-library-id");
        assert(toolNames.includes("query-docs"), "Context7 should expose query-docs");

        const result = await callContext7({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
                name: "resolve-library-id",
                arguments: {
                    libraryName: "Vitest",
                    query: "Find official Vitest documentation for running tests from the CLI.",
                },
            },
        });
        const text = result.result.content.map((item) => item.text || "").join("\n");
        assertIncludes(text, "/vitest-dev/vitest", "Context7 resolve-library-id should return the Vitest library ID");
    });
});