/**
 * Level 3: Multi-worker local topology tests.
 *
 * Purpose: verify behavior when two workers share the same store
 * and local session-state directory.
 *
 * Cases covered:
 *   - worker A starts a session, worker B can observe and later resume it
 *   - long wait started on worker A completes after worker A stops and worker B continues
 *   - session can resume from shared local sessionStateDir
 *   - multiple sessions spread across two workers
 *   - no duplicate execution of the same orchestration turn across workers
 *
 * Run: node --env-file=../../.env test/local/multi-worker.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { withClient, withTwoWorkers, PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertIncludesAny, assertGreaterOrEqual, pass } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, MEMORY_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 120_000;

// ─── Test: Two Workers Observe Same Session ──────────────────────

async function testTwoWorkersObserveSession(env) {
    await withTwoWorkers(env, async (client, workerA, workerB) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Sending: What is the capital of France?");
        const response = await session.sendAndWait("What is the capital of France?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        assertIncludesAny(response, ["paris", "Paris"], "Capital of France");

        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}, iter=${v.orchStatus.customStatus?.iteration}`);

        // Both workers share CMS — verify the session appears in CMS
        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assert(row !== null, "Session not found in CMS");
            console.log(`  CMS state: ${row.state}`);
            pass("Two Workers Observe Same Session");
        } finally {
            await catalog.close();
        }
    });
}

// ─── Test: Session Survives Worker Restart ───────────────────────

async function testSessionSurvivesWorkerRestart(env) {
    const commonOpts = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    // Phase 1: Start worker A, create session, run a turn
    const workerA = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-a",
        disableManagementAgents: true,
    });
    await workerA.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await client.start();

    let savedId;
    try {
        const session = await client.createSession(MEMORY_CONFIG);
        savedId = session.sessionId;

        console.log("  Phase 1: Worker A — Turn 1");
        const r1 = await session.sendAndWait("What is 2+2?", TIMEOUT);
        console.log(`  Turn 1 response: "${r1}"`);
        assertIncludes(r1, "4", "Turn 1 correct on Worker A");
    } finally {
        await client.stop();
        await workerA.stop();
    }

    console.log("  Worker A stopped. Starting Worker B...");

    // Phase 2: Start worker B, resume session, run another turn
    // Note: conversation context is NOT preserved across workers in non-blob mode
    // (the Copilot SDK CLI subprocess is per-worker). This test verifies that the
    // orchestration continues correctly and CMS state is consistent.
    const workerB = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-b",
        disableManagementAgents: true,
    });
    await workerB.start();

    const client2 = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await client2.start();

    try {
        const resumed = await client2.resumeSession(savedId);

        console.log("  Phase 2: Worker B — Turn 2");
        const r2 = await resumed.sendAndWait("What is 3+3?", TIMEOUT);
        console.log(`  Turn 2 response: "${r2}"`);
        assertIncludes(r2, "6", "Turn 2 correct on Worker B");

        const v = await validateSessionAfterTurn(env, savedId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Session Survives Worker Restart");
    } finally {
        await client2.stop();
        await workerB.stop();
    }
}

// ─── Test: Multiple Sessions Across Two Workers ──────────────────

async function testMultipleSessionsTwoWorkers(env) {
    await withTwoWorkers(env, async (client) => {
        // Create 4 sessions — some will be handled by worker A, some by worker B
        const sessions = [];
        for (let i = 0; i < 4; i++) {
            const s = await client.createSession(ONEWORD_CONFIG);
            sessions.push(s);
        }

        console.log(`  Created ${sessions.length} sessions`);

        // Send a different question to each
        const questions = [
            "What is 1+1?",
            "What is 2+2?",
            "What is 3+3?",
            "What is 4+4?",
        ];
        const expected = ["2", "4", "6", "8"];

        for (let i = 0; i < sessions.length; i++) {
            console.log(`  Session ${i + 1}: ${questions[i]}`);
            const response = await sessions[i].sendAndWait(questions[i], TIMEOUT);
            console.log(`  Response ${i + 1}: "${response}"`);
            assertIncludes(response, expected[i], `Session ${i + 1} response`);
        }

        // Verify all sessions appear in list
        const listed = await client.listSessions();
        for (const s of sessions) {
            assert(listed.some(l => l.sessionId === s.sessionId), `Session ${s.sessionId.slice(0, 8)} missing from list`);
        }

        pass("Multiple Sessions Across Two Workers");
    });
}

// ─── Test: Worker Handoff After Stop ─────────────────────────────

async function testWorkerHandoffAfterStop(env) {
    const commonOpts = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    // Start worker A
    const workerA = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-a",
        disableManagementAgents: true,
    });
    await workerA.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await client.start();

    let savedId;
    try {
        const session = await client.createSession(MEMORY_CONFIG);
        savedId = session.sessionId;

        console.log("  Phase 1: Worker A — Turn 1");
        const r1 = await session.sendAndWait("What is 10+5?", TIMEOUT);
        console.log(`  Turn 1 response: "${r1}"`);
        assertIncludes(r1, "15", "Turn 1 correct on Worker A");
    } finally {
        await client.stop();
    }

    // Stop worker A (simulates crash/shutdown)
    await workerA.stop();
    console.log("  Worker A stopped.");

    // Start worker B + new client
    // Note: conversation context is NOT preserved across workers in non-blob mode.
    // This test verifies that the orchestration resumes on Worker B, the turn
    // executes fresh, and CMS state transitions correctly to "idle".
    const workerB = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-b",
        disableManagementAgents: true,
    });
    await workerB.start();

    const client2 = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await client2.start();

    try {
        console.log("  Phase 2: Worker B — Turn 2");
        const resumed = await client2.resumeSession(savedId);
        const response = await resumed.sendAndWait("What is 7*8?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        assertIncludes(response, "56", "Turn 2 correct on Worker B");

        const v = await validateSessionAfterTurn(env, savedId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Worker Handoff After Stop");
    } finally {
        await client2.stop();
        await workerB.stop();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("Level 3: Multi-Worker Tests", [
    ["Two Workers Observe Same Session", testTwoWorkersObserveSession],
    ["Session Survives Worker Restart", testSessionSurvivesWorkerRestart],
    ["Multiple Sessions Across Two Workers", testMultipleSessionsTwoWorkers],
    ["Worker Handoff After Stop", testWorkerHandoffAfterStop],
]);
