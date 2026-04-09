/**
 * Session lifecycle tests around stale or missing runtime state.
 *
 * Covers:
 *   - missing resumable state falls back to lossy replay instead of hard-failing
 *   - recovered sessions remain usable after lossy replay
 *   - stale CMS error rows self-heal when the orchestration is still running
 *
 * Run: npx vitest run test/local/session-failures.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient, PilotSwarmWorker, createManagementClient, withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertNotNull } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { MEMORY_CONFIG, ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function createSessionWithDeletedResumableState(env) {
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

async function testMissingStateRecoversViaLossyReplay(env) {
    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);
    const recovered = await createSessionWithDeletedResumableState(env);

    try {
        const resumed = await recovered.client.resumeSession(recovered.sessionId);
        const response = await resumed.sendAndWait(
            "State may have been lost. Explain briefly how you will proceed carefully.",
            60_000,
        );
        assert(response && response.length > 0, "lossy replay should still return a response");

        const row = await waitForSessionState(catalog, recovered.sessionId, ["idle"], 30_000);
        assertEqual(row.state, "idle", "CMS should recover back to idle");
        assertEqual(row.lastError, null, "lossy replay should not leave a terminal lastError");

        const view = await mgmt.getSession(recovered.sessionId);
        assertNotNull(view, "management view should exist for recovered session");
        assertEqual(view.status, "idle", "management should expose the recovered session as idle");

        const status = await mgmt.getSessionStatus(recovered.sessionId);
        assertEqual(status.orchestrationStatus, "Running", "recovered session orchestration should remain live");

        const events = await catalog.getSessionEvents(recovered.sessionId);
        const lossyEvent = events.find((event) => event.eventType === "session.lossy_handoff");
        assertNotNull(lossyEvent, "recovery should record a lossy handoff warning");
        assertEqual(lossyEvent.data?.cause, "missing_resumable_state_before_run_turn", "lossy warning should explain the recovery cause");
        const replayNotice = events.find((event) =>
            event.eventType === "system.message"
            && String(event.data?.content || "").includes("replaying this turn after a worker restart lost the live Copilot session state"),
        );
        assertNotNull(replayNotice, "recovery should record a visible replay notice");
    } finally {
        await recovered.cleanup();
        await mgmt.stop();
        await catalog.close();
    }
}

async function testRecoveredSessionsAcceptFutureMessages(env) {
    const mgmt = await createManagementClient(env);
    const recovered = await createSessionWithDeletedResumableState(env);

    try {
        const resumed = await recovered.client.resumeSession(recovered.sessionId);
        const first = await resumed.sendAndWait(
            "You may have lost some state. In one short sentence, say you will continue carefully.",
            60_000,
        );
        assert(first && first.length > 0, "recovery turn should succeed");

        const second = await resumed.sendAndWait("Say OK if you can still continue.", 30_000);
        assert(second && second.length > 0, "client should still accept follow-up messages after recovery");

        await mgmt.sendMessage(recovered.sessionId, "Reply with a short acknowledgement.");
    } finally {
        await recovered.cleanup();
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

    it("recovers missing resumable-state sessions via lossy replay", { timeout: TIMEOUT * 2 }, async () => {
        await testMissingStateRecoversViaLossyReplay(getEnv());
    });

    it("keeps recovered sessions usable for future messages", { timeout: TIMEOUT * 2 }, async () => {
        await testRecoveredSessionsAcceptFutureMessages(getEnv());
    });

    it("self-heals stale CMS errors when the orchestration is still running", { timeout: TIMEOUT }, async () => {
        await testStaleCmsErrorSelfHealsWhileRunning(getEnv());
    });

    it("recovers when a warm live Copilot session is lost mid-turn", { timeout: TIMEOUT }, async () => {
        await testLiveSessionLossRecoversFromWarmState(getEnv());
    });
});
