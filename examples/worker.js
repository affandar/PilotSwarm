#!/usr/bin/env node

/**
 * Headless durable-copilot-sdk worker.
 * Runs as a K8s pod — polls PostgreSQL for orchestrations and executes them.
 *
 * Env vars:
 *   DATABASE_URL   — PostgreSQL connection string
 *   GITHUB_TOKEN   — Copilot API token
 *   LOG_LEVEL      — Tracing level (default: "info")
 *
 * Usage:
 *   node --env-file=.env.remote examples/worker.js
 *   # Or in Docker: ENTRYPOINT ["node", "examples/worker.js"]
 */

import { DurableCopilotClient } from "../dist/index.js";

const logLevel = process.env.LOG_LEVEL || "info";

const client = new DurableCopilotClient({
    store: process.env.DATABASE_URL,
    githubToken: process.env.GITHUB_TOKEN,
    logLevel,
});

console.log(`[worker] Starting durable-copilot-sdk worker...`);
console.log(`[worker] Store: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);
await client.start();
console.log("[worker] Runtime started. Polling for orchestrations...");

// Graceful shutdown
process.on("SIGTERM", async () => {
    console.log("[worker] SIGTERM received, shutting down...");
    await client.stop();
    process.exit(0);
});

process.on("SIGINT", async () => {
    console.log("[worker] SIGINT received, shutting down...");
    await client.stop();
    process.exit(0);
});

// Block forever — runtime polls in background
await new Promise(() => {});
