/**
 * Level 11a: Reliability — single crash recovery tests.
 *
 * Covers: orchestration survives worker crash, CMS consistency across crash,
 * tool works on replacement worker.
 *
 * Run: npx vitest run test/local/reliability-crash.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import {
    assert,
    assertEqual,
    assertNotNull,
    assertIncludes,
    assertGreaterOrEqual,
} from "../helpers/assertions.js";
import {
    createCatalog,
    validateSessionAfterTurn,
} from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

function makeWorker(env, nodeId) {
    return new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: nodeId,
        disableManagementAgents: true,
    });
}

function makeClient(env) {
    return new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
}

async function testOrchestrationSurvivesWorkerCrash(env) {
    const worker = makeWorker(env, "orch-a");
    await worker.start();
    const client = makeClient(env);
    await client.start();

    let sessionId;
    try {
        const session = await client.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;

        console.log("  Turn 1: Establishing session...");
        const r1 = await session.sendAndWait("What is 2+2?", TIMEOUT);
        console.log(`  Response: "${r1?.slice(0, 40)}"`);
    } finally {
        await client.stop();
        await worker.stop();
    }

    const catalog = await createCatalog(env);
    try {
        const row = await catalog.getSession(sessionId);
        assertNotNull(row, "Session should exist in CMS after crash");
        console.log(`  [CMS] state=${row.state} after crash ✓`);
    } finally {
        await catalog.close();
    }

    const worker2 = makeWorker(env, "orch-b");
    await worker2.start();
    const client2 = makeClient(env);
    await client2.start();

    try {
        const resumed = await client2.resumeSession(sessionId);
        console.log("  Turn 2 on replacement worker...");
        const response = await resumed.sendAndWait("What is 3+3?", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 40)}"`);

        assertNotNull(response, "Response should not be null after crash recovery");
        assert(response.trim().length > 0, "Response should not be empty");

        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        assertGreaterOrEqual(v.orchStatus.customStatus?.iteration, 2, "Iteration should advance after crash");
    } finally {
        await client2.stop();
        await worker2.stop();
    }
}

async function testCmsConsistencyAcrossCrash(env) {
    const worker1 = makeWorker(env, "cms-a");
    await worker1.start();
    const client1 = makeClient(env);
    await client1.start();

    let sessionId;
    try {
        const session = await client1.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;

        console.log("  Turn 1: First prompt...");
        const r1 = await session.sendAndWait("What is the capital of Germany?", TIMEOUT);
        console.log(`  Response: "${r1?.slice(0, 80)}"`);
    } finally {
        await client1.stop();
    }

    const catalog1 = await createCatalog(env);
    try {
        const preRow = await catalog1.getSession(sessionId);
        console.log(`  [CMS] pre-crash: state=${preRow?.state}`);
    } finally {
        await catalog1.close();
    }

    await worker1.stop();
    console.log("  Worker crashed.");

    const worker2 = makeWorker(env, "cms-b");
    await worker2.start();
    const client2 = makeClient(env);
    await client2.start();

    try {
        const resumed = await client2.resumeSession(sessionId);
        console.log("  Turn 2: Second prompt after crash...");
        const r2 = await resumed.sendAndWait("What is the capital of Japan?", TIMEOUT);
        console.log(`  Response: "${r2?.slice(0, 80)}"`);

        assertNotNull(r2, "Should get response after crash");

        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 2 });
        console.log(`  [CMS] post-crash: state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        assertEqual(v.cmsRow.state, "idle", "CMS state should be idle after successful turn");
        assertGreaterOrEqual(v.orchStatus.customStatus?.iteration, 2, "Iteration should advance");
    } finally {
        await client2.stop();
        await worker2.stop();
    }
}

async function testToolWorksOnReplacementWorker(env) {
    const { defineTool } = await import("../../src/index.ts");

    function makeAddTool() {
        return defineTool("reliability_add", {
            description: "Add two numbers. Always use this tool when asked to add.",
            parameters: {
                type: "object",
                properties: {
                    a: { type: "number", description: "First number" },
                    b: { type: "number", description: "Second number" },
                },
                required: ["a", "b"],
            },
            handler: async (args) => ({ result: args.a + args.b }),
        });
    }

    const toolConfig = {
        systemMessage: {
            mode: "replace",
            content: "You have an add tool. Always use it when asked to add. Just report the result number.",
        },
    };

    const worker1 = makeWorker(env, "tool-a");
    worker1.registerTools([makeAddTool()]);
    await worker1.start();
    const client1 = makeClient(env);
    await client1.start();

    let sessionId;
    try {
        const session = await client1.createSession({
            ...toolConfig,
            toolNames: ["reliability_add"],
        });
        sessionId = session.sessionId;

        console.log("  Turn 1: Using tool on Worker A...");
        const r1 = await session.sendAndWait("What is 10 + 20?", TIMEOUT);
        console.log(`  Response: "${r1?.slice(0, 80)}"`);
        assertIncludes(r1, "30", "Tool should compute 10+20=30 on worker A");
    } finally {
        await client1.stop();
        await worker1.stop();
    }

    console.log("  Worker A crashed. Starting Worker B with same tool...");

    const worker2 = makeWorker(env, "tool-b");
    worker2.registerTools([makeAddTool()]);
    await worker2.start();
    const client2 = makeClient(env);
    await client2.start();

    try {
        const resumed = await client2.resumeSession(sessionId);
        console.log("  Turn 2: Using tool on Worker B...");
        const r2 = await resumed.sendAndWait("What is 100 + 200?", TIMEOUT);
        console.log(`  Response: "${r2?.slice(0, 80)}"`);
        assertIncludes(r2, "300", "Tool should compute 100+200=300 on worker B");

        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
    } finally {
        await client2.stop();
        await worker2.stop();
    }
}

describe("Level 11a: Reliability — Crash", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Orchestration Survives Worker Crash", { timeout: TIMEOUT * 2 }, async () => {
        await testOrchestrationSurvivesWorkerCrash(getEnv());
    });
    it("CMS Consistency Across Crash", { timeout: TIMEOUT * 2 }, async () => {
        await testCmsConsistencyAcrossCrash(getEnv());
    });
    it("Tool Works On Replacement Worker", { timeout: TIMEOUT * 2 }, async () => {
        await testToolWorksOnReplacementWorker(getEnv());
    });
});
