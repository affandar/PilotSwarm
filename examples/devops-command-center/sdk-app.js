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
import { PilotSwarmClient, PilotSwarmWorker } from "pilotswarm-sdk";
import { createDevopsTools } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, "plugin");
const STORE = process.env.DATABASE_URL;
if (!STORE) {
    throw new Error("Missing DATABASE_URL. DevOps Command Center requires PostgreSQL for PilotSwarm CMS and facts.");
}
const SCENARIO = process.env.DEVOPS_SCENARIO || "incident";
const ARTIFACT_URI_RE = /artifact:\/\/[a-f0-9-]+\/[^\s"'`)\]]+/i;
const devopsTools = createDevopsTools({ workerMarker: "sdk-example-worker" });

const SCENARIOS = {
    incident: {
        kind: "single",
        title: "Incident Investigation",
        agent: "investigator",
        timeoutMs: 180_000,
        prompt:
            "There's a CPU spike on payment-service. Error rates are elevated. " +
            "Investigate the root cause — check metrics, logs, and health for " +
            "payment-service and any upstream/downstream services that might be affected.",
    },
    "build-local": {
        kind: "single",
        title: "Worker-Local Build",
        agent: "builder",
        timeoutMs: 300_000,
        prompt:
            "Start a new build from the devops-command-center repo on this worker and monitor it until it completes. " +
            "Use the worker-local build flow.",
    },
    "build-remote": {
        kind: "single",
        title: "Remote Build Monitoring",
        agent: "builder",
        timeoutMs: 300_000,
        prompt:
            "Start a mock remote build for the devops-command-center repo and monitor it until it completes. " +
            "Use the remote build monitoring flow.",
    },
    "report-artifact": {
        kind: "single",
        title: "Reporter Artifact Export",
        agent: "reporter",
        timeoutMs: 180_000,
        prompt:
            "Generate a detailed status report for payment-service. " +
            "Write the full markdown report to payment-service-status-report.md with write_artifact, " +
            "then call export_artifact and include the artifact:// link in your response. " +
            "Keep the inline summary to 4 short bullets.",
    },
    "artifact-handoff": {
        kind: "artifactHandoff",
        title: "Artifact Handoff",
        timeoutMs: 240_000,
    },
};

const scenario = SCENARIOS[SCENARIO];
if (!scenario) {
    console.error(`Unknown DEVOPS_SCENARIO="${SCENARIO}". Available: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
}

console.log("🔧 DevOps Command Center (SDK)");
console.log(`   Store: ${STORE.startsWith("postgres") ? "PostgreSQL" : STORE}`);
console.log(`   Plugin: ${PLUGIN_DIR}`);
console.log(`   Scenario: ${scenario.title} (${SCENARIO})\n`);

function extractArtifactUri(text) {
    const match = String(text || "").match(ARTIFACT_URI_RE);
    return match ? match[0] : null;
}

function attachEventStream(session) {
    session.on((event) => {
        const type = event.eventType;
        if (type === "tool.execution_start") {
            console.log(`   🔧 ${event.data?.toolName || event.data?.name}`);
        } else if (type === "assistant.turn_end") {
            console.log("   ✓ Turn complete");
        }
    });
}

async function createAgentSession(agentName) {
    const session = await client.createSessionForAgent(agentName);
    worker.setSessionConfig(session.sessionId, {});
    attachEventStream(session);
    const info = await session.getInfo();
    console.log(`   Session: ${session.sessionId}`);
    console.log(`   Title: ${info.title}`);
    console.log(`   Agent: ${info.agentId}\n`);
    return { session, info };
}

async function runSingleScenario(entry) {
    console.log(`━━━ Scenario: ${entry.title} ━━━\n`);

    const { session } = await createAgentSession(entry.agent);

    console.log(`   Sending: ${entry.prompt}\n`);
    const response = await session.sendAndWait(entry.prompt, entry.timeoutMs);

    console.log(`\n━━━ ${entry.title} Result ━━━\n`);
    console.log(response?.slice(0, 1500) || "(no response)");
    console.log("\n");

    const finalInfo = await session.getInfo();
    console.log(`   Final status: ${finalInfo.status}`);
    console.log(`   Iterations: ${finalInfo.iterations}`);
    console.log(`   Title: ${finalInfo.title}`);

    const artifactUri = extractArtifactUri(response);
    if (artifactUri) {
        console.log(`   Artifact: ${artifactUri}`);
        console.log(`   Session ref: session://${session.sessionId}`);
    }
}

async function runArtifactHandoffScenario(entry) {
    console.log(`━━━ Scenario: ${entry.title} ━━━\n`);

    const { session: reporter } = await createAgentSession("reporter");
    const reporterPrompt =
        "Generate a detailed status report for payment-service. " +
        "Write the full markdown report to payment-service-status-report.md with write_artifact, " +
        "then call export_artifact and include the artifact:// link in your response. " +
        "Keep the inline summary brief.";
    console.log(`   Reporter sending: ${reporterPrompt}\n`);
    const reporterResponse = await reporter.sendAndWait(reporterPrompt, entry.timeoutMs);

    console.log("━━━ Reporter Result ━━━\n");
    console.log(reporterResponse?.slice(0, 1500) || "(no response)");
    console.log("\n");

    const artifactUri = extractArtifactUri(reporterResponse);
    if (!artifactUri) {
        throw new Error("Reporter did not return an artifact:// link. Try the report-artifact scenario to inspect the raw output.");
    }

    const reporterSessionRef = `session://${reporter.sessionId}`;
    console.log(`   Artifact: ${artifactUri}`);
    console.log(`   Reporter session ref: ${reporterSessionRef}\n`);

    const { session: investigator } = await createAgentSession("investigator");
    const investigatorPrompt =
        `Review this exported status report ${artifactUri}. ` +
        "Use read_artifact before answering. " +
        `The operator recorded the source session as ${reporterSessionRef}. ` +
        "Treat that session reference as operator context only, then give the next three follow-up investigations.";
    console.log(`   Investigator sending: ${investigatorPrompt}\n`);
    const investigatorResponse = await investigator.sendAndWait(investigatorPrompt, entry.timeoutMs);

    console.log("━━━ Investigator Result ━━━\n");
    console.log(investigatorResponse?.slice(0, 1500) || "(no response)");
    console.log("\n");

    const reporterInfo = await reporter.getInfo();
    const investigatorInfo = await investigator.getInfo();
    console.log(`   Reporter final status: ${reporterInfo.status}`);
    console.log(`   Reporter title: ${reporterInfo.title}`);
    console.log(`   Investigator final status: ${investigatorInfo.status}`);
    console.log(`   Investigator title: ${investigatorInfo.title}`);
}

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

// ─── Scenario runner ──────────────────────────────────────────────

if (scenario.kind === "artifactHandoff") {
    await runArtifactHandoffScenario(scenario);
} else {
    await runSingleScenario(scenario);
}

// ─── Cleanup ─────────────────────────────────────────────────────

await client.stop();
await worker.stop();
console.log("\n   Done ✓");
process.exit(0);
