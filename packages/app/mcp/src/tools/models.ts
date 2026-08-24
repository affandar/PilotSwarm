import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import {
    CommandRejectedError,
    CommandTimeoutError,
    sendCommandAndWait,
} from "../util/command.js";
import { errorToResult } from "../util/respond.js";

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
                // Runtime provider INSTANCES. Web mode derives the viewer from
                // the MCP credential server-side; direct mode has no user
                // principal and therefore sees shared providers only.
                const viewer = { principal: null, isAdmin: ctx.admin };
                const models = await ctx.mgmt.listRuntimeModels(viewer);
                if (!models || models.length === 0) {
                    return {
                        content: [
                            { type: "text" as const, text: JSON.stringify({ error: "no usable model providers for this credential" }) },
                        ],
                        isError: true,
                    };
                }

                // SDK ModelDescriptor exposes `qualifiedName` (provider:model)
                // and `modelName` (the bare model id). There is no `name`
                // field — emitting `m.name` would silently produce
                // `{ name: undefined, ... }` payloads, leaving callers no
                // identifier to pass back into switch_model.

                const groups = new Map<string, { providerId: string; type: string; models: any[] }>();
                for (const model of models) {
                    const providerId = model.providerId || String(model.qualifiedName || "").split(":", 1)[0];
                    const group = groups.get(providerId) || {
                        providerId,
                        type: model.providerType || providerId,
                        models: [],
                    };
                    group.models.push(model);
                    groups.set(providerId, group);
                }

                if (group_by_provider) {
                    const grouped = [...groups.values()].map((p) => ({
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
                const flat = [...groups.values()].flatMap((p) =>
                    p.models.map((m) => ({
                        qualified_name: m.qualifiedName,
                        model_name: m.modelName,
                        provider: p.providerId,
                        description: m.description,
                        cost: m.cost,
                    })),
                );
                const defaults = await ctx.mgmt.getModelDefaults(viewer).catch(() => null);
                const defaultModel = defaults?.userSession?.effective?.model
                    ?? defaults?.clusterSession?.effective?.model
                    ?? ((await ctx.mgmt.getDefaultModel()) ?? null);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({ models: flat, default_model: defaultModel, count: flat.length }, null, 2),
                        },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{
                        type: "text" as const,
                        text: (err as any)?.code === "MODEL_AMBIGUOUS"
                            ? JSON.stringify({
                                error: msg,
                                code: "MODEL_AMBIGUOUS",
                                candidates: Array.isArray((err as any)?.candidates) ? (err as any).candidates : [],
                            })
                            : `Error: ${msg}`,
                    }],
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
            description: "Change the model for a PilotSwarm session, optionally setting reasoning effort",
            inputSchema: {
                session_id: z.string().describe("The session to switch the model for"),
                model: z.string().describe("The model to switch to"),
                reasoning_effort: z
                    .string()
                    .optional()
                    .describe("Reasoning effort for the new model (e.g. low, medium, high) — web mode only"),
                context_tier: z
                    .string()
                    .optional()
                    .describe("Context-window tier for the new model: 'default' (smaller) or 'long_context' — web mode only"),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Max time to wait for the orchestration to acknowledge the switch (default 15000)"),
            },
        },
        async ({ session_id, model, reasoning_effort, context_tier, timeout_ms }) => {
            try {
                await (ctx.mgmt.setSessionModel as any)(session_id, model, {
                    ...(reasoning_effort !== undefined ? { reasoningEffort: reasoning_effort } : {}),
                    ...(context_tier !== undefined ? { contextTier: context_tier } : {}),
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                switched: true,
                                model,
                                ...(reasoning_effort ? { reasoning_effort } : {}),
                                ...(context_tier ? { context_tier } : {}),
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
                return errorToResult(err);
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
                if (ctx.webMode) {
                    // Raw orchestration-command plumbing (KV command channel) is
                    // deliberately not exposed over the Web API.
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({
                                    sent: false,
                                    error: "send_command is direct-mode only; over the Web API use the dedicated tools (switch_model, abort_session, …).",
                                }),
                            },
                        ],
                        isError: true,
                    };
                }
                if (command === "set_model") {
                    return {
                        content: [{
                            type: "text" as const,
                            text: JSON.stringify({
                                sent: false,
                                error: "Use switch_model for model changes; raw set_model bypass is disabled.",
                            }),
                        }],
                        isError: true,
                    };
                }
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
