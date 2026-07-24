/**
 * Footprint integration tests — CMS procs + management surface, no LLM.
 *
 * Covers (docs/proposals/session-regen-and-footprint.md §15.4):
 * - cms_get_session_event_stats: count/bytes/max-seq, afterSeq scoping
 * - cms_get_session_compaction_stats: starts/completes/failed/tokensRemoved,
 *   malformed payloads skipped (never an error)
 * - mgmt.getSessionFootprint: assembled axes + assessment over real rows,
 *   TTL cache behavior (second call serves the cached value; bypass recomputes)
 */

import { randomUUID } from "node:crypto";
import { beforeAll, describe, it } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual, assertGreaterOrEqual, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const usage = (currentTokens, tokenLimit = 200_000) => ({
    eventType: "session.usage_info",
    data: { tokenLimit, currentTokens, messagesLength: 10 },
});

describe("session footprint", () => {
    beforeAll(async () => {
        await preflightChecks();
    }, TIMEOUT);

    // The suite env resets schemas after EVERY test — clients must be
    // per-test, never cached across tests.
    async function setup(withMgmt = false) {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const mgmt = withMgmt ? await createManagementClient(env) : null;
        return { catalog, mgmt };
    }

    it("event and compaction stats aggregate one session's rows only", { timeout: TIMEOUT }, async () => {
        const { catalog } = await setup();
        const sessionId = randomUUID();
        const otherId = randomUUID();
        await catalog.createSession(sessionId, {});
        await catalog.createSession(otherId, {});

        await catalog.recordEvents(sessionId, [
            { eventType: "user.message", data: { content: "start the watch" } },
            usage(40_000),
            { eventType: "session.compaction_start", data: {} },
            {
                eventType: "session.compaction_complete",
                data: { success: true, tokensRemoved: 12_000, preCompactionTokens: 150_000, postCompactionTokens: 90_000 },
            },
            { eventType: "session.compaction_start", data: {} },
            {
                eventType: "session.compaction_complete",
                data: { success: false, error: "timeout", tokensRemoved: "garbage" },
            },
            usage(170_000),
        ]);
        // Noise in another session must not leak into the aggregates.
        await catalog.recordEvents(otherId, [
            usage(10_000),
            { eventType: "session.compaction_complete", data: { success: true, tokensRemoved: 999_999 } },
        ]);

        const stats = await catalog.getSessionEventStats(sessionId);
        assertEqual(stats.eventCount, 7, "event count is session-scoped");
        assertGreaterOrEqual(stats.dataBytes, 1, "payload bytes accumulate");
        assertGreaterOrEqual(stats.maxSeq, 7, "max seq present");

        // afterSeq scoping: everything after the first event's seq.
        const events = await catalog.getSessionEvents(sessionId, undefined, 10);
        const firstSeq = Number(events[0].seq);
        const scoped = await catalog.getSessionEventStats(sessionId, firstSeq);
        assertEqual(scoped.eventCount, 6, "afterSeq excludes the boundary event");

        const compaction = await catalog.getSessionCompactionStats(sessionId);
        assertEqual(compaction.starts, 2);
        assertEqual(compaction.completes, 2);
        assertEqual(compaction.failed, 1);
        // The malformed "garbage" tokensRemoved is skipped, not an error.
        assertEqual(compaction.tokensRemoved, 12_000);
    });

    it("management footprint assembles axes and assesses degradation", { timeout: TIMEOUT }, async () => {
        const { catalog, mgmt } = await setup(true);
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, {});
        await catalog.recordEvents(sessionId, [
            usage(150_000),
            { eventType: "session.compaction_start", data: {} },
            { eventType: "session.compaction_complete", data: { success: true, tokensRemoved: 30_000 } },
            { eventType: "session.compaction_start", data: {} },
            { eventType: "session.compaction_complete", data: { success: true, tokensRemoved: 40_000 } },
            { eventType: "session.compaction_start", data: {} },
            { eventType: "session.compaction_complete", data: { success: true, tokensRemoved: 50_000 } },
            usage(178_000),
        ]);

        const fp = await mgmt.getSessionFootprint(sessionId, { bypassCache: true });
        assertNotNull(fp, "footprint computed");
        assertEqual(fp.sessionId, sessionId);
        assertEqual(fp.transcriptEpoch, 0, "pre-regen sessions are epoch 0");
        assertEqual(fp.context.compactionCount, 3);
        assertEqual(fp.context.compactionGeneration, 2, "generation = completes - 1");
        assertEqual(fp.context.tokensRemovedCumulative, 120_000);
        assertEqual(fp.assessment.level, "degraded", "generation >= 2 degrades");
        assertEqual(fp.assessment.recommendation, "regenerate");
        assertEqual(fp.events.count, 8);
        assertEqual(fp.events.sinceEpochStart, fp.events.count, "epoch 0 spans the whole session");
        assert(fp.context.utilization > 0.8, "latest usage reading wins");

        // Cache contract: direct mode returns the cached OBJECT; bypass recomputes.
        const cached = await mgmt.getSessionFootprint(sessionId);
        assert(cached === fp, "second call within TTL serves the cached object");
        const fresh = await mgmt.getSessionFootprint(sessionId, { bypassCache: true });
        assert(fresh !== fp, "bypass recomputes a new object");
    });

    it("healthy session reads ok end to end", { timeout: TIMEOUT }, async () => {
        const { catalog, mgmt } = await setup(true);
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, {});
        await catalog.recordEvents(sessionId, [
            { eventType: "user.message", data: { content: "hi" } },
            usage(30_000),
        ]);
        const fp = await mgmt.getSessionFootprint(sessionId, { bypassCache: true });
        assertEqual(fp.assessment.level, "ok");
        assertEqual(fp.assessment.recommendation, "none");
        assertEqual(fp.context.failedOrStuckCompactions, 0);
    });
});
