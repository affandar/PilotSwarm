/**
 * DbMetricsReporter unit tests (no real DB required).
 *
 * Covers:
 *   - delta computation logic (first snapshot, subsequent deltas, clamp, empty)
 *   - processId / processRole field presence
 *   - resilience: upsert error is caught and forwarded, never thrown
 *   - lifecycle: start sets timer, stop clears it, start is idempotent
 *   - ManagementClient Phase 2 methods: catalog passthrough + null-catalog defaults
 *
 * Run: npx vitest run test/local/db-metrics-reporter.test.js
 */

import { describe, it, expect, vi } from "vitest";
import { DbMetricsReporter, makeProcessRole } from "../../src/db-metrics-reporter.ts";
import { PilotSwarmManagementClient } from "../../src/index.ts";

// ─── Test helpers ─────────────────────────────────────────────────

function emptySnap(overrides = {}) {
    return { counts: {}, errors: {}, totalMs: {}, avgMs: {}, capturedAt: "", ...overrides };
}

function makeMockCatalog() {
    const upsertCalls = [];
    const catalog = {
        async upsertDbCallMetricBucketBatch(rows) {
            upsertCalls.push([...rows]);
            return rows.length;
        },
    };
    return { catalog, upsertCalls };
}

function makeReporter(metricsOrSnapshots, catalogOverride, extraOpts = {}) {
    let callCount = 0;
    const metrics = Array.isArray(metricsOrSnapshots)
        ? { snapshot() { return metricsOrSnapshots[Math.min(callCount++, metricsOrSnapshots.length - 1)]; } }
        : metricsOrSnapshots;
    const { catalog, upsertCalls } = makeMockCatalog();
    const reporter = new DbMetricsReporter({
        catalog: catalogOverride ?? catalog,
        metrics,
        processId: "testhost:1:0",
        processRole: "worker",
        intervalMs: 60_000,
        ...extraOpts,
    });
    return { reporter, upsertCalls, catalog };
}

// ─── Delta logic ──────────────────────────────────────────────────

