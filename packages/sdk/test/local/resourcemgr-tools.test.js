import { describe, it } from "vitest";
import { createResourceManagerTools } from "../../src/index.ts";
import { assert, assertEqual } from "../helpers/assertions.js";

function createFakePool() {
    const queries = [];
    return {
        queries,
        async query(sql, params = []) {
            queries.push({ sql: String(sql), params });

            if (String(sql).includes('FROM "copilot_sessions".sessions') || String(sql).includes("FROM copilot_sessions.sessions")) {
                return {
                    rows: [{
                        total: "8",
                        active: "6",
                        deleted: "2",
                        running: "2",
                        completed: "3",
                        pending: "1",
                        failed: "0",
                        system_sessions: "4",
                        sub_agents: "2",
                    }],
                };
            }

            if (String(sql).includes('FROM "copilot_sessions".session_events') || String(sql).includes("FROM copilot_sessions.session_events")) {
                return {
                    rows: [{
                        total_events: "42",
                        sessions_with_events: "6",
                        earliest_event: "2026-04-04T00:00:00.000Z",
                        latest_event: "2026-04-04T00:10:00.000Z",
                    }],
                };
            }

            if (String(sql).includes("pg_database_size(current_database())")) {
                return { rows: [{ db_size: "128 MB" }] };
            }

            if (String(sql).includes("FROM pg_tables")) {
                return {
                    rows: [
                        { schemaname: "copilot_sessions", size: "16 MB" },
                        { schemaname: "duroxide", size: "64 MB" },
                    ],
                };
            }

            throw new Error(`Unexpected SQL in fake pool: ${sql}`);
        },
    };
}

describe("resource manager tools", () => {
    it("uses duroxide management APIs instead of querying runtime internals", async () => {
        const pool = createFakePool();
        const duroxideClient = {
            async getSystemMetrics() {
                return {
                    totalInstances: 11,
                    totalExecutions: 27,
                    runningInstances: 3,
                    completedInstances: 5,
                    failedInstances: 1,
                    totalEvents: 88,
                };
            },
            async getQueueDepths() {
                return {
                    orchestratorQueue: 2,
                    workerQueue: 4,
                    timerQueue: 6,
                };
            },
            async listInstancesByStatus(status) {
                if (status === "Suspended") return ["a", "b"];
                if (status === "Terminated") return ["c"];
                return [];
            },
        };

        const tools = createResourceManagerTools({
            catalog: { pool },
            duroxideClient,
            blobStore: null,
        });
        const tool = tools.find((candidate) => candidate.name === "get_database_stats");
        assert(tool, "get_database_stats tool should be registered");

        const result = await tool.handler({});

        assertEqual(result.cms.total, "8", "cms session totals should still come from SQL");
        assertEqual(result.duroxide.instances.total_instances, 11, "instance totals should come from getSystemMetrics");
        assertEqual(result.duroxide.instances.running, 3, "running instance counts should come from getSystemMetrics");
        assertEqual(result.duroxide.instances.completed, 5, "completed instance counts should come from getSystemMetrics");
        assertEqual(result.duroxide.instances.failed, 1, "failed instance counts should come from getSystemMetrics");
        assertEqual(result.duroxide.instances.suspended, 2, "suspended instance counts should come from listInstancesByStatus");
        assertEqual(result.duroxide.instances.terminated, 1, "terminated instance counts should come from listInstancesByStatus");
        assertEqual(result.duroxide.totalExecutions, 27, "execution totals should come from getSystemMetrics");
        assertEqual(result.duroxide.totalHistoryEvents, 88, "history totals should come from getSystemMetrics");
        assertEqual(result.duroxide.avgExecutionsPerInstance, 2.5, "avg executions per instance should be derived from management metrics");
        assertEqual(result.duroxide.queues.orchestrator_queue, 2, "queue depths should come from getQueueDepths");
        assertEqual(result.duroxide.queues.worker_queue, 4, "queue depths should come from getQueueDepths");
        assertEqual(result.duroxide.queues.timer_queue, 6, "queue depths should come from getQueueDepths");

        const queriedSql = pool.queries.map((entry) => entry.sql).join("\n");
        assert(!queriedSql.includes("runtime_status"), "should not query runtime_status directly");
        assert(!queriedSql.includes("orchestrator_queue"), "should not query duroxide queue tables directly");
        assert(!queriedSql.includes("worker_queue"), "should not query duroxide queue tables directly");
        assert(!queriedSql.includes("timer_queue"), "should not query duroxide queue tables directly");
    });
});
