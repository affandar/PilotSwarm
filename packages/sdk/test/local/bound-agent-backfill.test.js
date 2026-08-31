/**
 * Bound-agent self-heal, reproduced the way production loses it.
 *
 * A top-level session's creation config lives in an in-memory map on the API
 * client that created it. In production the portal runs several replicas, and
 * the FIRST MESSAGE — which is what lazily starts the orchestration — often
 * lands on a replica that never saw the create. That replica starts the
 * orchestration with an empty config: no boundAgentName, no model. Found live
 * on waldemort chk 2026-08-31: `"config":{"waitThreshold":30}` verbatim in
 * the durable input of every MCP-created agent session, which therefore ran
 * with NO agent prompt and NO agent MCP servers, while looking fully bound
 * (CMS agentId, title, splash all correct).
 *
 * This test reproduces that shape locally with two client instances sharing
 * one store: client A creates the agent-bound session (no initial prompt),
 * client B — whose sessionConfigs map is empty, standing in for the other
 * replica — sends the first message and thereby starts the orchestration.
 * Without the runTurn backfill the session answers WITHOUT the agent's
 * instructions; with it, the worker restores the binding from the CMS row.
 *
 * Run: npx vitest run test/local/bound-agent-backfill.test.js
 */

import { describe, it, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { assert, assertIncludes } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { TEST_GPT_MODEL } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => {
    await preflightChecks();
});

const MARKER = "XYZZY-BACKFILL";

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
        `You MUST begin every single reply with the exact word ${MARKER} followed by a space.`,
        "This applies to every message, no exceptions.",
        "",
    ].join("\n"));
    return dir;
}

describe("Bound-agent backfill (cross-replica config loss)", () => {
    it("a session whose first message arrives via a client that never saw the create still gets its agent prompt", async () => {
        const env = getEnv();
        const pluginDir = writeMarkerPlugin();

        const worker = new PilotSwarmWorker({
            store: env.store,
            githubToken: process.env.GITHUB_TOKEN,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            sessionStateDir: env.sessionStateDir,
            workerNodeId: "backfill-worker",
            disableManagementAgents: true,
            pluginDirs: [pluginDir],
            logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        });
        await worker.start();

        const clientCommon = {
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
        };
        // Replica A: handles the create. Its in-memory sessionConfigs learns
        // the binding.
        const clientA = new PilotSwarmClient({
            ...clientCommon,
            ...(worker.allowedAgentNames?.length ? { allowedAgentNames: worker.allowedAgentNames } : {}),
        });
        await clientA.start();
        // Replica B: handles the first message. Fresh process state — its
        // sessionConfigs has never heard of the session.
        const clientB = new PilotSwarmClient({ ...clientCommon });
        await clientB.start();

        try {
            const created = await clientA.createSessionForAgent("backfill-marker", {
                model: TEST_GPT_MODEL,
                // Deliberately NO initialPrompt: sending it here would start
                // the orchestration on replica A with the config intact,
                // which is the UI path that always worked.
            });

            const resumed = await clientB.resumeSession(created.sessionId);
            const response = await resumed.sendAndWait("What is 1+1? Answer with one word.", TIMEOUT);
            console.log(`  Response: "${response}"`);

            // The agent's instructions reached the model even though the
            // orchestration was started from an empty config.
            assertIncludes(response, MARKER, "agent prompt must reach a session started by the replica that missed the create");

            // And the heal is observable: the worker recorded that it
            // restored the binding from the catalog row.
            const catalog = await createCatalog(env);
            try {
                const events = await catalog.getSessionEvents(created.sessionId);
                const restored = events.filter((e) => e.eventType === "session.bound_agent_restored");
                assert(restored.length >= 1, "worker must record session.bound_agent_restored for the healed session");
                console.log(`  bound_agent_restored events: ${restored.length}`);
            } finally {
                await catalog.close?.();
            }
        } finally {
            await clientB.stop();
            await clientA.stop();
            await worker.stop();
        }
    }, TIMEOUT);
});
