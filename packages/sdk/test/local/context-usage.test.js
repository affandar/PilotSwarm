/**
 * Context usage integration tests.
 *
 * Covers:
 * - context usage becomes available through orchestration custom status
 * - session.getInfo() exposes the same snapshot
 * - management getSession() exposes the same snapshot
 * - CMS persists usage events that the TUI can consume
 */

import { beforeAll, describe, it } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { assert, assertEqual, assertGreaterOrEqual, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const CONTEXT_TEST_CONFIG = {
    systemMessage: { mode: "replace", content: "Be brief and answer in one sentence." },
};

async function waitForContextUsage(readSnapshot, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastValue = null;
    while (Date.now() < deadline) {
        lastValue = await readSnapshot();
        if (lastValue
            && typeof lastValue.tokenLimit === "number" && lastValue.tokenLimit > 0
            && typeof lastValue.currentTokens === "number" && lastValue.currentTokens > 0
            && typeof lastValue.messagesLength === "number" && lastValue.messagesLength > 0
            && typeof lastValue.utilization === "number" && lastValue.utilization > 0) {
            return lastValue;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for context usage. Last value: ${JSON.stringify(lastValue)}`);
}

async function testContextUsageExposure(env) {
    const mgmt = await createManagementClient(env);
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(CONTEXT_TEST_CONFIG);

            await session.sendAndWait("Say hello in one short sentence.", TIMEOUT);

            await waitForEventCount(catalog, session.sessionId, "session.usage_info", 1, 30_000);

            const statusSnapshot = await waitForContextUsage(async () => {
                const status = await mgmt.getSessionStatus(session.sessionId);
                return status.customStatus?.contextUsage ?? null;
            });

            assertGreaterOrEqual(statusSnapshot.tokenLimit, 1, "context usage should include tokenLimit");
            assertGreaterOrEqual(statusSnapshot.currentTokens, 1, "context usage should include currentTokens");
            assertGreaterOrEqual(statusSnapshot.messagesLength, 1, "context usage should include messagesLength");
            assert(statusSnapshot.utilization > 0 && statusSnapshot.utilization <= 1, "utilization should be a ratio between 0 and 1");

            const info = await session.getInfo();
            assertNotNull(info.contextUsage, "session.getInfo should expose context usage");
            assertEqual(info.contextUsage.tokenLimit, statusSnapshot.tokenLimit, "session.getInfo tokenLimit");
            assertEqual(info.contextUsage.currentTokens, statusSnapshot.currentTokens, "session.getInfo currentTokens");
            assertEqual(info.contextUsage.messagesLength, statusSnapshot.messagesLength, "session.getInfo messagesLength");

            const mgmtView = await mgmt.getSession(session.sessionId);
            assertNotNull(mgmtView, "management getSession should return the session");
            assertNotNull(mgmtView.contextUsage, "management getSession should expose context usage");
            assertEqual(mgmtView.contextUsage.tokenLimit, statusSnapshot.tokenLimit, "management getSession tokenLimit");
            assertEqual(mgmtView.contextUsage.currentTokens, statusSnapshot.currentTokens, "management getSession currentTokens");
            assertEqual(mgmtView.contextUsage.messagesLength, statusSnapshot.messagesLength, "management getSession messagesLength");
        });
    } finally {
        await catalog.close();
        await mgmt.stop();
    }
}

describe("Level 4c: Context Usage", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("surfaces context usage through status, session info, and management views", { timeout: TIMEOUT }, async () => {
        await testContextUsageExposure(getEnv());
    });
});
