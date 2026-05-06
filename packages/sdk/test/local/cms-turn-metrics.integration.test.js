import { describe, it, beforeAll } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

describe("CMS turn metrics integration", () => {
    beforeAll(async () => {
        const env = getEnv();
        const { default: pg } = await import("pg");
        const client = new pg.Client({
            connectionString: env.store,
            connectionTimeoutMillis: 4000,
        });
        try {
            await client.connect();
            await client.query("SELECT 1");
        } finally {
            try { await client.end(); } catch {}
        }
    });

    it("default getSessionTurnMetrics limit is 200", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `turn-metrics-limit-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "ag-1", model: "claude-sonnet-4-6" });

        await directQuery(
            env,
            `
            INSERT INTO "${env.cmsSchema}".session_turn_metrics (
                session_id, agent_id, model, turn_index,
                started_at, ended_at, duration_ms,
                tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
                tool_calls, tool_errors, result_type, error_message, worker_node_id
            )
            SELECT
                $1, 'ag-1', 'claude-sonnet-4-6', gs,
                now() - (gs || ' seconds')::interval,
                now() - ((gs - 1) || ' seconds')::interval,
                1000,
                10, 5, 1, 0,
                1, 0, 'completed', NULL, 'wk-1'
            FROM generate_series(1, 250) AS gs
            `,
            [sid],
        );

        const rows = await catalog.getSessionTurnMetrics(sid);
        assertEqual(rows.length, 200, "default limit should return 200 rows");
        assertEqual(rows[0].turnIndex, 250, "newest row should be first");
        assertEqual(rows[199].turnIndex, 51, "200th row should match descending limit");

        await catalog.close();
    }, TIMEOUT);

    it("hourly bucket rows contain only hourly aggregate fields", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `turn-hourly-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "ag-hourly", model: "claude-opus-4-7" });

        const now = new Date();
        await catalog.insertTurnMetric({
            sessionId: sid,
            agentId: "ag-hourly",
            model: "claude-opus-4-7",
            turnIndex: 1,
            startedAt: new Date(now.getTime() - 5_000),
            endedAt: now,
            durationMs: 5_000,
            tokensInput: 120,
            tokensOutput: 80,
            tokensCacheRead: 10,
            tokensCacheWrite: 5,
            toolCalls: 1,
            toolErrors: 0,
            resultType: "completed",
            errorMessage: null,
            workerNodeId: "wk-hourly",
        });

        const buckets = await catalog.getHourlyTokenBuckets(
            new Date(now.getTime() - 2 * 60 * 60 * 1000),
            { agentId: "ag-hourly", model: "claude-opus-4-7" },
        );

        assert(buckets.length >= 1, "expected at least one hourly bucket");
        const row = buckets[0];
        assert(row.hourBucket instanceof Date, "hourBucket should be Date");
        assert(typeof row.turnCount === "number", "turnCount should be numeric");
        assert(!("agentId" in row), "hourly row should not expose agentId");
        assert(!("model" in row), "hourly row should not expose model");

        await catalog.close();
    }, TIMEOUT);
});
