/**
 * Level 4a: User command tests.
 *
 * Covers: get_info command, /done command, /done during idle window.
 *
 * Run: npx vitest run test/local/commands.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assert, assertNotNull } from "../helpers/assertions.js";
import { validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { randomUUID } from "node:crypto";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testGetInfoCommand(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            const cmdId = randomUUID();
            console.log("  Sending get_info command...");
            await mgmt.sendCommand(session.sessionId, {
                cmd: "get_info",
                id: cmdId,
            });

            await new Promise(r => setTimeout(r, 3000));

            const status = await mgmt.getSessionStatus(session.sessionId);
            console.log(`  Status: ${JSON.stringify(status)}`);
            assertNotNull(status, "Status should be available");

            const v = await validateSessionAfterTurn(env, session.sessionId);
            console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
        });
    } finally {
        await mgmt.stop();
    }
}

async function testDoneCommand(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            const cmdId = randomUUID();
            console.log("  Sending /done command...");
            await mgmt.sendCommand(session.sessionId, {
                cmd: "done",
                id: cmdId,
            });

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

            const status = await mgmt.getSessionStatus(session.sessionId);
            console.log(`  Orchestration status: ${status.orchestrationStatus}`);
            assert(
                status.orchestrationStatus === "Completed" || status.customStatus?.status === "completed",
                `Expected completed status but got: ${status.orchestrationStatus}`,
            );
        });
    } finally {
        await mgmt.stop();
    }
}

async function testDoneDuringIdle(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 3+3?");
            await session.sendAndWait("What is 3+3?", TIMEOUT);

            const cmdId = randomUUID();
            console.log("  Sending /done immediately after response...");
            await mgmt.sendCommand(session.sessionId, {
                cmd: "done",
                id: cmdId,
            });

            let cmdResponse = null;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && !cmdResponse) {
                cmdResponse = await mgmt.getCommandResponse(session.sessionId, cmdId);
                if (!cmdResponse) await new Promise(r => setTimeout(r, 500));
            }

            console.log(`  Command response: ${JSON.stringify(cmdResponse)}`);
            assertNotNull(cmdResponse, "Command response for /done should exist");
            assert(cmdResponse.result?.ok === true, "/done should return ok: true");
        });
    } finally {
        await mgmt.stop();
    }
}

describe("Level 4a: Commands", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("get_info Command", { timeout: TIMEOUT }, async () => {
        await testGetInfoCommand(getEnv());
    });
    it("/done Command", { timeout: TIMEOUT }, async () => {
        await testDoneCommand(getEnv());
    });
    it("/done During Idle Window", { timeout: TIMEOUT }, async () => {
        await testDoneDuringIdle(getEnv());
    });
});
