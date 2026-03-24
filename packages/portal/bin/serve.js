#!/usr/bin/env node

/**
 * pilotswarm-web — Starts the Express + WebSocket server and serves the
 * built React portal.  In development, use `npm run dev` (Vite) with the
 * server running separately via `node server.js`.
 *
 * Usage:
 *   npx pilotswarm-web --env .env.remote
 *   npx pilotswarm-web --port 3001
 *   npx pilotswarm-web --workers 4          # embedded workers
 *   npx pilotswarm-web --workers 0          # remote workers (AKS)
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env file if --env flag provided
const envIdx = process.argv.indexOf("--env");
if (envIdx !== -1 && process.argv[envIdx + 1]) {
  const envPath = path.resolve(process.argv[envIdx + 1]);
  // Node 24+ supports --env-file natively; for programmatic loading we
  // read the file and set process.env entries manually.
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

// Dynamically import the server (after env is loaded)
const { startServer } = await import("../server.js");

const portFlag = process.argv.indexOf("--port");
const port = portFlag !== -1 ? parseInt(process.argv[portFlag + 1], 10) : 3001;

const workersFlag = process.argv.indexOf("--workers");
const workers = workersFlag !== -1 ? parseInt(process.argv[workersFlag + 1], 10) : 4;

startServer({ port, workers });
