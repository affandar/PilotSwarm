import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

export function registerSessionResources(server: McpServer, ctx: ServerContext) {
    // 1. sessions-list — Static resource listing all sessions
    server.registerResource(
        "sessions-list",
        "pilotswarm://sessions",
        {
            description: "List all PilotSwarm sessions with status",
            mimeType: "application/json",
        },
        async (uri) => {
            const sessions = await ctx.mgmt.listSessions();
            const data = sessions.map((s: any) => ({
                session_id: s.sessionId,
                title: s.title,
                status: s.status,
                model: s.model,
                agent_id: s.agentId,
                is_system: s.isSystem,
                created_at: s.createdAt,
                updated_at: s.updatedAt,
            }));
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: JSON.stringify(data, null, 2),
                        mimeType: "application/json",
                    },
                ],
            };
        },
    );

    // 2. session-detail — URI template for a specific session
    server.registerResource(
        "session-detail",
        new ResourceTemplate("pilotswarm://sessions/{id}", {
            list: async () => {
                const sessions = await ctx.mgmt.listSessions();
                return {
                    resources: sessions.map((s: any) => ({
                        uri: `pilotswarm://sessions/${s.sessionId}`,
                        name: s.title ?? s.sessionId,
                        description: `Session ${s.sessionId} (${s.status})`,
                        mimeType: "application/json",
                    })),
                };
            },
        }),
        {
            description: "Get detailed info for a specific PilotSwarm session",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const id = String(variables.id);
            const session = await ctx.mgmt.getSession(id);
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: JSON.stringify(session, null, 2),
                        mimeType: "application/json",
                    },
                ],
            };
        },
    );

    // 3. session-messages — URI template for session chat history
    server.registerResource(
        "session-messages",
        new ResourceTemplate("pilotswarm://sessions/{id}/messages", {
            list: async () => {
                const sessions = await ctx.mgmt.listSessions();
                return {
                    resources: sessions.map((s: any) => ({
                        uri: `pilotswarm://sessions/${s.sessionId}/messages`,
                        name: `Messages: ${s.title ?? s.sessionId}`,
                        description: `Chat history for session ${s.sessionId}`,
                        mimeType: "application/json",
                    })),
                };
            },
        }),
        {
            description: "Get chat history for a specific PilotSwarm session",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const id = String(variables.id);
            try {
                const raw = await ctx.mgmt.dumpSession(id);
                const dump = typeof raw === "string" ? JSON.parse(raw) : raw;
                const events = dump?.events ?? [];
                return {
                    contents: [
                        {
                            uri: uri.href,
                            text: JSON.stringify(events, null, 2),
                            mimeType: "application/json",
                        },
                    ],
                };
            } catch {
                return {
                    contents: [
                        {
                            uri: uri.href,
                            text: JSON.stringify([], null, 2),
                            mimeType: "application/json",
                        },
                    ],
                };
            }
        },
    );

    // 4. session-events — CMS event stream (tool calls, errors, status changes, etc.)
    server.registerResource(
        "session-events",
        new ResourceTemplate("pilotswarm://sessions/{id}/events", {
            list: async () => {
                const sessions = await ctx.mgmt.listSessions();
                return {
                    resources: sessions.map((s: any) => ({
                        uri: `pilotswarm://sessions/${s.sessionId}/events`,
                        name: `Events: ${s.title ?? s.sessionId}`,
                        description: `CMS event stream for session ${s.sessionId}`,
                        mimeType: "application/json",
                    })),
                };
            },
        }),
        {
            description: "CMS event stream for a session (tool calls, LLM responses, errors, status changes)",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const id = String(variables.id);
            try {
                const events = await ctx.mgmt.getSessionEvents(id, undefined, 100);
                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify(events, null, 2),
                        mimeType: "application/json",
                    }],
                };
            } catch {
                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify([], null, 2),
                        mimeType: "application/json",
                    }],
                };
            }
        },
    );

    // 5. session-dump — Full Markdown dump of session + descendants
    server.registerResource(
        "session-dump",
        new ResourceTemplate("pilotswarm://sessions/{id}/dump", {
            list: async () => {
                const sessions = await ctx.mgmt.listSessions();
                return {
                    resources: sessions.map((s: any) => ({
                        uri: `pilotswarm://sessions/${s.sessionId}/dump`,
                        name: `Dump: ${s.title ?? s.sessionId}`,
                        description: `Full Markdown dump for session ${s.sessionId}`,
                        mimeType: "text/markdown",
                    })),
                };
            },
        }),
        {
            description: "Full Markdown dump of a session and its descendants",
            mimeType: "text/markdown",
        },
        async (uri, variables) => {
            const id = String(variables.id);
            try {
                const dump = await ctx.mgmt.dumpSession(id);
                const text = typeof dump === "string" ? dump : JSON.stringify(dump, null, 2);
                return {
                    contents: [{
                        uri: uri.href,
                        text,
                        mimeType: "text/markdown",
                    }],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    contents: [{
                        uri: uri.href,
                        text: `Error generating dump: ${message}`,
                        mimeType: "text/plain",
                    }],
                };
            }
        },
    );
}
