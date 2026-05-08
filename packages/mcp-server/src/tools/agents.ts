import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";

export function registerAgentTools(server: McpServer, ctx: ServerContext) {
    // list_agents — List all sub-agents across sessions (read-only inspection).
    //
    // The external MCP surface deliberately does NOT expose action tools for
    // sub-agents (spawn / message / cancel). Sub-agent lifecycle belongs to
    // the parent session's reasoning loop and is reachable only via the
    // in-loop `ps_spawn_agent` tool. See `packages/mcp-server/README.md`
    // section "External MCP boundary" for the full rule.
    server.registerTool(
        "list_agents",
        {
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
}
