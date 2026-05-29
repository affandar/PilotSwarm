/**
 * Management client top event emitter diagnostics tests.
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertGreaterOrEqual, assertThrows } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

function makeEvents(count, eventType) {
    return Array.from({ length: count }, (_, i) => ({
        eventType,
        data: { index: i, eventType },
    }));
}

describe("Management top event emitters", () => {
    it("returns bounded top event emitter diagnostics", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        let mgmt = null;

        try {
            await catalog.initialize();

            const hotSession = `emit-hot-${Date.now()}`;
            await catalog.createSession(hotSession);
            await catalog.recordEvents(hotSession, makeEvents(12, "tool.hot"), "worker-hot");

            const noisySession = `emit-noisy-${Date.now()}`;
            await catalog.createSession(noisySession);
            for (let i = 0; i < 110; i += 1) {
                await catalog.recordEvents(
                    noisySession,
                    [{ eventType: `noise.${i}`, data: { index: i } }],
                    `worker-${String(i).padStart(3, "0")}`,
                );
            }

            mgmt = await createManagementClient(env);

            const rows = await mgmt.getTopEventEmitters({
                since: new Date(Date.now() - 60_000),
                limit: 1_000,
            });

            assert(rows.length > 0, "Expected top emitter rows");
            assert(rows.length <= 100, "Management top emitter limit should clamp to 100");
            assertEqual(rows[0].workerNodeId, "worker-hot", "Expected busiest worker first");
            assertEqual(rows[0].eventType, "tool.hot", "Expected busiest event type first");
            assertGreaterOrEqual(rows[0].eventCount, 12, "Expected aggregated hot event count");
            assertGreaterOrEqual(rows[0].sessionCount, 1, "Expected aggregated session count");

            await assertThrows(
                () => mgmt.getTopEventEmitters({ since: new Date("invalid-date") }),
                /since must be a valid Date/,
                "Invalid since should be rejected",
            );
        } finally {
            if (mgmt) await mgmt.stop();
            await catalog.close();
        }
    }, TIMEOUT);
});
