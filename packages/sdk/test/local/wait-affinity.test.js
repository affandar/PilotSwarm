/**
 * Level 2/3: wait affinity behavior.
 *
 * Verifies that long waits rotate affinity by default, but preserve it when
 * the LLM opts in with preserveWorkerAffinity=true.
 */

import { describe, it, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";
import { planWaitHandling } from "../../src/wait-affinity.ts";
import { ManagedSession } from "../../src/managed-session.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function getSessionInfo(mgmt, sessionId) {
    const cmdId = randomUUID();
    await mgmt.sendCommand(sessionId, { cmd: "get_info", id: cmdId });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const response = await mgmt.getCommandResponse(sessionId, cmdId);
        if (response?.result) return response.result;
        await new Promise(r => setTimeout(r, 250));
    }

    throw new Error(`Timed out waiting for get_info response for session ${sessionId}`);
}

function fullAffinityKey(info) {
    return info.affinityKey || info.affinityKeyShort;
}

async function waitForSessionStatus(mgmt, sessionId, expectedStatus) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const status = await mgmt.getSessionStatus(sessionId);
        if (status?.customStatus?.status === expectedStatus) return status;
        await new Promise(r => setTimeout(r, 250));
    }

    throw new Error(`Timed out waiting for session ${sessionId} to reach status ${expectedStatus}`);
}

async function testLongWaitRotatesAffinity(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, {
            client: {
                blobEnabled: true,
                waitThreshold: 0,
                dehydrateThreshold: 0,
            },
        }, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content:
                        "If the user says exactly 'baseline-ready-test', reply with exactly the single word 'ready'. " +
                        "You have a wait tool. If the user says exactly 'default-wait-test', " +
                        "you must call wait with seconds=5 and reason='default wait test'. " +
                        "Do not include preserveWorkerAffinity. After the wait completes, reply with exactly 'done'. " +
                        "For any other prompt, reply with exactly the single word 'ready'.",
                },
            });

            const ready = await session.sendAndWait("baseline-ready-test", TIMEOUT);
            assert(ready?.toLowerCase().includes("ready"), `Expected ready response but got: ${ready}`);
            const before = await getSessionInfo(mgmt, session.sessionId);
            assertNotNull(fullAffinityKey(before), "baseline affinity key present");

            await session.send("default-wait-test");
            const waiting = await waitForSessionStatus(mgmt, session.sessionId, "waiting");
            assert(
                waiting.customStatus?.preserveWorkerAffinity !== true,
                "default long wait should not request preserveWorkerAffinity",
            );

            const response = await session.wait(TIMEOUT);
            assert(response?.toLowerCase().includes("done"), `Expected done response but got: ${response}`);

            const after = await getSessionInfo(mgmt, session.sessionId);
            assertNotNull(fullAffinityKey(after), "post-wait affinity key present");
            assert(
                fullAffinityKey(before) !== fullAffinityKey(after),
                `Expected affinity key to rotate after long wait, but it stayed ${fullAffinityKey(before)}`,
            );
        });
    } finally {
        await mgmt.stop();
    }
}

async function testLongWaitPreservesAffinity(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, {
            client: {
                blobEnabled: true,
                waitThreshold: 0,
                dehydrateThreshold: 0,
            },
        }, async (client) => {
            const session = await client.createSession({
                systemMessage: {
                    mode: "replace",
                    content:
                        "If the user says exactly 'baseline-ready-test', reply with exactly the single word 'ready'. " +
                        "You have a wait_on_worker tool for worker-local waits. " +
                        "If the user says exactly 'preserve-wait-test', you must call wait_on_worker with " +
                        "seconds=5 and reason='preserve wait test'. " +
                        "After the wait completes, reply with exactly 'done'. " +
                        "For any other prompt, reply with exactly the single word 'ready'.",
                },
            });

            const ready = await session.sendAndWait("baseline-ready-test", TIMEOUT);
            assert(ready?.toLowerCase().includes("ready"), `Expected ready response but got: ${ready}`);
            const before = await getSessionInfo(mgmt, session.sessionId);
            assertNotNull(fullAffinityKey(before), "baseline affinity key present");

            await session.send("preserve-wait-test");
            const waiting = await waitForSessionStatus(mgmt, session.sessionId, "waiting");
            assertEqual(
                waiting.customStatus?.preserveWorkerAffinity,
                true,
                "preserved long wait should request preserveWorkerAffinity",
            );

            const response = await session.wait(TIMEOUT);
            assert(response?.toLowerCase().includes("done"), `Expected done response but got: ${response}`);

            const after = await getSessionInfo(mgmt, session.sessionId);
            assertNotNull(fullAffinityKey(after), "post-wait affinity key present");
            assertEqual(
                fullAffinityKey(before),
                fullAffinityKey(after),
                "Expected affinity key to stay the same after preserved long wait",
            );
        });
    } finally {
        await mgmt.stop();
    }
}

function testWaitToolSchemaIncludesPreserveAffinity() {
    const waitTool = ManagedSession.systemToolDefs().find((tool) => tool.name === "wait");
    assertNotNull(waitTool, "wait tool definition exists");
    assert(
        Object.prototype.hasOwnProperty.call(waitTool.parameters?.properties ?? {}, "preserveWorkerAffinity"),
        "wait tool schema should expose preserveWorkerAffinity",
    );

    const waitOnWorkerTool = ManagedSession.systemToolDefs().find((tool) => tool.name === "wait_on_worker");
    assertNotNull(waitOnWorkerTool, "wait_on_worker tool definition exists");
}

function testWaitHandlingPlanPreservesAffinity() {
    const preservePlan = planWaitHandling({
        blobEnabled: true,
        seconds: 60,
        dehydrateThreshold: 0,
        preserveWorkerAffinity: true,
    });
    assertEqual(preservePlan.shouldDehydrate, true, "preserve plan should dehydrate");
    assertEqual(preservePlan.resetAffinityOnDehydrate, false, "preserve plan should keep affinity");
    assertEqual(preservePlan.preserveAffinityOnHydrate, true, "preserve plan should rehydrate with preserved affinity");

    const shortPlan = planWaitHandling({
        blobEnabled: true,
        seconds: 1,
        dehydrateThreshold: 30,
        preserveWorkerAffinity: true,
    });
    assertEqual(shortPlan.shouldDehydrate, false, "short wait should stay in-process");
    assertEqual(shortPlan.resetAffinityOnDehydrate, false, "short wait should not reset affinity");
    assertEqual(shortPlan.preserveAffinityOnHydrate, false, "short wait should not need preserved hydration");
}

describe("Level 2/3: Wait Affinity", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("long wait rotates affinity by default", { timeout: TIMEOUT }, async () => {
        await testLongWaitRotatesAffinity(getEnv());
    });

    it("long wait preserves affinity when requested", { timeout: TIMEOUT }, async () => {
        await testLongWaitPreservesAffinity(getEnv());
    });

    it("wait planning preserves affinity when requested", async () => {
        testWaitHandlingPlanPreservesAffinity();
    });

    it("wait tool schema exposes preserve affinity controls", async () => {
        testWaitToolSchemaIncludesPreserveAffinity();
    });
});
