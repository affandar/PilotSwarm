/**
 * Level 2: Durability and orchestration behavior tests.
 *
 * Purpose: verify timer, retry, hydration, and continue-as-new behavior.
 *
 * Cases covered:
 *   - short wait stays in-process
 *   - long wait crosses the durable threshold (abort + resume via timer)
 *   - wait completes and returns the correct response
 *   - input_required round-trip
 *   - continue-as-new after idle
 *   - retry flow on turn failure
 *   - error status propagation
 *
 * Run: node --env-file=../../.env test/local/durability.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertIncludes, assertIncludesAny, assertGreaterOrEqual, pass } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, waitForEventCount, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { WAIT_CONFIG, ONEWORD_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 120_000;

// ─── Test: Short Wait (in-process) ──────────────────────────────

async function testShortWait(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(WAIT_CONFIG);

        console.log("  Sending: Wait 2 seconds then tell me 5+5");
        const start = Date.now();
        const response = await session.sendAndWait("Wait 2 seconds then tell me 5+5", TIMEOUT);
        const elapsed = (Date.now() - start) / 1000;

        console.log(`  Response: "${response}" (took ${elapsed.toFixed(1)}s)`);
        assertIncludes(response, "10", "Expected 10 in response");
        assertGreaterOrEqual(elapsed, 1.5, "Wait duration");

        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Short Wait (in-process)");
    });
}

// ─── Test: Durable Timer (long wait → abort + timer resume) ─────

async function testDurableTimer(env) {
    // waitThreshold: 0 forces all waits through the durable timer path
    await withClient(env, { client: { waitThreshold: 0 } }, async (client) => {
        const session = await client.createSession(WAIT_CONFIG);

        console.log("  Sending: Wait 1 second then tell me the capital of Germany");
        const response = await session.sendAndWait(
            "Wait 1 second then tell me the capital of Germany",
            TIMEOUT,
        );

        console.log(`  Response: "${response}"`);
        assertIncludesAny(response, ["berlin", "Berlin"], "Capital of Germany");

        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Durable Timer");
    });
}

// ─── Test: Durable Timer with CMS State Transitions ─────────────

async function testDurableTimerCmsState(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, { client: { waitThreshold: 0 } }, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content: "You have a wait tool. When asked to wait, use it with 3 seconds. After waiting, say 'done'. Be brief.",
                },
            });

            console.log("  Sending: Wait 3 seconds");
            const sendPromise = session.sendAndWait("Wait 3 seconds", TIMEOUT);

            // During the wait, the session should transition to "waiting"
            const waitRow = await waitForSessionState(catalog, session.sessionId, ["waiting"], 30_000);
            console.log(`  CMS state during wait: ${waitRow.state}`);
            assert(waitRow.state === "waiting", `Expected 'waiting' state, got: ${waitRow.state}`);

            const response = await sendPromise;
            console.log(`  Response: "${response}"`);

            // After completion, should be idle
            const finalRow = await waitForSessionState(catalog, session.sessionId, ["idle", "completed"], 30_000);
            console.log(`  CMS state after completion: ${finalRow.state}`);
            pass("Durable Timer CMS States");
        });
    } finally {
        await catalog.close();
    }
}

// ─── Test: User Input (input_required round-trip) ────────────────

async function testUserInput(env) {
    let questionAsked = null;

    await withClient(env, async (client) => {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content:
                    "Before answering any question, ALWAYS use the ask_user tool to ask the user to confirm what city they want information about. Then answer about that city. Be brief.",
            },
            onUserInputRequest: async (request) => {
                console.log(`  [USER INPUT] Question: "${request.question}"`);
                questionAsked = request.question;
                return { answer: "Tokyo", wasFreeform: true };
            },
        });

        console.log("  Sending: What is the population?");
        const response = await session.sendAndWait("What is the population?", TIMEOUT);

        console.log(`  Response: "${response}"`);
        assert(questionAsked !== null, "ask_user was never called");
        assertIncludesAny(
            response,
            ["tokyo", "Tokyo", "million"],
            "Expected info about Tokyo",
        );

        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
        pass("User Input (input_required)");
    });
}

// ─── Test: Continue-as-new After Idle ────────────────────────────

async function testContinueAsNewAfterIdle(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        // Turn 1
        console.log("  Turn 1: What is 2+2?");
        const r1 = await session.sendAndWait("What is 2+2?", TIMEOUT);
        console.log(`  Response 1: "${r1}"`);

        // Turn 2 (triggers continue-as-new if the orchestration idles between turns)
        console.log("  Turn 2: What is 3+3?");
        const r2 = await session.sendAndWait("What is 3+3?", TIMEOUT);
        console.log(`  Response 2: "${r2}"`);

        // Turn 3 — the key assertion: session memory and orchestration survive continue-as-new
        console.log("  Turn 3: What was your first answer?");
        const r3 = await session.sendAndWait("What was your first answer?", TIMEOUT);
        console.log(`  Response 3: "${r3}"`);

        // Should still remember earlier answers across continue-as-new
        assertIncludesAny(r3, ["4", "four"], "Memory across continue-as-new");

        const v = await validateSessionAfterTurn(env, session.sessionId, { minIteration: 3 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        pass("Continue-as-new After Idle");
    });
}

// ─── Test: Multiple Iterations ──────────────────────────────────

async function testMultipleIterations(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        // Do 3 turns
        console.log("  Turn 1...");
        await session.sendAndWait("What is 1+1?", TIMEOUT);
        console.log("  Turn 2...");
        await session.sendAndWait("What is 2+2?", TIMEOUT);
        console.log("  Turn 3...");
        await session.sendAndWait("What is 3+3?", TIMEOUT);

        // Check iteration count via getInfo() — iteration lives in customStatus, not CMS
        const info = await session.getInfo();
        console.log(`  Iterations via getInfo(): ${info.iterations}`);
        assertGreaterOrEqual(info.iterations, 3, "Iteration count after 3 turns");

        const v = await validateSessionAfterTurn(env, session.sessionId, { minIteration: 3 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}, response.v=${v.latestResponse?.version}`);
        pass("Multiple Iterations");
    });
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("Level 2: Durability Tests", [
    ["Short Wait (in-process)", testShortWait],
    ["Durable Timer (abort + resume)", testDurableTimer],
    ["Durable Timer CMS States", testDurableTimerCmsState],
    ["User Input (input_required)", testUserInput],
    ["Continue-as-new After Idle", testContinueAsNewAfterIdle],
    ["Multiple Iterations", testMultipleIterations],
]);