describe("DbMetricsReporter — delta logic", () => {
    it("first flush with no activity emits no rows", async () => {
        const { reporter, upsertCalls } = makeReporter([emptySnap(), emptySnap()]);
        reporter.start();
        await reporter.flushOnce();
        expect(upsertCalls).toHaveLength(0);
        reporter.stop();
    });

    it("emits one row per method with positive delta after activity", async () => {
        const snap1 = emptySnap();
        const snap2 = emptySnap({
            counts:  { "cms.getSession": 5 },
            errors:  { "cms.getSession": 1 },
            totalMs: { "cms.getSession": 200 },
        });
        const { reporter, upsertCalls } = makeReporter([snap1, snap2]);
        reporter.start();      // baseline = snap1
        await reporter.flushOnce(); // current = snap2, delta = snap2 - snap1
        expect(upsertCalls).toHaveLength(1);
        const rows = upsertCalls[0];
        expect(rows).toHaveLength(1);
        expect(rows[0].method).toBe("cms.getSession");
        expect(rows[0].calls).toBe(5);
        expect(rows[0].errors).toBe(1);
        expect(rows[0].totalMs).toBe(200);
        reporter.stop();
    });

    it("emits only incremental delta between successive flushes", async () => {
        const snap1 = emptySnap({ counts: { "cms.foo": 3 }, errors: {}, totalMs: { "cms.foo": 60 } });
        const snap2 = emptySnap({ counts: { "cms.foo": 8 }, errors: {}, totalMs: { "cms.foo": 160 } });
        const snap3 = emptySnap({ counts: { "cms.foo": 10 }, errors: {}, totalMs: { "cms.foo": 200 } });
        const { reporter, upsertCalls } = makeReporter([snap1, snap2, snap3]);
        reporter.start();
        await reporter.flushOnce(); // delta = snap2 - snap1 = { calls: 5, totalMs: 100 }
        await reporter.flushOnce(); // delta = snap3 - snap2 = { calls: 2, totalMs: 40 }
        expect(upsertCalls).toHaveLength(2);
        expect(upsertCalls[0][0].calls).toBe(5);
        expect(upsertCalls[0][0].totalMs).toBe(100);
        expect(upsertCalls[1][0].calls).toBe(2);
        expect(upsertCalls[1][0].totalMs).toBe(40);
        reporter.stop();
    });

    it("clamps negative deltas to 0 and skips zero rows (counter reset scenario)", async () => {
        const snap1 = emptySnap({ counts: { "cms.foo": 10 }, errors: {}, totalMs: { "cms.foo": 300 } });
        const snap2 = emptySnap({ counts: { "cms.foo": 3 },  errors: {}, totalMs: { "cms.foo": 80 } });
        const { reporter, upsertCalls } = makeReporter([snap1, snap2]);
        reporter.start();
        await reporter.flushOnce();
        // Delta is negative → clamped to 0 → no non-zero rows → no DB call
        expect(upsertCalls).toHaveLength(0);
        reporter.stop();
    });

    it("skips DB write when all method deltas are zero (no new calls)", async () => {
        const fixed = emptySnap({ counts: { "cms.foo": 5 }, errors: {}, totalMs: { "cms.foo": 100 } });
        const { reporter, upsertCalls } = makeReporter({ snapshot: () => fixed });
        reporter.start(); // baseline = fixed
        await reporter.flushOnce(); // current = fixed, delta = 0 → no write
        expect(upsertCalls).toHaveLength(0);
        reporter.stop();
    });

    it("rows include processId and processRole", async () => {
        const snap1 = emptySnap();
        const snap2 = emptySnap({ counts: { "cms.bar": 2 }, errors: {}, totalMs: { "cms.bar": 40 } });
        const { catalog, upsertCalls } = makeMockCatalog();
        let callCount = 0;
        const metrics = { snapshot() { return [snap1, snap2][callCount++] ?? snap2; } };
        const reporter = new DbMetricsReporter({
            catalog,
            metrics,
            processId:   "myhost:99:1700000000000",
            processRole: "portal",
            intervalMs:  60_000,
        });
        reporter.start();
        await reporter.flushOnce();
        const row = upsertCalls[0][0];
        expect(row.process).toBe("myhost:99:1700000000000");
        expect(row.processRole).toBe("portal");
        reporter.stop();
    });

    it("bucket is a Date at minute granularity (no sub-minute component)", async () => {
        const snap1 = emptySnap();
        const snap2 = emptySnap({ counts: { "cms.x": 1 }, errors: {}, totalMs: { "cms.x": 5 } });
        const { reporter, upsertCalls } = makeReporter([snap1, snap2]);
        reporter.start();
        await reporter.flushOnce();
        const bucket = upsertCalls[0][0].bucket;
        expect(bucket).toBeInstanceOf(Date);
        expect(bucket.getTime() % 60_000).toBe(0);
        reporter.stop();
    });
});

// ─── Resilience ───────────────────────────────────────────────────

