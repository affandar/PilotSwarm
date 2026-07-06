import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * debug_session — the agent-tuner's diagnostic surface as one MCP tool.
 *
 * The agent-tuner system agent investigates "why is this session/agent
 * misbehaving" with a read-only toolset (read_agent_events, session info,
 * metric/token/tree summaries, retrieval + graph usage, orchestration stats,
 * execution history). This tool exposes the same axes to an external MCP
 * operator in a single include-driven call, so a debugging conversation can
 * pull exactly the evidence it needs.
 *
 * Read-only by construction — every axis maps to a mgmt read. Axis failures
 * are isolated into errors{} so one unsupported/broken read never sinks the
 * investigation. (Fleet-level counterparts live in get_fleet_overview;
 * knowledge reads in read_facts / search_facts.)
 */
const DEBUG_AXES = [
    "info",                    // CMS session row (read_session_info)
    "status",                  // live orchestration + custom status
    "latest_response",         // last turn's LLM payload
    "events",                  // recent CMS events (read_agent_events)
    "summary",                 // metric summary (read_session_metric_summary)
    "tokens_by_model",         // read_session_tokens_by_model
    "tree_stats",              // read_session_tree_stats
    "skill_usage",             // per-session skill usage
    "retrieval_usage",         // read_session_retrieval_usage (tree-aware)
    "facts_stats",             // per-session facts footprint
    "orchestration_stats",     // read_orchestration_stats (duroxide runtime)
    "execution_history",       // read_execution_history (heavyweight)
    "child_outcomes",          // what sub-agents concluded
    "graph_node_usage",        // read_session_graph_node_usage
    "graph_edge_search_usage", // read_session_graph_edge_search_usage
    "graph_searches",          // recent graph search events
] as const;

const DEFAULT_AXES = ["info", "status", "latest_response", "events", "summary", "orchestration_stats"];

export function registerDebugTools(server: McpServer, ctx: ServerContext) {
    server.registerTool(
        "debug_session",
        {
            title: "Debug Session",
            description:
                "Tuner-grade, read-only diagnostic bundle for one session — the same evidence surface PilotSwarm's "
                + "agent-tuner uses to investigate misbehaving sessions/agents. include selects axes "
                + `(default ${JSON.stringify(DEFAULT_AXES)}); the full set is ${JSON.stringify(DEBUG_AXES)}. `
                + "Per-axis failures are isolated under errors{}. Heavyweight axes: execution_history. "
                + "Fleet-level counterparts live in get_fleet_overview; knowledge reads in read_facts/search_facts.",
            inputSchema: {
                session_id: z.string().min(1).describe("The session to investigate"),
                include: z.array(z.enum(DEBUG_AXES)).optional().describe("Diagnostic axes to fetch"),
                tree: z.boolean().optional().describe("Tree-aware axes (retrieval_usage, skill_usage) aggregate across the spawn tree"),
                since: z.string().optional().describe("ISO lower bound for usage axes (skill/retrieval/graph)"),
                events_limit: z.number().int().positive().max(500).optional().describe("Recent-events window (default 50)"),
                event_types: z.array(z.string()).optional().describe("Server-side event-type filter for the events axis"),
                execution_id: z.number().int().optional().describe("Specific execution for execution_history (default latest)"),
            },
        },
        withToolErrors(async ({ session_id, include, tree, since, events_limit, event_types, execution_id }) => {
            const session = await ctx.mgmt.getSession(session_id);
            if (!session) return errorResult("session not found", { session_id });

            const wants = new Set(include ?? DEFAULT_AXES);
            const sinceDate = since ? new Date(since) : undefined;
            const sinceOpts = sinceDate ? { since: sinceDate } : undefined;
            const result: Record<string, unknown> = { session_id, tree: Boolean(tree) };
            const errors: Record<string, string> = {};

            const grab = async (key: string, fn: () => Promise<unknown>) => {
                if (!wants.has(key as (typeof DEBUG_AXES)[number])) return;
                try {
                    result[key] = await fn();
                } catch (err: unknown) {
                    errors[key] = err instanceof Error ? err.message : String(err);
                }
            };

            await grab("info", async () => session);
            await grab("status", () => ctx.mgmt.getSessionStatus(session_id));
            await grab("latest_response", () => ctx.mgmt.getLatestResponse(session_id));
            await grab("events", () => ctx.mgmt.getSessionEvents(session_id, undefined, events_limit ?? 50, event_types));
            await grab("summary", () => ctx.mgmt.getSessionMetricSummary(session_id));
            await grab("tokens_by_model", () => ctx.mgmt.getSessionTokensByModel(session_id));
            await grab("tree_stats", () => ctx.mgmt.getSessionTreeStats(session_id));
            await grab("skill_usage", () =>
                tree ? ctx.mgmt.getSessionTreeSkillUsage(session_id, sinceOpts) : ctx.mgmt.getSessionSkillUsage(session_id, sinceOpts));
            await grab("retrieval_usage", () =>
                tree ? ctx.mgmt.getSessionTreeRetrievalUsage(session_id, sinceOpts) : ctx.mgmt.getSessionRetrievalUsage(session_id, sinceOpts));
            await grab("facts_stats", () => ctx.mgmt.getSessionFactsStats(session_id));
            await grab("orchestration_stats", () => ctx.mgmt.getOrchestrationStats(session_id));
            await grab("execution_history", () => ctx.mgmt.getExecutionHistory(session_id, execution_id));
            await grab("child_outcomes", () => ctx.mgmt.listChildOutcomes(session_id));
            await grab("graph_node_usage", () => ctx.mgmt.getSessionGraphNodeUsage(session_id, sinceOpts));
            await grab("graph_edge_search_usage", () => ctx.mgmt.getSessionGraphEdgeSearchUsage(session_id, sinceOpts));
            await grab("graph_searches", () => ctx.mgmt.getSessionGraphSearches(session_id));

            if (Object.keys(errors).length > 0) result.errors = errors;
            return jsonResult(result);
        }),
    );
}
