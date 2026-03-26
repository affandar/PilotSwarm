/**
 * Level 2b: Wait interrupt regression tests.
 *
 * Purpose: verify that when a user interrupts a session that is currently
 * waiting on a durable timer, the agent emits a user-visible text reply
 * before resuming the remaining wait.
 *
 * By default this uses the suite's currently selected/default model, which is
 * how most of the local tests behave. The model can still be overridden per
 * run with PS_INTERRUPT_TEST_MODEL for ad-hoc sweeps without touching the
 * shared model provider config used by parallel tests.
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert } from "../helpers/assertions.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const INTERRUPT_MODEL = process.env.PS_INTERRUPT_TEST_MODEL || "";

async function waitForSessionCustomStatus(mgmt, sessionId, predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;

    while (Date.now() < deadline) {
        lastStatus = await mgmt.getSessionStatus(sessionId);
        if (predicate(lastStatus?.customStatus, lastStatus)) {
            return lastStatus;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
        `Timed out waiting for ${label} for session ${sessionId.slice(0, 8)}. ` +
        `Last status: ${JSON.stringify(lastStatus)}`,
    );
}

async function waitForInterruptReply(mgmt, catalog, sessionId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latestResponse = null;
    let assistantContents = [];

    while (Date.now() < deadline) {
        latestResponse = await mgmt.getLatestResponse(sessionId);
        const events = await catalog.getSessionEvents(sessionId);
        const assistantMessages = events.filter((event) => event.eventType === "assistant.message");
        assistantContents = assistantMessages.map((event) => event.data?.content ?? null);
        const lastAssistantContent = assistantContents.at(-1);

        if (
            latestResponse?.iteration === 2 &&
            typeof latestResponse?.content === "string" &&
            latestResponse.content.trim().length > 0 &&
            typeof lastAssistantContent === "string" &&
            lastAssistantContent.trim().length > 0
        ) {
            return { latestResponse, assistantContents, lastAssistantContent };
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return {
        latestResponse,
        assistantContents,
        lastAssistantContent: assistantContents.at(-1),
    };
}

async function testInterruptDuringWaitEmitsReply(env) {
    const mgmt = await createManagementClient(env);
    const catalog = await createCatalog(env);

    try {
        await withClient(env, { client: { waitThreshold: 0 } }, async (client) => {
            const session = await client.createSession({
                ...(INTERRUPT_MODEL ? { model: INTERRUPT_MODEL } : {}),
                systemMessage: {
                    mode: "replace",
                    content:
                        "You are in a durable timer interrupt regression test. " +
                        "When the user asks you to start a timer, first reply with one short sentence confirming the timer started. " +
                        "Then call wait with the exact seconds and reason. " +
                        "If a user message interrupts your timer, first reply to that user message with one short sentence. " +
                        "Then resume the wait for the remaining time.",
                },
            });

            console.log(`  Using model: ${INTERRUPT_MODEL || "(suite default)"}`);
            console.log("  Sending initial timer prompt...");
            await session.send(
                'Start a 20 second timer with reason "interrupt regression". ' +
                "First reply with one short sentence that the timer started, then wait.",
            );

            const initialWaiting = await waitForSessionCustomStatus(
                mgmt,
                session.sessionId,
                (customStatus) => customStatus?.status === "waiting" && (customStatus?.iteration ?? 0) >= 1,
                60_000,
                "initial waiting status",
            );
            console.log(`  Initial waiting status: ${JSON.stringify(initialWaiting.customStatus)}`);

            console.log('  Interrupting with: "hey are you there?"');
            await mgmt.sendMessage(session.sessionId, "hey are you there?");

            const resumedWaiting = await waitForSessionCustomStatus(
                mgmt,
                session.sessionId,
                (customStatus) => customStatus?.status === "waiting" && (customStatus?.iteration ?? 0) >= 2,
                60_000,
                "post-interrupt waiting status",
            );
            console.log(`  Waiting status after interrupt: ${JSON.stringify(resumedWaiting.customStatus)}`);

            const { latestResponse, assistantContents, lastAssistantContent } = await waitForInterruptReply(
                mgmt,
                catalog,
                session.sessionId,
                20_000,
            );

            console.log(`  Latest response after interrupt: ${JSON.stringify(latestResponse)}`);

            console.log(`  Assistant message contents: ${JSON.stringify(assistantContents)}`);

            assert(
                typeof lastAssistantContent === "string" && lastAssistantContent.trim().length > 0,
                "Expected a non-empty assistant reply after interrupt before resuming wait, " +
                `got ${JSON.stringify(lastAssistantContent)}. ` +
                `latestResponse=${JSON.stringify(latestResponse)}`,
            );

            assert(
                latestResponse?.iteration === 2 &&
                typeof latestResponse?.content === "string" &&
                latestResponse.content.trim().length > 0,
                "Expected response.latest to advance to the interrupt turn with non-empty content, " +
                `got ${JSON.stringify(latestResponse)}`,
            );
        });
    } finally {
        await catalog.close();
        await mgmt.stop();
    }
}

describe("Level 2b: Wait Interrupt Tests", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("interrupt during wait emits a user-visible reply before resuming wait", { timeout: TIMEOUT }, async () => {
        await testInterruptDuringWaitEmitsReply(getEnv());
    });
});
