/**
 * Level 4b: Management client operation tests.
 *
 * Covers: sendMessage via management, management session operations, cancel session.
 *
 * Run: npx vitest run test/local/management.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assert, assertNotNull } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, BRIEF_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testSendMessage(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Turn 1 via client: What is 2+2?");
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            const status1 = await mgmt.getSessionStatus(session.sessionId);
            const versionBefore = status1.customStatusVersion;
            console.log(`  Status version before sendMessage: ${versionBefore}`);

            console.log("  Turn 2 via management client: What is 3+3?");
            await mgmt.sendMessage(session.sessionId, "What is 3+3?");

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

            const response = await mgmt.getLatestResponse(session.sessionId);
            console.log(`  Latest response: ${JSON.stringify(response)?.slice(0, 100)}`);
            assertNotNull(response, "Latest response should exist after sendMessage");
        });
    } finally {
        await mgmt.stop();
    }
}

async function testManagementSessionOps(env) {
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(BRIEF_CONFIG);

            console.log("  Sending: Hello");
            await session.sendAndWait("Hello", TIMEOUT);

            const sessions = await mgmt.listSessions();
            console.log(`  Management listSessions: ${sessions.length} session(s)`);
            assert(sessions.length >= 1, "Expected at least 1 session from management client");

            const view = await mgmt.getSession(session.sessionId);
            assertNotNull(view, "Session should be visible via management client");
            console.log(`  Session state: ${view.status}`);

            await mgmt.renameSession(session.sessionId, "Test Session");
            const renamed = await mgmt.getSession(session.sessionId);
            assertNotNull(renamed, "Renamed session should exist");
            console.log(`  Title after rename: "${renamed.title}"`);
            assert(renamed.title === "Test Session", `Expected 'Test Session' but got: ${renamed.title}`);

            const v = await validateSessionAfterTurn(env, session.sessionId);
            console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}`);
        });
    } finally {
        await mgmt.stop();
    }
}

async function testCancelSession(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            console.log("  Sending: What is 1+1?");
            await session.sendAndWait("What is 1+1?", TIMEOUT);

            console.log("  Cancelling session...");
            await mgmt.cancelSession(session.sessionId, "Test cancellation");

            const row = await waitForSessionState(
                catalog,
                session.sessionId,
                ["failed", "completed", "cancelled"],
                30_000,
            );
            console.log(`  CMS state after cancel: ${row.state}`);
        });
    } finally {
        await catalog.close();
        await mgmt.stop();
    }
}

describe("Level 4b: Management", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("sendMessage via Management", { timeout: TIMEOUT }, async () => {
        await testSendMessage(getEnv());
    });
    it("Management Session Operations", { timeout: TIMEOUT }, async () => {
        await testManagementSessionOps(getEnv());
    });
    it("Cancel Session", { timeout: TIMEOUT }, async () => {
        await testCancelSession(getEnv());
    });
});
