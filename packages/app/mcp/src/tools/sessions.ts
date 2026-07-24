import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
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
                system_message: z.string().optional().describe("Custom system message (direct mode only — the Web API has no carrier for worker-side options)"),
                title: z.string().min(1).max(512).optional().describe("Optional title — if omitted, PilotSwarm auto-generates one from the conversation after the first turn"),
                prompt: z.string().optional().describe("Initial message to send immediately after session creation (fire-and-forget)"),
                reasoning_effort: z.string().optional().describe("Reasoning effort for the session's model (e.g. low, medium, high)"),
                context_tier: z.string().optional().describe("Context-window tier for the session's model: 'default' (smaller window) or 'long_context'"),
                group_id: z.string().optional().describe("One of YOUR session groups to place the new session in (groups are private per-user organization; fails if the group is not yours)"),
                splash: z.string().optional().describe("Splash text shown in the portal UI (agent-bound sessions only)"),
            },
        },
        async ({ model, agent, system_message, title, prompt, reasoning_effort, context_tier, group_id, splash }) => {
            try {
                // system_message is a worker-side option with no Web API
                // carrier: the web client silently DROPS it (it is not sent
                // on the wire). Don't fail the creation — but never lie by
                // omission either: surface system_message_applied so the
                // caller knows the session runs WITHOUT their prompt.
                const systemMessageDropped = system_message !== undefined && ctx.webMode;

                let session;
                if (agent) {
                    if (system_message !== undefined && !ctx.webMode) {
                        // createSessionForAgent does not forward systemMessage,
                        // so route through createSession directly when the
                        // caller supplied a custom system message (direct mode
                        // only). The allowedAgentNames guard inside
                        // createSession still enforces the agent allowlist.
                        session = await ctx.client.createSession({
                            agentId: agent,
                            boundAgentName: agent,
                            model,
                            systemMessage: system_message,
                        });
                    } else {
                        session = await ctx.client.createSessionForAgent(agent, {
                            model,
                            title,
                            reasoningEffort: reasoning_effort,
                            contextTier: context_tier,
                            groupId: group_id,
                            splash,
                        } as any);
                    }
                } else {
                    session = await ctx.client.createSession({
                        model,
                        ...(ctx.webMode ? {} : { systemMessage: system_message }),
                        reasoningEffort: reasoning_effort,
                        contextTier: context_tier,
                        groupId: group_id,
                    } as any);
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

                // Queue-and-monitor semantics: PilotSwarm is a durable async
                // system. Creation (and any initial prompt) is queued; the
                // session runs when a worker picks it up. No liveness
                // probing here — callers monitor the session directly via
                // get_session_detail (include: ['status']) or
                // get_session_events (wait: true).
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify({
                                session_id: session.sessionId,
                                status: "created",
                                ...(systemMessageDropped && {
                                    system_message_applied: false,
                                    warning: "system_message has no Web API carrier and was NOT applied — bind the session to an agent whose definition carries the prompt, or run the MCP server in direct mode.",
                                }),
                                model: model ?? "default",
                                title: title ?? null,
                                ...(prompt !== undefined && {
                                    prompt_sent: promptSent,
                                    note: "Queued durably; monitor with get_session_detail (include: ['status']) or get_session_events (wait: true).",
                                }),
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
            description:
                "Send a fire-and-forget message to a PilotSwarm session. Pass client_message_ids to make the "
                + "message(s) cancellable later via cancel_pending_messages; enqueue_only queues without waking the session. "
                + "attachments references IMAGE artifacts already uploaded to this session (via upload_artifact) — "
                + "vision-capable models receive them as true image input.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to send the message to"),
                message: z.string().describe("The message to send"),
                client_message_ids: z.array(z.string().min(1)).optional().describe("Caller-chosen ids for this message — required later by cancel_pending_messages"),
                enqueue_only: z.boolean().optional().describe("Queue the message without triggering processing (web mode only)"),
                attachments: z.array(z.object({ filename: z.string().min(1) })).max(4).optional()
                    .describe("Image artifacts of this session to show the model (upload first via upload_artifact; png/jpeg/gif/webp, ≤4 MB each)"),
            },
        },
        async ({ session_id, message, client_message_ids, enqueue_only, attachments }) => {
            try {
                const existing = await ctx.mgmt.getSession(session_id);
                if (!existing) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
                        isError: true,
                    };
                }
                if (attachments && attachments.length > 0 && !ctx.api) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "attachments are only supported in Web API mode (refs are validated against the session's artifact store at the API edge)" }) }],
                        isError: true,
                    };
                }
                if (enqueue_only) {
                    if (!ctx.api) {
                        return {
                            content: [{ type: "text" as const, text: JSON.stringify({ error: "enqueue_only is only supported in Web API mode" }) }],
                            isError: true,
                        };
                    }
                    await ctx.api.call("sendMessage", {
                        sessionId: session_id,
                        prompt: message,
                        options: {
                            enqueueOnly: true,
                            ...(client_message_ids ? { clientMessageIds: client_message_ids } : {}),
                            ...(attachments && attachments.length > 0 ? { attachments } : {}),
                        },
                    });
                    return {
                        content: [
                            { type: "text" as const, text: JSON.stringify({ sent: true, enqueued: true, ...(client_message_ids ? { client_message_ids } : {}) }) },
                        ],
                    };
                }
                // Use cached PilotSwarmSession when available; fall back to
                // resumeSession() so a fresh session created via this MCP
                // server's create_session (which doesn't auto-boot the
                // orchestration unless a prompt was supplied) still works.
                // The bare ctx.mgmt.sendMessage(...) path requires an
                // already-live orchestration and throws otherwise — that
                // breaks the canonical "create then send" workflow.
                const session = sessionCache.get(session_id)
                    ?? await ctx.client.resumeSession(session_id);
                if (!sessionCache.has(session_id)) sessionCache.set(session_id, session);
                // attachments only reach here in web mode (rejected above for
                // direct); WebPilotSwarmSession.send accepts {filename} refs and
                // the API edge resolves them — cast because the static type here
                // is the direct-client union member.
                await session.send(message, (client_message_ids || (attachments && attachments.length > 0))
                    ? ({
                        ...(client_message_ids ? { clientMessageIds: client_message_ids } : {}),
                        ...(attachments && attachments.length > 0 ? { attachments } : {}),
                    } as never)
                    : undefined);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ sent: true, ...(client_message_ids ? { client_message_ids } : {}) }) },
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
            description: "Send a message to a PilotSwarm session and wait for the response. "
                + "attachments references IMAGE artifacts already uploaded to this session (via upload_artifact).",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to send the message to"),
                message: z.string().describe("The message to send"),
                timeout_ms: z.number().optional().describe("Timeout in milliseconds (default 120000)"),
                attachments: z.array(z.object({ filename: z.string().min(1) })).max(4).optional()
                    .describe("Image artifacts of this session to show the model (upload first via upload_artifact; png/jpeg/gif/webp, ≤4 MB each)"),
            },
        },
        async ({ session_id, message, timeout_ms, attachments }) => {
            try {
                const existing = await ctx.mgmt.getSession(session_id);
                if (!existing) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
                        isError: true,
                    };
                }
                if (attachments && attachments.length > 0 && !ctx.api) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "attachments are only supported in Web API mode (refs are validated against the session's artifact store at the API edge)" }) }],
                        isError: true,
                    };
                }
                const timeout = timeout_ms ?? 120_000;
                // Use cached session object if available (preserves correct
                // orchestration creation path). Fall back to resumeSession()
                // for sessions created outside the MCP server.
                const session = sessionCache.get(session_id)
                    ?? await ctx.client.resumeSession(session_id);
                if (attachments && attachments.length > 0) {
                    // Web mode only (rejected above for direct) — see send_message.
                    await session.send(message, { attachments } as never);
                    const response = await session.wait(timeout);
                    return {
                        content: [{ type: "text" as const, text: response ?? "(no response)" }],
                    };
                }
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
                session_id: sessionIdShape().describe("The session awaiting an answer"),
                answer: z.string().describe("The answer to provide"),
            },
        },
        async ({ session_id, answer }) => {
            try {
                const existing = await ctx.mgmt.getSession(session_id);
                if (!existing) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
                        isError: true,
                    };
                }
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
                session_id: sessionIdShape().describe("The session to abort"),
                reason: z.string().optional().describe("Optional reason for cancellation"),
            },
        },
        async ({ session_id, reason }) => {
            try {
                const existing = await ctx.mgmt.getSession(session_id);
                if (!existing) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
                        isError: true,
                    };
                }
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
                session_id: sessionIdShape().describe("The session to rename"),
                title: z.string().min(1).max(512).describe("The new title for the session"),
            },
        },
        async ({ session_id, title }) => {
            try {
                const existing = await ctx.mgmt.getSession(session_id);
                if (!existing) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
                        isError: true,
                    };
                }
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

    // ── Session sharing (security model) ─────────────────────────────
    // Owner-or-admin operations; the server enforces and returns the authz
    // reason in the error when refused. Registered for all callers.
    // Web mode: dispatch through the API (server enforces). Direct mode
    // (admin/test-only): call the management client with POSITIONAL args —
    // its signatures are (sessionId, …), not a single params object.
    const callShare = async (op: string, params: Record<string, unknown>, positional: unknown[]) => {
        if (ctx.api) return ctx.api.call(op, params);
        return (ctx.mgmt as any)[op]?.(...positional);
    };
    const shareError = (err: unknown, session_id: string) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err), session_id }) }],
        isError: true,
    });

    server.registerTool(
        "set_session_visibility",
        {
            title: "Set Session Visibility",
            description:
                "Set the sharing level of a session's tree (owner or admin only): "
                + "'private' (only owner + admins), 'shared_read' (every user can view), "
                + "'shared_write' (every user can view and send). Applies to the whole sub-agent tree.",
            inputSchema: {
                session_id: sessionIdShape().describe("Session whose tree visibility to set"),
                visibility: z.enum(["private", "shared_read", "shared_write"]).describe("New visibility level"),
            },
        },
        async ({ session_id, visibility }) => {
            try {
                await callShare("setSessionVisibility", { sessionId: session_id, visibility }, [session_id, visibility]);
                return { content: [{ type: "text" as const, text: JSON.stringify({ session_id, visibility }) }] };
            } catch (err) { return shareError(err, session_id); }
        },
    );

    server.registerTool(
        "grant_session_share",
        {
            title: "Grant Session Share",
            description:
                "Grant a specific user read or write access to a session's tree (owner or admin only). "
                + "Refused with the reason in the error if you are not the owner/admin, or on a system session. "
                + "The grantee does NOT need to have signed in yet: list_known_users is only a lookup helper. "
                + "If the grantee's stable subject is unknown, pass their EMAIL as the subject — the grant "
                + "binds automatically the first time they sign in.",
            inputSchema: {
                session_id: sessionIdShape().describe("Session whose tree to share"),
                provider: z.string().describe("Grantee auth provider (e.g. 'entra', 'dev')"),
                subject: z.string().describe("Grantee stable subject id, or their email if they have never signed in"),
                access: z.enum(["read", "write"]).describe("Access level to grant"),
                email: z.string().nullish().describe("Optional grantee email for display"),
                display_name: z.string().nullish().describe("Optional grantee display name"),
            },
        },
        async ({ session_id, provider, subject, access, email, display_name }) => {
            try {
                const grantee = { provider, subject, email: email ?? null, displayName: display_name ?? null };
                await callShare("grantSessionShare",
                    { sessionId: session_id, user: grantee, access },
                    [session_id, grantee, access]);
                return { content: [{ type: "text" as const, text: JSON.stringify({ session_id, granted: { provider, subject, access } }) }] };
            } catch (err) { return shareError(err, session_id); }
        },
    );

    server.registerTool(
        "revoke_session_share",
        {
            title: "Revoke Session Share",
            description: "Revoke a user's targeted share on a session's tree (owner or admin only).",
            inputSchema: {
                session_id: sessionIdShape().describe("Session whose share to revoke"),
                provider: z.string().describe("Grantee auth provider"),
                subject: z.string().describe("Grantee stable subject id"),
            },
        },
        async ({ session_id, provider, subject }) => {
            try {
                await callShare("revokeSessionShare", { sessionId: session_id, user: { provider, subject } }, [session_id, { provider, subject }]);
                return { content: [{ type: "text" as const, text: JSON.stringify({ session_id, revoked: { provider, subject } }) }] };
            } catch (err) { return shareError(err, session_id); }
        },
    );

    server.registerTool(
        "list_session_shares",
        {
            title: "List Session Shares",
            description: "List the targeted user grants on a session's tree (owner or admin only).",
            inputSchema: {
                session_id: sessionIdShape().describe("Session whose shares to list"),
            },
        },
        async ({ session_id }) => {
            try {
                const shares = await callShare("listSessionShares", { sessionId: session_id }, [session_id]);
                return { content: [{ type: "text" as const, text: JSON.stringify({ session_id, shares: shares ?? [] }) }] };
            } catch (err) { return shareError(err, session_id); }
        },
    );

    server.registerTool(
        "list_known_users",
        {
            title: "List Known Users",
            description:
                "Directory of users who have signed in at least once (provider, subject, email, display name) — "
                + "a HELPER for resolving a grantee's stable subject by name/email before grant_session_share. "
                + "It is NOT an allowlist: grants may target someone who is not in this directory — even someone "
                + "who has never signed in. For such users pass their email as the subject; the grant binds "
                + "automatically when they first sign in.",
            inputSchema: {
                limit: z.number().int().min(1).max(2000).nullish().describe("Max entries to return (default 500)"),
            },
        },
        async ({ limit }) => {
            try {
                const users = ctx.api
                    ? await ctx.api.call("listKnownUsers", limit != null ? { limit } : {})
                    : await (ctx.mgmt as any).listKnownUsers?.(limit != null ? { limit } : undefined);
                return { content: [{ type: "text" as const, text: JSON.stringify({ users: users ?? [] }) }] };
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
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
                "Use status_filter to narrow results (e.g. 'running', 'idle', 'waiting', 'completed', 'failed'). " +
                "viewer_group_id is YOUR private group placement for the session's tree (groups are per-user organization).",
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
                limit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Page size — switches to keyset pagination (fleet-scale listing). Response carries next_cursor."),
                cursor: z
                    .object({ updatedAt: z.number(), sessionId: z.string() })
                    .optional()
                    .describe("Keyset cursor from a previous page's next_cursor"),
                include_deleted: z
                    .boolean()
                    .optional()
                    .describe("Include soft-deleted sessions (paginated mode only)"),
            },
        },
        async ({ status_filter, include_system, agent_id, limit, cursor, include_deleted }) => {
            try {
                let page: { hasMore: boolean; nextCursor?: unknown } | null = null;
                let sessions: any[];
                if (limit !== undefined || cursor !== undefined || include_deleted !== undefined) {
                    const p = await ctx.mgmt.listSessionsPage({
                        limit,
                        cursor: cursor ?? null,
                        includeDeleted: include_deleted,
                    });
                    sessions = p.sessions;
                    page = { hasMore: p.hasMore, nextCursor: p.nextCursor };
                } else {
                    sessions = await ctx.mgmt.listSessions();
                }

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
                    viewer_group_id: s.viewerGroupId ?? null,
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
                                {
                                    count: data.length,
                                    sessions: data,
                                    ...(page ? { has_more: page.hasMore, next_cursor: page.nextCursor ?? null } : {}),
                                },
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
                "Use 'include' to fetch additional data: 'status' for live orchestration status, 'response' for latest LLM response, 'dump' for full Markdown dump, 'footprint' for context/compaction health + sizes + assessment.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session ID to inspect"),
                include: z
                    .array(z.enum(["status", "response", "dump", "footprint"]))
                    .optional()
                    .describe("Additional data to include: 'status' (orchestration status), 'response' (latest LLM response), 'dump' (full Markdown dump), 'footprint' (health assessment + sizes)"),
            },
        },
        async ({ session_id, include }) => {
            try {
                const session = await ctx.mgmt.getSession(session_id);
                if (!session) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
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

                if (includes.has("footprint")) {
                    try {
                        result.footprint = await ctx.mgmt.getSessionFootprint(session_id);
                    } catch (err: unknown) {
                        result.footprint = null;
                        result.footprint_error = err instanceof Error ? err.message : String(err);
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
                session_id: sessionIdShape().describe("The session to delete"),
            },
        },
        async ({ session_id }) => {
            try {
                const existing = await ctx.mgmt.getSession(session_id);
                if (!existing) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
                        isError: true,
                    };
                }
                // mgmt.deleteSession routes through sendCommand and rejects
                // with "orchestration ... is not started (status=NotFound)"
                // for sessions whose orchestration was never registered (e.g.
                // create_session ran while no worker was active). Fall back
                // to client.deleteSession in that case — it soft-deletes the
                // CMS row directly and best-effort cancels the orchestration.
                if (existing.orchestrationStatus === "NotFound") {
                    await ctx.client.deleteSession(session_id);
                } else {
                    await ctx.mgmt.deleteSession(session_id);
                }
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
                "Read the CMS event stream for a session. Supports forward pagination with after_seq, backward " +
                "history paging with before_seq, server-side event_types filtering, and long-polling " +
                "with wait=true to block until new events or a status change arrives.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to read events for"),
                after_seq: z.number().optional().describe("Return events after this CMS sequence number (forward paging)"),
                before_seq: z.number().optional().describe("Return events BEFORE this sequence number (backward history paging; mutually exclusive with after_seq/wait)"),
                event_types: z.array(z.string()).optional().describe("Server-side filter to these event types (e.g. chat transcript paging)"),
                limit: z.number().optional().describe("Max events to return (default 50)"),
                wait: z.boolean().optional().describe("If true, long-poll until new events or status change arrives"),
                wait_timeout_ms: z.number().optional().describe("Long-poll timeout in ms (default 30000)"),
                after_version: z.number().optional().describe("For wait mode: block until customStatusVersion exceeds this value"),
            },
        },
        async ({ session_id, after_seq, before_seq, event_types, limit, wait, wait_timeout_ms, after_version }) => {
            try {
                const existing = await ctx.mgmt.getSession(session_id);
                if (!existing) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "session not found", session_id }) }],
                        isError: true,
                    };
                }
                const eventLimit = limit ?? 50;

                if (before_seq !== undefined && (after_seq !== undefined || wait)) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({ error: "before_seq is mutually exclusive with after_seq and wait" }) }],
                        isError: true,
                    };
                }

                // Backward history paging — a plain read, no long-poll.
                if (before_seq !== undefined) {
                    const events = await ctx.mgmt.getSessionEventsBefore(session_id, before_seq, eventLimit, event_types);
                    const oldestSeq = events.length > 0
                        ? Math.min(...events.map((e: any) => e.seq ?? 0))
                        : before_seq;
                    return {
                        content: [{
                            type: "text" as const,
                            text: JSON.stringify({ events, oldest_seq: oldestSeq, count: events.length }, null, 2),
                        }],
                    };
                }

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

                const events = await ctx.mgmt.getSessionEvents(session_id, after_seq, eventLimit, event_types);
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
