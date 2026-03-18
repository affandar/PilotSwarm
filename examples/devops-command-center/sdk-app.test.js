/**
 * DevOps Command Center — Example Tests
 *
 * Verifies that the devops-command-center example plugin, tools, and agents
 * work end-to-end with PilotSwarm. These are integration tests that exercise
 * the plugin directory, session policy, tool execution, and agent creation.
 *
 * Run: npx vitest run examples/devops-command-center/sdk-app.test.js
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../../packages/sdk/test/helpers/local-env.js";
import { withClient, createManagementClient } from "../../packages/sdk/test/helpers/local-workers.js";
import { assert, assertEqual, assertNotNull, assertIncludes, assertThrows } from "../../packages/sdk/test/helpers/assertions.js";
import { createCatalog, getSession } from "../../packages/sdk/test/helpers/cms-helpers.js";
import { devopsTools } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, "plugin");
const TIMEOUT = 120_000;

/** Standard opts for all devops tests: plugin dir + tools. */
const DEVOPS_OPTS = {
    worker: { pluginDirs: [PLUGIN_DIR] },
    tools: devopsTools,
};

// ─── Tests ───────────────────────────────────────────────────────

async function testPolicyBlocksGenericSession(env) {
    await withClient(env, DEVOPS_OPTS, async (client) => {
        console.log("  Attempting to create generic session (should fail)...");
        await assertThrows(
            () => client.createSession({ systemMessage: { mode: "replace", content: "Hi" } }),
            "policy",
            "generic session blocked by allowlist policy",
        );
    });
}

async function testCreateInvestigatorSession(env) {
    await withClient(env, DEVOPS_OPTS, async (client) => {
        console.log("  Creating investigator session...");
        const session = await client.createSessionForAgent("investigator");
        assertNotNull(session, "session created");

        const info = await session.getInfo();
        console.log(`  Title: "${info.title}"`);
        console.log(`  Agent: ${info.agentId}`);
        assertEqual(info.agentId, "investigator", "agentId is investigator");
        assert(info.title?.startsWith("Investigator:"), `title starts with prefix: ${info.title}`);
    });
}

async function testInvestigatorUsesTools(env) {
    await withClient(env, DEVOPS_OPTS, async (client) => {
        const session = await client.createSessionForAgent("investigator");

        const toolsUsed = [];
        session.on((event) => {
            if (event.eventType === "tool.execution_start") {
                toolsUsed.push(event.data?.toolName || event.data?.name);
            }
        });

        console.log("  Sending investigation prompt...");
        const response = await session.sendAndWait(
            "Call the query_metrics tool for payment-service. Report the CPU and error rate numbers.",
            TIMEOUT,
        );

        console.log(`  Tools used: ${toolsUsed.join(", ")}`);
        console.log(`  Response: ${response?.slice(0, 100)}`);
        assertNotNull(response, "got response");
        const usedDevopsTool = toolsUsed.some(t => ["query_metrics", "query_logs", "get_service_health"].includes(t));
        assert(usedDevopsTool, `investigator called a devops tool (used: ${toolsUsed.join(", ")})`);
    });
}

async function testDeployerUsesTools(env) {
    await withClient(env, DEVOPS_OPTS, async (client, worker) => {
        const session = await client.createSessionForAgent("deployer");

        const toolsUsed = [];
        session.on((event) => {
            if (event.eventType === "tool.execution_start") {
                toolsUsed.push(event.data?.toolName || event.data?.name);
            }
        });

        console.log("  Sending deployment query...");
        const response = await session.sendAndWait(
            "Call the list_deployments tool and tell me which services have active deployments.",
            TIMEOUT,
        );

        console.log(`  Tools used: ${toolsUsed.join(", ")}`);
        console.log(`  Response: ${response?.slice(0, 100)}`);
        assertNotNull(response, "got response");
        const usedDevopsTool = toolsUsed.some(t => ["list_deployments", "get_service_health", "query_metrics"].includes(t));
        assert(usedDevopsTool, `deployer called a devops tool (used: ${toolsUsed.join(", ")})`);
    });
}

async function testReporterGeneratesReport(env) {
    await withClient(env, DEVOPS_OPTS, async (client) => {
        const session = await client.createSessionForAgent("reporter");

        console.log("  Requesting status report...");
        const response = await session.sendAndWait(
            "Generate a status report for payment-service — include metrics and health check results.",
            TIMEOUT,
        );

        console.log(`  Report length: ${response?.length} chars`);
        assertNotNull(response, "got report");
        // Reporter should mention the service and include some metric data
        assertIncludes(response.toLowerCase(), "payment", "report mentions payment-service");
    });
}

