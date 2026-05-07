import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PilotSwarmSession } from "pilotswarm-sdk";
import type { ServerContext } from "../context.js";

// Cache child PilotSwarmSession objects so message_agent can reuse them
// instead of re-resuming each call. Key is the child's sessionId.
const childSessionCache = new Map<string, PilotSwarmSession>();

export function registerAgentTools(server: McpServer, ctx: ServerContext) {
    // 1. spawn_agent — Create a sub-agent session linked to a parent session.
    //
    // Implementation note: the durable orchestration's command handler does
    // NOT recognize "spawn_agent" / "message_agent" / "cancel_agent" — only
    // set_model / list_models / get_info / done / cancel / delete. The
    // LLM-driven `spawn_agent` TurnAction path inside the orchestration body
    // is unrelated to management commands. To honestly drive sub-agent
    // spawn from outside the LLM loop, this tool calls the real management
    // API: `client.createSessionForAgent(...)` with `parentSessionId` set.
    // The child runs as an independent session linked to the parent via
    // the existing `parentSessionId` plumbing in CMS / SDK.
    server.registerTool(
        "spawn_agent",
        {
            description:
                "Create a sub-agent (child session) linked to a parent PilotSwarm session. " +
                "The child runs independently; its output does not flow back into the parent's " +
                "LLM context (use the LLM-driven `ps_spawn_agent` tool for in-loop sub-agent " +
                "spawning).",
            inputSchema: {
                session_id: z.string().describe("The parent session id"),
                agent_name: z.string().describe("The named agent to spawn"),
                task: z.string().optional().describe("Optional initial prompt to send to the child"),
                model: z.string().optional().describe("Optional model override for the child"),
                title: z.string().optional().describe("Optional title for the child session"),
                system_message: z
                    .string()
                    .optional()
                    .describe("Optional system message override for the child"),
            },
        },
        async ({ session_id, agent_name, task, model, title, system_message }) => {
            try {
                const opts: {
                    parentSessionId?: string;
                    model?: string;
                    title?: string;
                    systemMessage?: string;
                } = { parentSessionId: session_id };
                if (model !== undefined) opts.model = model;
                if (title !== undefined) opts.title = title;
                if (system_message !== undefined) opts.systemMessage = system_message;

                const child = await ctx.client.createSessionForAgent(agent_name, opts);
                childSessionCache.set(child.sessionId, child);

                let promptSent = false;
                if (task) {
                    try {
                        await child.send(task);
                        promptSent = true;
                    } catch {
                        // Best-effort — the child session is still created.
                    }
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                spawned: true,
                                parent_session_id: session_id,
                                child_session_id: child.sessionId,
                                agent_name,
                                ...(task !== undefined ? { prompt_sent: promptSent } : {}),
                            }),
                        },
                    ],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );

    // 2. message_agent — Send a message to an existing child session.
    //
    // The child is just a session with a parentSessionId — messaging it is
    // structurally identical to send_message on a top-level session, so we
    // route through the same cached-or-resumed `session.send()` pattern.
    // The bare ctx.mgmt.sendMessage(...) call requires an already-live
    // orchestration and would throw on a freshly-spawned child whose
    // orchestration hasn't booted yet (e.g. spawn_agent without `task`).
    server.registerTool(
        "message_agent",
        {
            description: "Send a message to a running sub-agent (child session)",
            inputSchema: {
                child_session_id: z
                    .string()
                    .describe("The child session id (returned from spawn_agent)"),
                message: z.string().describe("The message to send to the child"),
            },
        },
        async ({ child_session_id, message }) => {
            try {
                const session = childSessionCache.get(child_session_id)
                    ?? await ctx.client.resumeSession(child_session_id);
                if (!childSessionCache.has(child_session_id)) {
                    childSessionCache.set(child_session_id, session);
                }
                await session.send(message);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({ sent: true, child_session_id }),
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

    // 3. list_agents — List all sub-agents across sessions
    server.registerTool(
        "list_agents",
        {
            description:
                "List all sub-agents (child sessions) across PilotSwarm. Shows agent name, status, model, parent session, and task context. " +
                "Optionally filter by parent session or status.",
            inputSchema: {
                parent_session_id: z
                    .string()
                    .optional()
                    .describe("Filter agents belonging to a specific parent session"),
                status_filter: z
                    .string()
                    .optional()
                    .describe("Filter by status (running, idle, waiting, completed, failed)"),
            },
        },
        async ({ parent_session_id, status_filter }) => {
            try {
                const sessions = await ctx.mgmt.listSessions();

                // Agents are sessions with a parentSessionId
                let agents = sessions.filter((s: any) => s.parentSessionId);

                if (parent_session_id) {
                    agents = agents.filter((s: any) => s.parentSessionId === parent_session_id);
                }
                if (status_filter) {
                    const f = status_filter.toLowerCase();
                    agents = agents.filter((s: any) => s.status?.toLowerCase() === f);
                }

                const data = agents.map((s: any) => ({
                    agent_session_id: s.sessionId,
                    agent_id: s.agentId ?? null,
                    title: s.title ?? null,
                    status: s.status,
                    orchestration_status: s.orchestrationStatus ?? null,
                    model: s.model ?? "default",
                    parent_session_id: s.parentSessionId,
                    is_system: s.isSystem ?? false,
                    iterations: s.iterations ?? 0,
                    wait_reason: s.waitReason ?? null,
                    error: s.error ?? null,
                    created_at: s.createdAt,
                    updated_at: s.updatedAt ?? null,
                }));

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                { count: data.length, agents: data },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );

    // 4. cancel_agent — Cancel a running sub-agent.
    //
    // Routed through the real management API `mgmt.cancelSession(...)`,
    // which uses the orchestration's recognized `cancel` command and waits
    // on the orchestration to ack via the existing cancel path. The prior
    // implementation enqueued `cmd: "cancel_agent"` (unrecognized) and
    // returned `{ cancelled: true }` while the orchestration logged
    // `Unknown command: cancel_agent` and the agent kept running.
    server.registerTool(
        "cancel_agent",
        {
            description: "Cancel a running sub-agent (child session)",
            inputSchema: {
                child_session_id: z
                    .string()
                    .describe("The child session id to cancel"),
                reason: z.string().optional().describe("Optional reason for cancellation"),
            },
        },
        async ({ child_session_id, reason }) => {
            try {
                await ctx.mgmt.cancelSession(child_session_id, reason);
                childSessionCache.delete(child_session_id);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                cancelled: true,
                                child_session_id,
                                ...(reason !== undefined ? { reason } : {}),
                            }),
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
