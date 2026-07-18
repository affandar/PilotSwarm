import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { buildCapabilities } from "../tools/capabilities.js";

export function registerCapabilityResources(server: McpServer, ctx: ServerContext) {
    server.registerResource(
        "capabilities",
        "pilotswarm://capabilities",
        {
            title: "Server Capabilities",
            description:
                "Capability descriptor for this MCP server: mode, admin role, enhanced-facts flags, graph availability, "
                + "and the deployment session-capability catalog summary (capability_catalog; null = not published).",
            mimeType: "application/json",
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    text: JSON.stringify(buildCapabilities(ctx), null, 2),
                    mimeType: "application/json",
                },
            ],
        }),
    );
}