describe("DbMetricsReporter — resilience", () => {
    it("catches upsert error, forwards to onError, does not throw", async () => {
        const snap1 = emptySnap();
        const snap2 = emptySnap({ counts: { "cms.err": 3 }, errors: {}, totalMs: { "cms.err": 60 } });
        let callCount = 0;
        const metrics = { snapshot() { return [snap1, snap2][callCount++] ?? snap2; } };
        const failingCatalog = {
            async upsertDbCallMetricBucketBatch() { throw new Error("DB down"); },
        };
        const errors = [];
        const reporter = new DbMetricsReporter({
            catalog:     failingCatalog,
            metrics,
            processId:   "h:1:0",
            processRole: "worker",
            onError:     (err) => errors.push(err),
        });
        reporter.start();
        await expect(reporter.flushOnce()).resolves.toBeUndefined();
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe("DB down");
        reporter.stop();
    });

    it("advances baseline even when upsert throws (prevents unbounded delta growth)", async () => {
        let snapCount = 0;
        const snapshots = [
            emptySnap(),
            emptySnap({ counts: { "cms.foo": 5 }, errors: {}, totalMs: { "cms.foo": 100 } }),
            emptySnap({ counts: { "cms.foo": 7 }, errors: {}, totalMs: { "cms.foo": 140 } }),
        ];
        const metrics = { snapshot() { return snapshots[Math.min(snapCount++, snapshots.length - 1)]; } };
        const upsertCalls = [];
        let shouldFail = true;
        const catalog = {
            async upsertDbCallMetricBucketBatch(rows) {
                if (shouldFail) { shouldFail = false; throw new Error("temporary failure"); }
                upsertCalls.push([...rows]);
                return rows.length;
            },
        };
        const reporter = new DbMetricsReporter({ catalog, metrics, processId: "h:1:0", processRole: "worker" });
        reporter.start();                 // baseline = snap[0]
        await reporter.flushOnce();       // current = snap[1], upsert throws — baseline advances to snap[1]
        await reporter.flushOnce();       // current = snap[2], delta = snap[2]-snap[1] = { calls: 2, totalMs: 40 }
        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0][0].calls).toBe(2);   // NOT 7 (which would happen if baseline hadn't advanced)
        reporter.stop();
    });
});

// ─── Lifecycle ────────────────────────────────────────────────────

describe("DbMetricsReporter — lifecycle", () => {
    it("_timer is null before start, set after start, null again after stop", () => {
        const { reporter } = makeReporter([emptySnap()]);
        expect(reporter["_timer"]).toBeNull();
        reporter.start();
        expect(reporter["_timer"]).not.toBeNull();
        reporter.stop();
        expect(reporter["_timer"]).toBeNull();
    });

    it("start() is idempotent — second call does not replace the timer", () => {
        const { reporter } = makeReporter([emptySnap()]);
        reporter.start();
        const timer1 = reporter["_timer"];
        reporter.start();
        expect(reporter["_timer"]).toBe(timer1);
        reporter.stop();
    });

    it("stop() is idempotent — second call is a no-op", () => {
        const { reporter } = makeReporter([emptySnap()]);
        reporter.start();
        reporter.stop();
        expect(() => reporter.stop()).not.toThrow();
        expect(reporter["_timer"]).toBeNull();
    });
});

describe("DbMetricsReporter helpers", () => {
    it("makeProcessRole falls back to unknown for empty/whitespace env", () => {
        const original = process.env.PILOTSWARM_PROCESS_ROLE;
        try {
            process.env.PILOTSWARM_PROCESS_ROLE = "";
            expect(makeProcessRole()).toBe("unknown");
            process.env.PILOTSWARM_PROCESS_ROLE = "   ";
            expect(makeProcessRole()).toBe("unknown");
            process.env.PILOTSWARM_PROCESS_ROLE = "worker";
            expect(makeProcessRole()).toBe("worker");
        } finally {
            if (original == null) delete process.env.PILOTSWARM_PROCESS_ROLE;
            else process.env.PILOTSWARM_PROCESS_ROLE = original;
        }
    });
});

// ─── ManagementClient Phase 2 methods ────────────────────────────

function buildMockClient(mockCatalog) {
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._catalog = mockCatalog;
    client._started = true;
    return client;
}

function buildNullCatalogClient() {
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._catalog = null;
    client._started = true;
    return client;
}

describe("ManagementClient — getSessionTurnMetrics", () => {
    it("delegates to catalog with sessionId and opts", async () => {
        const since = new Date("2026-04-01T00:00:00Z");
        const calls = [];
        const catalog = {
            async getSessionTurnMetrics(sessionId, opts) {
                calls.push({ sessionId, opts });
                return [{ id: 1, sessionId, turnIndex: 0 }];
            },
        };
        const client = buildMockClient(catalog);
        const rows = await client.getSessionTurnMetrics("sess-1", { since, limit: 10 });
        expect(calls[0]).toEqual({ sessionId: "sess-1", opts: { since, limit: 10 } });
        expect(rows).toHaveLength(1);
    });

    it("returns [] when catalog is null", async () => {
        const client = buildNullCatalogClient();
        const rows = await client.getSessionTurnMetrics("sess-x");
        expect(rows).toEqual([]);
    });
});

