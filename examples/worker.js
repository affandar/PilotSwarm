#!/usr/bin/env node

/**
 * Headless durable-copilot-sdk worker.
 * Runs as a K8s pod — polls PostgreSQL for orchestrations and executes them.
 *
 * Env vars:
 *   DATABASE_URL   — PostgreSQL connection string
 *   GITHUB_TOKEN   — Copilot API token
 *   LOG_LEVEL      — Tracing level (default: "info")
 *   RUNTIMES_PER_POD — Number of runtime instances per pod (default: 1)
 *   POD_NAME       — K8s pod name, used as worker identity prefix (default: hostname)
 *
 * Usage:
 *   node --env-file=.env.remote examples/worker.js
 *   RUNTIMES_PER_POD=4 node --env-file=.env.remote examples/worker.js
 *   # Or in Docker: ENTRYPOINT ["node", "examples/worker.js"]
 */

import os from "node:os";
import { DurableCopilotClient } from "../dist/index.js";

const logLevel = process.env.LOG_LEVEL || "info";
const runtimesPerPod = parseInt(process.env.RUNTIMES_PER_POD || "1", 10);
const podName = process.env.POD_NAME || os.hostname();

console.log(`[worker] Pod: ${podName}, Runtimes: ${runtimesPerPod}`);
console.log(`[worker] Store: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);

const clients = [];

for (let i = 0; i < runtimesPerPod; i++) {
    const nodeId = `${podName}-rt-${i}`;
    const client = new DurableCopilotClient({
        store: process.env.DATABASE_URL,
        githubToken: process.env.GITHUB_TOKEN,
        logLevel,
        blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
        blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
        workerNodeId: nodeId,
    });
    await client.start();
    clients.push(client);
    console.log(`[worker] Runtime ${nodeId} started ✓`);
}

console.log(`[worker] All ${runtimesPerPod} runtimes running. Polling for orchestrations...`);

// Graceful shutdown — stop all runtimes
async function shutdown(signal) {
    console.log(`[worker] ${signal} received, shutting down ${clients.length} runtimes...`);
    await Promise.allSettled(clients.map(c => c.stop()));
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Block forever — runtimes poll in background
await new Promise(() => {});
