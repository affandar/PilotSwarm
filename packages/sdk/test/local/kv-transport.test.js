/**
 * Level 6: KV/customStatus transport tests.
 *
 * Purpose: verify the hybrid signaling model directly — that responses
 * and command results are correctly written to the duroxide KV store
 * and readable by clients.
 *
 * Cases covered:
 *   - completed response written to response.latest and observed correctly
 *   - customStatus carries signal fields for the observer path
 *   - command response written to command.response.<id>
 *   - response/command versions are monotonically increasing
 *   - waitForStatusChange detects updates
 *   - getLatestResponse returns valid payload
 *
 * Run: node --env-file=../../.env test/local/kv-transport.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assert, assertNotNull, assertGreaterOrEqual } from "../helpers/assertions.js";
import { validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, BRIEF_CONFIG } from "../helpers/fixtures.js";
import { randomUUID } from "node:crypto";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function settlePromiseBriefly(promise, timeoutMs = 5_000) {
    await Promise.race([
        promise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

// ─── Test: Response Written to response.latest ──────────────────

async function testResponseLatest(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            // Read the latest response via management client
            const response = await mgmt.getLatestResponse(session.sessionId);
            console.log(`  response.latest: ${JSON.stringify(response)?.slice(0, 200)}`);

            assertNotNull(response, "response.latest should have a value");
            assert(
                response.type === "completed" || response.content,
                "response.latest should have type or content",
            );

            await validateSessionAfterTurn(env, session.sessionId);
            ("Response Written to response.latest");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: CustomStatus Available ────────────────────────────────

async function testCustomStatus(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 5+5?");
            await session.sendAndWait("What is 5+5?", TIMEOUT);

            const status = await mgmt.getSessionStatus(session.sessionId);
            console.log(`  Status: ${JSON.stringify(status)}`);

            assertNotNull(status, "Session status should exist");
            assert(
                status.customStatusVersion > 0,
                `Expected customStatusVersion > 0, got: ${status.customStatusVersion}`,
            );

            await validateSessionAfterTurn(env, session.sessionId);
            ("CustomStatus Available");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: Command Response via KV ──────────────────────────────

async function testCommandResponseKV(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            // Start the orchestration
            console.log("  Sending: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            // Send a get_info command
            const cmdId = randomUUID();
            console.log(`  Sending get_info command (id=${cmdId.slice(0, 8)})...`);
            await mgmt.sendCommand(session.sessionId, {
                cmd: "get_info",
                id: cmdId,
            });

            // Poll for command response
            let cmdResponse = null;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && !cmdResponse) {
                cmdResponse = await mgmt.getCommandResponse(session.sessionId, cmdId);
                if (!cmdResponse) await new Promise(r => setTimeout(r, 500));
            }

            console.log(`  Command response: ${JSON.stringify(cmdResponse)?.slice(0, 200)}`);
            assertNotNull(cmdResponse, "Command response should be in KV");
            assert(cmdResponse.id === cmdId, `Command response ID mismatch: expected ${cmdId}, got ${cmdResponse.id}`);
            assert(cmdResponse.cmd === "get_info", `Command response cmd mismatch: ${cmdResponse.cmd}`);
            assert(cmdResponse.result != null, "get_info should return result");

            await validateSessionAfterTurn(env, session.sessionId);
            ("Command Response via KV");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: Response Versions Increase Monotonically ──────────────

async function testResponseVersionsMonotonic(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            // Turn 1
            console.log("  Turn 1: What is 1+1?");
            await session.sendAndWait("What is 1+1?", TIMEOUT);

            const r1 = await mgmt.getLatestResponse(session.sessionId);
            const v1 = r1?.version ?? 0;
            console.log(`  Response version after turn 1: ${v1}`);

            // Turn 2
            console.log("  Turn 2: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            const r2 = await mgmt.getLatestResponse(session.sessionId);
            const v2 = r2?.version ?? 0;
            console.log(`  Response version after turn 2: ${v2}`);

            assert(v2 > v1, `Response version should increase: v1=${v1} v2=${v2}`);

            await validateSessionAfterTurn(env, session.sessionId, { minIteration: 2 });
            ("Response Versions Monotonic");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: waitForStatusChange Detects Updates ──────────────────

async function testWaitForStatusChange(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);
            const controller = new AbortController();

            // Start a turn — it'll produce status changes
            console.log("  Starting turn...");
            const sendPromise = session.sendAndWait("What is 3+3?", TIMEOUT, undefined, {
                signal: controller.signal,
            });

            try {
                // Wait for any status change from version 0
                const change = await mgmt.waitForStatusChange(
                    session.sessionId,
                    0,    // afterVersion
                    200,  // pollIntervalMs
                    30_000, // timeoutMs
                );

                console.log(`  Status change detected: version=${change.customStatusVersion}`);
                assertGreaterOrEqual(change.customStatusVersion, 1, "Status version after change");

                await sendPromise;

                await validateSessionAfterTurn(env, session.sessionId);
                ("waitForStatusChange Detects Updates");
            } finally {
                controller.abort();
                await settlePromiseBriefly(sendPromise);
            }
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

describe("Level 6: KV Transport Tests", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Response Written to response.latest", { timeout: TIMEOUT }, async () => {
        await testResponseLatest(getEnv());
    });
    it("CustomStatus Available", { timeout: TIMEOUT }, async () => {
        await testCustomStatus(getEnv());
    });
    it("Command Response via KV", { timeout: TIMEOUT }, async () => {
        await testCommandResponseKV(getEnv());
    });
    it("Response Versions Monotonic", { timeout: TIMEOUT }, async () => {
        await testResponseVersionsMonotonic(getEnv());
    });
    it("waitForStatusChange Detects Updates", { timeout: TIMEOUT }, async () => {
        await testWaitForStatusChange(getEnv());
    });
});
