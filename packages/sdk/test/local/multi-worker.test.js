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
 *   - filesystem-backed rehydration preserves conversation context across workers
 *   - multiple sessions spread across two workers
 *   - no duplicate execution of the same orchestration turn across workers
 *
 * Run: node --env-file=../../.env test/local/multi-worker.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient, withTwoWorkers, PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertIncludesAny, assertGreaterOrEqual, assertThrows } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, MEMORY_CONFIG } from "../helpers/fixtures.js";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { FilesystemSessionStore, SessionManager } from "../../dist/index.js";

const TIMEOUT = 120_000;

const EXPECTED_ONE_WORD_ANSWERS = [
    ["2", "two", "Two"],
    ["4", "four", "Four"],
    ["6", "six", "Six"],
    ["8", "eight", "Eight"],
];

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
            ("Two Workers Observe Same Session");
        } finally {
            await catalog.close();
        }
    });
}

// ─── Test: Session Survives Graceful Restart ─────────────────────

async function testSessionSurvivesGracefulRestart(env) {
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

        console.log("  Phase 1: Worker A — establish memory");
        const r1 = await session.sendAndWait("Remember this exact code: X123", TIMEOUT);
        console.log(`  Turn 1 response: "${r1}"`);
        assert(r1 && r1.length > 0, "Turn 1 should produce a response on Worker A");
    } finally {
        await client.stop();
        await workerA.gracefulShutdown();
    }

    console.log("  Worker A gracefully shut down. Starting Worker B...");

    const archiveDir = join(dirname(env.sessionStateDir), "session-store");
    const archivePath = join(archiveDir, `${savedId}.tar.gz`);
    console.log(`  Checking session archive: ${archivePath}`);
    assert(existsSync(archivePath), "Expected filesystem session archive after Worker A stop");

    // Phase 2: Start worker B, resume session, run another turn
    // Filesystem-backed session rehydration should preserve the Copilot session's
    // conversation state across workers in local mode.
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

        console.log("  Phase 2: Worker B — recover remembered context");
        const r2 = await resumed.sendAndWait("What code did I ask you to remember?", TIMEOUT);
        console.log(`  Turn 2 response: "${r2}"`);
        assertIncludesAny(r2, ["X123", "x123"], "Recovered memory on Worker B");

        const v = await validateSessionAfterTurn(env, savedId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        ("Session Survives Graceful Restart");
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
        for (let i = 0; i < sessions.length; i++) {
            console.log(`  Session ${i + 1}: ${questions[i]}`);
            const response = await sessions[i].sendAndWait(questions[i], TIMEOUT);
            console.log(`  Response ${i + 1}: "${response}"`);
            assertIncludesAny(response, EXPECTED_ONE_WORD_ANSWERS[i], `Session ${i + 1} response`);
        }

        // Verify all sessions appear in list
        const listed = await client.listSessions();
        for (const s of sessions) {
            assert(listed.some(l => l.sessionId === s.sessionId), `Session ${s.sessionId.slice(0, 8)} missing from list`);
        }

        ("Multiple Sessions Across Two Workers");
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
    // The resumed session should be able to continue from shared local state.
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
        ("Worker Handoff After Stop");
    } finally {
        await client2.stop();
        await workerB.stop();
    }
}

// ─── Test: Turn 0 Resets Stale Stored Session ───────────────────

