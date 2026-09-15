import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withClient } from "../helpers/local-workers.js";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "generic-base-v2-owner", email: null, displayName: "Base V2 owner" };

function write(root, relative, content) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function writeCapabilityOnlyPackage(root) {
    write(root, "plugin.json", JSON.stringify({
        name: "published-operations-kit", version: "1.0.0",
        description: "Published operations capabilities without an agent entry point",
    }));
    write(root, "skills/published-operations/SKILL.md", [
        "---",
        "name: published-operations",
        "description: Published operations procedure",
        "---",
        "",
        "PUBLISHED_SKILL_BODY: inspect the service before changing it.",
    ].join("\n"));
    write(root, "tools/worker-module.js", [
        "export default {",
        "  createTools: ({ workerNodeId }) => [{",
        "    name: 'published_lookup',",
        "    description: 'Published operations lookup',",
        "    parameters: { type: 'object', properties: { value: { type: 'string' } } },",
        "    handler: async ({ value }) => ({ source: 'published-package', value, workerNodeId }),",
        "  }],",
        "};",
        "",
    ].join("\n"));
    write(root, "mcp-servers/records.js", [
        "#!/usr/bin/env node",
        "const send = value => process.stdout.write(`${JSON.stringify(value)}\\n`);",
        "let buffer = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk;",
        "  let newline = buffer.indexOf('\\n');",
        "  while (newline !== -1) {",
        "    const line = buffer.slice(0, newline).trim();",
        "    buffer = buffer.slice(newline + 1);",
        "    if (line) {",
        "      const message = JSON.parse(line);",
        "      if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'published-records', version: '1.0.0' } } });",
        "      else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'published_mcp_lookup', description: 'Published MCP lookup', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] } });",
        "      else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ source: 'published-mcp', value: message.params?.arguments?.value }) }] } });",
        "      else if (message.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });",
        "    }",
        "    newline = buffer.indexOf('\\n');",
        "  }",
        "});",
        "",
    ].join("\n"));
    write(root, ".mcp.json", JSON.stringify({
        published_records: { command: "node", args: ["./mcp-servers/records.js"], tools: ["*"] },
    }));
    return root;
}

function invokeMcpTool(config, toolName, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(config.command, config.args ?? [], {
            cwd: config.cwd,
            env: { ...process.env, ...(config.env ?? {}) },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let buffer = "", stderr = "";
        let listedTools = [];
        const timer = setTimeout(() => finish(new Error(`MCP probe timed out: ${stderr}`)), 10_000);
        const finish = (error, value) => {
            clearTimeout(timer);
            child.kill();
            if (error) reject(error); else resolve(value);
        };
        const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        child.on("error", finish);
        child.on("exit", code => { if (code && code !== 0) finish(new Error(`MCP probe exited ${code}: ${stderr}`)); });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => {
            buffer += chunk;
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line) {
                    const message = JSON.parse(line);
                    if (message.id === 1) {
                        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
                        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
                    } else if (message.id === 2) {
                        listedTools = message.result?.tools ?? [];
                        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: args } });
                    } else if (message.id === 3) {
                        finish(null, { tools: listedTools, result: message.result });
                    }
                }
                newline = buffer.indexOf("\n");
            }
        });
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    });
}

async function featurePolicy(baseV2Enabled) {
    const definitions = Object.entries(FEATURE_FLAGS).map(([featureKey, definition]) => ({
        featureKey, ...definition, revision: "1",
    }));
    const settings = definitions.map(({ featureKey }) => ({
        featureKey, scope: "cluster", userId: null,
        enabled: featureKey === "agents.base_v2" ? baseV2Enabled : true,
        allowUserOverride: true, revision: "1",
    }));
    const cache = new FeatureFlagCache({
        revisions: async () => definitions.map(({ featureKey, revision }) => ({ featureKey, revision })),
        snapshot: async () => ({ definitions, settings }),
    });
    await cache.pollRevisionsAndRefresh();
    return cache;
}

