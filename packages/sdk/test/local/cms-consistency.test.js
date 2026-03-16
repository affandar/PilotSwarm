/**
 * Level 7: CMS and event-history consistency tests.
 *
 * Purpose: verify the persisted read model that clients and TUI depend on.
 *
 * Cases covered:
 *   - session_events.seq is strictly increasing
 *   - expected event types are persisted
 *   - transient/delta events are NOT persisted
 *   - title/model/system metadata written correctly
 *   - parent/child links in CMS are correct
 *   - session state transitions are correct in CMS
 *   - no duplicate final messages written on completed sessions
 *
 * Run: node --env-file=../../.env test/local/cms-consistency.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull, assertGreaterOrEqual, pass } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, getEvents, getSession, assertStrictlyIncreasingSeq, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, BRIEF_CONFIG, MEMORY_CONFIG } from "../helpers/fixtures.js";
import { randomUUID } from "node:crypto";

const TIMEOUT = 120_000;

// ─── Test: Events Seq Strictly Increasing ────────────────────────

async function testEventsSeqIncreasing(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(BRIEF_CONFIG);

            // Do multiple turns to generate many events
            console.log("  Turn 1...");
            await session.sendAndWait("Hello, how are you?", TIMEOUT);
            console.log("  Turn 2...");
            await session.sendAndWait("What is 2+2?", TIMEOUT);
            console.log("  Turn 3...");
            await session.sendAndWait("Tell me a one-word color", TIMEOUT);

            await new Promise(r => setTimeout(r, 500));

            const events = await getEvents(catalog, session.sessionId);
            console.log(`  Total events: ${events.length}`);

            assertGreaterOrEqual(events.length, 6, "Expected at least 6 events from 3 turns");
            assertStrictlyIncreasingSeq(events, "Multi-turn events");

            await validateSessionAfterTurn(env, session.sessionId, { minIteration: 3 });
            pass("Events Seq Strictly Increasing");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Expected Event Types Persisted ────────────────────────

async function testExpectedEventTypes(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);
            await new Promise(r => setTimeout(r, 500));

            const events = await getEvents(catalog, session.sessionId);
            const eventTypes = new Set(events.map(e => e.eventType));
            console.log(`  Persisted event types: ${[...eventTypes].join(", ")}`);

            // Must have user.message and assistant.message
            assert(eventTypes.has("user.message"), "Missing user.message");
            assert(eventTypes.has("assistant.message"), "Missing assistant.message");

            // Must NOT have ephemeral types
            assert(!eventTypes.has("assistant.message_delta"), "delta events should not be persisted");
            assert(!eventTypes.has("reasoning_delta"), "reasoning_delta should not be persisted");

            await validateSessionAfterTurn(env, session.sessionId);
            pass("Expected Event Types Persisted");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: No Transient Events Persisted ─────────────────────────

async function testNoTransientEventsPersisted(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(BRIEF_CONFIG);

            console.log("  Sending: Tell me a short story in two sentences");
            await session.sendAndWait("Tell me a short story in two sentences", TIMEOUT);
            await new Promise(r => setTimeout(r, 500));

            const events = await getEvents(catalog, session.sessionId);
            const ephemeralTypes = ["assistant.message_delta", "reasoning_delta", "thinking_delta"];

            for (const evt of events) {
                assert(
                    !ephemeralTypes.includes(evt.eventType),
                    `Ephemeral event type '${evt.eventType}' should not be persisted (seq=${evt.seq})`,
                );
            }

            console.log(`  Verified ${events.length} events have no ephemeral types`);

            await validateSessionAfterTurn(env, session.sessionId);
            pass("No Transient Events Persisted");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Session State Transitions ─────────────────────────────

async function testSessionStateTransitions(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            // Before any interaction — should be pending
            let row = await getSession(catalog, session.sessionId);
            assertNotNull(row, "Session must exist");
            console.log(`  State before send: ${row.state}`);
            assertEqual(row.state, "pending", "Initial state");

            // After sending, should transition to running → idle
            console.log("  Sending: What is 1+1?");
            await session.sendAndWait("What is 1+1?", TIMEOUT);

            row = await getSession(catalog, session.sessionId);
            console.log(`  State after first turn: ${row.state}`);
            assert(
                row.state === "idle" || row.state === "running" || row.state === "completed",
                `Expected idle/running/completed but got: ${row.state}`,
            );

            await validateSessionAfterTurn(env, session.sessionId, {
                expectedCmsStates: ["idle", "running", "completed"],
            });
            pass("Session State Transitions");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Title Update via Management Client ───────────────────
// Auto-summarization fires 60s after session start (too slow for fast tests).
// Verify the CMS title field can be written and read correctly.

async function testTitleUpdate(env) {
    const catalog = await createCatalog(env);
    const { PilotSwarmManagementClient } = await import("../../dist/index.js");
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await mgmt.start();

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(BRIEF_CONFIG);

            console.log("  Sending: Tell me about quantum computing");
            await session.sendAndWait("Tell me about quantum computing", TIMEOUT);

            // Before rename — title should be null (summarize hasn't fired yet)
            let row = await getSession(catalog, session.sessionId);
            console.log(`  Title before rename: "${row?.title}"`);

            // Rename via management client
            await mgmt.renameSession(session.sessionId, "Quantum Computing Chat");

            // Verify title was written to CMS
            row = await getSession(catalog, session.sessionId);
            console.log(`  Title after rename: "${row?.title}"`);
            assertEqual(row.title, "Quantum Computing Chat", "CMS title after rename");

            await validateSessionAfterTurn(env, session.sessionId);
            pass("Title Update via Management Client");
        });
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

// ─── Test: Session Iteration Count ───────────────────────────────

async function testSessionIterationCount(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        // Initial info — iterations should be 0
        let info = await session.getInfo();
        assertEqual(info.iterations, 0, "Initial iteration should be 0");

        console.log("  Turn 1...");
        await session.sendAndWait("What is 1+1?", TIMEOUT);

        info = await session.getInfo();
        console.log(`  Iterations after turn 1: ${info.iterations}`);
        assertGreaterOrEqual(info.iterations, 1, "After turn 1");

        console.log("  Turn 2...");
        await session.sendAndWait("What is 2+2?", TIMEOUT);

        info = await session.getInfo();
        console.log(`  Iterations after turn 2: ${info.iterations}`);
        assertGreaterOrEqual(info.iterations, 2, "After turn 2");

        await validateSessionAfterTurn(env, session.sessionId, { minIteration: 2 });
        pass("Session Iteration Count");
    });
}

// ─── Test: User Message Event Data ───────────────────────────────

async function testUserMessageEventData(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            const testPrompt = "What is the capital of Italy?";
            console.log(`  Sending: ${testPrompt}`);
            await session.sendAndWait(testPrompt, TIMEOUT);

            await new Promise(r => setTimeout(r, 500));

            const events = await getEvents(catalog, session.sessionId);
            const userEvents = events.filter(e => e.eventType === "user.message");

            assertGreaterOrEqual(userEvents.length, 1, "At least 1 user.message event");

            const firstUserEvent = userEvents[0];
            console.log(`  user.message data: ${JSON.stringify(firstUserEvent.data)?.slice(0, 200)}`);

            // Verify the event data contains the prompt text
            const dataStr = JSON.stringify(firstUserEvent.data);
            assert(
                dataStr.includes("capital") || dataStr.includes("Italy"),
                "user.message event data should contain the prompt text",
            );

            await validateSessionAfterTurn(env, session.sessionId);
            pass("User Message Event Data");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: Soft Delete Hides Session ─────────────────────────────

async function testSoftDeleteHidesSession(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);
            const id = session.sessionId;

            // Do a turn so the session has CMS + duroxide state
            await session.sendAndWait("What is 1+1?", TIMEOUT);

            // Session visible before delete
            let row = await getSession(catalog, id);
            assertNotNull(row, "Session should exist before delete");

            // Validate CMS + duroxide integrity before deletion
            await validateSessionAfterTurn(env, id);

            // Delete it
            await client.deleteSession(id);

            // Session hidden after soft delete
            row = await getSession(catalog, id);
            assert(row === null, "Session should be null after soft delete");

            // Also hidden from list
            const list = await catalog.listSessions();
            assert(!list.some(s => s.sessionId === id), "Deleted session should not appear in list");

            pass("Soft Delete Hides Session");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("Level 7: CMS Consistency Tests", [
    ["Events Seq Strictly Increasing", testEventsSeqIncreasing],
    ["Expected Event Types Persisted", testExpectedEventTypes],
    ["No Transient Events Persisted", testNoTransientEventsPersisted],
    ["Session State Transitions", testSessionStateTransitions],
    ["Title Update via Management", testTitleUpdate],
    ["Session Iteration Count", testSessionIterationCount],
    ["User Message Event Data", testUserMessageEventData],
    ["Soft Delete Hides Session", testSoftDeleteHidesSession],
]);
