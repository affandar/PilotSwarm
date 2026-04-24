import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

const SYSTEM_AGENTS = ["sweeper", "resourcemgr", "facts-manager"] as const;

async function resolveSystemAgent(ctx: ServerContext, agentId: string) {
    const sessions = await ctx.mgmt.listSessions();
    return sessions.find(
        (s: any) => s.isSystem && s.agentId === agentId,
    ) ?? null;
}

export function registerAgentResources(server: McpServer, ctx: ServerContext) {
    for (const agentId of SYSTEM_AGENTS) {
        // Detail resource for each system agent
        server.registerResource(
            `agent-${agentId}`,
            `pilotswarm://agents/${agentId}`,
            {
                description: `System agent detail: ${agentId} — status, last activity, iterations, error state`,
                mimeType: "application/json",
            },
            async (uri) => {
                const agent = await resolveSystemAgent(ctx, agentId);
                if (!agent) {
                    return {
                        contents: [{
                            uri: uri.href,
                            text: JSON.stringify({ error: `System agent '${agentId}' not found or not running` }),
                            mimeType: "application/json",
                        }],
                    };
                }

                const detail = await ctx.mgmt.getSession((agent as any).sessionId);
                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify(detail, null, 2),
                        mimeType: "application/json",
                    }],
                };
            },
        );

        // Events resource for each system agent
        server.registerResource(
            `agent-${agentId}-events`,
            `pilotswarm://agents/${agentId}/events`,
            {
                description: `Event stream for system agent: ${agentId}`,
                mimeType: "application/json",
            },
            async (uri) => {
                const agent = await resolveSystemAgent(ctx, agentId);
                if (!agent) {
                    return {
                        contents: [{
                            uri: uri.href,
                            text: JSON.stringify({ error: `System agent '${agentId}' not found or not running` }),
                            mimeType: "application/json",
                        }],
                    };
                }

                const events = await ctx.mgmt.getSessionEvents(
                    (agent as any).sessionId,
                    undefined,
                    100,
                );
                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify(events, null, 2),
                        mimeType: "application/json",
                    }],
                };
            },
        );
    }
}
