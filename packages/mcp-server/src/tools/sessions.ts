import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PilotSwarmSession } from "pilotswarm-sdk";
import type { ServerContext } from "../context.js";

// Cache session objects so send_and_wait can reuse them instead of
// calling resumeSession() which incorrectly assumes the orchestration
// is already running. Mirrors the TUI pattern of holding onto sess.
const sessionCache = new Map<string, PilotSwarmSession>();

export function registerSessionTools(server: McpServer, ctx: ServerContext) {
    // 1. create_session — Create a new PilotSwarm session
    server.registerTool(
        "create_session",
        {
            title: "Create Session",
            description: "Create a new PilotSwarm session, optionally bound to a named agent",
            inputSchema: {
                model: z.string().optional().describe("Model to use for the session"),
                agent: z.string().optional().describe("Agent name to bind the session to"),
                system_message: z.string().optional().describe("Custom system message for the session"),
                title: z.string().optional().describe("Optional title — if omitted, PilotSwarm auto-generates one from the conversation after the first turn"),
                prompt: z.string().optional().describe("Initial message to send immediately after session creation (fire-and-forget)"),
            },
        },
        async ({ model, agent, system_message, title, prompt }) => {
            try {
                const config: Record<string, unknown> = {};
                if (model !== undefined) config.model = model;
                if (system_message !== undefined) config.systemMessage = system_message;
                if (title !== undefined) config.title = title;

                let session;
                if (agent) {
                    session = await ctx.client.createSessionForAgent(agent, {
                        model,
                        title,
                    });
                } else {
                    session = await ctx.client.createSession({
                        model,
                        systemMessage: system_message,
                    });
                }

                // Cache the session object for later use by send_and_wait
                sessionCache.set(session.sessionId, session);

                // Persist title via management client (createSession doesn't accept title)
                if (title) {
                    try {
                        await ctx.mgmt.renameSession(session.sessionId, title);
                    } catch {
                        // Best-effort — session still created
                    }
                }

                // Fire initial prompt if provided (non-blocking)
                let promptSent = false;
                if (prompt) {
                    try {
                        await session.send(prompt);
                        promptSent = true;
                    } catch {
                        // Best-effort — session still created
                    }
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                session_id: session.sessionId,
                                status: "created",
                                model: model ?? "default",
                                title: title ?? null,
                                ...(prompt !== undefined && { prompt_sent: promptSent }),
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

    // 2. send_message — Fire-and-forget message to a session
    server.registerTool(
        "send_message",
        {
            title: "Send Message",
            description: "Send a fire-and-forget message to a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to send the message to"),
                message: z.string().describe("The message to send"),
            },
        },
        async ({ session_id, message }) => {
            try {
                await ctx.mgmt.sendMessage(session_id, message);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ sent: true }) },
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

    // 3. send_and_wait — Send message and wait for response
    server.registerTool(
        "send_and_wait",
        {
            title: "Send and Wait",
            description: "Send a message to a PilotSwarm session and wait for the response",
            inputSchema: {
                session_id: z.string().describe("The session to send the message to"),
                message: z.string().describe("The message to send"),
                timeout_ms: z.number().optional().describe("Timeout in milliseconds (default 120000)"),
            },
        },
        async ({ session_id, message, timeout_ms }) => {
            try {
                const timeout = timeout_ms ?? 120_000;
                // Use cached session object if available (preserves correct
                // orchestration creation path). Fall back to resumeSession()
                // for sessions created outside the MCP server.
                const session = sessionCache.get(session_id)
                    ?? await ctx.client.resumeSession(session_id);
                const response = await session.sendAndWait(message, timeout);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                response: response ?? null,
                                status: response !== undefined ? "completed" : "timeout",
                            }),
                        },
                    ],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.toLowerCase().includes("timeout")) {
                    return {
                        content: [
                            { type: "text" as const, text: JSON.stringify({ error: "timeout" }) },
                        ],
                    };
                }
                return {
                    content: [{ type: "text" as const, text: `Error: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // 4. send_answer — Answer a pending input_required question
    server.registerTool(
        "send_answer",
        {
            title: "Send Answer",
            description: "Answer a pending input_required question in a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session awaiting an answer"),
                answer: z.string().describe("The answer to provide"),
            },
        },
        async ({ session_id, answer }) => {
            try {
                await ctx.mgmt.sendAnswer(session_id, answer);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ sent: true }) },
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

    // 5. abort_session — Cancel a running session
    server.registerTool(
        "abort_session",
        {
            title: "Abort Session",
            description: "Cancel a running PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to abort"),
                reason: z.string().optional().describe("Optional reason for cancellation"),
            },
        },
        async ({ session_id, reason }) => {
            try {
                await ctx.mgmt.cancelSession(session_id, reason);
                sessionCache.delete(session_id);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ aborted: true }) },
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

    // 6. rename_session — Rename a session
    server.registerTool(
        "rename_session",
        {
            title: "Rename Session",
            description: "Rename a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to rename"),
                title: z.string().describe("The new title for the session"),
            },
        },
        async ({ session_id, title }) => {
            try {
                await ctx.mgmt.renameSession(session_id, title);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ renamed: true }) },
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

    // 7. list_sessions — List all sessions with status
    server.registerTool(
        "list_sessions",
        {
            title: "List Sessions",
            description:
                "List all PilotSwarm sessions with their current status, model, agent info, and parent/child relationships. " +
                "Use status_filter to narrow results (e.g. 'running', 'idle', 'waiting', 'completed', 'failed').",
            inputSchema: {
                status_filter: z
                    .string()
                    .optional()
                    .describe("Filter by status (running, idle, waiting, completed, failed, input_required)"),
                include_system: z
                    .boolean()
                    .optional()
                    .describe("Include system sessions like Sweeper Agent (default false)"),
                agent_id: z
                    .string()
                    .optional()
                    .describe("Filter by agent ID (e.g. 'sweeper', 'resourcemgr', or a custom agent name)"),
            },
        },
        async ({ status_filter, include_system, agent_id }) => {
            try {
                let sessions = await ctx.mgmt.listSessions();

                if (!include_system) {
                    sessions = sessions.filter((s: any) => !s.isSystem);
                }
                if (status_filter) {
                    const f = status_filter.toLowerCase();
                    sessions = sessions.filter((s: any) => s.status?.toLowerCase() === f);
                }
                if (agent_id) {
                    sessions = sessions.filter((s: any) => s.agentId === agent_id);
                }

                const data = sessions.map((s: any) => ({
                    session_id: s.sessionId,
                    title: s.title ?? null,
                    status: s.status,
                    orchestration_status: s.orchestrationStatus ?? null,
                    model: s.model ?? "default",
                    agent_id: s.agentId ?? null,
                    is_system: s.isSystem ?? false,
                    parent_session_id: s.parentSessionId ?? null,
                    iterations: s.iterations ?? 0,
                    wait_reason: s.waitReason ?? null,
                    error: s.error ?? null,
                    pending_question: s.pendingQuestion ?? null,
                    created_at: s.createdAt,
                    updated_at: s.updatedAt ?? null,
                }));

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                { count: data.length, sessions: data },
                                null,
                                2,
                            ),
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

    // 8. get_session_detail — Get detailed info for a single session
    server.registerTool(
        "get_session_detail",
        {
            title: "Get Session Detail",
            description:
                "Get detailed information for a specific PilotSwarm session including status, context usage, cron state, and pending questions. " +
                "Use 'include' to fetch additional data: 'status' for live orchestration status, 'response' for latest LLM response, 'dump' for full Markdown dump.",
            inputSchema: {
                session_id: z.string().describe("The session ID to inspect"),
                include: z
                    .array(z.enum(["status", "response", "dump"]))
                    .optional()
                    .describe("Additional data to include: 'status' (orchestration status), 'response' (latest LLM response), 'dump' (full Markdown dump)"),
            },
        },
        async ({ session_id, include }) => {
            try {
                const session = await ctx.mgmt.getSession(session_id);
                if (!session) {
                    return {
                        content: [{ type: "text" as const, text: `Error: session ${session_id} not found` }],
                        isError: true,
                    };
                }

                const result: Record<string, unknown> = { session };
                const includes = new Set(include ?? []);

                if (includes.has("status")) {
                    try {
                        result.orchestration_status = await ctx.mgmt.getSessionStatus(session_id);
                    } catch {
                        result.orchestration_status = null;
                    }
                }

                if (includes.has("response")) {
                    try {
                        result.latest_response = await ctx.mgmt.getLatestResponse(session_id);
                    } catch {
                        result.latest_response = null;
                    }
                }

                if (includes.has("dump")) {
                    try {
                        result.dump = await ctx.mgmt.dumpSession(session_id);
                    } catch {
                        result.dump = null;
                    }
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(result, null, 2),
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

    // 9. delete_session — Delete a session
    server.registerTool(
        "delete_session",
        {
            title: "Delete Session",
            description: "Delete a PilotSwarm session",
            inputSchema: {
                session_id: z.string().describe("The session to delete"),
            },
        },
        async ({ session_id }) => {
            try {
                await ctx.mgmt.deleteSession(session_id);
                sessionCache.delete(session_id);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ deleted: true }) },
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

    // 10. get_session_events — Paginated CMS event stream with optional long-poll
    server.registerTool(
        "get_session_events",
        {
            title: "Get Session Events",
            description:
                "Read the CMS event stream for a session. Supports pagination with after_seq and long-polling " +
                "with wait=true to block until new events or a status change arrives.",
            inputSchema: {
                session_id: z.string().describe("The session to read events for"),
                after_seq: z.number().optional().describe("Return events after this CMS sequence number (for paging)"),
                limit: z.number().optional().describe("Max events to return (default 50)"),
                wait: z.boolean().optional().describe("If true, long-poll until new events or status change arrives"),
                wait_timeout_ms: z.number().optional().describe("Long-poll timeout in ms (default 30000)"),
                after_version: z.number().optional().describe("For wait mode: block until customStatusVersion exceeds this value"),
            },
        },
        async ({ session_id, after_seq, limit, wait, wait_timeout_ms, after_version }) => {
            try {
                const eventLimit = limit ?? 50;
                let statusChange: unknown = undefined;

                if (wait) {
                    const timeoutMs = wait_timeout_ms ?? 30_000;
                    // If after_version not provided, fetch current version first
                    let version = after_version;
                    if (version === undefined) {
                        try {
                            const status = await ctx.mgmt.getSessionStatus(session_id);
                            version = (status as any)?.customStatusVersion ?? 0;
                        } catch {
                            version = 0;
                        }
                    }
                    try {
                        statusChange = await ctx.mgmt.waitForStatusChange(
                            session_id,
                            version!,
                            1_000,
                            timeoutMs,
                        );
                    } catch {
                        // Timeout or error — still return whatever events exist
                    }
                }

                const events = await ctx.mgmt.getSessionEvents(session_id, after_seq, eventLimit);
                const latestSeq = events.length > 0
                    ? Math.max(...events.map((e: any) => e.seq ?? 0))
                    : (after_seq ?? 0);

                const result: Record<string, unknown> = {
                    events,
                    latest_seq: latestSeq,
                    count: events.length,
                };
                if (statusChange !== undefined) {
                    result.status_change = statusChange;
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(result, null, 2),
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
