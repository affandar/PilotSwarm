import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Session-group tools (proposal G5). Groups are each user's PRIVATE
 * organization of sessions: placements are viewer-scoped, so organizing a
 * session into your group never changes what anyone else sees. Seven write
 * routes consolidate into one action-dispatched tool to keep tool-count
 * growth sane.
 */
export function registerGroupTools(server: McpServer, ctx: ServerContext) {
    server.registerTool(
        "list_session_groups",
        {
            title: "List Session Groups",
            description:
                "List YOUR PilotSwarm session groups (groups are private per-user organization; other users' groups "
                + "are never returned). Set include_sessions to also return the sessions you placed in each group "
                + "(derived from list_sessions' viewer_group_id).",
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
                const gid = s.viewerGroupId ?? null;
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

    // Viewer-private placement. Web mode: the server derives the placing
    // viewer from the credential. Direct mode (admin/test-only) carries no
    // request principal, so it routes through the deprecated alias, which
    // places for the target group's owner (or clears each session owner's
    // placement when ungrouping).
    const placeSessions = async (groupId: string | null, sessionIds: string[]) => {
        if (ctx.webMode) {
            return await (ctx.mgmt as any).placeSessionsInGroup(sessionIds, groupId);
        }
        return await (ctx.mgmt as any).moveSessionsToGroup(groupId, sessionIds);
    };

    server.registerTool(
        "manage_session_group",
        {
            title: "Manage Session Group",
            description:
                "Session-group lifecycle, dispatched by action. Groups are YOUR private per-user organization: "
                + "placing a session only changes how it appears to you, read access to a session suffices to place "
                + "it, and recipients of shared sessions organize them into their own groups.\n"
                + "  create   — create a group (title required)\n"
                + "  update   — patch title/description (group_id required)\n"
                + "  place    — place session_ids' trees into your group_id (null/omitted group_id = ungroup); "
                + "returns per-root {rootSessionId, placed, reason}\n"
                + "  assign   — deprecated alias of place (group_id required)\n"
                + "  move     — deprecated alias of place (null/omitted group_id = ungroup)\n"
                + "  cancel   — deprecated: cancel every session in the group\n"
                + "  complete — deprecated: complete every session in the group\n"
                + "  delete   — delete one of your groups (its placements are cleared; sessions are untouched)",
            inputSchema: {
                action: z.enum(["create", "update", "place", "assign", "move", "cancel", "complete", "delete"]).describe("The operation to perform"),
                group_id: z.string().optional().describe("Target group (required for all actions except create; optional for place/move = ungroup)"),
                title: z.string().optional().describe("Group title (create/update)"),
                description: z.string().optional().describe("Group description (create/update)"),
                session_ids: z.array(z.string()).optional().describe("Sessions to place/assign/move"),
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
                case "place": {
                    if (!session_ids?.length) return errorResult("place requires session_ids");
                    const results = await placeSessions(group_id ?? null, session_ids);
                    return jsonResult({ placed: true, group_id: group_id ?? null, results: results ?? null });
                }
                case "assign": {
                    if (!group_id) return errorResult("assign requires group_id");
                    if (!session_ids?.length) return errorResult("assign requires session_ids");
                    const results = await placeSessions(group_id, session_ids);
                    return jsonResult({ assigned: true, group_id, session_ids, results: results ?? null });
                }
                case "move": {
                    if (!session_ids?.length) return errorResult("move requires session_ids");
                    const results = await placeSessions(group_id ?? null, session_ids);
                    return jsonResult({ moved: true, group_id: group_id ?? null, session_ids, results: results ?? null });
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
