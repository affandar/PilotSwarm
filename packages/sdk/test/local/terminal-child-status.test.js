/**
 * Terminal child session lifecycle tests.
 *
 * Covers:
 *   - non-system child sessions reach the `completed` terminal state when the
 *     parent (or operator) explicitly closes them with a `/done` command
 *   - management rejects new messages to completed terminal children
 *
 * v1.0.49 note: non-system children no longer auto-terminate when their LLM
 * turn produces a final assistant message. The parent (or an operator via
 * `mgmt.sendCommand({ cmd: "done" })`) is now responsible for closing the
 * child. This test drives that path explicitly.
 *
 * Run: npx vitest run test/local/terminal-child-status.test.js
 */

import { randomUUID } from "node:crypto";
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

            // v1.0.49: the child does NOT auto-complete after its turn. It
            // stays alive idle until the parent (or an operator) closes it.
            const idleView = await mgmt.getSession(child.sessionId);
            assertNotNull(idleView, "management view should exist for child");
            console.log(`  Child status after task (pre-/done): ${idleView.status}`);
            if (idleView.status === "completed") {
                throw new Error(
                    "Sub-agent regressed to v<=1.0.48 auto-terminate behavior: " +
                    "child reported 'completed' before the parent issued a /done command.",
                );
            }

            // Operator-driven close: send the /done command to the child's
            // orchestration. This is the same path complete_agent uses.
            console.log("  Sending /done command to child via management...");
            await mgmt.sendCommand(child.sessionId, {
                cmd: "done",
                id: `test-done-${randomUUID()}`,
            });

            const row = await waitForSessionState(catalog, child.sessionId, ["completed"], 30_000);
            console.log(`  Child CMS state after /done: ${row.state}`);
            assertEqual(row.state, "completed", "CMS should reflect the /done shutdown");

            const view = await mgmt.getSession(child.sessionId);
            assertNotNull(view, "management view should exist for completed child");
            console.log(`  Child management status after /done: ${view.status}`);
            assertEqual(view.status, "completed", "terminal child should report completed");

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

