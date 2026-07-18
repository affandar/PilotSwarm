import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CapabilityCatalog } from "pilotswarm-sdk";
import type { ServerContext } from "../context.js";
import { capabilityOverrideShape } from "../capability-override.js";
import { sessionIdShape } from "../session-id.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Compact catalog summary for the capability descriptor: names and counts
 * only — tool GROUP names with member counts instead of the full tool list
 * (a deployment ships ~70 tools; get_system_status include:['capabilities']
 * serves the full catalog). Null ⇒ the deployment has not published a
 * catalog (no worker yet, or a schema predating it).
 */
function summarizeCapabilityCatalog(catalog: CapabilityCatalog | null | undefined) {
    if (!catalog) return null;
    const toolGroups: Record<string, number> = {};
    let ungrouped = 0;
    for (const tool of catalog.tools ?? []) {
        if (tool.group) toolGroups[tool.group] = (toolGroups[tool.group] ?? 0) + 1;
        else ungrouped += 1;
    }
    return {
        mcp_servers: (catalog.mcpServers ?? []).map((s) => ({ name: s.name, is_default: s.isDefault })),
        skills: (catalog.skills ?? []).map((s) => s.name),
        tool_count: (catalog.tools ?? []).length,
        tool_groups: toolGroups,
        ...(ungrouped > 0 ? { ungrouped_tools: ungrouped } : {}),
        agents_with_defaults: Object.keys(catalog.agentDefaults ?? {}),
    };
}

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
        // Deployment capability catalog summary (capability-profiles): the
        // valid-name universe for create_session/configure_session overrides.
        // Null = the deployment has not published a catalog.
        capability_catalog: summarizeCapabilityCatalog(ctx.capabilityCatalog ?? null),
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
                + "absent capabilities are not registered at all. Also carries capability_catalog, a summary of the "
                + "deployment's SESSION capability catalog (MCP server names with default flags, skill names, tool "
                + "GROUP names with member counts, agents with declared defaults) — the valid names for create_session "
                + "capabilities and configure_session; null = not published by any worker. Full catalog: "
                + "get_system_status (include: ['capabilities']).",
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

    // configure_session — per-tree capability override (capability-profiles
    // Phase 4). Dual-registered like switch_model, but the override op is a
    // Web API surface only: direct mode (test-only topology) has no
    // supported path and returns a clear error instead of half-working.
    server.registerTool(
        "configure_session",
        {
            title: "Configure Session",
            description:
                "Reconfigure a session's capabilities (MCP servers, skills, tools) with an enable/disable override on "
                + "top of the bound agent's profile. Discover valid names first via get_capabilities "
                + "(capability_catalog summary) or get_system_status (include: ['capabilities'], full catalog); tools "
                + "entries may be individual tool names or tool GROUP names (a group expands to its members; an "
                + "individual entry overrides its group; disable wins over enable). Pass capabilities: null to clear "
                + "the override. Changes apply on the session's NEXT turn and cascade to the ENTIRE session tree (the "
                + "override is stored on the tree root). Web API mode only. Read the stored override back with "
                + "get_session_detail.",
            inputSchema: {
                session_id: sessionIdShape().describe("Any session in the tree — the override is stored on the tree root"),
                capabilities: capabilityOverrideShape()
                    .nullable()
                    .describe("The capability override to store, or null to clear it"),
            },
        },
        withToolErrors(async ({ session_id, capabilities }) => {
            if (!ctx.api) {
                return errorResult(
                    "configure_session requires Web API mode (run the MCP server with --api-url). "
                    + "Direct mode is a test-only topology with no capability-override surface.",
                );
            }
            const result = await ctx.api.call("configureSession", {
                sessionId: session_id,
                capabilities: capabilities ?? null,
            });
            return jsonResult({
                ...(result && typeof result === "object" ? result : { result }),
                note: "Capability changes apply on the session's next turn and cascade to the whole session tree.",
            });
        }),
    );
}
