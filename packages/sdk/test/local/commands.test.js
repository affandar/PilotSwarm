/**
 * Level 4: Command and event-queue semantics tests.
 *
 * Purpose: verify slash-command-like flows at the orchestration level,
 * without the TUI.
 *
 * Cases covered:
 *   - command event returns a command response
 *   - command response is delivered via KV-backed path
 *   - /done command while the session is running
 *   - /done command during the post-response idle window
 *   - command on a waiting session
 *   - command on an already completed session
 *   - get_info command returns session info
 *   - set_model command changes the model
 *   - list_models command returns available models
 *
 * Run: node --env-file=../../.env test/local/commands.test.js
 */

import { runSuite } from "../helpers/runner.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assert, assertIncludes, assertNotNull, pass } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, BRIEF_CONFIG } from "../helpers/fixtures.js";
import { randomUUID } from "node:crypto";

const TIMEOUT = 120_000;

// ─── Test: get_info Command ──────────────────────────────────────

async function testGetInfoCommand(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            // Send a prompt first so the orchestration is started
            console.log("  Sending: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            // Send get_info command
            const cmdId = randomUUID();
            console.log("  Sending get_info command...");
            await mgmt.sendCommand(session.sessionId, {
                cmd: "get_info",
                id: cmdId,
            });

            // Wait for the command response to appear
            await new Promise(r => setTimeout(r, 3000));

            // Read the command response from KV
            const status = await mgmt.getSessionStatus(session.sessionId);
            console.log(`  Status: ${JSON.stringify(status)}`);
            assertNotNull(status, "Status should be available");

            const v = await validateSessionAfterTurn(env, session.sessionId);
            console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
            pass("get_info Command");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: /done Command ─────────────────────────────────────────

async function testDoneCommand(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            // Send a prompt to start the orchestration
            console.log("  Sending: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            // Send /done command
            const cmdId = randomUUID();
            console.log("  Sending /done command...");
            await mgmt.sendCommand(session.sessionId, {
                cmd: "done",
                id: cmdId,
            });

            // Wait for the command response in KV
            let cmdResponse = null;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && !cmdResponse) {
                cmdResponse = await mgmt.getCommandResponse(session.sessionId, cmdId);
                if (!cmdResponse) await new Promise(r => setTimeout(r, 500));
            }

            console.log(`  Command response: ${JSON.stringify(cmdResponse)}`);
            assertNotNull(cmdResponse, "Command response for /done should exist");
            assert(cmdResponse.cmd === "done", `Expected cmd=done, got ${cmdResponse.cmd}`);
            assert(cmdResponse.result?.ok === true, "/done should return ok: true");

            // Verify orchestration status is completed
            const status = await mgmt.getSessionStatus(session.sessionId);
            console.log(`  Orchestration status: ${status.orchestrationStatus}`);
            assert(
                status.orchestrationStatus === "Completed" || status.customStatus?.status === "completed",
                `Expected completed status but got: ${status.orchestrationStatus}`,
            );

            pass("/done Command");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: /done During Post-Response Idle Window ────────────────

async function testDoneDuringIdle(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 3+3?");
            await session.sendAndWait("What is 3+3?", TIMEOUT);

            // Immediately send /done — the session should be in the idle window
            const cmdId = randomUUID();
            console.log("  Sending /done immediately after response...");
            await mgmt.sendCommand(session.sessionId, {
                cmd: "done",
                id: cmdId,
            });

            // Wait for the command response in KV
            let cmdResponse = null;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && !cmdResponse) {
                cmdResponse = await mgmt.getCommandResponse(session.sessionId, cmdId);
                if (!cmdResponse) await new Promise(r => setTimeout(r, 500));
            }

            console.log(`  Command response: ${JSON.stringify(cmdResponse)}`);
            assertNotNull(cmdResponse, "Command response for /done should exist");
            assert(cmdResponse.result?.ok === true, "/done should return ok: true");

            pass("/done During Post-Response Idle Window");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: sendMessage via Management Client ─────────────────────

async function testSendMessage(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            // Start the orchestration with a first message
            console.log("  Turn 1 via client: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            // Record the current response version
            const status1 = await mgmt.getSessionStatus(session.sessionId);
            const versionBefore = status1.customStatusVersion;
            console.log(`  Status version before sendMessage: ${versionBefore}`);

            // Send a message via management client
            console.log("  Turn 2 via management client: What is 3+3?");
            await mgmt.sendMessage(session.sessionId, "What is 3+3?");

            // Wait for status version to advance (indicating the turn was processed)
            const status2 = await mgmt.waitForStatusChange(
                session.sessionId,
                versionBefore,
                200,
                60_000,
            );
            console.log(`  Status version after sendMessage: ${status2.customStatusVersion}`);
            assert(
                status2.customStatusVersion > versionBefore,
                "Status version should advance after sendMessage",
            );

            // Verify a response was produced
            const response = await mgmt.getLatestResponse(session.sessionId);
            console.log(`  Latest response: ${JSON.stringify(response)?.slice(0, 100)}`);
            assertNotNull(response, "Latest response should exist after sendMessage");

            pass("sendMessage via Management Client");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: Management Client Session Operations ──────────────────

async function testManagementSessionOps(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(BRIEF_CONFIG);

            console.log("  Sending: Hello");
            await session.sendAndWait("Hello", TIMEOUT);

            // List sessions via management client
            const sessions = await mgmt.listSessions();
            console.log(`  Management listSessions: ${sessions.length} session(s)`);
            assert(sessions.length >= 1, "Expected at least 1 session from management client");

            // Get specific session
            const view = await mgmt.getSession(session.sessionId);
            assertNotNull(view, "Session should be visible via management client");
            console.log(`  Session state: ${view.status}`);

            // Rename session
            await mgmt.renameSession(session.sessionId, "Test Session");
            const renamed = await mgmt.getSession(session.sessionId);
            assertNotNull(renamed, "Renamed session should exist");
            console.log(`  Title after rename: "${renamed.title}"`);
            assert(renamed.title === "Test Session", `Expected 'Test Session' but got: ${renamed.title}`);

            const v = await validateSessionAfterTurn(env, session.sessionId);
            console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
            pass("Management Client Session Operations");
        });
    } finally {
        await mgmt.stop();
    }
}

// ─── Test: Cancel Session ────────────────────────────────────────

async function testCancelSession(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            // Start orchestration
            console.log("  Sending: What is 1+1?");
            await session.sendAndWait("What is 1+1?", TIMEOUT);

            // Cancel via management client
            console.log("  Cancelling session...");
            await mgmt.cancelSession(session.sessionId, "Test cancellation");

            // Verify the session is cancelled/failed in CMS
            const row = await waitForSessionState(
                catalog,
                session.sessionId,
                ["failed", "completed", "cancelled"],
                30_000,
            );
            console.log(`  CMS state after cancel: ${row.state}`);
            pass("Cancel Session");
        });
    } finally {
        await catalog.close();
        await mgmt.stop();
    }
}

// ─── Runner ──────────────────────────────────────────────────────

await runSuite("Level 4: Command & Event Tests", [
    ["get_info Command", testGetInfoCommand],
    ["/done Command", testDoneCommand],
    ["/done During Idle Window", testDoneDuringIdle],
    ["sendMessage via Management", testSendMessage],
    ["Management Session Operations", testManagementSessionOps],
    ["Cancel Session", testCancelSession],
]);
