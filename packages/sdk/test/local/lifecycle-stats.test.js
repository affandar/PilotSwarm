/**
 * Persistence counters under the session lifecycle protocol.
 *
 * The Stats pane reads the CMS metric summary (snapshotSizeBytes,
 * dehydrationCount, hydrationCount, lastHydratedAt) and session.hydrated /
 * session.dehydrated events. Those used to be fed exclusively by the
 * legacy dehydrate/hydrate activities, which the protocol never schedules
 * — so commits must report the snapshot size and preamble hydrations must
 * count as hydrations, while dehydrations honestly stay 0.
 *
 * Uses the kill-harness worker geometry (separate per-worker disks, one
 * shared snapshot store) WITHOUT any faults: worker A serves two warm
 * turns, then a clean worker B takes over cold — one real hydration.
 */
import { describe, it, beforeAll, afterEach } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient } from "../helpers/local-workers.js";
import { forkKillWorker } from "../helpers/kill-harness.js";
import { createCatalog, getEvents } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 420_000;
const REPLY_TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => { await preflightChecks(); });

const liveWorkers = [];
afterEach(async () => {
    for (const w of liveWorkers.splice(0)) {
        try { await w.stop(); } catch {}
    }
});

describe("lifecycle persistence counters", () => {
    it("commits feed snapshot size; cold takeover counts exactly one hydration; dehydrations stay 0", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const workerA = forkKillWorker(env, "stats-a");
        liveWorkers.push(workerA);
        await workerA.ready;

        const client = new PilotSwarmClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
        });
        await client.start();
        try {
            const session = await client.createSession(ONEWORD_CONFIG);
            const sessionId = session.sessionId;

            // Two warm turns on A: commits happen, hydrations don't.
            await session.sendAndWait("What is 2+2? Answer with just the number.", REPLY_TIMEOUT);
            await session.sendAndWait("What is 3+3? Answer with just the number.", REPLY_TIMEOUT);

            const warm = await catalog.getSessionMetricSummary(sessionId);
            assert(warm, "metric summary exists after warm turns");
            assert(warm.snapshotSizeBytes > 0, `commit must report snapshot size (got ${warm.snapshotSizeBytes})`);
            // Brotli codec: the uncompressed size must be recorded and larger
            // than the stored size (a real session tar always compresses).
            assert(warm.rawSizeBytes > warm.snapshotSizeBytes, `raw size ${warm.rawSizeBytes} must exceed stored ${warm.snapshotSizeBytes}`);
            assertEqual(warm.hydrationCount, 0, "warm turns must not count hydrations");
            assertEqual(warm.dehydrationCount, 0, "the protocol never dehydrates");
            const warmSize = warm.snapshotSizeBytes;

            // Cold takeover: stop A entirely, bring up clean B — the next
            // turn hydrates from the shared store exactly once.
            await workerA.stop();
            const workerB = forkKillWorker(env, "stats-b");
            liveWorkers.push(workerB);
            await workerB.ready;

            await session.sendAndWait("What is 5+5? Answer with just the number.", REPLY_TIMEOUT);

            const cold = await catalog.getSessionMetricSummary(sessionId);
            assertEqual(cold.hydrationCount, 1, "cold takeover counts exactly one hydration");
            assert(cold.lastHydratedAt != null, "lastHydratedAt must be set by the hydration");
            assertEqual(cold.dehydrationCount, 0, "still no dehydrations");
            assert(cold.snapshotSizeBytes >= warmSize, "snapshot size keeps tracking the latest commit");

            // The event stream carries the protocol-native hydration record.
            const events = await getEvents(catalog, sessionId);
            const hydratedEvents = events.filter((e) => e.eventType === "session.hydrated");
            assertEqual(hydratedEvents.length, 1, "exactly one session.hydrated event");
            assertEqual(hydratedEvents[0].data?.protocol, "lifecycle", "hydration event is protocol-native");
            assert(
                events.every((e) => e.eventType !== "session.dehydrated"),
                "no session.dehydrated events under the protocol",
            );

            // One more warm turn on B: hydration count must NOT move.
            await session.sendAndWait("What is 7+7? Answer with just the number.", REPLY_TIMEOUT);
            const after = await catalog.getSessionMetricSummary(sessionId);
            assertEqual(after.hydrationCount, 1, "warm turns after takeover don't count hydrations");
        } finally {
            await client.stop();
            try { await catalog.close?.(); } catch {}
        }
    });
});
