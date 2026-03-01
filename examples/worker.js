#!/usr/bin/env node

/**
 * Headless durable-copilot-sdk worker.
 * Runs as a K8s pod — polls PostgreSQL for orchestrations and executes them.
 *
 * Env vars:
 *   DATABASE_URL                    — PostgreSQL connection string
 *   GITHUB_TOKEN                    — Copilot API token
 *   LOG_LEVEL                       — Tracing level (default: "info")
 *   AZURE_STORAGE_CONNECTION_STRING — Blob storage for session dehydration
 *   AZURE_STORAGE_CONTAINER         — Blob container name (default: "copilot-sessions")
 *   POD_NAME                        — K8s pod name (default: hostname)
 *   PLUGIN_DIRS                     — Comma-separated plugin directories (default: /app/plugin)
 *
 * Usage:
 *   node --env-file=.env.remote examples/worker.js
 *   # Or in Docker: ENTRYPOINT ["node", "examples/worker.js"]
 */

import os from "node:os";
import fs from "node:fs";
import { DurableCopilotWorker } from "../dist/index.js";

const logLevel = process.env.LOG_LEVEL || "info";
const podName = process.env.POD_NAME || os.hostname();

// Plugin directories: env override or auto-detect /app/plugin (Docker default)
const pluginDirs = process.env.PLUGIN_DIRS
    ? process.env.PLUGIN_DIRS.split(",").map(d => d.trim()).filter(Boolean)
    : [];
if (pluginDirs.length === 0 && fs.existsSync("/app/plugin/plugin.json")) {
    pluginDirs.push("/app/plugin");
}

console.log(`[worker] Pod: ${podName}`);
console.log(`[worker] Store: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);
if (pluginDirs.length > 0) console.log(`[worker] Plugin dirs: ${pluginDirs.join(", ")}`);

const SYSTEM_MESSAGE = `You are a helpful assistant running in a durable execution environment. Be concise.

CRITICAL RULES:
1. You have a 'wait' tool. You MUST use it whenever you need to wait, pause, sleep, delay, poll, check back later, schedule a future action, or implement any recurring/periodic task.
2. NEVER say you cannot wait or set timers. You CAN — use the 'wait' tool.
3. NEVER use bash sleep, setTimeout, setInterval, cron, or any other timing mechanism.
4. The 'wait' tool enables durable timers that survive process restarts and node migrations.
5. For recurring tasks: use the 'wait' tool in a loop — complete the action, then call wait(seconds), then repeat.`;

const worker = new DurableCopilotWorker({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    logLevel,
    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
    workerNodeId: podName,
    systemMessage: SYSTEM_MESSAGE,
    pluginDirs,
});

await worker.start();
console.log(`[worker] Started ✓ Polling for orchestrations...`);
if (worker.loadedAgents.length > 0) {
    console.log(`[worker] Agents: ${worker.loadedAgents.map(a => a.name).join(", ")}`);
}
if (worker.loadedSkillDirs.length > 0) {
    console.log(`[worker] Skill dirs: ${worker.loadedSkillDirs.join(", ")}`);
}
const mcpNames = Object.keys(worker.loadedMcpServers);
if (mcpNames.length > 0) {
    console.log(`[worker] MCP servers: ${mcpNames.join(", ")}`);
}

// Graceful shutdown
async function shutdown(signal) {
    console.log(`[worker] ${signal} received, shutting down...`);
    await worker.stop();
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Block forever — worker polls in background
await new Promise(() => {});
