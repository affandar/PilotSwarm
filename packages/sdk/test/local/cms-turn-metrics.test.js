/**
 * CMS turn-metrics wiring tests (mock-pool, no real DB required).
 *
 * Verifies that:
 *   - each new method calls the correct SQL function
 *   - parameters are passed in the right positions
 *   - row mappers transform snake_case PG output to camelCase TS types
 *   - edge cases (empty batch, null fields) are handled
 *
 * Run: npx vitest run test/local/cms-turn-metrics.test.js
 */

import { describe, it, expect } from "vitest";
import { PgSessionCatalogProvider } from "../../src/index.ts";

// ─── Mock pool factory ────────────────────────────────────────────

function createMockPool(returnRows = []) {
    const calls = [];
    const pool = {
        async query(sql, params) {
            calls.push({ sql: String(sql), params: params ?? [] });
            return { rows: returnRows };
        },
        on() {},
        async end() {},
    };
    return { pool, calls };
}

async function makeProvider(pool) {
    // Bypass the async factory — inject the mock pool directly via the
    // private constructor path used only in tests.
    const provider = await PgSessionCatalogProvider.create("postgresql://x:x@localhost/x");
    provider.pool = pool;
    provider.initialized = true;
    provider.sql = provider.sql; // keep schema already set
    return provider;
}

// Build a provider with a mock pool injected after construction.
// PgSessionCatalogProvider.create() tries to connect — work around by
// intercepting the pool after construction using the public accessor
// pattern that exists in tests (pool is set as a property).
function buildProvider(mockPool) {
    const schema = "copilot_sessions";
    const s = `"${schema}"`;
    // Directly instantiate using the private class pattern mirrored from pg-migrator tests:
    // we give it a real-enough pool that initialize() won't be called.
    const provider = Object.create(PgSessionCatalogProvider.prototype);
    provider.pool = mockPool;
    provider.initialized = true;
    provider.sql = {
        schema,
        fn: {
            insertTurnMetric:              `${s}.cms_insert_turn_metric`,
            getSessionTurnMetrics:         `${s}.cms_get_session_turn_metrics`,
            getFleetTurnAnalytics:         `${s}.cms_get_fleet_turn_analytics`,
            getHourlyTokenBuckets:         `${s}.cms_get_hourly_token_buckets`,
            pruneTurnMetrics:              `${s}.cms_prune_turn_metrics`,
            upsertDbCallMetricBucketBatch: `${s}.cms_upsert_db_call_metric_bucket_batch`,
            getFleetDbCallMetrics:         `${s}.cms_get_fleet_db_call_metrics`,
        },
    };
    return provider;
}

// ─── insertTurnMetric ─────────────────────────────────────────────

