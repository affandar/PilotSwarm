/**
 * Failed session lifecycle tests.
 *
 * Covers:
 *   - a real failed orchestration path (missing resumable state) settles to failed
 *   - failed sessions reject future messages via both the client and management APIs
 *   - stale CMS error rows self-heal when the orchestration is still running
 *
 * Run: npx vitest run test/local/session-failures.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient, PilotSwarmWorker, createManagementClient, withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertNotNull, assertThrows } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { MEMORY_CONFIG, ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function createFailedSessionViaMissingState(env) {
    const commonOpts = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    const workerA = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "failed-state-a",
        disableManagementAgents: true,
    });
    await workerA.start();

    const clientA = new PilotSwarmClient(commonOpts);
    await clientA.start();

    let sessionId;
    try {
        const session = await clientA.createSession(MEMORY_CONFIG);
        sessionId = session.sessionId;
        await session.sendAndWait("Remember this exact code: FAILED77", TIMEOUT);
    } finally {
        await clientA.stop();
        await workerA.gracefulShutdown();
    }

    const archiveDir = join(dirname(env.sessionStateDir), "session-store");
    rmSync(join(archiveDir, `${sessionId}.tar.gz`), { force: true });
    rmSync(join(archiveDir, `${sessionId}.meta.json`), { force: true });
    rmSync(join(env.sessionStateDir, sessionId), { recursive: true, force: true });

    const workerB = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "failed-state-b",
        disableManagementAgents: true,
    });
    await workerB.start();

    const clientB = new PilotSwarmClient(commonOpts);
    await clientB.start();

    const resumed = await clientB.resumeSession(sessionId);
    await assertThrows(
        () => resumed.sendAndWait("What code did I ask you to remember?", 30_000),
        /expected resumable Copilot session state/i,
        "missing resumable state should hard-fail the orchestration",
    );

    return {
        sessionId,
        client: clientB,
        worker: workerB,
        async cleanup() {
            await clientB.stop();
            await workerB.stop();
        },
    };
}

async function testMissingStateFailureSurfacesAsFailed(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);
    const failed = await createFailedSessionViaMissingState(env);

    try {
        const row = await waitForSessionState(catalog, failed.sessionId, ["failed"], 30_000);
        assertEqual(row.state, "failed", "CMS should settle to failed");
        assert(row.lastError, "failed session should record lastError");
        assertIncludes(
            row.lastError,
            "expected resumable Copilot session state",
            "CMS lastError should explain the hard failure",
        );

        const view = await mgmt.getSession(failed.sessionId);
        assertNotNull(view, "management view should exist for failed session");
        assertEqual(view.status, "failed", "management should expose failed status");
        assertIncludes(
            view.error || "",
            "expected resumable Copilot session state",
            "management should expose the failure reason",
        );

        const status = await mgmt.getSessionStatus(failed.sessionId);
        assertEqual(status.orchestrationStatus, "Failed", "orchestration should be terminal failed");
    } finally {
        await failed.cleanup();
        await mgmt.stop();
        await catalog.close();
    }
}

async function testFailedSessionsRejectFurtherMessages(env) {
    const mgmt = await createManagementClient(env);
    const failed = await createFailedSessionViaMissingState(env);

    try {
        const resumedAgain = await failed.client.resumeSession(failed.sessionId);

        await assertThrows(
            () => resumedAgain.sendAndWait("hello again", 30_000),
            /failed terminal orchestration/i,
            "client should reject sends to failed terminal sessions",
        );

        await assertThrows(
            () => mgmt.sendMessage(failed.sessionId, "hello again"),
            /failed terminal orchestration/i,
            "management should reject sends to failed terminal sessions",
        );
    } finally {
        await failed.cleanup();
        await mgmt.stop();
    }
}

async function testStaleCmsErrorSelfHealsWhileRunning(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);
            await session.sendAndWait("What is 2+2?", TIMEOUT);

            await catalog.updateSession(session.sessionId, {
                state: "error",
                lastError: "stale transport error",
            });

            const poisoned = await catalog.getSession(session.sessionId);
            assertEqual(poisoned?.state, "error", "test should start from a stale CMS error row");

            const view = await mgmt.getSession(session.sessionId);
            assertNotNull(view, "management view should exist");
            assertEqual(view.status, "idle", "live orchestration should override stale CMS error");
            assert(view.error == null, "stale error should not be treated as a live failure");

            const healed = await waitForSessionState(catalog, session.sessionId, ["idle"], 10_000);
            assertEqual(healed.state, "idle", "CMS row should self-heal back to idle");
            assertEqual(healed.lastError, null, "self-heal should clear the stale error");
        });
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

async function testLiveSessionLossRecoversFromWarmState(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client, worker) => {
            const session = await client.createSession(MEMORY_CONFIG);
            await session.sendAndWait("Remember this exact code: RECOVER91", TIMEOUT);

            const managed = worker.sessionManager.get(session.sessionId);
            assertNotNull(managed, "expected warm managed session before injecting loss");

            const copilotSession = managed.getCopilotSession();
            const originalSend = copilotSession.send.bind(copilotSession);
            let injected = false;

            copilotSession.send = async (payload) => {
                const promptText = String(payload?.displayPrompt ?? payload?.prompt ?? "");
                if (!injected && /What code did I ask you to remember\?/i.test(promptText)) {
                    injected = true;
                    throw new Error(`Request session.send failed with message: Session not found: ${session.sessionId}`);
                }
                return await originalSend(payload);
            };

            const response = await session.sendAndWait("What code did I ask you to remember?", TIMEOUT);
            assert(injected, "test should inject a live-session loss exactly once");
            assertIncludes(response, "RECOVER91", "recovered session should still preserve durable memory");

            const row = await waitForSessionState(catalog, session.sessionId, ["idle"], 15_000);
            assertEqual(row.state, "idle", "recovered session should return to idle");

            const events = await catalog.getSessionEvents(session.sessionId);
            const recoveryNotice = events.find((event) =>
                event.eventType === "system.message"
                && String(event.data?.content || "").includes("worker lost the live Copilot session"),
            );
            assertNotNull(recoveryNotice, "recovery should record a system notice about possible state loss");
        });
    } finally {
        await catalog.close();
    }
}

describe("Failed Session Handling", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("marks missing resumable-state sessions failed and surfaces the error", { timeout: TIMEOUT * 2 }, async () => {
        await testMissingStateFailureSurfacesAsFailed(getEnv());
    });

    it("rejects future messages to failed terminal sessions", { timeout: TIMEOUT * 2 }, async () => {
        await testFailedSessionsRejectFurtherMessages(getEnv());
    });

    it("self-heals stale CMS errors when the orchestration is still running", { timeout: TIMEOUT }, async () => {
        await testStaleCmsErrorSelfHealsWhileRunning(getEnv());
    });

    it("recovers when a warm live Copilot session is lost mid-turn", { timeout: TIMEOUT }, async () => {
        await testLiveSessionLossRecoversFromWarmState(getEnv());
    });
});
