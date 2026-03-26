/**
 * Level 7a: CMS consistency — event history tests.
 *
 * Covers: events seq strictly increasing, expected event types persisted,
 * no transient events persisted, user message event data.
 *
 * Run: npx vitest run test/local/cms-events.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertGreaterOrEqual } from "../helpers/assertions.js";
import { createCatalog, getEvents, assertStrictlyIncreasingSeq, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, BRIEF_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testEventsSeqIncreasing(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(BRIEF_CONFIG);

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
        });
    } finally {
        await catalog.close();
    }
}

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

            assert(eventTypes.has("user.message"), "Missing user.message");
            assert(eventTypes.has("assistant.message"), "Missing assistant.message");

            assert(!eventTypes.has("assistant.message_delta"), "delta events should not be persisted");
            assert(!eventTypes.has("reasoning_delta"), "reasoning_delta should not be persisted");

            await validateSessionAfterTurn(env, session.sessionId);
        });
    } finally {
        await catalog.close();
    }
}

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
        });
    } finally {
        await catalog.close();
    }
}

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

            const dataStr = JSON.stringify(firstUserEvent.data);
            assert(
                dataStr.includes("capital") || dataStr.includes("Italy"),
                "user.message event data should contain the prompt text",
            );

            await validateSessionAfterTurn(env, session.sessionId);
        });
    } finally {
        await catalog.close();
    }
}

describe("Level 7a: CMS — Events", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Events Seq Strictly Increasing", { timeout: TIMEOUT }, async () => {
        await testEventsSeqIncreasing(getEnv());
    });
    it("Expected Event Types Persisted", { timeout: TIMEOUT }, async () => {
        await testExpectedEventTypes(getEnv());
    });
    it("No Transient Events Persisted", { timeout: TIMEOUT }, async () => {
        await testNoTransientEventsPersisted(getEnv());
    });
    it("User Message Event Data", { timeout: TIMEOUT }, async () => {
        await testUserMessageEventData(getEnv());
    });
});