describe("ManagementClient — getFleetTurnAnalytics", () => {
    it("delegates to catalog with opts", async () => {
        const since = new Date("2026-04-01T00:00:00Z");
        const calls = [];
        const catalog = {
            async getFleetTurnAnalytics(opts) {
                calls.push(opts);
                return [{ agentId: "ag-1", turnCount: 10 }];
            },
        };
        const client = buildMockClient(catalog);
        const rows = await client.getFleetTurnAnalytics({ since, agentId: "ag-1", model: "claude-sonnet-4-6" });
        expect(calls[0]).toEqual({ since, agentId: "ag-1", model: "claude-sonnet-4-6" });
        expect(rows).toHaveLength(1);
    });

    it("returns [] when catalog is null", async () => {
        const rows = await buildNullCatalogClient().getFleetTurnAnalytics();
        expect(rows).toEqual([]);
    });
});

describe("ManagementClient — getHourlyTokenBuckets", () => {
    it("delegates to catalog with since and opts", async () => {
        const since = new Date("2026-04-25T00:00:00Z");
        const calls = [];
        const catalog = {
            async getHourlyTokenBuckets(s, opts) {
                calls.push({ s, opts });
                return [{ hourBucket: s }];
            },
        };
        const client = buildMockClient(catalog);
        const rows = await client.getHourlyTokenBuckets(since, { agentId: "ag-2" });
        expect(calls[0].s).toBe(since);
        expect(calls[0].opts).toEqual({ agentId: "ag-2" });
        expect(rows).toHaveLength(1);
    });

    it("returns [] when catalog is null", async () => {
        const rows = await buildNullCatalogClient().getHourlyTokenBuckets(new Date());
        expect(rows).toEqual([]);
    });
});

describe("ManagementClient — getFleetDbCallMetrics", () => {
    it("delegates to catalog with opts", async () => {
        const since = new Date("2026-04-26T00:00:00Z");
        const calls = [];
        const catalog = {
            async getFleetDbCallMetrics(opts) {
                calls.push(opts);
                return [{ method: "cms.getSession", calls: 100 }];
            },
        };
        const client = buildMockClient(catalog);
        const rows = await client.getFleetDbCallMetrics({ since });
        expect(calls[0]).toEqual({ since });
        expect(rows[0].method).toBe("cms.getSession");
    });

    it("returns [] when catalog is null", async () => {
        const rows = await buildNullCatalogClient().getFleetDbCallMetrics();
        expect(rows).toEqual([]);
    });
});

describe("ManagementClient — pruneTurnMetrics", () => {
    it("delegates to catalog and returns count", async () => {
        const olderThan = new Date("2026-01-01T00:00:00Z");
        const catalog = {
            async pruneTurnMetrics(d) {
                return d === olderThan ? 17 : 0;
            },
        };
        const count = await buildMockClient(catalog).pruneTurnMetrics(olderThan);
        expect(count).toBe(17);
    });

    it("returns 0 when catalog is null", async () => {
        const count = await buildNullCatalogClient().pruneTurnMetrics(new Date());
        expect(count).toBe(0);
    });
});

describe("ManagementClient reporter lifecycle", () => {
    it("stop() stops reporter and clears field", async () => {
        const stopSpy = vi.fn();
        const client = Object.create(PilotSwarmManagementClient.prototype);
        client._activeStatusWaitControllers = new Set();
        client._activeStatusWaitPromises = new Set();
        client._reporter = { stop: stopSpy };
        client._factStore = null;
        client._catalog = null;
        client._duroxideClient = null;
        client._started = true;

        await client.stop();

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(client._reporter).toBeNull();
    });
});
