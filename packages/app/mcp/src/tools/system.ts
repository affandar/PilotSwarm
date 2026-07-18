import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Ops preflight & system tools (proposal G7).
 *
 *   get_system_status       workers / log config / session policy / creatable agents
 *   restart_system_session  bounce sweeper, resourcemgr, ... [admin]
 *   facts_admin             purge tombstoned facts, prune deleted summaries [admin]
 *
 * get_system_status turns the `no_worker_claimed` create_session failure into
 * a preflight check: workers === 0 means don't bother creating sessions yet.
 */
export function registerSystemTools(server: McpServer, ctx: ServerContext) {
    // Web-mode only: worker count / log config / policy / agents are Web API
    // operations with no direct-mode equivalent.
    if (ctx.api) {
        server.registerTool(
            "get_system_status",
            {
                title: "Get System Status",
                description:
                    "Deployment status: embedded-worker count (workers running inside the portal process — dedicated "
                    + "worker pods report 0 here and that is normal), session-creation policy, creatable agents, "
                    + "log-tail availability, and the FULL deployment capability catalog (include: ['capabilities'] — "
                    + "every MCP server, skill, and tool with its group, plus per-agent defaults; null = no worker has "
                    + "published one; use with configure_session or create_session capabilities). include narrows the "
                    + "fetch (default all).",
                inputSchema: {
                    include: z
                        .array(z.enum(["workers", "policy", "agents", "log_config", "capabilities"]))
                        .optional()
                        .describe("Axes to fetch (default all)"),
                },
            },
            withToolErrors(async ({ include }) => {
                const wants = new Set(include ?? ["workers", "policy", "agents", "log_config", "capabilities"]);
                const result: Record<string, unknown> = {};
                const errors: Record<string, string> = {};

                const grab = async (key: string, fn: () => Promise<unknown>) => {
                    try {
                        result[key] = await fn();
                    } catch (err: unknown) {
                        errors[key] = err instanceof Error ? err.message : String(err);
                    }
                };

                if (wants.has("workers")) {
                    await grab("workers", async () => {
                        const w: any = await ctx.api!.call("getWorkerCount");
                        const count = typeof w === "number" ? w : (w?.count ?? null);
                        return {
                            embedded_count: count,
                            note: "Counts workers embedded in the portal process only. Deployments with dedicated worker pods report 0 here — use worker_claimed on create_session responses for per-run liveness.",
                        };
                    });
                }
                if (wants.has("policy")) await grab("policy", () => ctx.api!.call("getSessionCreationPolicy"));
                if (wants.has("agents")) await grab("agents", () => ctx.api!.call("listCreatableAgents"));
                if (wants.has("log_config")) await grab("log_config", () => ctx.api!.call("getLogConfig"));
                if (wants.has("capabilities")) {
                    await grab("capabilities", async () => {
                        // Live re-fetch (not the boot-frozen ctx copy) so a
                        // worker publishing after MCP boot is visible.
                        const boot: any = await ctx.api!.getBootstrap();
                        return boot?.capabilityCatalog ?? null;
                    });
                }

                if (Object.keys(errors).length > 0) result.errors = errors;
                return jsonResult(result);
            }),
        );
    }

    // restart_system_session — [admin] disruptive lifecycle operation on the
    // deployment's system agents (sweeper, resourcemgr, ...).
    if (ctx.admin) {
        server.registerTool(
            "restart_system_session",
            {
                title: "Restart System Session",
                description:
                    "Restart a system session (sweeper, resourcemgr, ...) by agent id or session id. disposition "
                    + "controls what happens to the old session: complete (graceful), terminate, or hard_delete. [admin]",
                inputSchema: {
                    agent_or_session_id: z.string().min(1).describe("System agent id (e.g. 'sweeper') or its session id"),
                    disposition: z.enum(["complete", "terminate", "hard_delete"]).describe("How to dispose of the old session"),
                    reason: z.string().optional().describe("Reason recorded on the restart"),
                },
            },
            withToolErrors(async ({ agent_or_session_id, disposition, reason }) => {
                const result = await ctx.mgmt.restartSystemSession(agent_or_session_id, { disposition, reason } as any);
                // The system-agent set may have changed identity; refresh the
                // dynamic resource registrations' source of truth.
                await ctx.refreshSystemAgentIds();
                return jsonResult({ restarted: true, ...(result && typeof result === "object" ? result : {}) });
            }),
        );

        // facts_admin — destructive housekeeping, action-dispatched.
        server.registerTool(
            "facts_admin",
            {
                title: "Facts Admin",
                description:
                    "Administrative facts housekeeping. action: 'purge' force-purges soft-deleted (tombstoned) facts; "
                    + "'prune_summaries' prunes summaries of deleted sessions older than a cutoff. Both DESTRUCTIVE. [admin]",
                inputSchema: {
                    action: z.enum(["purge", "prune_summaries"]).describe("The housekeeping operation"),
                    cutoff: z.string().describe("ISO timestamp — purge/prune anything soft-deleted before this"),
                    key_prefix: z.string().optional().describe("purge: restrict to keys under this prefix"),
                    only_unreconciled: z.boolean().optional().describe("purge: only facts whose graph evidence is not yet reconciled"),
                    limit: z.number().int().positive().optional().describe("purge: max rows per call"),
                },
            },
            withToolErrors(async ({ action, cutoff, key_prefix, only_unreconciled, limit }) => {
                const cutoffDate = new Date(cutoff);
                if (Number.isNaN(cutoffDate.getTime())) return errorResult("cutoff must be a valid ISO timestamp");
                if (action === "purge") {
                    const purged = await ctx.facts.forcePurgeFacts({
                        cutoff: cutoffDate,
                        keyPrefix: key_prefix,
                        onlyUnreconciled: only_unreconciled,
                        limit,
                    });
                    return jsonResult({ purged });
                }
                const pruned = await ctx.mgmt.pruneDeletedSummaries(cutoffDate);
                return jsonResult({ pruned });
            }),
        );
    }
}
