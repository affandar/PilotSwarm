import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

/**
 * Capability & identity descriptor (proposal G1).
 *
 * Two-layer discovery: conditional tool registration means an absent
 * capability's tools never appear in tools/list; this descriptor explains the
 * shape of what IS present, so clients can plan instead of probe. Flags are
 * frozen at boot (the same per-boot gate used for registration) — a restart
 * picks up provider changes, matching worker semantics.
 */
export function buildCapabilities(ctx: ServerContext) {
    return {
        mode: ctx.webMode ? "web" : "direct",
        admin: ctx.admin,
        // Ownership/visibility posture (security model): the caller's role and
        // whether the deployment enforces per-user session access. When
        // ownership_enforced is true, list_sessions returns only sessions you
        // can read and a send/read to another user's private session is
        // refused with the reason in the error.
        role: ctx.role ?? null,
        ownership_enforced: ctx.authz?.ownershipEnforced ?? false,
        default_visibility: ctx.authz?.defaultVisibility ?? "private",
        // Session groups are private per-user organization: list_session_groups
        // returns only the caller's groups, session views carry viewer_group_id
        // (the caller's own placement), and manage_session_group 'place' needs
        // only read access to the sessions being organized.
        viewerScopedGroups: true,
        facts: {
            search: Boolean(ctx.enhancedFacts?.capabilities.search),
            embedder: Boolean(ctx.enhancedFacts?.capabilities.embedder),
        },
        graph: Boolean(ctx.graph),
        // Optional-method probes on the graph provider — presence differs by
        // provider, not by transport.
        graph_namespaces: Boolean(ctx.graph && typeof (ctx.graph as any).listGraphNamespaces === "function"),
        graph_stats: Boolean(ctx.graph && typeof (ctx.graph as any).graphStats === "function"),
        models_configured: Boolean(ctx.models) || ctx.webMode,
        skills_prompts: ctx.skills.length,
        registered_agents: ctx.registeredAgents.length,
        // Image attachments on send_message/send_and_wait (web mode only —
        // refs are validated against the session's artifact store at the API
        // edge, which direct mode does not run).
        prompt: { imageAttachments: ctx.webMode },
    };
}

export function registerCapabilityTools(server: McpServer, ctx: ServerContext) {
    server.registerTool(
        "get_capabilities",
        {
            title: "Get Capabilities",
            description:
                "Describe this PilotSwarm MCP server's capability surface: mode (web/direct), whether the caller's "
                + "credential carries the admin role, enhanced-facts search/embedder availability, graph availability, "
                + "and counts of registered agents/skills. Use this before planning multi-step operations — tools for "
                + "absent capabilities are not registered at all.",
            inputSchema: {},
        },
        withToolErrors(async () => {
            // Embedded-worker count — live state, fetched fresh (web only).
            // IMPORTANT: this counts workers embedded in the PORTAL process.
            // Deployments running dedicated worker pods report 0 here even
            // with a healthy worker fleet; the truthful per-session signal is
            // worker_claimed on the create_session response.
            let embeddedWorkers: number | null = null;
            if (ctx.api) {
                try {
                    const w: any = await ctx.api.call("getWorkerCount");
                    embeddedWorkers = typeof w === "number" ? w : (w?.count ?? w?.workers ?? null);
                } catch {
                    embeddedWorkers = null;
                }
            }
            let defaultModel: string | null = null;
            try {
                defaultModel = ctx.models
                    ? (ctx.models.defaultModel ?? null)
                    : ((await ctx.mgmt.getDefaultModel()) ?? null);
            } catch {
                defaultModel = null;
            }
            return jsonResult({
                ...buildCapabilities(ctx),
                embedded_workers: embeddedWorkers,
                default_model: defaultModel,
            });
        }),
    );
}
