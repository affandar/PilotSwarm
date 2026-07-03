import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";

export function registerFactsTools(server: McpServer, ctx: ServerContext) {
    // 1. store_fact — Store a fact in the knowledge store
    server.registerTool(
        "store_fact",
        {
            title: "Store Fact",
            description: "Store a fact in the PilotSwarm knowledge store",
            inputSchema: {
                key: z.string().describe("The key to store the fact under"),
                value: z.any().describe("The value to store"),
                tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
                shared: z.boolean().optional().describe("Whether the fact is shared across sessions (default false)"),
                session_id: z.string().optional().describe("Session ID to associate the fact with"),
            },
        },
        async ({ key, value, tags, shared, session_id }) => {
            try {
                const result = await ctx.facts.storeFact({
                    key,
                    value,
                    tags,
                    shared: shared ?? false,
                    sessionId: session_id,
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(result, null, 2),
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

    // 2. read_facts — Query facts from the knowledge store
    //
    // Privilege boundary (see README › Security model):
    //   `session_id`, `reader_session_id`, and `granted_session_ids` are all
    //   caller-supplied. The MCP server has no ambient mapping from MCP client
    //   to PilotSwarm session, so it cannot derive the right session implicitly
    //   — any client speaking to this MCP endpoint can read facts scoped to any
    //   session it names. Operators MUST treat MCP clients as trusted: gate the
    //   stdio transport via process isolation and the HTTP transport via the
    //   shared `PILOTSWARM_MCP_KEY` bearer (both already enforced upstream of
    //   this tool). A stricter per-client privilege boundary belongs at the
    //   transport / auth layer, not here.
    server.registerTool(
        "read_facts",
        {
            title: "Read Facts",
            description:
                "Query facts from the PilotSwarm knowledge store. " +
                "TRUST NOTE: session_id / reader_session_id / granted_session_ids are caller-supplied; " +
                "this tool does not authenticate that the caller owns the named session. " +
                "MCP clients connecting to this server are trusted with cross-session fact reads.",
            inputSchema: {
                key_pattern: z.string().optional().describe("Pattern to match fact keys against"),
                tags: z.array(z.string()).optional().describe("Filter by tags"),
                session_id: z
                    .string()
                    .optional()
                    .describe(
                        "Filter by session ID. Caller-supplied and not authenticated against client identity — see tool description.",
                    ),
                reader_session_id: z
                    .string()
                    .optional()
                    .describe(
                        "Session ID of the reader for access control. Caller-supplied; trust assumption applies.",
                    ),
                granted_session_ids: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "Session IDs the reader has been granted access to. Caller-supplied; trust assumption applies.",
                    ),
                keys_only: z.boolean().optional().describe("If true, return only fact keys without values (default false)"),
                limit: z.number().optional().describe("Maximum number of facts to return"),
            },
        },
        async ({ key_pattern, tags, session_id, reader_session_id, granted_session_ids, keys_only, limit }) => {
            try {
                const query: Record<string, unknown> = {};
                if (key_pattern !== undefined) query.keyPattern = key_pattern;
                if (tags !== undefined) query.tags = tags;
                if (session_id !== undefined) query.sessionId = session_id;
                if (limit !== undefined) query.limit = limit;

                const access =
                    reader_session_id !== undefined || granted_session_ids !== undefined
                        ? { readerSessionId: reader_session_id, grantedSessionIds: granted_session_ids }
                        : undefined;

                const result = await ctx.facts.readFacts(query, access);

                if (keys_only) {
                    const keys = result.facts.map((f: any) => f.key);
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({ count: keys.length, keys }, null, 2),
                            },
                        ],
                    };
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
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );

    // 3. delete_fact — Delete a fact from the knowledge store
    server.registerTool(
        "delete_fact",
        {
            title: "Delete Fact",
            description: "Delete a fact from the PilotSwarm knowledge store",
            inputSchema: {
                key: z.string().describe("The key of the fact to delete"),
                session_id: z.string().optional().describe("Session ID the fact is associated with"),
            },
        },
        async ({ key, session_id }) => {
            try {
                const result = await ctx.facts.deleteFact({
                    key,
                    sessionId: session_id,
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(result, null, 2),
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
}
