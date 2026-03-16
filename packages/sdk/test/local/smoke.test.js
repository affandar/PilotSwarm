/**
 * Level 1: Single-session smoke tests.
 *
 * Purpose: confirm the runtime still works end-to-end in the happy path.
 *
 * Cases covered:
 *   - create session + simple Q&A
 *   - multi-turn memory
 *   - event persistence (CMS session_events)
 *   - session resume by ID
 *   - session list
 *   - session info
 *   - session delete
 *
 * Run: node --env-file=../../.env test/local/smoke.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertIncludesAny, assertGreaterOrEqual, assertNotNull, pass } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, assertStrictlyIncreasingSeq, validateSessionAfterTurn, validateSessionDeleted } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, BRIEF_CONFIG, MEMORY_CONFIG, createAddTool } from "../helpers/fixtures.js";

const TIMEOUT = 120_000;

// ─── Test: Simple Q&A ───────────────────────────────────────────

async function testSimpleQA(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Sending: What is the capital of France?");
        const response = await session.sendAndWait("What is the capital of France?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assertIncludesAny(response, ["paris", "Paris"], "Capital of France");

        // ── CMS + orchestration validation ──
        const v = await validateSessionAfterTurn(env, session.sessionId, {
            requiredEventTypes: ["user.message", "assistant.message"],
        });
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}, iter=${v.orchStatus.customStatus?.iteration}`);
        console.log(`  [KV]  response.latest type=${v.latestResponse?.type}, version=${v.latestResponse?.version}`);
        pass("Simple Q&A");
    });
}

// ─── Test: Tool Calling ──────────────────────────────────────────

async function testToolCalling(env) {
    const tracker = {};
    const addTool = createAddTool(tracker);

    await withClient(env, async (client) => {
        const session = await client.createSession({
            tools: [addTool],
            systemMessage: {
                mode: "replace",
                content: "You have a test_add tool. Use it when asked to add numbers. Be brief.",
            },
        });

        console.log("  Sending: What is 17 + 25?");
        const response = await session.sendAndWait("What is 17 + 25?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(tracker.called, "test_add tool was not called");
        assertIncludes(response, "42", "Expected 42 in response");

        // ── CMS + orchestration validation ──
        const v = await validateSessionAfterTurn(env, session.sessionId, {
            requiredEventTypes: ["user.message", "assistant.message"],
        });
        // Tool calls should produce tool execution events
        const toolEvents = v.events.filter(e => e.eventType.startsWith("tool."));
        console.log(`  [CMS] tool events: ${toolEvents.length}, total events: ${v.events.length}`);
        pass("Tool Calling");
    });
}

// ─── Test: Multi-turn Conversation ───────────────────────────────

async function testMultiTurn(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(MEMORY_CONFIG);

        console.log("  Turn 1: My name is Alice");
        await session.sendAndWait("My name is Alice", TIMEOUT);

        console.log("  Turn 2: What is my name?");
        const r2 = await session.sendAndWait("What is my name?", TIMEOUT);
        console.log(`  Response: "${r2}"`);
        assertIncludesAny(r2, ["alice", "Alice"], "Multi-turn memory");

        // ── CMS + orchestration validation ──
        // After 2 turns, iteration should be >= 2 and we should have multiple user+assistant events
        const v = await validateSessionAfterTurn(env, session.sessionId, {
            minIteration: 2,
            requiredEventTypes: ["user.message", "assistant.message"],
        });
        const userEvents = v.events.filter(e => e.eventType === "user.message");
        assertGreaterOrEqual(userEvents.length, 2, "[CMS] user.message events after 2 turns");
        console.log(`  [CMS] user events=${userEvents.length}, total events=${v.events.length}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Multi-turn Conversation");
    });
}

// ─── Test: Event Persistence ─────────────────────────────────────

async function testEventPersistence(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Sending: What is 2+2?");
        await session.sendAndWait("What is 2+2?", TIMEOUT);

        // Wait for events to be written to CMS
        await new Promise(r => setTimeout(r, 500));

        const events = await session.getMessages();
        console.log(`  Events persisted: ${events.length}`);

        assertGreaterOrEqual(events.length, 2, "Event count");

        const eventTypes = events.map(e => e.eventType);
        console.log(`  Event types: ${[...new Set(eventTypes)].join(", ")}`);

        assert(eventTypes.includes("user.message"), "Missing user.message event");
        assert(eventTypes.includes("assistant.message"), "Missing assistant.message event");

        // Verify sequential ordering
        assertStrictlyIncreasingSeq(events, "Events");

        // Verify no ephemeral events were persisted
        assert(!eventTypes.includes("assistant.message_delta"), "Ephemeral delta events should not be persisted");

        pass("Event Persistence");
    });
}

// ─── Test: Session Resume ────────────────────────────────────────

async function testSessionResume(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(MEMORY_CONFIG);
        const savedId = session.sessionId;

        console.log("  Turn 1: My favorite color is purple");
        await session.sendAndWait("My favorite color is purple", TIMEOUT);

        console.log("  Resuming session by ID...");
        const resumed = await client.resumeSession(savedId);
        assertEqual(resumed.sessionId, savedId, "Resumed session ID");

        console.log("  Turn 2: What is my favorite color?");
        const response = await resumed.sendAndWait("What is my favorite color?", TIMEOUT);
        console.log(`  Response: "${response}"`);
        assertIncludesAny(response, ["purple"], "Resume context preserved");

        // ── CMS + orchestration validation ──
        // Resumed session should have the same orchestration, iteration >= 2
        const v = await validateSessionAfterTurn(env, savedId, {
            minIteration: 2,
        });
        // Verify orchestration ID is correctly linked
        assertEqual(v.cmsRow.orchestrationId, `session-${savedId}`, "[CMS] orchestrationId after resume");
        console.log(`  [CMS] orchestrationId=${v.cmsRow.orchestrationId}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Session Resume");
    });
}

// ─── Test: Session List ──────────────────────────────────────────

async function testSessionList(env) {
    await withClient(env, async (client) => {
        const s1 = await client.createSession(ONEWORD_CONFIG);
        const s2 = await client.createSession(ONEWORD_CONFIG);

        console.log(`  Created: ${s1.sessionId.slice(0, 8)}, ${s2.sessionId.slice(0, 8)}`);

        const sessions = await client.listSessions();
        console.log(`  listSessions() returned ${sessions.length} session(s)`);

        const ids = sessions.map(s => s.sessionId);
        assert(ids.includes(s1.sessionId), "Session 1 not in list");
        assert(ids.includes(s2.sessionId), "Session 2 not in list");
        pass("Session List");
    });
}

// ─── Test: Session Info ──────────────────────────────────────────

async function testSessionInfo(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        const info1 = await session.getInfo();
        console.log(`  Status before send: ${info1.status}`);
        assert(
            info1.status === "pending" || info1.status === "idle",
            `Expected pending/idle but got: ${info1.status}`,
        );
        assertEqual(info1.sessionId, session.sessionId, "Session ID in info");

        console.log("  Sending: What is 3+3?");
        await session.sendAndWait("What is 3+3?", TIMEOUT);

        const info2 = await session.getInfo();
        console.log(`  Status after send: ${info2.status}, iterations: ${info2.iterations}`);
        assert(
            info2.status === "idle" || info2.status === "completed",
            `Expected idle/completed but got: ${info2.status}`,
        );
        assertGreaterOrEqual(info2.iterations, 1, "Iteration count");

        // ── CMS + orchestration consistency ──
        // Verify getInfo matches CMS + orchestration state
        const v = await validateSessionAfterTurn(env, session.sessionId);
        assertEqual(v.cmsRow.state, info2.status, "[CMS↔Client] state consistency");
        const orchIter = v.orchStatus.customStatus?.iteration ?? 0;
        assertEqual(orchIter, info2.iterations, "[Orch↔Client] iteration consistency");
        console.log(`  [Consistency] CMS=${v.cmsRow.state}, orch.iter=${orchIter}, client.iter=${info2.iterations} ✓`);
        pass("Session Info");
    });
}

// ─── Test: Session Delete ────────────────────────────────────────

async function testSessionDelete(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);
        const id = session.sessionId;
        console.log(`  Created session: ${id.slice(0, 8)}`);

        let sessions = await client.listSessions();
        assert(sessions.some(s => s.sessionId === id), "Session not in list before delete");

        await client.deleteSession(id);
        console.log("  Deleted session");

        sessions = await client.listSessions();
        assert(!sessions.some(s => s.sessionId === id), "Session still in list after delete");

        // ── CMS delete validation ──
        await validateSessionDeleted(env, id);
        console.log("  [CMS] soft-delete confirmed ✓");
        pass("Session Delete");
    });
}

// ─── Test: send() + wait() ───────────────────────────────────────

async function testSendAndWait(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Calling send() (fire-and-forget)...");
        await session.send("What is the capital of Japan?");

        console.log("  Calling wait() (blocking until done)...");
        const response = await session.wait(TIMEOUT);

        console.log(`  Response: "${response}"`);

        // ── CMS + orchestration validation ──
        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
        pass("send() + wait()");
    });
}

// ─── Test: Event Subscription via on() ───────────────────────────

async function testSessionOn(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        const receivedEvents = [];
        const assistantMessages = [];

        const unsub1 = session.on((event) => { receivedEvents.push(event); });
        const unsub2 = session.on("assistant.message", (event) => { assistantMessages.push(event); });

        console.log("  Sending: What color is the sky?");
        await session.sendAndWait("What color is the sky?", TIMEOUT);

        await new Promise(r => setTimeout(r, 2000));

        console.log(`  Events via on(): ${receivedEvents.length}`);
        console.log(`  Assistant messages via on("assistant.message"): ${assistantMessages.length}`);

        assertGreaterOrEqual(receivedEvents.length, 2, "Total events via on()");
        assertGreaterOrEqual(assistantMessages.length, 1, "Assistant messages via on()");

        for (const evt of receivedEvents) {
            assert(evt.seq > 0, "Event missing seq");
            assertNotNull(evt.sessionId, "Event missing sessionId");
            assertNotNull(evt.eventType, "Event missing eventType");
        }

        unsub1();
        unsub2();
        pass("session.on() Events");
    });
}

// ─── Test: Event Type Filter ─────────────────────────────────────

async function testEventTypeFilter(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        const userMessages = [];
        const assistantMessages = [];

        session.on("user.message", (event) => { userMessages.push(event); });
        session.on("assistant.message", (event) => { assistantMessages.push(event); });

        console.log("  Sending: What is 7+7?");
        await session.sendAndWait("What is 7+7?", TIMEOUT);

        await new Promise(r => setTimeout(r, 2000));

        console.log(`  user.message events: ${userMessages.length}`);
        console.log(`  assistant.message events: ${assistantMessages.length}`);

        assertGreaterOrEqual(userMessages.length, 1, "user.message count");
        assertGreaterOrEqual(assistantMessages.length, 1, "assistant.message count");

        for (const evt of userMessages) {
            assertEqual(evt.eventType, "user.message", "user filter correctness");
        }
        for (const evt of assistantMessages) {
            assertEqual(evt.eventType, "assistant.message", "assistant filter correctness");
        }

        pass("Event Type Filter");
    });
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("Level 1: Smoke Tests", [
    ["Simple Q&A", testSimpleQA],
    ["Tool Calling", testToolCalling],
    ["Multi-turn Conversation", testMultiTurn],
    ["Event Persistence", testEventPersistence],
    ["Session Resume", testSessionResume],
    ["Session List", testSessionList],
    ["Session Info", testSessionInfo],
    ["Session Delete", testSessionDelete],
    ["send() + wait()", testSendAndWait],
    ["session.on() Events", testSessionOn],
    ["Event Type Filter", testEventTypeFilter],
]);
