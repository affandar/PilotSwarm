/**
 * CMS-Derived Sequence & Node Map — Integration Tests
 *
 * Tests the CMS enrichments from Phases 1a–1c:
 * - worker_node_id column on every CMS event
 * - session.turn_started / session.turn_completed events
 * - session event ordering by seq (immune to clock skew)
 * - Management client getSessionEvents() API
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertNotNull, assertIncludes } from "../helpers/assertions.js";
import { createCatalog, waitForEventCount, getEvents } from "../helpers/cms-helpers.js";

const TIMEOUT = 120_000;

// ─── Phase 1a: worker_node_id on CMS events ──────────────────────

async function testWorkerNodeIdOnEvents(env) {
    await withClient(env, async (client, worker) => {
        const session = await client.createSession();
        console.log(`  Session: ${session.sessionId}`);

        console.log("  Sending: What is 2+2?");
        const response = await session.sendAndWait("What is 2+2?", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 60)}"`);
        assertNotNull(response, "Should get a response");

        // Check CMS events have workerNodeId populated
        const catalog = await createCatalog(env);
        const events = await getEvents(catalog, session.sessionId);

        console.log(`  Total events: ${events.length}`);
        assert(events.length > 0, "Should have CMS events");

        const eventsWithWorker = events.filter(e => e.workerNodeId);
        console.log(`  Events with workerNodeId: ${eventsWithWorker.length} / ${events.length}`);
        assert(eventsWithWorker.length > 0, "At least some events should have workerNodeId");

        // The workerNodeId should be consistent (single worker test)
        const nodeIds = new Set(eventsWithWorker.map(e => e.workerNodeId));
        console.log(`  Distinct workerNodeIds: ${[...nodeIds].join(", ")}`);
        assert(nodeIds.size === 1, `Expected 1 distinct workerNodeId, got ${nodeIds.size}`);

        await catalog.close();
    });
}

// ─── Phase 1b: Turn events ───────────────────────────────────────

async function testTurnEvents(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession();
        console.log(`  Session: ${session.sessionId}`);

        console.log("  Sending: Say hello");
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 60)}"`);
        assertNotNull(response, "Should get a response");

        const catalog = await createCatalog(env);

        // Wait for turn_completed event (may lag slightly behind the response)
        await waitForEventCount(catalog, session.sessionId, "session.turn_completed", 1, 10_000);
        const events = await getEvents(catalog, session.sessionId);

        const turnStarted = events.filter(e => e.eventType === "session.turn_started");
        const turnCompleted = events.filter(e => e.eventType === "session.turn_completed");

        console.log(`  turn_started events: ${turnStarted.length}`);
        console.log(`  turn_completed events: ${turnCompleted.length}`);
        assert(turnStarted.length >= 1, "Should have at least 1 turn_started event");
        assert(turnCompleted.length >= 1, "Should have at least 1 turn_completed event");

        // turn_completed should come after turn_started (by seq)
        const firstStart = turnStarted[0];
        const firstEnd = turnCompleted[0];
        console.log(`  turn_started seq: ${firstStart.seq}, turn_completed seq: ${firstEnd.seq}`);
        assert(firstEnd.seq > firstStart.seq, "turn_completed seq should be > turn_started seq");

        // Turn events should have iteration data
        assert(
            firstStart.data?.iteration !== undefined,
            `turn_started should have iteration, got: ${JSON.stringify(firstStart.data)}`,
        );

        await catalog.close();
    });
}

// ─── Event ordering by seq ───────────────────────────────────────

async function testEventSeqOrdering(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession();
        console.log(`  Session: ${session.sessionId}`);

        console.log("  Sending: What is the capital of France?");
        const response = await session.sendAndWait("What is the capital of France?", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 60)}"`);
        assertNotNull(response, "Should get a response");

        const catalog = await createCatalog(env);
        await waitForEventCount(catalog, session.sessionId, "session.turn_completed", 1, 10_000);
        const events = await getEvents(catalog, session.sessionId);

        console.log(`  Total events: ${events.length}`);
        assert(events.length >= 4, "Should have at least 4 events (turn_started, user.message, assistant.message, turn_completed)");

        // Verify seq is strictly increasing
        for (let i = 1; i < events.length; i++) {
            assert(
                events[i].seq > events[i - 1].seq,
                `seq should be strictly increasing: event[${i - 1}].seq=${events[i - 1].seq} >= event[${i}].seq=${events[i].seq}`,
            );
        }

        // Verify expected event type order for a single turn
        const types = events.map(e => e.eventType);
        console.log(`  Event types in order: ${types.join(", ")}`);

        // turn_started should come before turn_completed
        // user.message may come before or after turn_started (both are fire-and-forget)
        const turnStartIdx = types.indexOf("session.turn_started");
        const turnEndIdx = types.indexOf("session.turn_completed");
        const assistantMsgIdx = types.indexOf("assistant.message");

        assert(turnStartIdx >= 0, "Should have session.turn_started");
        assert(turnEndIdx >= 0, "Should have session.turn_completed");
        assert(turnStartIdx < turnEndIdx, "turn_started should come before turn_completed");
        if (assistantMsgIdx >= 0) {
            assert(assistantMsgIdx < turnEndIdx, "assistant.message should come before turn_completed");
        }

        await catalog.close();
    });
}

// ─── Management client getSessionEvents ──────────────────────────

async function testMgmtGetSessionEvents(env) {
    await withClient(env, async (client, worker) => {
        const session = await client.createSession();
        console.log(`  Session: ${session.sessionId}`);

        console.log("  Sending: What is 3+3?");
        const response = await session.sendAndWait("What is 3+3?", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 60)}"`);
        assertNotNull(response, "Should get a response");

        // Use management client to read events (same API the TUI will use)
        const { PilotSwarmManagementClient } = await import("pilotswarm-sdk");
        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            cmsSchema: env.cmsSchema,
            duroxideSchema: env.duroxideSchema,
        });
        await mgmt.start();

        try {
            const events = await mgmt.getSessionEvents(session.sessionId);
            console.log(`  Events via mgmt: ${events.length}`);
            assert(events.length > 0, "Management client should return events");

            // Should have the same structure as catalog events
            const first = events[0];
            assert(first.seq > 0, "Event should have seq");
            assert(typeof first.eventType === "string", "Event should have eventType");
            assert(first.createdAt instanceof Date, "Event should have createdAt as Date");

            // Test afterSeq parameter (incremental polling)
            const midSeq = events[Math.floor(events.length / 2)].seq;
            const laterEvents = await mgmt.getSessionEvents(session.sessionId, midSeq);
            console.log(`  Events after seq ${midSeq}: ${laterEvents.length}`);
            assert(laterEvents.length < events.length, "afterSeq should return fewer events");
            assert(laterEvents.every(e => e.seq > midSeq), "All returned events should have seq > afterSeq");
        } finally {
            await mgmt.stop();
        }
    });
}

// ─── Test suite ──────────────────────────────────────────────────

describe.concurrent("CMS-Derived Sequence & Node Map", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("worker_node_id on CMS events", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-seq-worker");
        try { await testWorkerNodeIdOnEvents(env); } finally { await env.cleanup(); }
    });

    it("Turn started/completed events", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-seq-turns");
        try { await testTurnEvents(env); } finally { await env.cleanup(); }
    });

    it("Event seq ordering", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-seq-order");
        try { await testEventSeqOrdering(env); } finally { await env.cleanup(); }
    });

    it("Management client getSessionEvents", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-seq-mgmt");
        try { await testMgmtGetSessionEvents(env); } finally { await env.cleanup(); }
    });
});
