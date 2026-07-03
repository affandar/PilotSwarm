import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";

export function registerAgentTools(server: McpServer, ctx: ServerContext) {
    // list_agents — List all sub-agents across sessions (read-only inspection).
    //
    // The external MCP surface deliberately does NOT expose action tools for
    // sub-agents — spawn_agent / message_agent / cancel_agent are reachable
    // only from inside the parent session's reasoning loop, via the
    // in-loop `spawn_agent` tool and related orchestration commands. See
    // `packages/app/mcp/README.md` section "External MCP boundary" for
    // the full rule.
    server.registerTool(
        "list_agents",
        {
            title: "List Sub-Agents",
            description:
                "List all sub-agents (child sessions) across PilotSwarm. Shows agent name, status, model, parent session, and task context. " +
                "Optionally filter by parent session or status.",
            inputSchema: {
                parent_session_id: z
                    .string()
                    .optional()
                    .describe("Filter agents belonging to a specific parent session"),
                status_filter: z
                    .string()
                    .optional()
                    .describe("Filter by status (running, idle, waiting, completed, failed)"),
            },
        },
        async ({ parent_session_id, status_filter }) => {
            try {
                const sessions = await ctx.mgmt.listSessions();

                // Agents are sessions with a parentSessionId
                let agents = sessions.filter((s: any) => s.parentSessionId);

                if (parent_session_id) {
                    agents = agents.filter((s: any) => s.parentSessionId === parent_session_id);
                }
                if (status_filter) {
                    const f = status_filter.toLowerCase();
                    agents = agents.filter((s: any) => s.status?.toLowerCase() === f);
                }

                const data = agents.map((s: any) => ({
                    agent_session_id: s.sessionId,
                    agent_id: s.agentId ?? null,
                    title: s.title ?? null,
                    status: s.status,
                    orchestration_status: s.orchestrationStatus ?? null,
                    model: s.model ?? "default",
                    parent_session_id: s.parentSessionId,
                    is_system: s.isSystem ?? false,
                    iterations: s.iterations ?? 0,
                    wait_reason: s.waitReason ?? null,
                    error: s.error ?? null,
                    created_at: s.createdAt,
                    updated_at: s.updatedAt ?? null,
                }));

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                { count: data.length, agents: data },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );

    // list_registered_agents — Read PilotSwarm's catalog of agent definitions.
    //
    // Returns agent definitions visible to this MCP server (loaded from
    // configured plugin dirs). Pure read; no creation affordance — external
    // MCP clients cannot spawn from this. Workers in different processes
    // may have a different catalog because plugin dirs are configured
    // per-process; this tool reports only what this MCP server sees.
    server.registerTool(
        "list_registered_agents",
        {
            title: "List Registered Agents",
            description:
                "Read PilotSwarm's catalog of registered agent definitions visible to this MCP server. " +
                "Returns name, description, system flag, and parent constraint per definition. " +
                "Pure inspection — does not create or spawn anything. Workers in different processes " +
                "may have a different catalog (configured per-process via --plugin).",
            inputSchema: {
                include_system: z
                    .boolean()
                    .optional()
                    .describe("Include system agent definitions like sweeper, resourcemgr (default false)"),
            },
        },
        async ({ include_system }) => {
            try {
                let agents = ctx.registeredAgents;
                if (!include_system) {
                    agents = agents.filter((a) => !a.system);
                }

                const data = agents.map((a) => ({
                    name: a.name,
                    title: a.title ?? null,
                    description: a.description ?? null,
                    system: Boolean(a.system),
                    parent: a.parent ?? null,
                }));

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({ count: data.length, agents: data }, null, 2),
                        },
                    ],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );

    // get_agent_tree — Recursive subtree of a root session.
    //
    // One mgmt.listSessions() call, then in-memory depth-first walk over
    // the parent_session_id graph. Cycle-defensive via visited Set, bounded
    // by max_depth.
    server.registerTool(
        "get_agent_tree",
        {
            title: "Get Agent Tree",
            description:
                "Recursive sub-agent tree rooted at the given session. " +
                "Returns nested children with status, agent_id, depth. " +
                "Bounded by max_depth (default 5). " +
                "include_system filters system descendants; the root session is always returned regardless.",
            inputSchema: {
                root_session_id: z
                    .string()
                    .min(1)
                    .describe(
                        "Root session id to walk from (top-level or any sub-agent). " +
                        "Accepts any non-empty string; PilotSwarm system-agent UUIDs are not strictly RFC-4122 compliant.",
                    ),
                max_depth: z
                    .number()
                    .int()
                    .min(0)
                    .max(20)
                    .optional()
                    .describe("Maximum recursion depth (default 5)"),
                include_system: z
                    .boolean()
                    .optional()
                    .describe("Include system sub-agents in the tree (default true)"),
            },
        },
        async ({ root_session_id, max_depth, include_system }) => {
            try {
                const limit = max_depth ?? 5;
                const includeSystem = include_system ?? true;
                const sessions = await ctx.mgmt.listSessions();

                // Index children by parentSessionId
                const childrenByParent = new Map<string, any[]>();
                const sessionById = new Map<string, any>();
                for (const s of sessions as any[]) {
                    sessionById.set(s.sessionId, s);
                    if (s.parentSessionId) {
                        const arr = childrenByParent.get(s.parentSessionId) ?? [];
                        arr.push(s);
                        childrenByParent.set(s.parentSessionId, arr);
                    }
                }

                const root = sessionById.get(root_session_id);
                if (!root) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({
                                    error: "session not found",
                                    root_session_id,
                                }),
                            },
                        ],
                        isError: true,
                    };
                }

                const visited = new Set<string>();
                let totalNodes = 0;
                let depthReached = 0;

                const buildNode = (s: any, depth: number): any => {
                    if (visited.has(s.sessionId)) {
                        return { session_id: s.sessionId, agent_id: s.agentId ?? null, status: s.status, depth, children: [], cycle_detected: true };
                    }
                    visited.add(s.sessionId);
                    totalNodes++;
                    if (depth > depthReached) depthReached = depth;

                    let childNodes: any[] = [];
                    if (depth < limit) {
                        const kids = childrenByParent.get(s.sessionId) ?? [];
                        childNodes = kids
                            .filter((c) => includeSystem || !c.isSystem)
                            .map((c) => buildNode(c, depth + 1));
                    }

                    return {
                        session_id: s.sessionId,
                        agent_id: s.agentId ?? null,
                        title: s.title ?? null,
                        status: s.status,
                        is_system: Boolean(s.isSystem),
                        depth,
                        children: childNodes,
                    };
                };

                const tree = buildNode(root, 0);

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                { root_session_id, depth_reached: depthReached, total_nodes: totalNodes, tree },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );

    // get_session_tree_stats — Aggregated metrics over a session subtree.
    // Wraps mgmt.getSessionTreeStats() and snake_cases the field names.
    server.registerTool(
        "get_session_tree_stats",
        {
            title: "Get Session Tree Stats",
            description:
                "Aggregated metrics for a session and all its descendants: token totals, " +
                "session count, dehydration / hydration counts, per-model breakdown, cache hit ratio. " +
                "Pure inspection.",
            inputSchema: {
                session_id: z
                    .string()
                    .min(1)
                    .describe(
                        "Root session id of the subtree. Accepts any non-empty string; " +
                        "PilotSwarm system-agent UUIDs are not strictly RFC-4122 compliant.",
                    ),
            },
        },
        async ({ session_id }) => {
            try {
                const stats = await ctx.mgmt.getSessionTreeStats(session_id);
                if (!stats) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({ error: "session not found", session_id }),
                            },
                        ],
                        isError: true,
                    };
                }

                const out = {
                    root_session_id: stats.rootSessionId,
                    self: {
                        session_id: stats.self.sessionId,
                        agent_id: stats.self.agentId ?? null,
                        model: stats.self.model ?? null,
                        reasoning_effort: stats.self.reasoningEffort ?? null,
                        parent_session_id: stats.self.parentSessionId ?? null,
                        snapshot_size_bytes: stats.self.snapshotSizeBytes,
                        dehydration_count: stats.self.dehydrationCount,
                        hydration_count: stats.self.hydrationCount,
                        lossy_handoff_count: stats.self.lossyHandoffCount,
                        last_dehydrated_at: stats.self.lastDehydratedAt ?? null,
                        last_hydrated_at: stats.self.lastHydratedAt ?? null,
                        last_checkpoint_at: stats.self.lastCheckpointAt ?? null,
                        tokens_input: stats.self.tokensInput,
                        tokens_output: stats.self.tokensOutput,
                        tokens_cache_read: stats.self.tokensCacheRead,
                        tokens_cache_write: stats.self.tokensCacheWrite,
                        cache_hit_ratio: stats.self.cacheHitRatio,
                        deleted_at: stats.self.deletedAt ?? null,
                        created_at: stats.self.createdAt,
                        updated_at: stats.self.updatedAt,
                    },
                    tree: {
                        session_count: stats.tree.sessionCount,
                        total_tokens_input: stats.tree.totalTokensInput,
                        total_tokens_output: stats.tree.totalTokensOutput,
                        total_tokens_cache_read: stats.tree.totalTokensCacheRead,
                        total_tokens_cache_write: stats.tree.totalTokensCacheWrite,
                        cache_hit_ratio: stats.tree.cacheHitRatio,
                        total_dehydration_count: stats.tree.totalDehydrationCount,
                        total_hydration_count: stats.tree.totalHydrationCount,
                        total_lossy_handoff_count: stats.tree.totalLossyHandoffCount,
                        total_snapshot_size_bytes: stats.tree.totalSnapshotSizeBytes,
                    },
                    by_model: stats.byModel.map((m) => ({
                        model: m.model,
                        session_count: m.sessionCount,
                        total_tokens_input: m.totalTokensInput,
                        total_tokens_output: m.totalTokensOutput,
                        total_tokens_cache_read: m.totalTokensCacheRead,
                        total_tokens_cache_write: m.totalTokensCacheWrite,
                        total_snapshot_size_bytes: m.totalSnapshotSizeBytes,
                        cache_hit_ratio: m.cacheHitRatio,
                    })),
                };

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(out, null, 2),
                        },
                    ],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );
}