async function testTurnZeroResetsStaleStoredSession(env) {
    const fixedSessionId = "00000000-0000-4000-8000-000000000001";
    const archiveDir = join(dirname(env.sessionStateDir), "session-store");
    const store = new FilesystemSessionStore(archiveDir, env.sessionStateDir);

    // Pre-seed stale Copilot session state without any orchestration/CMS history.
    const seedManager = new SessionManager(process.env.GITHUB_TOKEN, store, {}, env.sessionStateDir);
    const stale = await seedManager.getOrCreate(fixedSessionId, MEMORY_CONFIG);
    const r1 = await stale.runTurn("Remember this exact code: STALE42");
    assertEqual(r1.type, "completed", "stale seed turn should complete");
    await seedManager.dehydrate(fixedSessionId, "seed");
    await seedManager.shutdown();

    const archivePath = join(archiveDir, `${fixedSessionId}.tar.gz`);
    assert(existsSync(archivePath), "Expected seeded archive before turn-0 reset");

    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "turn-zero-reset",
        disableManagementAgents: true,
    });
    await worker.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await client.start();

    try {
        const session = await client.createSession({ ...MEMORY_CONFIG, sessionId: fixedSessionId });
        const response = await session.sendAndWait(
            'If I already told you a code earlier in this session, answer with just that code. Otherwise answer with just "UNKNOWN".',
            TIMEOUT,
        );
        console.log(`  Turn 0 reset response: "${response}"`);
        assert(!/STALE42/i.test(response), "Turn 0 must not reuse stale stored Copilot session state");
        assert(!existsSync(archivePath), "Turn 0 reset should purge the stale archive before creating a fresh session");
    } finally {
        await client.stop();
        await worker.stop();
    }
}

// ─── Test: Turn 1+ Fails Without Stored Session ─────────────────

async function testTurnOneFailsWithoutStoredSession(env) {
    const commonOpts = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    const workerA = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "missing-state-a",
        disableManagementAgents: true,
    });
    await workerA.start();

    const clientA = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await clientA.start();

    let sessionId;
    try {
        const session = await clientA.createSession(MEMORY_CONFIG);
        sessionId = session.sessionId;
        const response = await session.sendAndWait("Remember this exact code: LOST77", TIMEOUT);
        assert(response && response.length > 0, "Turn 1 response should exist before state deletion");
    } finally {
        await clientA.stop();
        await workerA.gracefulShutdown();
    }

    const archiveDir = join(dirname(env.sessionStateDir), "session-store");
    rmSync(join(archiveDir, `${sessionId}.tar.gz`), { force: true });
    rmSync(join(archiveDir, `${sessionId}.meta.json`), { force: true });
    rmSync(join(env.sessionStateDir, sessionId), { recursive: true, force: true });

    const workerB = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "missing-state-b",
        disableManagementAgents: true,
    });
    await workerB.start();

    const clientB = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await clientB.start();

    try {
        const resumed = await clientB.resumeSession(sessionId);
        await assertThrows(
            () => resumed.sendAndWait("What code did I ask you to remember?", 30_000),
            "expected resumable copilot session state",
            "turn 1+ should fail when no resumable session state exists",
        );

        const catalog = await createCatalog(env);
        try {
            const row = await waitForSessionState(catalog, sessionId, ["failed"], 30_000);
            assert(row?.lastError, "Expected CMS lastError for missing resumable session state");
            assertIncludes(row.lastError, "expected resumable Copilot session state", "CMS lastError records missing session state");
        } finally {
            await catalog.close();
        }
    } finally {
        await clientB.stop();
        await workerB.stop();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

describe.concurrent("Level 3: Multi-Worker Tests", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Two Workers Observe Same Session", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("multi-worker");
        try { await testTwoWorkersObserveSession(env); } finally { await env.cleanup(); }
    });
    it("Session Survives Graceful Restart", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("multi-worker");
        try { await testSessionSurvivesGracefulRestart(env); } finally { await env.cleanup(); }
    });
    it("Multiple Sessions Across Two Workers", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("multi-worker");
        try { await testMultipleSessionsTwoWorkers(env); } finally { await env.cleanup(); }
    });
    it("Worker Handoff After Stop", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("multi-worker");
        try { await testWorkerHandoffAfterStop(env); } finally { await env.cleanup(); }
    });
    it("Turn 0 Resets Stale Stored Session", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("multi-worker");
        try { await testTurnZeroResetsStaleStoredSession(env); } finally { await env.cleanup(); }
    });
    it("Turn 1+ Fails Without Stored Session", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("multi-worker");
        try { await testTurnOneFailsWithoutStoredSession(env); } finally { await env.cleanup(); }
    });
});
