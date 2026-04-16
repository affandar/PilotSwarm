import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

export function registerModelsResources(server: McpServer, ctx: ServerContext) {
    server.registerResource(
        "models-list",
        "pilotswarm://models",
        {
            title: "Models List",
            description: "Available LLM models grouped by provider",
            mimeType: "application/json",
        },
        async () => {
            if (!ctx.models) {
                return {
                    contents: [
                        {
                            uri: "pilotswarm://models",
                            text: JSON.stringify({ error: "no model providers configured" }),
                            mimeType: "application/json",
                        },
                    ],
                };
            }

            const byProvider = ctx.models.getModelsByProvider();
            const data = byProvider.map((p: any) => ({
                provider_id: p.providerId,
                type: p.type,
                models: p.models.map((m: any) => ({
                    name: m.name,
                    description: m.description,
                    cost: m.cost,
                })),
            }));

            return {
                contents: [
                    {
                        uri: "pilotswarm://models",
                        text: JSON.stringify(data, null, 2),
                        mimeType: "application/json",
                    },
                ],
            };
        },
    );
}
