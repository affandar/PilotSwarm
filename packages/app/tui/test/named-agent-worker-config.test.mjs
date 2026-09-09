import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotSwarmWorker } from "pilotswarm-sdk";
import { getPluginDirsFromEnv } from "../src/plugin-config.js";
import { loadSessionCreationMetadataFromPluginDirs } from "../src/node-sdk-transport.js";

test("local portal and native-enabled worker agree on named agents and preserve bound MCP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-native-named-agents-"));
    const originalCwd = process.cwd();
    const originalPluginDirs = process.env.PLUGIN_DIRS;
    let worker;
    try {
        // Exercise the bundled-plugin fallback used by a plain local launch.
        process.chdir(root);
        delete process.env.PLUGIN_DIRS;
        const pluginDirs = getPluginDirsFromEnv();
        const metadata = loadSessionCreationMetadataFromPluginDirs(pluginDirs);
        worker = new PilotSwarmWorker({
            pluginDirs,
            nativeSubagents: "sync",
            disableManagementAgents: true,
            sessionStateDir: path.join(root, "session-state"),
        });
        assert.deepEqual(
            [...worker.allowedAgentNames].sort(),
            [...metadata.allowedAgentNames].sort(),
            "the worker must load the same blueprints shown in the portal",
        );
        assert.ok(worker.allowedAgentNames.includes("deepwiki"));
        assert.ok(worker.allowedAgentNames.includes("generic-crawler"));
        assert.deepEqual(Object.keys(worker.agentMcpServers.deepwiki), ["deepwiki"]);

        // Capture real session assembly without starting a worker, making an
        // LLM request, or contacting an MCP server.
        const configs = [];
        worker.sessionManager.client = {
            async createSession(config) {
                configs.push(config);
                return { on: () => () => {}, registerTools() {} };
            },
            async stop() {},
        };
        worker.sessionManager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
        await worker.sessionManager.getOrCreate("generic", { model: "gpt-5.6-terra" }, { turnIndex: 0 });
        await worker.sessionManager.getOrCreate("named", {
            model: "gpt-5.6-terra",
            boundAgentName: "deepwiki",
        }, { turnIndex: 0 });

        for (const config of configs) {
            assert.deepEqual(config.customAgents.map(agent => agent.name), ["swarm-explore", "swarm-task"]);
            assert.equal(config.excludedTools.includes("task"), false);
        }
        assert.equal(configs[0].mcpServers?.deepwiki, undefined, "generic sessions do not inherit named MCP grants");
        assert.deepEqual(Object.keys(configs[1].mcpServers), ["deepwiki"]);
        assert.equal(configs[1].mcpServers.deepwiki.url, "https://mcp.deepwiki.com/mcp");
        assert.ok(worker.allowedAgentNames.includes("deepwiki"), "SDK local task profiles must not replace durable blueprints");
    } finally {
        await worker?.sessionManager.shutdown();
        process.chdir(originalCwd);
        if (originalPluginDirs === undefined) delete process.env.PLUGIN_DIRS;
        else process.env.PLUGIN_DIRS = originalPluginDirs;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