async function exercisePublishedCapabilities(env, baseV2Enabled) {
    const catalog = await createCatalog(env);
    const artifactStore = new FilesystemArtifactStore(path.join(path.dirname(env.sessionStateDir), "artifacts"));
    const packageDir = writeCapabilityOnlyPackage(path.join(env.baseDir, "published-operations-kit"));
    expect(fs.existsSync(path.join(packageDir, "agents"))).toBe(false);
    const modelProvidersPath = path.join(env.baseDir, "model-providers.capability-package.json");
    try {
        fs.writeFileSync(modelProvidersPath, JSON.stringify({ providers: [{
            id: "fixture-openai-type", type: "openai", baseUrl: "https://example.invalid/v1",
            models: [{ name: "fixture-model" }],
        }] }));
        await catalog.providers.createProvider({
            name: "fixture-provider", typeId: "fixture-openai-type", class: "shared",
            secretRef: { apiKey: "fixture-key" },
        }, null, true);
        await catalog.providers.setClusterDefault({
            provider: "fixture-provider", model: "fixture-provider:fixture-model",
            reasoning: null, context: null,
        }, true);
        await publishAgentPackageDir({ catalog, artifactStore }, {
            dir: packageDir, scope: "shared", owner: OWNER, createdBy: "base-v2@test", isAdmin: false,
        });
        await withClient(env, {
            workerNodeId: `base-v2-package-${env.runId}`,
            worker: { nativeSubagents: "sync", modelProvidersPath, agentPackages: {
                cacheDir: path.join(env.baseDir, "agent-package-cache"), refreshIntervalMs: 0,
            } },
            client: { modelProvidersPath },
        }, async (_client, worker) => {
            const policy = await featurePolicy(baseV2Enabled);
            worker.sessionManager.setFeatureFlagCache(policy);
            const sessionId = randomUUID();
            await catalog.createSession(sessionId, { owner: OWNER, model: "fixture-provider:fixture-model" });
            const opened = [];
            const open = config => {
                fs.mkdirSync(path.join(env.sessionStateDir, config.sessionId), { recursive: true });
                const handle = {
                    sessionId: config.sessionId,
                    disconnect: vi.fn(async () => {}),
                    registerTools: vi.fn(),
                    rpc: { tasks: { list: vi.fn(async () => ({ tasks: [] })) } },
                };
                opened.push({ config, handle });
                return handle;
            };
            worker.sessionManager.ensureClient = async () => ({
                createSession: async config => open(config),
                resumeSession: async (_id, config) => open(config),
                deleteSession: async () => {},
            });
            try {
                const first = await worker.sessionManager.getOrCreate(sessionId, {
                    model: "fixture-provider:fixture-model",
                }, { turnIndex: 0 });
                expect(first.config.baseAgentPolicy.version).toBe(baseV2Enabled ? "v2" : "v1");
                expect(first.config.boundAgentName).toBeUndefined();
                const instructions = opened[0].config.systemMessage.sections.custom_instructions.content;
                if (baseV2Enabled) expect(instructions).toContain("search_capabilities");
                else expect(instructions).not.toContain("search_capabilities");
                expect(first.config.tools.some(tool => tool.name === "published_lookup")).toBe(false);
                expect(first.config.mcpServers?.published_records).toBeUndefined();

                // With V1 there is no progressive-discovery instruction and no
                // package export is attached automatically. The management APIs
                // remain additive and ungated, but this generic session has no
                // published skill body, worker tool or MCP server to use.
                if (!baseV2Enabled) return;

                const found = await first.config.capabilityServices.search({
                    query: "published operations", sources: ["published"], limit: 20,
                });
                const byKind = Object.fromEntries(found.capabilities.map(item => [item.kind, item]));
                expect(Object.keys(byKind).sort()).toEqual(["mcp", "skill", "tool"]);
                expect(byKind.skill.name).toBe("published-operations");
                expect(byKind.tool.name).toBe("published_lookup");
                expect(byKind.mcp.name).toBe("published_records");
                expect(new Set(found.capabilities.map(item => item.source_ref)).size).toBe(1);

                const loadedSkill = await first.config.capabilityServices.load(byKind.skill.ref, "skill");
                expect(loadedSkill.body).toContain("PUBLISHED_SKILL_BODY");
                const sourceRef = byKind.skill.source_ref;
                await expect(first.config.capabilityServices.use({
                    source_ref: sourceRef,
                    tools: ["published_lookup"],
                    mcp_servers: ["published_records"],
                    expected_revision: 0,
                    request_id: "activate-published-operations",
                })).resolves.toEqual({ changed: true, revision: 1 });

                const rebound = await worker.sessionManager.getOrCreate(sessionId, {
                    model: "fixture-provider:fixture-model",
                }, { turnIndex: 1 });
                expect(opened).toHaveLength(2);
                expect(opened[0].handle.disconnect).toHaveBeenCalledOnce();
                expect(opened[1].config.mcpServers).toMatchObject({
                    published_records: { command: "node", tools: ["*"] },
                });
                const attached = rebound.config.tools.find(tool => tool.name === "published_lookup");
                await expect(attached.handler({ value: "record-7" }, {})).resolves.toEqual({
                    source: "published-package", value: "record-7", workerNodeId: `base-v2-package-${env.runId}`,
                });
                const mcp = await invokeMcpTool(opened[1].config.mcpServers.published_records,
                    "published_mcp_lookup", { value: "mcp-record-8" });
                expect(mcp.tools.map(tool => tool.name)).toContain("published_mcp_lookup");
                expect(JSON.parse(mcp.result.content[0].text)).toEqual({
                    source: "published-mcp", value: "mcp-record-8",
                });
            } finally {
                policy.stop();
            }
        });
    } finally {
        await catalog.close();
    }
}

describe("published capability-only package in a generic session", () => {
    it("uses the skill, tool and MCP server with Base V2 enabled", { timeout: 180_000 }, async () => {
        await exercisePublishedCapabilities(getEnv(), true);
    });

    it("does not auto-load published skill, tool or MCP exports with Base V2 disabled", { timeout: 180_000 }, async () => {
        await exercisePublishedCapabilities(getEnv(), false);
    });
});
