/**
 * Durable creation config (migration 0072) + the bound-agent safety net,
 * reproduced the way production loses them.
 *
 * A top-level session's creation config lives in an in-memory map on the API
 * client that created it, and the orchestration is started lazily by
 * whichever process handles the FIRST MESSAGE. In production the portal runs
 * several replicas, so that is routinely a process that never saw the create
 * — found live on waldemort chk 2026-08-31 as `"config":{"waitThreshold":30}`
 * verbatim in the durable input: sessions ran with no agent prompt, no
 * custom system message, no tool names, while looking fully bound.
 *
 * Since 0072 the create persists the full serializable config to the catalog
 * row and the start restores it when the map misses, so nothing is lost. The
 * worker-side bound-agent backfill (0.5.54) stays as the safety net for
 * sessions whose durable input predates the fix — those inputs can never be
 * repaired.
 *
 * Every test uses two client instances sharing one store: client A creates,
 * client B (fresh process state, standing in for the other replica) sends
 * the first message.
 *
 * Run: npx vitest run test/local/bound-agent-backfill.test.js
 */

import { describe, it, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createAddTool, TEST_GPT_MODEL } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => {
    await preflightChecks();
});

const AGENT_MARKER = "XYZZY-BACKFILL";

function writeMarkerPlugin() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-backfill-plugin-"));
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "backfill-fixture", version: "1.0.0" }));
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "backfill-marker.agent.md"), [
        "---",
        "name: backfill-marker",
        "description: Fixture agent whose prompt is detectable in its replies.",
        "---",
        "",
        `You MUST begin every single reply with the exact word ${AGENT_MARKER} followed by a space.`,
        "This applies to every message, no exceptions.",
        "",
    ].join("\n"));
    return dir;
}

/** Worker + two independent clients over one store; fn(clientA, clientB, worker). */
async function withSplitClients(env, { tools } = {}, fn) {
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "backfill-worker",
        disableManagementAgents: true,
        pluginDirs: [writeMarkerPlugin()],
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
    });
    if (tools) worker.registerTools(tools);
    await worker.start();
    const common = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    };
    const clientA = new PilotSwarmClient({
        ...common,
        ...(worker.allowedAgentNames?.length ? { allowedAgentNames: worker.allowedAgentNames } : {}),
    });
    await clientA.start();
    const clientB = new PilotSwarmClient({ ...common });
    await clientB.start();
    try {
        await fn(clientA, clientB, worker);
    } finally {
        await clientB.stop();
        await clientA.stop();
        await worker.stop();
    }
}

async function restoredEvents(env, sessionId) {
    const catalog = await createCatalog(env);
    try {
        const events = await catalog.getSessionEvents(sessionId);
        return events.filter((e) => e.eventType === "session.bound_agent_restored");
    } finally {
        await catalog.close?.();
    }
}

describe("Durable creation config across replicas", () => {
    it("an agent session created on A and first-messaged on B keeps its agent — durably, without the safety net", async () => {
        const env = getEnv();
        await withSplitClients(env, {}, async (clientA, clientB) => {
            const created = await clientA.createSessionForAgent("backfill-marker", {
                model: TEST_GPT_MODEL,
                // Deliberately NO initialPrompt — sending it here would start
                // the orchestration on A with its map intact (the UI path
                // that always worked).
            });

            // The full projection is on the row before any message is sent.
            const catalog = await createCatalog(env);
            try {
                const stored = await catalog.getSessionCreationConfig(created.sessionId);
                assert(stored, "creation config must be persisted at create");
                assertEqual(stored.boundAgentName, "backfill-marker", "persisted boundAgentName");
                // The projection stores the RESOLVED model (provider prefix
                // stripped by _resolveCreationModel); the row's own model
                // column keeps the full name. Both are fine — assert presence.
                assert(String(stored.model || "").includes("gpt-"), `persisted model, got ${stored.model}`);
            } finally {
                await catalog.close?.();
            }

            const resumed = await clientB.resumeSession(created.sessionId);
            const response = await resumed.sendAndWait("What is 1+1? Answer with one word.", TIMEOUT);
            console.log(`  Response: "${response}"`);
            assertIncludes(response, AGENT_MARKER, "agent prompt must reach a session started by the replica that missed the create");

            // The binding rode the DURABLE config into the orchestration
            // input, so the worker-side backfill had nothing to restore. If
            // this fires, the durable path silently failed and the belt
            // caught it — which is a regression, not a pass.
            const restored = await restoredEvents(env, created.sessionId);
            assertEqual(restored.length, 0, "durable config must carry the binding; the safety net must stay idle");
        });
    }, TIMEOUT);

    it("custom systemMessage and toolNames — the fields the safety net cannot save — survive the split too", async () => {
        const env = getEnv();
        const tracker = {};
        const addTool = createAddTool(tracker);
        await withSplitClients(env, { tools: [addTool] }, async (clientA, clientB) => {
            const SYS_MARKER = "QWERTY-DURABLE";
            const session = await clientA.createSession({
                model: TEST_GPT_MODEL,
                systemMessage: `You MUST begin every reply with the exact word ${SYS_MARKER} followed by a space. No exceptions.`,
                toolNames: ["test_add"],
            });

            const resumed = await clientB.resumeSession(session.sessionId);
            const response = await resumed.sendAndWait(
                "Use your test_add tool to add 2 and 3, then state the result.",
                TIMEOUT,
            );
            console.log(`  Response: "${response}"`);
            assertIncludes(response, SYS_MARKER, "custom systemMessage must survive a cross-replica start");
            assert(tracker.called, "toolNames must survive a cross-replica start (test_add was gated by them)");
        });
    }, TIMEOUT);

    it("a legacy session (row without creation config) heals through the safety net, announced exactly once", async () => {
        const env = getEnv();
        await withSplitClients(env, {}, async (clientA, clientB) => {
            // Shape of every session created BEFORE migration 0072: a real
            // row with an agentId but no creation_config. Create it properly,
            // then null the column — byte-for-byte the legacy state, without
            // hand-rolling row values the create path normally derives.
            const created = await clientA.createSessionForAgent("backfill-marker", {
                model: TEST_GPT_MODEL,
            });
            const sessionId = created.sessionId;
            const catalog = await createCatalog(env);
            try {
                await catalog.pool.query(
                    `UPDATE "${env.cmsSchema}".sessions SET creation_config = NULL WHERE session_id = $1`,
                    [sessionId],
                );
                const stored = await catalog.getSessionCreationConfig(sessionId);
                assertEqual(stored, null, "precondition: the row must look pre-0072");
            } finally {
                await catalog.close?.();
            }

            const resumed = await clientB.resumeSession(sessionId);
            const first = await resumed.sendAndWait("What is 2+2? Answer with one word.", TIMEOUT);
            console.log(`  First response: "${first}"`);
            assertIncludes(first, AGENT_MARKER, "the worker-side backfill must restore the agent for a legacy session");

            const second = await resumed.sendAndWait("And 3+3? One word.", TIMEOUT);
            console.log(`  Second response: "${second}"`);
            assertIncludes(second, AGENT_MARKER, "the backfill must keep restoring on every turn");

            // The heal re-fires each turn (the durable input is beyond
            // repair) but is ANNOUNCED once per session per worker process.
            const restored = await restoredEvents(env, sessionId);
            assertEqual(restored.length, 1, "session.bound_agent_restored must be recorded exactly once, not per turn");
        });
    }, TIMEOUT);
});
