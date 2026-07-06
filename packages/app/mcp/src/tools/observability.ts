import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Observability & forensics tools (proposal G6), consolidated by axis:
 *
 *   get_session_metrics   per-session (or spawn-tree) metrics via include[]
 *   get_fleet_overview    fleet-wide aggregates via include[]
 *   list_child_outcomes   what did the sub-agents conclude
 *   get_execution_history raw orchestration execution events
 *   export_execution_history  export history → artifact
 */
export function registerObservabilityTools(server: McpServer, ctx: ServerContext) {
    // 1. get_session_metrics — one tool, one session, many axes
    server.registerTool(
        "get_session_metrics",
        {
            title: "Get Session Metrics",
            description:
                "Metrics for one session (or its whole spawn tree with tree=true). include selects axes: "
                + "'summary' (turn/token metric summary), 'tokens_by_model', 'skill_usage', 'retrieval_usage', "
                + "'facts_stats', 'orchestration_stats' (runtime internals; self only). Default ['summary']. "
                + "For a full diagnostic bundle (events, execution history, graph usage), use debug_session.",
            inputSchema: {
                session_id: z.string().min(1).describe("The session to inspect"),
                include: z
                    .array(z.enum(["summary", "tokens_by_model", "skill_usage", "retrieval_usage", "facts_stats", "orchestration_stats"]))
                    .optional()
                    .describe("Metric axes to fetch (default ['summary'])"),
                tree: z.boolean().optional().describe("Aggregate across the spawn tree where supported (skill_usage, retrieval_usage, facts_stats; summary→tree stats)"),
                since: z.string().optional().describe("ISO timestamp lower bound (skill_usage, retrieval_usage)"),
            },
        },
        withToolErrors(async ({ session_id, include, tree, since }) => {
            const session = await ctx.mgmt.getSession(session_id);
            if (!session) return errorResult("session not found", { session_id });

            const wants = new Set(include ?? ["summary"]);
            const sinceDate = since ? new Date(since) : undefined;
            const result: Record<string, unknown> = { session_id, tree: Boolean(tree) };
            const errors: Record<string, string> = {};

            const grab = async (key: string, fn: () => Promise<unknown>) => {
                try {
                    result[key] = await fn();
                } catch (err: unknown) {
                    errors[key] = err instanceof Error ? err.message : String(err);
                }
            };

            if (wants.has("summary")) {
                await grab("summary", () =>
                    tree ? ctx.mgmt.getSessionTreeStats(session_id) : ctx.mgmt.getSessionMetricSummary(session_id));
            }
            if (wants.has("tokens_by_model")) {
                await grab("tokens_by_model", () => ctx.mgmt.getSessionTokensByModel(session_id));
            }
            if (wants.has("skill_usage")) {
                await grab("skill_usage", () =>
                    tree
                        ? ctx.mgmt.getSessionTreeSkillUsage(session_id, sinceDate ? { since: sinceDate } : undefined)
                        : ctx.mgmt.getSessionSkillUsage(session_id, sinceDate ? { since: sinceDate } : undefined));
            }
            if (wants.has("retrieval_usage")) {
                await grab("retrieval_usage", () =>
                    tree
                        ? ctx.mgmt.getSessionTreeRetrievalUsage(session_id, sinceDate ? { since: sinceDate } : undefined)
                        : ctx.mgmt.getSessionRetrievalUsage(session_id, sinceDate ? { since: sinceDate } : undefined));
            }
            if (wants.has("facts_stats")) {
                await grab("facts_stats", () =>
                    tree ? ctx.mgmt.getSessionTreeFactsStats(session_id) : ctx.mgmt.getSessionFactsStats(session_id));
            }
            if (wants.has("orchestration_stats")) {
                await grab("orchestration_stats", () => ctx.mgmt.getOrchestrationStats(session_id));
            }

            if (Object.keys(errors).length > 0) result.errors = errors;
            return jsonResult(result);
        }),
    );

    // 2. get_fleet_overview — fleet-wide aggregates
    server.registerTool(
        "get_fleet_overview",
        {
            title: "Get Fleet Overview",
            description:
                "Fleet-wide aggregates. include selects axes: 'stats' (sessions/tokens fleet stats), 'skill_usage', "
                + "'retrieval_usage', 'graph_node_usage', 'user_stats', 'top_emitters' (noisiest event emitters), "
                + "'shared_facts', 'tombstones' (soft-deleted facts awaiting reconciliation). Default ['stats'].",
            inputSchema: {
                include: z
                    .array(z.enum(["stats", "skill_usage", "retrieval_usage", "graph_node_usage", "user_stats", "top_emitters", "shared_facts", "tombstones"]))
                    .optional()
                    .describe("Axes to fetch (default ['stats'])"),
                since: z.string().optional().describe("ISO timestamp lower bound (stats/skill/retrieval/graph/user/top_emitters)"),
                include_deleted: z.boolean().optional().describe("Include soft-deleted sessions in aggregates"),
                limit: z.number().int().positive().optional().describe("Row cap for top_emitters / graph_node_usage (default 20)"),
            },
        },
        withToolErrors(async ({ include, since, include_deleted, limit }) => {
            const wants = new Set(include ?? ["stats"]);
            const sinceDate = since ? new Date(since) : undefined;
            const base = { since: sinceDate, includeDeleted: include_deleted } as any;
            const result: Record<string, unknown> = {};
            const errors: Record<string, string> = {};

            const grab = async (key: string, fn: () => Promise<unknown>) => {
                try {
                    result[key] = await fn();
                } catch (err: unknown) {
                    errors[key] = err instanceof Error ? err.message : String(err);
                }
            };

            if (wants.has("stats")) await grab("stats", () => ctx.mgmt.getFleetStats(base));
            if (wants.has("skill_usage")) await grab("skill_usage", () => ctx.mgmt.getFleetSkillUsage(base));
            if (wants.has("retrieval_usage")) await grab("retrieval_usage", () => ctx.mgmt.getFleetRetrievalUsage(base));
            if (wants.has("graph_node_usage")) await grab("graph_node_usage", () => ctx.mgmt.getFleetGraphNodeUsage({ ...base, limit }));
            if (wants.has("user_stats")) await grab("user_stats", () => ctx.mgmt.getUserStats(base));
            if (wants.has("top_emitters")) {
                await grab("top_emitters", () =>
                    ctx.mgmt.getTopEventEmitters({ since: sinceDate ?? new Date(Date.now() - 24 * 3600 * 1000), limit: limit ?? 20 }));
            }
            if (wants.has("shared_facts")) await grab("shared_facts", () => ctx.mgmt.getSharedFactsStats());
            if (wants.has("tombstones")) await grab("tombstones", () => ctx.mgmt.getFactsTombstoneStats());

            if (Object.keys(errors).length > 0) result.errors = errors;
            return jsonResult(result);
        }),
    );

    // 3. list_child_outcomes — sub-agent conclusions without transcript dumps
    server.registerTool(
        "list_child_outcomes",
        {
            title: "List Child Outcomes",
            description:
                "Outcomes recorded by child sessions (sub-agents) under a parent session — what each child concluded, "
                + "without dumping transcripts. Pass child_session_id instead to fetch a single child's outcome.",
            inputSchema: {
                parent_session_id: z.string().optional().describe("Parent session — lists all child outcomes under it"),
                child_session_id: z.string().optional().describe("One child session — fetches just its outcome"),
            },
        },
        withToolErrors(async ({ parent_session_id, child_session_id }) => {
            if (!parent_session_id && !child_session_id) {
                return errorResult("provide parent_session_id or child_session_id");
            }
            if (child_session_id) {
                const outcome = await ctx.mgmt.getChildOutcome(child_session_id);
                if (!outcome) return errorResult("no outcome recorded", { child_session_id });
                return jsonResult({ outcome });
            }
            const outcomes = await ctx.mgmt.listChildOutcomes(parent_session_id!);
            return jsonResult({ count: outcomes.length, outcomes });
        }),
    );

    // 4. get_execution_history — raw orchestration forensics
    server.registerTool(
        "get_execution_history",
        {
            title: "Get Execution History",
            description:
                "Raw duroxide execution-history events for a session — orchestration-level forensics (activity "
                + "scheduling, retries, continue-as-new boundaries). Heavyweight; prefer get_session_events for chat-level history.",
            inputSchema: {
                session_id: z.string().min(1).describe("The session to inspect"),
                execution_id: z.number().int().optional().describe("Specific execution (default: latest)"),
            },
        },
        withToolErrors(async ({ session_id, execution_id }) => {
            const history = await ctx.mgmt.getExecutionHistory(session_id, execution_id);
            if (!history) return errorResult("session or execution not found", { session_id });
            return jsonResult({ count: history.length, events: history });
        }),
    );

    // 5. export_execution_history — history → artifact (web mode; the export
    // lands in the session's artifacts, retrievable via get_artifact).
    if (ctx.api) {
        server.registerTool(
            "export_execution_history",
            {
                title: "Export Execution History",
                description:
                    "Export a session's full execution history to an artifact on the session; returns the artifact "
                    + "metadata. Retrieve it with get_artifact / list_artifacts.",
                inputSchema: {
                    session_id: z.string().uuid({ message: "session_id must be a valid UUID" }).describe("The session to export"),
                },
            },
            withToolErrors(async ({ session_id }) => {
                const meta = await ctx.api!.call("exportExecutionHistory", { sessionId: session_id });
                return jsonResult({ exported: true, artifact: meta });
            }),
        );
    }
}
