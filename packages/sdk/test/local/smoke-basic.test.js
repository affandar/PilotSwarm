/**
 * Level 1a: Smoke tests — core LLM flows.
 *
 * Covers: simple Q&A, tool calling, multi-turn memory, event persistence,
 * session resume, send()+wait().
 *
 * Run: npx vitest run test/local/smoke-basic.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertIncludes, assertIncludesAny, assertGreaterOrEqual, assertNotNull, assertEqual } from "../helpers/assertions.js";
import { assertStrictlyIncreasingSeq, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, MEMORY_CONFIG, createAddTool } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testSimpleQA(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Sending: What is the capital of France?");
        const response = await session.sendAndWait("What is the capital of France?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assertIncludesAny(response, ["paris", "Paris"], "Capital of France");

        const v = await validateSessionAfterTurn(env, session.sessionId, {
            requiredEventTypes: ["user.message", "assistant.message"],
        });
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}, iter=${v.orchStatus.customStatus?.iteration}`);
        console.log(`  [KV]  response.latest type=${v.latestResponse?.type}, version=${v.latestResponse?.version}`);
    });
}

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

        const v = await validateSessionAfterTurn(env, session.sessionId, {
            requiredEventTypes: ["user.message", "assistant.message"],
        });
        const toolEvents = v.events.filter(e => e.eventType.startsWith("tool."));
        console.log(`  [CMS] tool events: ${toolEvents.length}, total events: ${v.events.length}`);
    });
}

async function testMultiTurn(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(MEMORY_CONFIG);

        console.log("  Turn 1: My name is Alice");
        await session.sendAndWait("My name is Alice", TIMEOUT);

        console.log("  Turn 2: What is my name?");
        const r2 = await session.sendAndWait("What is my name?", TIMEOUT);
        console.log(`  Response: "${r2}"`);
        assertIncludesAny(r2, ["alice", "Alice"], "Multi-turn memory");

        const v = await validateSessionAfterTurn(env, session.sessionId, {
            minIteration: 2,
            requiredEventTypes: ["user.message", "assistant.message"],
        });
        const userEvents = v.events.filter(e => e.eventType === "user.message");
        assertGreaterOrEqual(userEvents.length, 2, "[CMS] user.message events after 2 turns");
        console.log(`  [CMS] user events=${userEvents.length}, total events=${v.events.length}, iter=${v.orchStatus.customStatus?.iteration}`);
    });
}

async function testEventPersistence(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Sending: What is 2+2?");
        await session.sendAndWait("What is 2+2?", TIMEOUT);

        await new Promise(r => setTimeout(r, 500));

        const events = await session.getMessages();
        console.log(`  Events persisted: ${events.length}`);

        assertGreaterOrEqual(events.length, 2, "Event count");

        const eventTypes = events.map(e => e.eventType);
        console.log(`  Event types: ${[...new Set(eventTypes)].join(", ")}`);

        assert(eventTypes.includes("user.message"), "Missing user.message event");
        assert(eventTypes.includes("assistant.message"), "Missing assistant.message event");

        assertStrictlyIncreasingSeq(events, "Events");

        assert(!eventTypes.includes("assistant.message_delta"), "Ephemeral delta events should not be persisted");
    });
}

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

        const v = await validateSessionAfterTurn(env, savedId, { minIteration: 2 });
        assertEqual(v.cmsRow.orchestrationId, `session-${savedId}`, "[CMS] orchestrationId after resume");
        console.log(`  [CMS] orchestrationId=${v.cmsRow.orchestrationId}, iter=${v.orchStatus.customStatus?.iteration}`);
    });
}

async function testSendAndWait(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Calling send() (fire-and-forget)...");
        await session.send("What is the capital of Japan?");

        console.log("  Calling wait() (blocking until done)...");
        const response = await session.wait(TIMEOUT);

        console.log(`  Response: "${response}"`);

        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
    });
}

describe("Level 1a: Smoke — Basic", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Simple Q&A", { timeout: TIMEOUT }, async () => {
        await testSimpleQA(getEnv());
    });
    it("Tool Calling", { timeout: TIMEOUT }, async () => {
        await testToolCalling(getEnv());
    });
    it("Multi-turn Conversation", { timeout: TIMEOUT * 2 }, async () => {
        await testMultiTurn(getEnv());
    });
    it("Event Persistence", { timeout: TIMEOUT }, async () => {
        await testEventPersistence(getEnv());
    });
    it("Session Resume", { timeout: TIMEOUT * 2 }, async () => {
        await testSessionResume(getEnv());
    });
    it("send() + wait()", { timeout: TIMEOUT }, async () => {
        await testSendAndWait(getEnv());
    });
});
