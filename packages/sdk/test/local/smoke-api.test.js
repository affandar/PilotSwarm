/**
 * Level 1b: Smoke tests — session API operations.
 *
 * Covers: session list, session info, session delete, on() events, event type filter.
 *
 * Run: npx vitest run test/local/smoke-api.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertGreaterOrEqual, assertNotNull } from "../helpers/assertions.js";
import { validateSessionAfterTurn, validateSessionDeleted } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

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
    });
}

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

        const v = await validateSessionAfterTurn(env, session.sessionId);
        assertEqual(v.cmsRow.state, info2.status, "[CMS↔Client] state consistency");
        const orchIter = v.orchStatus.customStatus?.iteration ?? 0;
        assertEqual(orchIter, info2.iterations, "[Orch↔Client] iteration consistency");
        console.log(`  [Consistency] CMS=${v.cmsRow.state}, orch.iter=${orchIter}, client.iter=${info2.iterations} ✓`);
    });
}

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

        await validateSessionDeleted(env, id);
        console.log("  [CMS] soft-delete confirmed ✓");
    });
}

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
    });
}

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
    });
}

describe("Level 1b: Smoke — API", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Session List", { timeout: TIMEOUT }, async () => {
        await testSessionList(getEnv());
    });
    it("Session Info", { timeout: TIMEOUT }, async () => {
        await testSessionInfo(getEnv());
    });
    it("Session Delete", { timeout: TIMEOUT }, async () => {
        await testSessionDelete(getEnv());
    });
    it("session.on() Events", { timeout: TIMEOUT }, async () => {
        await testSessionOn(getEnv());
    });
    it("Event Type Filter", { timeout: TIMEOUT }, async () => {
        await testEventTypeFilter(getEnv());
    });
});