describe("insertTurnMetric", () => {
    it("calls cms_insert_turn_metric with 16 positional params", async () => {
        const { pool, calls } = createMockPool([]);
        const p = buildProvider(pool);

        const startedAt = new Date("2026-04-26T10:00:00Z");
        const endedAt   = new Date("2026-04-26T10:00:05Z");

        await p.insertTurnMetric({
            sessionId: "sess-1", agentId: "ag-1", model: "claude-sonnet-4-6",
            turnIndex: 3, startedAt, endedAt, durationMs: 5000,
            tokensInput: 100, tokensOutput: 50, tokensCacheRead: 20, tokensCacheWrite: 10,
            toolCalls: 2, toolErrors: 0, resultType: "completed",
            errorMessage: null, workerNodeId: "wk-1",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toContain("cms_insert_turn_metric");
        expect(calls[0].params).toHaveLength(16);
        expect(calls[0].params[0]).toBe("sess-1");
        expect(calls[0].params[3]).toBe(3);
        expect(calls[0].params[6]).toBe(5000);
    });
});

// ─── getSessionTurnMetrics ───────────────────────────────────────

describe("getSessionTurnMetrics", () => {
    it("calls cms_get_session_turn_metrics with sessionId, since, limit", async () => {
        const since = new Date("2026-04-01T00:00:00Z");
        const mockRow = {
            id: "7", session_id: "sess-1", agent_id: "ag-1", model: "claude-sonnet-4-6",
            turn_index: "2", started_at: "2026-04-26T10:00:00Z", ended_at: "2026-04-26T10:00:05Z",
            duration_ms: "5000", tokens_input: "100", tokens_output: "50",
            tokens_cache_read: "20", tokens_cache_write: "10",
            tool_calls: "2", tool_errors: "0",
            result_type: "completed", error_message: null, worker_node_id: "wk-1",
            created_at: "2026-04-26T10:00:05Z",
        };
        const { pool, calls } = createMockPool([mockRow]);
        const p = buildProvider(pool);

        const rows = await p.getSessionTurnMetrics("sess-1", { since, limit: 50 });

        expect(calls[0].sql).toContain("cms_get_session_turn_metrics");
        expect(calls[0].params).toEqual(["sess-1", since, 50]);

        // Row mapper
        expect(rows).toHaveLength(1);
        const r = rows[0];
        expect(r.id).toBe(7);
        expect(r.sessionId).toBe("sess-1");
        expect(r.agentId).toBe("ag-1");
        expect(r.turnIndex).toBe(2);
        expect(r.durationMs).toBe(5000);
        expect(r.tokensInput).toBe(100);
        expect(r.tokensCacheRead).toBe(20);
        expect(r.toolCalls).toBe(2);
        expect(r.resultType).toBe("completed");
        expect(r.errorMessage).toBeNull();
        expect(r.startedAt).toBeInstanceOf(Date);
    });

    it("passes null for missing opts", async () => {
        const { pool, calls } = createMockPool([]);
        const p = buildProvider(pool);
        await p.getSessionTurnMetrics("sess-2");
        expect(calls[0].params).toEqual(["sess-2", null, 200]);
    });
});

// ─── getFleetTurnAnalytics ───────────────────────────────────────

describe("getFleetTurnAnalytics", () => {
    it("calls cms_get_fleet_turn_analytics with since, agentId, model", async () => {
        const since = new Date("2026-04-01T00:00:00Z");
        const mockRow = {
            agent_id: "ag-1", model: "claude-sonnet-4-6",
            turn_count: "10", error_count: "1", tool_call_count: "5", tool_error_count: "0",
            avg_duration_ms: "3200.50", p95_duration_ms: "8100.00",
            total_tokens_input: "5000", total_tokens_output: "2000",
            total_tokens_cache_read: "1000", total_tokens_cache_write: "500",
        };
        const { pool, calls } = createMockPool([mockRow]);
        const p = buildProvider(pool);

        const rows = await p.getFleetTurnAnalytics({ since, agentId: "ag-1", model: "claude-sonnet-4-6" });

        expect(calls[0].sql).toContain("cms_get_fleet_turn_analytics");
        expect(calls[0].params).toEqual([since, "ag-1", "claude-sonnet-4-6"]);

        const r = rows[0];
        expect(r.agentId).toBe("ag-1");
        expect(r.turnCount).toBe(10);
        expect(r.errorCount).toBe(1);
        expect(r.p95DurationMs).toBe(8100);
        expect(r.totalTokensInput).toBe(5000);
    });

    it("passes nulls when no opts", async () => {
        const { pool, calls } = createMockPool([]);
        const p = buildProvider(pool);
        await p.getFleetTurnAnalytics();
        expect(calls[0].params).toEqual([null, null, null]);
    });
});

// ─── getHourlyTokenBuckets ───────────────────────────────────────

describe("getHourlyTokenBuckets", () => {
    it("calls cms_get_hourly_token_buckets with since, agentId, model", async () => {
        const since = new Date("2026-04-25T00:00:00Z");
        const mockRow = {
            hour_bucket: "2026-04-25T10:00:00Z",
            turn_count: "3",
            total_tokens_input: "900", total_tokens_output: "300",
            total_tokens_cache_read: "100", total_tokens_cache_write: "50",
        };
        const { pool, calls } = createMockPool([mockRow]);
        const p = buildProvider(pool);

        const rows = await p.getHourlyTokenBuckets(since, { agentId: null, model: "claude-opus-4-7" });

        expect(calls[0].sql).toContain("cms_get_hourly_token_buckets");
        expect(calls[0].params[0]).toBe(since);

        const r = rows[0];
        expect(r.hourBucket).toBeInstanceOf(Date);
        expect(r.turnCount).toBe(3);
        expect(r.totalTokensInput).toBe(900);
    });
});

// ─── pruneTurnMetrics ────────────────────────────────────────────

describe("pruneTurnMetrics", () => {
    it("calls cms_prune_turn_metrics and returns count", async () => {
        const { pool, calls } = createMockPool([{ pruned_count: "42" }]);
        const p = buildProvider(pool);
        const olderThan = new Date("2026-01-01T00:00:00Z");

        const count = await p.pruneTurnMetrics(olderThan);

        expect(calls[0].sql).toContain("cms_prune_turn_metrics");
        expect(calls[0].params).toEqual([olderThan]);
        expect(count).toBe(42);
    });

    it("returns 0 when no rows deleted", async () => {
        const { pool } = createMockPool([{ pruned_count: null }]);
        const p = buildProvider(pool);
        const count = await p.pruneTurnMetrics(new Date());
        expect(count).toBe(0);
    });
});

// ─── upsertDbCallMetricBucketBatch ───────────────────────────────

describe("upsertDbCallMetricBucketBatch", () => {
    it("skips DB call and returns 0 for empty batch", async () => {
        const { pool, calls } = createMockPool([]);
        const p = buildProvider(pool);
        const count = await p.upsertDbCallMetricBucketBatch([]);
        expect(calls).toHaveLength(0);
        expect(count).toBe(0);
    });

    it("calls cms_upsert_db_call_metric_bucket_batch with serialised JSON", async () => {
        const bucket = new Date("2026-04-26T10:00:00Z");
        const { pool, calls } = createMockPool([{ row_count: "2" }]);
        const p = buildProvider(pool);

        const count = await p.upsertDbCallMetricBucketBatch([
            { bucket, process: "worker-1", processRole: "worker", method: "cms.getSession",     calls: 10, errors: 0, totalMs: 200 },
            { bucket, process: "worker-1", processRole: "worker", method: "cms.recordEvents",   calls:  5, errors: 1, totalMs: 150 },
        ]);

        expect(calls[0].sql).toContain("cms_upsert_db_call_metric_bucket_batch");
        const payload = JSON.parse(calls[0].params[0]);
        expect(payload).toHaveLength(2);
        expect(payload[0].bucket).toBe(bucket.toISOString());
        expect(payload[0].process).toBe("worker-1");
        expect(payload[0].processRole).toBe("worker");
        expect(payload[0].method).toBe("cms.getSession");
        expect(payload[0].calls).toBe(10);
        expect(payload[1].errors).toBe(1);
        expect(count).toBe(2);
    });
});

// ─── getFleetDbCallMetrics ───────────────────────────────────────

describe("getFleetDbCallMetrics", () => {
    it("calls cms_get_fleet_db_call_metrics with since and maps rows", async () => {
        const since = new Date("2026-04-26T00:00:00Z");
        const mockRow = {
            method: "cms.getSession", calls: "100", errors: "2",
            total_ms: "3000", avg_ms: "30.00", error_rate: "0.0200",
        };
        const { pool, calls } = createMockPool([mockRow]);
        const p = buildProvider(pool);

        const rows = await p.getFleetDbCallMetrics({ since });

        expect(calls[0].sql).toContain("cms_get_fleet_db_call_metrics");
        expect(calls[0].params).toEqual([since]);

        const r = rows[0];
        expect(r.method).toBe("cms.getSession");
        expect(r.calls).toBe(100);
        expect(r.errors).toBe(2);
        expect(r.totalMs).toBe(3000);
        expect(r.avgMs).toBe(30);
        expect(r.errorRate).toBe(0.02);
    });

    it("passes null when no since", async () => {
        const { pool, calls } = createMockPool([]);
        const p = buildProvider(pool);
        await p.getFleetDbCallMetrics();
        expect(calls[0].params).toEqual([null]);
    });
});
