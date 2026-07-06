import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Session-group tools (proposal G5). Groups are the fleet-batching primitive:
 * create N sessions in a group, then cancel/complete the group as a unit.
 * Seven write routes consolidate into one action-dispatched tool to keep
 * tool-count growth sane.
 */
export function registerGroupTools(server: McpServer, ctx: ServerContext) {
    server.registerTool(
        "list_session_groups",
        {
            title: "List Session Groups",
            description:
                "List PilotSwarm session groups. Set include_sessions to also return each group's member sessions "
                + "(derived from list_sessions filtered by group).",
            inputSchema: {
                include_sessions: z.boolean().optional().describe("Also return member sessions per group (default false)"),
            },
        },
        withToolErrors(async ({ include_sessions }) => {
            const groups = await ctx.mgmt.listSessionGroups();
            if (!include_sessions) {
                return jsonResult({ count: groups.length, groups });
            }
            // Group membership rides on the session views — one listSessions
            // call covers every group (listGroupSessions is direct-mode-only).
            const sessions = await ctx.mgmt.listSessions();
            const byGroup = new Map<string, any[]>();
            for (const s of sessions as any[]) {
                const gid = s.groupId ?? s.sessionGroupId ?? null;
                if (!gid) continue;
                const arr = byGroup.get(gid) ?? [];
                arr.push({ session_id: s.sessionId, title: s.title ?? null, status: s.status });
                byGroup.set(gid, arr);
            }
            const enriched = (groups as any[]).map((g) => ({
                ...g,
                sessions: byGroup.get(g.groupId ?? g.id) ?? [],
            }));
            return jsonResult({ count: enriched.length, groups: enriched });
        }),
    );

    server.registerTool(
        "manage_session_group",
        {
            title: "Manage Session Group",
            description:
                "Session-group lifecycle, dispatched by action:\n"
                + "  create   — create a group (title required)\n"
                + "  update   — patch title/description (group_id required)\n"
                + "  assign   — assign session_ids to group_id\n"
                + "  move     — move session_ids to group_id (null/omitted group_id = ungroup)\n"
                + "  cancel   — cancel every session in the group\n"
                + "  complete — complete every session in the group\n"
                + "  delete   — delete an EMPTY group (move sessions out first)",
            inputSchema: {
                action: z.enum(["create", "update", "assign", "move", "cancel", "complete", "delete"]).describe("The operation to perform"),
                group_id: z.string().optional().describe("Target group (required for all actions except create; optional for move = ungroup)"),
                title: z.string().optional().describe("Group title (create/update)"),
                description: z.string().optional().describe("Group description (create/update)"),
                session_ids: z.array(z.string()).optional().describe("Sessions to assign/move"),
                reason: z.string().optional().describe("Reason (cancel/complete/delete)"),
            },
        },
        withToolErrors(async ({ action, group_id, title, description, session_ids, reason }) => {
            switch (action) {
                case "create": {
                    if (!title) return errorResult("create requires title");
                    const group = await ctx.mgmt.createSessionGroup({ title, description });
                    return jsonResult({ created: true, group });
                }
                case "update": {
                    if (!group_id) return errorResult("update requires group_id");
                    const group = await ctx.mgmt.updateSessionGroup(group_id, { title, description });
                    return jsonResult({ updated: true, group });
                }
                case "assign": {
                    if (!group_id) return errorResult("assign requires group_id");
                    if (!session_ids?.length) return errorResult("assign requires session_ids");
                    await ctx.mgmt.assignSessionsToGroup(group_id, session_ids);
                    return jsonResult({ assigned: true, group_id, session_ids });
                }
                case "move": {
                    if (!session_ids?.length) return errorResult("move requires session_ids");
                    await ctx.mgmt.moveSessionsToGroup(group_id ?? null, session_ids);
                    return jsonResult({ moved: true, group_id: group_id ?? null, session_ids });
                }
                case "cancel": {
                    if (!group_id) return errorResult("cancel requires group_id");
                    await ctx.mgmt.cancelSessionGroup(group_id, reason);
                    return jsonResult({ cancelled: true, group_id });
                }
                case "complete": {
                    if (!group_id) return errorResult("complete requires group_id");
                    await ctx.mgmt.completeSessionGroup(group_id, reason ? { reason } : undefined);
                    return jsonResult({ completed: true, group_id });
                }
                case "delete": {
                    if (!group_id) return errorResult("delete requires group_id");
                    await ctx.mgmt.deleteSessionGroup(group_id, reason);
                    return jsonResult({ deleted: true, group_id });
                }
            }
        }),
    );
}
