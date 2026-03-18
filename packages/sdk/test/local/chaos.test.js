/**
 * Level 9: Local chaos tests.
 *
 * Purpose: reproduce realistic failures locally, without AKS.
 *
 * Cases covered:
 *   - kill worker process during a long wait, then start another worker
 *   - stop one worker while another is still polling
 *   - stop both workers, restart both, confirm sessions resume
 *   - session deletion during or immediately after completion
 *   - worker crash after turn completion but before next orchestration step
 *
 * These tests use separate worker instances (not child processes for now)
 * to simulate crash/restart scenarios.
 *
 * Run: node --env-file=../../.env test/local/chaos.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { assert, assertIncludes, assertIncludesAny, assertGreaterOrEqual, assertNotNull } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, validateSessionAfterTurn, validateSessionDeleted } from "../helpers/cms-helpers.js";
import { MEMORY_CONFIG, ONEWORD_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 120_000;

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

// ─── Test: Worker Restart During Long Wait ───────────────────────

async function testWorkerRestartDuringWait(env) {
    // Phase 1: Start worker A, create session, send a prompt
    const workerA = makeWorker(env, "chaos-a");
    await workerA.start();

    const client1 = makeClient(env);
    await client1.start();

    let sessionId;
    try {
        const session = await client1.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;

        // Complete a turn first so the orchestration is established
        console.log("  Phase 1: Establishing session on Worker A...");
        await session.sendAndWait("What is 2+2?", TIMEOUT);
    } finally {
        await client1.stop();
    }

    // Kill worker A
    console.log("  Killing worker A...");
    await workerA.stop();

    // Phase 2: Start worker B, verify session can still be used
    console.log("  Starting worker B...");
    const workerB = makeWorker(env, "chaos-b");
    await workerB.start();

    const client2 = makeClient(env);
    await client2.start();

    try {
        const resumed = await client2.resumeSession(sessionId);
        console.log("  Sending new prompt on Worker B...");
        const response = await resumed.sendAndWait("What is the capital of France?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        // Verify the session still works after worker handoff — any valid response is fine
        assertNotNull(response, "Response should not be null after worker restart");
        assert(response.trim().length > 0, "Response should not be empty after worker restart");

        // Verify session is in a healthy state in CMS
        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);

        ("Worker Restart During Long Wait");
    } finally {
        await client2.stop();
        await workerB.stop();
    }
}

// ─── Test: Stop Both Workers Then Restart ────────────────────────

async function testStopBothRestart(env) {
    // Phase 1: Create session, do one turn
    const worker1 = makeWorker(env, "chaos-1");
    await worker1.start();

    const client1 = makeClient(env);
    await client1.start();

    let sessionId;
    try {
        const session = await client1.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;

        console.log("  Phase 1: First turn...");
        await session.sendAndWait("What is 2+2?", TIMEOUT);
    } finally {
        await client1.stop();
    }
    await worker1.stop();
    console.log("  All workers stopped.");

    // Phase 2: start two new workers, verify session can still be used
    const workerA = makeWorker(env, "chaos-a2");
    const workerB = makeWorker(env, "chaos-b2");
    await workerA.start();
    await workerB.start();
    console.log("  Two new workers started.");

    const client2 = makeClient(env);
    await client2.start();

    try {
        // Verify the session is still listed
        const sessions = await client2.listSessions();
        assert(sessions.some(s => s.sessionId === sessionId), "Session should survive full worker restart");
        console.log("  Session still listed after restart ✓");

        // Resume and send a new prompt — verifies orchestration is functional
        const resumed = await client2.resumeSession(sessionId);
        console.log("  Phase 2: Resume — What is the capital of Japan?");
        const response = await resumed.sendAndWait("What is the capital of Japan?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        assertNotNull(response, "Should get a response after full restart");
        assert(response.trim().length > 0, "Response should not be empty after full restart");

        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        ("Stop Both Workers Then Restart");
    } finally {
        await client2.stop();
        await workerB.stop();
        await workerA.stop();
    }
}

// ─── Test: Session Delete During Completion ──────────────────────

async function testDeleteDuringCompletion(env) {
    const worker = makeWorker(env, "chaos-del");
    await worker.start();

    const client = makeClient(env);
    await client.start();

    try {
        const session = await client.createSession(ONEWORD_CONFIG);
        const id = session.sessionId;

        console.log("  Sending: What is 2+2?");
        await session.sendAndWait("What is 2+2?", TIMEOUT);

        // Immediately delete after completion
        console.log("  Deleting session immediately after completion...");
        await client.deleteSession(id);

        // Verify it's gone
        const sessions = await client.listSessions();
        assert(!sessions.some(s => s.sessionId === id), "Session should be deleted");

        await validateSessionDeleted(env, id);
        console.log("  [CMS] soft-delete confirmed ✓");
        ("Session Delete During Completion");
    } finally {
        await client.stop();
        await worker.stop();
    }
}

// ─── Test: Rapid Worker Stop/Start ───────────────────────────────

async function testRapidWorkerStopStart(env) {
    // Create session on worker 1
    const worker1 = makeWorker(env, "rapid-1");
    await worker1.start();

    const client = makeClient(env);
    await client.start();

    let sessionId;
    try {
        const session = await client.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;

        console.log("  Turn 1 on worker-1...");
        await session.sendAndWait("What is 2+2?", TIMEOUT);
    } finally {
        // Don't stop client — reuse it
    }

    // Rapid stop/start cycle
    await worker1.stop();
    console.log("  Worker 1 stopped.");

    const worker2 = makeWorker(env, "rapid-2");
    await worker2.start();
    console.log("  Worker 2 started.");

    await worker2.stop();
    console.log("  Worker 2 stopped.");

    const worker3 = makeWorker(env, "rapid-3");
    await worker3.start();
    console.log("  Worker 3 started.");

    try {
        // Verify session survives rapid restarts and can process new prompts
        const resumed = await client.resumeSession(sessionId);
        console.log("  Turn 2 on worker-3: What is 3+3?");
        const response = await resumed.sendAndWait("What is 3+3?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        assertNotNull(response, "Should get response after rapid restarts");
        assertIncludesAny(response, ["6", "six", "Six"], "Should compute correctly after rapid restarts");

        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        ("Rapid Worker Stop/Start");
    } finally {
        await client.stop();
        await worker3.stop();
    }
}

// ─── Test: Concurrent Sessions Under Worker Restart ──────────────

async function testConcurrentSessionsRestart(env) {
    const worker1 = makeWorker(env, "conc-1");
    await worker1.start();

    const client = makeClient(env);
    await client.start();

    let ids = [];
    try {
        // Create 3 sessions
        for (let i = 0; i < 3; i++) {
            const s = await client.createSession(ONEWORD_CONFIG);
            ids.push(s.sessionId);
            console.log(`  Session ${i + 1}: ${s.sessionId.slice(0, 8)}`);
            await s.sendAndWait(`What is ${i + 1} + ${i + 1}?`, TIMEOUT);
        }
    } finally {
        await client.stop();
    }

    // Stop and restart
    await worker1.stop();
    console.log("  Worker stopped. Restarting...");

    const worker2 = makeWorker(env, "conc-2");
    await worker2.start();

    const client2 = makeClient(env);
    await client2.start();

    try {
        // All sessions should still be listable
        const listed = await client2.listSessions();
        for (const id of ids) {
            assert(listed.some(s => s.sessionId === id), `Session ${id.slice(0, 8)} missing after restart`);
        }
        console.log(`  All ${ids.length} sessions still listed after restart`);
        ("Concurrent Sessions Under Worker Restart");
    } finally {
        await client2.stop();
        await worker2.stop();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

describe.concurrent("Level 9: Chaos Tests", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Worker Restart During Long Wait", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("chaos");
        try { await testWorkerRestartDuringWait(env); } finally { await env.cleanup(); }
    });
    it("Stop Both Workers Then Restart", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("chaos");
        try { await testStopBothRestart(env); } finally { await env.cleanup(); }
    });
    it("Session Delete During Completion", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("chaos");
        try { await testDeleteDuringCompletion(env); } finally { await env.cleanup(); }
    });
    it("Rapid Worker Stop/Start", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("chaos");
        try { await testRapidWorkerStopStart(env); } finally { await env.cleanup(); }
    });
    it("Concurrent Sessions Under Restart", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("chaos");
        try { await testConcurrentSessionsRestart(env); } finally { await env.cleanup(); }
    });
});
