import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

export function registerModelsResources(server: McpServer, ctx: ServerContext) {
    server.registerResource(
        "models-list",
        "pilotswarm://models",
        {
            title: "Models List",
            description:
                "Available LLM models grouped by provider. Each model entry exposes " +
                "`qualified_name` (provider:model — pass to switch_model), `model_name` " +
                "(bare id), `provider`, `description`, and `cost`.",
            mimeType: "application/json",
        },
        async () => {
            const models = await ctx.mgmt.listRuntimeModels({ principal: null, isAdmin: ctx.admin });
            if (!models.length) {
                return {
                    contents: [
                        {
                            uri: "pilotswarm://models",
                            text: JSON.stringify({ error: "no usable model providers for this credential" }),
                            mimeType: "application/json",
                        },
                    ],
                };
            }

            const grouped = new Map<string, { provider_id: string; type: string; models: any[] }>();
            for (const model of models) {
                const provider = model.providerId;
                const group = grouped.get(provider) || {
                    provider_id: provider,
                    type: model.providerType || provider,
                    models: [],
                };
                group.models.push({
                    qualified_name: model.qualifiedName,
                    model_name: model.modelName,
                    provider,
                    description: model.description,
                    cost: model.cost,
                });
                grouped.set(provider, group);
            }
            const data = [...grouped.values()];

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
