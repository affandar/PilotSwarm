import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import {
    CommandRejectedError,
    CommandTimeoutError,
    sendCommandAndWait,
} from "../util/command.js";

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

                // SDK ModelDescriptor exposes `qualifiedName` (provider:model)
                // and `modelName` (the bare model id). There is no `name`
                // field — emitting `m.name` would silently produce
                // `{ name: undefined, ... }` payloads, leaving callers no
                // identifier to pass back into switch_model.
                const byProvider = ctx.models.getModelsByProvider();

                if (group_by_provider) {
                    const grouped = byProvider.map((p) => ({
                        provider_id: p.providerId,
                        type: p.type,
                        models: p.models.map((m) => ({
                            qualified_name: m.qualifiedName,
                            model_name: m.modelName,
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
                const models = byProvider.flatMap((p) =>
                    p.models.map((m) => ({
                        qualified_name: m.qualifiedName,
                        model_name: m.modelName,
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
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Max time to wait for the orchestration to acknowledge the switch (default 15000)"),
            },
        },
        async ({ session_id, model, timeout_ms }) => {
            try {
                // Wait for the orchestration's command response so we don't
                // claim success when the orchestration rejects the command
                // (e.g. unknown model, set_model not allowed mid-turn).
                const response = await sendCommandAndWait(
                    ctx.mgmt,
                    session_id,
                    "set_model",
                    { model },
                    { timeoutMs: timeout_ms },
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                switched: true,
                                model,
                                command_id: response.id,
                                ...(response.result !== undefined ? { result: response.result } : {}),
                            }),
                        },
                    ],
                };
            } catch (err: unknown) {
                if (err instanceof CommandRejectedError) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({
                                    switched: false,
                                    error: err.message,
                                    command: err.cmd,
                                    command_id: err.cmdId,
                                }),
                            },
                        ],
                        isError: true,
                    };
                }
                if (err instanceof CommandTimeoutError) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({
                                    switched: false,
                                    error: err.message,
                                    timeout_ms: err.timeoutMs,
                                }),
                            },
                        ],
                        isError: true,
                    };
                }
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // 3. send_command — Send an arbitrary orchestration command
    server.registerTool(
        "send_command",
        {
            title: "Send Command",
            description:
                "Send an orchestration command to a PilotSwarm session and wait for the orchestration's response. " +
                "Recognized commands: set_model, list_models, get_info, done, cancel, delete. " +
                "Unknown commands are rejected by the orchestration and surfaced as MCP errors.",
            inputSchema: {
                session_id: z.string().describe("The session to send the command to"),
                command: z.string().describe("The command name to send"),
                args: z
                    .record(z.string(), z.any())
                    .optional()
                    .describe("Optional arguments for the command"),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Max time to wait for the orchestration's response (default 15000)"),
            },
        },
        async ({ session_id, command, args, timeout_ms }) => {
            try {
                const response = await sendCommandAndWait(
                    ctx.mgmt,
                    session_id,
                    command,
                    args,
                    { timeoutMs: timeout_ms },
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                sent: true,
                                command,
                                command_id: response.id,
                                ...(response.result !== undefined ? { result: response.result } : {}),
                            }),
                        },
                    ],
                };
            } catch (err: unknown) {
                if (err instanceof CommandRejectedError) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({
                                    sent: false,
                                    error: err.message,
                                    command: err.cmd,
                                    command_id: err.cmdId,
                                }),
                            },
                        ],
                        isError: true,
                    };
                }
                if (err instanceof CommandTimeoutError) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({
                                    sent: false,
                                    error: err.message,
                                    timeout_ms: err.timeoutMs,
                                }),
                            },
                        ],
                        isError: true,
                    };
                }
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );
}
