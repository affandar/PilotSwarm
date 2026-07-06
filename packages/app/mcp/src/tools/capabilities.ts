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
