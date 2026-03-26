/**
 * Level 11b: Reliability — multi-crash and edge-case recovery tests.
 *
 * Covers: staggered crashes with multiple sessions, deleted state files
 * recovered via orchestration, double crash with two consecutive restarts.
 *
 * Run: npx vitest run test/local/reliability-multi-crash.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import {
    assert,
    assertNotNull,
    assertGreaterOrEqual,
} from "../helpers/assertions.js";
import {
    createCatalog,
    validateSessionAfterTurn,
} from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

function makeWorker(env, nodeId) {
    return new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
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
        factsSchema: env.factsSchema,
    });
}

async function testStaggeredCrashesMultipleSessions(env) {
    const sessionIds = [];

    for (let i = 0; i < 3; i++) {
        const worker = makeWorker(env, `stagger-${i}`);
        await worker.start();
        const client = makeClient(env);
        await client.start();

        try {
            const session = await client.createSession(ONEWORD_CONFIG);
            sessionIds.push(session.sessionId);
            console.log(`  Session ${i + 1}: ${session.sessionId.slice(0, 8)} — Turn 1...`);
            await session.sendAndWait(`What is ${i + 1} + ${i + 1}?`, TIMEOUT);
        } finally {
            await client.stop();
            await worker.stop();
        }
        console.log(`  Worker stagger-${i} crashed.`);
    }

    console.log("  Starting recovery worker...");
    const recoveryWorker = makeWorker(env, "stagger-recovery");
    await recoveryWorker.start();
    const recoveryClient = makeClient(env);
    await recoveryClient.start();

    try {
        const listed = await recoveryClient.listSessions();
        for (const id of sessionIds) {
            assert(listed.some(s => s.sessionId === id), `Session ${id.slice(0, 8)} should be listed after staggered crashes`);
        }
        console.log(`  All ${sessionIds.length} sessions recovered ✓`);

        const resumed = await recoveryClient.resumeSession(sessionIds[0]);
        const response = await resumed.sendAndWait("What is the capital of France?", TIMEOUT);
        console.log(`  Resume response: "${response?.slice(0, 40)}"`);
        assertNotNull(response, "Should get response after staggered recovery");

        const v = await validateSessionAfterTurn(env, sessionIds[0], { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
    } finally {
        await recoveryClient.stop();
        await recoveryWorker.stop();
    }
}

async function testDeletedLocalStateRecoveredFromStore(env) {
    const worker1 = makeWorker(env, "deleted-a");
    await worker1.start();
    const client1 = makeClient(env);
    await client1.start();

    let sessionId;
    try {
        const session = await client1.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;

        console.log("  Turn 1: Establishing session...");
        await session.sendAndWait("What is 2+2?", TIMEOUT);
    } finally {
        await client1.stop();
        await worker1.gracefulShutdown();
    }

    const archiveDir = join(env.sessionStateDir, "..", "session-store");
    const archivePath = join(archiveDir, `${sessionId}.tar.gz`);
    assert(existsSync(archivePath), "Session archive should exist before deleting local files");

    const sessionDir = join(env.sessionStateDir, sessionId);
    if (existsSync(sessionDir)) {
        console.log("  Deleting session state files to simulate data loss...");
        rmSync(sessionDir, { recursive: true, force: true });
        assert(!existsSync(sessionDir), "Session dir should be deleted");
    }

    const worker2 = makeWorker(env, "deleted-b");
    await worker2.start();
    const client2 = makeClient(env);
    await client2.start();

    try {
        const listed = await client2.listSessions();
        assert(listed.some(s => s.sessionId === sessionId), "Session should still be listed in CMS despite file loss");
        console.log("  Session still in CMS after file deletion ✓");

        const resumed = await client2.resumeSession(sessionId);
        console.log("  Sending new turn after state file deletion...");
        const response = await resumed.sendAndWait("What is 5+5?", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 80)}"`);

        assertNotNull(response, "Should get response even after local file loss");
        assert(response.trim().length > 0, "Response should not be empty");

        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
    } finally {
        await client2.stop();
        await worker2.stop();
    }
}

async function testDoubleConsecutiveCrash(env) {
    const worker1 = makeWorker(env, "double-a");
    await worker1.start();
    const client1 = makeClient(env);
    await client1.start();

    let sessionId;
    try {
        const session = await client1.createSession(ONEWORD_CONFIG);
        sessionId = session.sessionId;

        console.log("  Turn 1 on Worker A...");
        const r1 = await session.sendAndWait("What is 2+2?", TIMEOUT);
        console.log(`  Response: "${r1?.slice(0, 40)}"`);
    } finally {
        await client1.stop();
        await worker1.stop();
    }
    console.log("  Worker A crashed.");

    const worker2 = makeWorker(env, "double-b");
    await worker2.start();
    const client2 = makeClient(env);
    await client2.start();

    try {
        const resumed = await client2.resumeSession(sessionId);
        console.log("  Turn 2 on Worker B...");
        const r2 = await resumed.sendAndWait("What is 5+5?", TIMEOUT);
        console.log(`  Response: "${r2?.slice(0, 40)}"`);
    } finally {
        await client2.stop();
        await worker2.stop();
    }
    console.log("  Worker B also crashed.");

    const worker3 = makeWorker(env, "double-c");
    await worker3.start();
    const client3 = makeClient(env);
    await client3.start();

    try {
        const resumed = await client3.resumeSession(sessionId);
        console.log("  Turn 3 on Worker C...");
        const r3 = await resumed.sendAndWait("What is 7+7?", TIMEOUT);
        console.log(`  Response: "${r3?.slice(0, 40)}"`);

        assertNotNull(r3, "Should get response after double crash");
        assert(r3.trim().length > 0, "Response should not be empty");

        const v = await validateSessionAfterTurn(env, sessionId, { minIteration: 3 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        assertGreaterOrEqual(v.orchStatus.customStatus?.iteration, 3, "Should be on iteration 3 after double crash");
    } finally {
        await client3.stop();
        await worker3.stop();
    }
}

describe("Level 11b: Reliability — Multi-Crash", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Staggered Crashes — Multiple Sessions", { timeout: TIMEOUT * 4 }, async () => {
        await testStaggeredCrashesMultipleSessions(getEnv());
    });
    it("Deleted Local State Recovered From Store", { timeout: TIMEOUT * 2 }, async () => {
        await testDeletedLocalStateRecoveredFromStore(getEnv());
    });
    it("Double Crash — Two Consecutive Restarts", { timeout: TIMEOUT * 3 }, async () => {
        await testDoubleConsecutiveCrash(getEnv());
    });
});
