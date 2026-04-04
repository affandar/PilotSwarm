/**
 * Terminal child session lifecycle tests.
 *
 * Covers:
 *   - non-system child sessions settle to completed
 *   - management rejects new messages to completed terminal children
 *
 * Run: npx vitest run test/local/terminal-child-status.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assertEqual, assertNotNull, assertThrows } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testCompletedTerminalChildRejectsFurtherMessages(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const parent = await client.createSession(ONEWORD_CONFIG);
            const child = await client.createSession({
                ...ONEWORD_CONFIG,
                parentSessionId: parent.sessionId,
            });

            console.log(`  Parent: ${parent.sessionId.slice(0, 8)}`);
            console.log(`  Child: ${child.sessionId.slice(0, 8)}`);

            await child.sendAndWait("Say hello", TIMEOUT);

            const view = await mgmt.getSession(child.sessionId);
            assertNotNull(view, "management view should exist for child");
            console.log(`  Child management status: ${view.status}`);
            assertEqual(view.status, "completed", "terminal child should report completed");

            const row = await waitForSessionState(catalog, child.sessionId, ["completed"], 30_000);
            console.log(`  Child CMS state: ${row.state}`);
            assertEqual(row.state, "completed", "CMS should self-heal to completed");

            await assertThrows(
                () => mgmt.sendMessage(child.sessionId, "hello again"),
                /completed terminal orchestration/i,
                "management should reject sends to terminal child",
            );
        });
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

describe("Terminal Child Sessions", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("mark completed and reject new messages", { timeout: TIMEOUT * 2 }, async () => {
        await testCompletedTerminalChildRejectsFurtherMessages(getEnv());
    });
});
