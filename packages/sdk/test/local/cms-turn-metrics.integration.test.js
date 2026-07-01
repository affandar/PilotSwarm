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

    it("renames session summaries to session_metrics with compatibility view", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const result = await directQuery(env, `
                SELECT relname, relkind
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1
                  AND relname IN ('session_metrics', 'session_metric_summaries')
                ORDER BY relname
            `, [env.cmsSchema]);
            const kinds = new Map(result.rows.map((row) => [row.relname, row.relkind]));
            assertEqual(kinds.get("session_metrics"), "r", "session_metrics should be the physical table");
            assertEqual(kinds.get("session_metric_summaries"), "v", "old summary name should be a compatibility view");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("default getSessionTurnMetrics limit is 200", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        try {
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
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("hourly bucket rows contain only hourly aggregate fields", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        try {
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
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("attributes tokens per model:effort with turn counts", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const sid = `turn-bymodel-${Date.now()}`;
            await catalog.createSession(sid, { agentId: "ag", model: "model-a" });
            const base = { sessionId: sid, agentId: "ag", durationMs: 100, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, toolCalls: 0, toolErrors: 0, resultType: "completed", errorMessage: null, workerNodeId: "wk" };
            const t0 = new Date(Date.now() - 60_000), t1 = new Date(Date.now() - 30_000), t2 = new Date();
            await catalog.insertTurnMetric({ ...base, model: "model-a", reasoningEffort: "high", turnIndex: 1, startedAt: t0, endedAt: t0, tokensInput: 100 });
            await catalog.insertTurnMetric({ ...base, model: "model-a", reasoningEffort: "high", turnIndex: 2, startedAt: t1, endedAt: t1, tokensInput: 50 });
            await catalog.insertTurnMetric({ ...base, model: "model-b", reasoningEffort: "medium", turnIndex: 3, startedAt: t2, endedAt: t2, tokensInput: 25 });

            const rows = await catalog.getSessionTurnMetrics(sid);
            assertEqual(rows[0].reasoningEffort, "medium", "reasoning effort round-trips");

            const buckets = await catalog.getSessionTokensByModel(sid);
            assertEqual(buckets.length, 2, "two model buckets");
            const a = buckets.find((b) => b.model === "model-a:high");
            const b = buckets.find((b) => b.model === "model-b:medium");
            assertEqual(a.turnCount, 2, "model-a two turns");
            assertEqual(a.totalTokensInput, 150, "model-a tokens summed");
            assertEqual(b.turnCount, 1, "model-b one turn");
            assertEqual(b.totalTokensInput, 25, "model-b tokens");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("completeTurnWriteback updates state totals turn row and completion event", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const sid = `turn-writeback-${Date.now()}`;
            await catalog.createSession(sid, { agentId: "ag-writeback", model: "model-a", reasoningEffort: "medium" });
            const startedAt = new Date(Date.now() - 1_250);
            const endedAt = new Date();
            await catalog.completeTurnWriteback({
                sessionId: sid,
                agentId: "ag-writeback",
                model: "model-a",
                reasoningEffort: "medium",
                turnIndex: 7,
                startedAt,
                endedAt,
                durationMs: endedAt.getTime() - startedAt.getTime(),
                tokensInput: 20,
                tokensOutput: 5,
                tokensCacheRead: 3,
                tokensCacheWrite: 1,
                toolCalls: 2,
                toolErrors: 1,
                toolNames: ["read_facts", "write_artifact"],
                resultType: "completed",
                errorMessage: null,
                workerNodeId: "wk-writeback",
                state: "idle",
                lastActiveAt: endedAt,
                lastError: null,
                waitReason: null,
                currentIteration: 7,
            });

            const session = await catalog.getSession(sid);
            assertEqual(session.state, "idle", "session state updated");
            assertEqual(session.currentIteration, 7, "current iteration updated");
            const summary = await catalog.getSessionMetricSummary(sid);
            assertEqual(summary.tokensInput, 20, "summary input tokens incremented");
            assertEqual(summary.tokensOutput, 5, "summary output tokens incremented");
            const rows = await catalog.getSessionTurnMetrics(sid);
            assertEqual(rows.length, 1, "one turn metric row inserted");
            assertEqual(rows[0].reasoningEffort, "medium", "turn reasoning effort recorded");
            assertEqual(rows[0].toolErrors, 1, "turn tool errors recorded");
            const events = await catalog.getSessionEvents(sid);
            const completed = events.find((event) => event.eventType === "session.turn_completed");
            assert(completed, "turn_completed event recorded");
            assertEqual(completed.data.turnIndex, 7, "completion event carries turn index");
            assertEqual(completed.data.tokensInput, 20, "completion event carries token metrics");
            const treeStats = await catalog.getSessionTreeStats(sid);
            const treeBucket = treeStats.byModel.find((bucket) => bucket.model === "model-a:medium");
            assert(treeBucket, "tree stats include model bucket");
            assertEqual(treeBucket.turnCount, 1, "tree model bucket turn count");
            const fleetStats = await catalog.getFleetStats();
            const fleetBucket = fleetStats.byAgent.find((bucket) => bucket.model === "model-a:medium");
            assert(fleetBucket, "fleet stats include model bucket");
            assertEqual(fleetBucket.turnCount, 1, "fleet model bucket turn count");
            const userStats = await catalog.getUserStats();
            const unowned = userStats.users.find((bucket) => bucket.ownerKind === "unowned");
            const userBucket = unowned?.byModel.find((bucket) => bucket.model === "model-a:medium");
            assert(userBucket, "user stats include model bucket");
            assertEqual(userBucket.turnCount, 1, "user model bucket turn count");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
