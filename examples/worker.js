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
 *
 * Usage:
 *   node --env-file=.env.remote examples/worker.js
 *   # Or in Docker: ENTRYPOINT ["node", "examples/worker.js"]
 */

import os from "node:os";
import { DurableCopilotWorker } from "../dist/index.js";

const logLevel = process.env.LOG_LEVEL || "info";
const podName = process.env.POD_NAME || os.hostname();

console.log(`[worker] Pod: ${podName}`);
console.log(`[worker] Store: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);

const worker = new DurableCopilotWorker({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    logLevel,
    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
    workerNodeId: podName,
});

await worker.start();
console.log(`[worker] Started ✓ Polling for orchestrations...`);

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
