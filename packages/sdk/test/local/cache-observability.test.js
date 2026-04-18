/**
 * Cache Observability — fleet cache columns and derived hit ratio.
 *
 * Verifies migration 0006 plus the computeCacheHitRatio helper:
 *   - getSessionMetricSummary exposes cacheHitRatio (derived, null-safe)
 *   - getSessionTreeStats rolls up cache tokens AND a derived ratio
 *   - getFleetStats now sums totalTokensCacheRead/Write at totals AND byAgent
 *     levels, with a derived cacheHitRatio per bucket and overall.
 *
 * Direct CMS-level tests, no LLM. We seed metric summaries with the
 * upsert proc and read them back.
 *
 * Run: npx vitest run test/local/cache-observability.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { computeCacheHitRatio } from "../../src/index.ts";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import {
    assert,
    assertEqual,
    assertNotNull,
} from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => {
    await preflightChecks();
});

async function seedSession(catalog, sessionId, opts) {
    await catalog.createSession(sessionId, opts);
    await catalog.updateSession(sessionId, { state: "running" });
}

async function seedMetrics(catalog, sessionId, { input, output, cacheRead, cacheWrite }) {
    await catalog.upsertSessionMetricSummary(sessionId, {
        tokensInputIncrement: input,
        tokensOutputIncrement: output,
        tokensCacheReadIncrement: cacheRead,
        tokensCacheWriteIncrement: cacheWrite,
    });
}

describe("Cache Observability", () => {
    it("computeCacheHitRatio handles edge cases", () => {
        assertEqual(computeCacheHitRatio(0, 0), null, "zero input -> null");
        assertEqual(computeCacheHitRatio(null, 100), null, "missing input -> null");
        assertEqual(computeCacheHitRatio(1000, 0), 0, "no cache reads -> 0");
        assertEqual(computeCacheHitRatio(1000, 250), 0.25, "25% hit");
        assertEqual(computeCacheHitRatio(1000, 1000), 1, "full cache");
        assertEqual(computeCacheHitRatio(1000, 5000), 1, "clamped to 1 if read > input (defensive)");
        assertEqual(computeCacheHitRatio(1000, -50), 0, "negative read -> 0");
    });

    it("getSessionMetricSummary returns derived cacheHitRatio", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });
            await seedMetrics(catalog, sid, { input: 4000, output: 200, cacheRead: 3000, cacheWrite: 100 });

            const summary = await catalog.getSessionMetricSummary(sid);
            assertNotNull(summary, "summary present");
            assertEqual(summary.tokensInput, 4000);
            assertEqual(summary.tokensCacheRead, 3000);
            assertEqual(summary.tokensCacheWrite, 100);
            assertEqual(summary.cacheHitRatio, 0.75, "3000/4000 = 0.75");
            console.log("  per-session ratio:", summary.cacheHitRatio);
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("getSessionTreeStats rolls up cache tokens + derived ratio", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const parent = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const child = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, parent, { agentId: "coordinator", model: "gpt-5" });
            await seedSession(catalog, child, { agentId: "alpha", parentSessionId: parent, model: "gpt-5-mini" });

            await seedMetrics(catalog, parent, { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50 });
            await seedMetrics(catalog, child,  { input: 3000, output: 300, cacheRead: 2500, cacheWrite: 0 });

            const tree = await catalog.getSessionTreeStats(parent);
            assertNotNull(tree, "tree present");
            assertEqual(tree.tree.sessionCount, 2);
            assertEqual(tree.tree.totalTokensInput, 4000);
            assertEqual(tree.tree.totalTokensCacheRead, 3000);
            assertEqual(tree.tree.totalTokensCacheWrite, 50);
            assertEqual(tree.tree.cacheHitRatio, 0.75, "3000/4000 across the tree");
            console.log("  tree ratio:", tree.tree.cacheHitRatio);

            // Tree by-model breakdown — sorted by total input tokens DESC.
            assertEqual(tree.byModel.length, 2, "two models in the tree");
            const m0 = tree.byModel[0];
            assertEqual(m0.model, "gpt-5-mini", "child has 3000 input → ranks first");
            assertEqual(m0.sessionCount, 1);
            assertEqual(m0.totalTokensInput, 3000);
            assertEqual(m0.totalTokensCacheRead, 2500);
            assertEqual(m0.cacheHitRatio, 2500 / 3000);
            const m1 = tree.byModel[1];
            assertEqual(m1.model, "gpt-5");
            assertEqual(m1.totalTokensInput, 1000);
            assertEqual(m1.cacheHitRatio, 0.5);
            console.log("  byModel:", tree.byModel.map(m => `${m.model}=${m.totalTokensInput}`).join(", "));
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("getFleetStats sums cache tokens and derives ratio at totals + byAgent", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const a1 = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const a2 = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const b  = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, a1, { agentId: "alpha", model: "gpt-4o" });
            await seedSession(catalog, a2, { agentId: "alpha", model: "gpt-4o" });
            await seedSession(catalog, b,  { agentId: "beta",  model: "claude" });

            await seedMetrics(catalog, a1, { input: 2000, output: 100, cacheRead: 1500, cacheWrite: 0 });
            await seedMetrics(catalog, a2, { input: 1000, output: 100, cacheRead: 500,  cacheWrite: 0 });
            await seedMetrics(catalog, b,  { input: 5000, output: 500, cacheRead: 0,    cacheWrite: 200 });

            const fleet = await catalog.getFleetStats();
            assertEqual(fleet.totals.totalTokensCacheRead, 2000, "total cache read = 1500+500+0");
            assertEqual(fleet.totals.totalTokensCacheWrite, 200);
            // 2000 / (2000+1000+5000) = 2000/8000 = 0.25
            assertEqual(fleet.totals.cacheHitRatio, 0.25);

            const alphaBucket = fleet.byAgent.find(g => g.agentId === "alpha");
            assertNotNull(alphaBucket, "alpha bucket present");
            assertEqual(alphaBucket.totalTokensCacheRead, 2000);
            // 2000 / 3000 ≈ 0.6667
            assert(Math.abs(alphaBucket.cacheHitRatio - (2000 / 3000)) < 1e-9, "alpha hit ratio");

            const betaBucket = fleet.byAgent.find(g => g.agentId === "beta");
            assertEqual(betaBucket.totalTokensCacheRead, 0);
            assertEqual(betaBucket.cacheHitRatio, 0, "beta zero reads -> 0");

            console.log("  fleet totals ratio:", fleet.totals.cacheHitRatio);
            console.log("  alpha bucket ratio:", alphaBucket.cacheHitRatio.toFixed(4));
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
