import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";

export function registerModelTools(server: McpServer, ctx: ServerContext) {
    // 1. list_models — List all available models
    server.registerTool(
        "list_models",
        {
            title: "List Models",
            description: "List all available LLM models, optionally grouped by provider",
            inputSchema: {
                group_by_provider: z
                    .boolean()
                    .optional()
                    .describe("If true, return models grouped by provider (default: flat list)"),
            },
        },
        async ({ group_by_provider }) => {
            try {
                if (!ctx.models) {
                    return {
                        content: [
                            { type: "text" as const, text: JSON.stringify({ error: "no model providers configured" }) },
                        ],
                        isError: true,
                    };
                }

                const byProvider = ctx.models.getModelsByProvider();

                if (group_by_provider) {
                    const grouped = byProvider.map((p: any) => ({
                        provider_id: p.providerId,
                        type: p.type,
                        models: p.models.map((m: any) => ({
                            name: m.name,
                            description: m.description,
                            cost: m.cost,
                        })),
                    }));
                    return {
                        content: [
                            { type: "text" as const, text: JSON.stringify({ providers: grouped }, null, 2) },
                        ],
                    };
                }

                // Flat list
                const models = byProvider.flatMap((p: any) =>
                    p.models.map((m: any) => ({
                        name: m.name,
                        provider: p.providerId,
                        description: m.description,
                        cost: m.cost,
                    })),
                );
                const defaultModel = ctx.models.defaultModel ?? null;
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({ models, default_model: defaultModel, count: models.length }, null, 2),
                        },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // 2. switch_model — Change the model for a session
    server.registerTool(
        "switch_model",
        {
            title: "Switch Model",
            description: "Change the model for a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to switch the model for"),
                model: z.string().describe("The model to switch to"),
            },
        },
        async ({ session_id, model }) => {
            try {
                await ctx.mgmt.sendCommand(session_id, {
                    cmd: "set_model",
                    id: `model-${Date.now()}`,
                    args: { model },
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({ switched: true, model }),
                        },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // 2. send_command — Send an arbitrary orchestration command
    server.registerTool(
        "send_command",
        {
            title: "Send Command",
            description: "Send an arbitrary orchestration command to a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to send the command to"),
                command: z.string().describe("The command name to send"),
                args: z
                    .record(z.string(), z.any())
                    .optional()
                    .describe("Optional arguments for the command"),
            },
        },
        async ({ session_id, command, args }) => {
            try {
                await ctx.mgmt.sendCommand(session_id, {
                    cmd: command,
                    id: `cmd-${Date.now()}`,
                    args,
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({ sent: true, command }),
                        },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );
}