async function testAgentNamespacing(env) {
    await withClient(env, DEVOPS_OPTS, async (client, worker) => {
        // Non-system agents
        const agents = worker.loadedAgents;
        const investigator = agents.find(a => a.name === "investigator");
        assertNotNull(investigator, "investigator loaded");
        assertEqual(investigator.namespace, "devops", "investigator has devops namespace");

        // System agents are in a separate accessor
        const sysAgents = worker.systemAgents;
        const watchdog = sysAgents.find(a => a.name === "watchdog");
        assertNotNull(watchdog, "watchdog loaded as system agent");
        assertEqual(watchdog.namespace, "devops", "watchdog has devops namespace");

        console.log(`  Agents: ${agents.map(a => `${a.namespace}:${a.name}`).join(", ")}`);
        console.log(`  System: ${sysAgents.map(a => `${a.namespace}:${a.name}`).join(", ")}`);
    });
}

async function testDefaultAgentLayering(env) {
    await withClient(env, DEVOPS_OPTS, async (_client, worker) => {
        const investigator = worker.loadedAgents.find(a => a.name === "investigator");
        assertNotNull(investigator, "investigator loaded");
        assertIncludes(investigator.prompt, "# Application Default Instructions", "app default wrapper present");
        assertIncludes(
            investigator.prompt,
            "Treat the current environment as a local mock lab unless a tool explicitly says otherwise.",
            "devops default instructions layered into investigator",
        );
        assertIncludes(investigator.prompt, "<ACTIVE_AGENT>", "active agent wrapper present");
    });
}

async function testRenameInvestigatorSession(env) {
    const mgmt = await createManagementClient(env);
    try {
        await withClient(env, DEVOPS_OPTS, async (client) => {
            const session = await client.createSessionForAgent("investigator");
            await session.sendAndWait("What services are available? Just list them briefly.", TIMEOUT);

            await mgmt.renameSession(session.sessionId, "CPU Spike Investigation");

            const info = await session.getInfo();
            console.log(`  Title after rename: "${info.title}"`);
            assertEqual(info.title, "CPU Spike Investigation", "title updated");

            const list = await client.listSessions();
            const entry = list.find(s => s.sessionId === session.sessionId);
            assertEqual(entry?.title, "CPU Spike Investigation", "title in list");
        });
    } finally {
        await mgmt.stop();
    }
}

async function testCannotCreateUnknownAgent(env) {
    await withClient(env, DEVOPS_OPTS, async (client) => {
        console.log("  Attempting to create unknown agent (should fail)...");
        await assertThrows(
            () => client.createSessionForAgent("hacker-agent"),
            "not found",
            "unknown agent rejected",
        );
    });
}

async function testCannotCreateSystemAgentDirectly(env) {
    await withClient(env, DEVOPS_OPTS, async (client) => {
        console.log("  Attempting to create system agent directly (should fail)...");
        await assertThrows(
            () => client.createSessionForAgent("watchdog"),
            "system",
            "system agent rejected for direct creation",
        );
    });
}

// ─── Test Suite ──────────────────────────────────────────────────

describe.concurrent("DevOps Command Center", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Policy Blocks Generic Session", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testPolicyBlocksGenericSession(env); } finally { await env.cleanup(); }
    });

    it("Create Investigator Session", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testCreateInvestigatorSession(env); } finally { await env.cleanup(); }
    });

    it("Investigator Uses Tools", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testInvestigatorUsesTools(env); } finally { await env.cleanup(); }
    });

    it("Deployer Uses Tools", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testDeployerUsesTools(env); } finally { await env.cleanup(); }
    });

    it("Reporter Generates Report", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testReporterGeneratesReport(env); } finally { await env.cleanup(); }
    });

    it("Agent Namespacing", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testAgentNamespacing(env); } finally { await env.cleanup(); }
    });
    it("Default Agent Layering", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testDefaultAgentLayering(env); } finally { await env.cleanup(); }
    });

    it("Rename Investigator Session", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testRenameInvestigatorSession(env); } finally { await env.cleanup(); }
    });

    it("Cannot Create Unknown Agent", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testCannotCreateUnknownAgent(env); } finally { await env.cleanup(); }
    });

    it("Cannot Create System Agent Directly", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("devops-example");
        try { await testCannotCreateSystemAgentDirectly(env); } finally { await env.cleanup(); }
    });
});
