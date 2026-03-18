#!/usr/bin/env node

/**
 * DevOps Command Center — SDK Example
 *
 * Demonstrates building an agent-powered DevOps platform using PilotSwarm:
 *   - Session policy (allowlist — only named agents can be created)
 *   - Custom tools (mock infrastructure queries)
 *   - Named agent sessions (createSessionForAgent)
 *   - Sub-agent spawning (investigator fans out parallel queries)
 *   - Live event streaming
 *
 * Usage:
 *   node --env-file=.env examples/devops-command-center/sdk-app.js
 *
 * Requires:
 *   DATABASE_URL — PostgreSQL connection string
 *   GITHUB_TOKEN — GitHub Copilot API token
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PilotSwarmClient, PilotSwarmWorker } from "@affandar/pilotswarm";
import { devopsTools } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, "plugin");
const STORE = process.env.DATABASE_URL || "sqlite::memory:";

console.log("🔧 DevOps Command Center (SDK)");
console.log(`   Store: ${STORE.startsWith("postgres") ? "PostgreSQL" : STORE}`);
console.log(`   Plugin: ${PLUGIN_DIR}\n`);

// ─── Start worker with devops tools + plugin ─────────────────────

const worker = new PilotSwarmWorker({
    store: STORE,
    githubToken: process.env.GITHUB_TOKEN,
    pluginDirs: [PLUGIN_DIR],
    disableManagementAgents: true,  // keep it focused on the devops agents
});
worker.registerTools(devopsTools);
await worker.start();

console.log(`   Agents: ${worker.loadedAgents.map(a => `${a.name}${a.system ? " (system)" : ""}`).join(", ")}`);
console.log(`   Tools: ${devopsTools.map(t => t.name).join(", ")}`);
console.log(`   Policy: ${worker.sessionPolicy?.creation?.mode || "open"}\n`);

// ─── Start client (inherits policy from co-located worker) ───────

const client = new PilotSwarmClient({
    store: STORE,
    ...(worker.sessionPolicy ? { sessionPolicy: worker.sessionPolicy } : {}),
    ...(worker.allowedAgentNames?.length ? { allowedAgentNames: worker.allowedAgentNames } : {}),
});
await client.start();

// ─── Scenario: Investigate a production incident ─────────────────

console.log("━━━ Scenario: Incident Investigation ━━━\n");

const session = await client.createSessionForAgent("investigator");
worker.setSessionConfig(session.sessionId, {});

console.log(`   Session: ${session.sessionId}`);
const info = await session.getInfo();
console.log(`   Title: ${info.title}`);
console.log(`   Agent: ${info.agentId}\n`);

// Stream events
session.on((event) => {
    const type = event.eventType;
    if (type === "tool.execution_start") {
        console.log(`   🔧 ${event.data?.toolName || event.data?.name}`);
    } else if (type === "assistant.turn_end") {
        console.log(`   ✓ Turn complete`);
    }
});

// Send the incident prompt
console.log("   Sending: Investigate CPU spike on payment-service...\n");
const response = await session.sendAndWait(
    "There's a CPU spike on payment-service. Error rates are elevated. " +
    "Investigate the root cause — check metrics, logs, and health for " +
    "payment-service and any upstream/downstream services that might be affected.",
    180_000,
);

console.log("\n━━━ Investigation Result ━━━\n");
console.log(response?.slice(0, 1500) || "(no response)");
console.log("\n");

// ─── Show final session state ────────────────────────────────────

const finalInfo = await session.getInfo();
console.log(`   Final status: ${finalInfo.status}`);
console.log(`   Iterations: ${finalInfo.iterations}`);
console.log(`   Title: ${finalInfo.title}`);

// ─── Cleanup ─────────────────────────────────────────────────────

await client.stop();
await worker.stop();
console.log("\n   Done ✓");
process.exit(0);
