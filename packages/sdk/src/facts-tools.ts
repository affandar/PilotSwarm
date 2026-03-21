import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { FactStore } from "./facts-store.js";

export function createFactTools(opts: {
    factStore: FactStore;
    getDescendantSessionIds?: (sessionId: string) => Promise<string[]>;
}): Tool<any>[] {
    const { factStore, getDescendantSessionIds } = opts;

    const storeTool = defineTool("store_fact", {
        description:
            "Store a fact in the facts table for durable structured memory. " +
            "Facts are session-scoped by default and are deleted when the session is deleted. " +
            "Set shared=true to create shared durable memory visible across sessions; shared facts persist until explicitly deleted.",
        parameters: {
            type: "object" as const,
            properties: {
                key: {
                    type: "string",
                    description: "Fact key, for example 'baseline/tps' or 'infra/server/fqdn'.",
                },
                value: {
                    description: "JSON-serializable fact value.",
                },
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional tags for querying related facts later.",
                },
                shared: {
                    type: "boolean",
                    description: "If true, store as shared global knowledge visible across sessions. Default: false.",
                },
            },
            required: ["key", "value"] as const,
        },
        handler: async (
            args: { key: string; value: unknown; tags?: string[]; shared?: boolean },
            ctx?: { sessionId?: string; agentId?: string },
        ) => {
            const result = await factStore.storeFact({
                key: args.key,
                value: args.value,
                tags: args.tags,
                shared: args.shared,
                sessionId: ctx?.sessionId ?? null,
                agentId: ctx?.agentId ?? null,
            });
            return {
                ...result,
                scope: result.shared ? "shared" : "session",
            };
        },
    });

    const readTool = defineTool("read_facts", {
        description:
            "Read durable facts. By default this returns facts accessible to you now: your current session's facts plus shared facts. " +
            "Use scope='shared' to read only shared facts. " +
            "Use scope='descendants' to also include facts from your sub-agent sessions (children, grandchildren, etc.).",
        parameters: {
            type: "object" as const,
            properties: {
                key_pattern: {
                    type: "string",
                    description:
                        "Optional key pattern. Supports SQL '%' wildcards or '*' globs, for example 'baseline/%' or 'infra/*'.",
                },
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional tags filter. All listed tags must be present.",
                },
                session_id: {
                    type: "string",
                    description:
                        "Filter by source session. When targeting a descendant session, its private facts become visible automatically.",
                },
                agent_id: {
                    type: "string",
                    description: "Optional provenance filter for the agent that stored the fact.",
                },
                limit: {
                    type: "number",
                    description: "Maximum number of rows to return. Default: 50.",
                },
                scope: {
                    type: "string",
                    enum: ["accessible", "shared", "session", "descendants"],
                    description:
                        "accessible = current session facts plus shared facts (default). " +
                        "shared = shared facts only. " +
                        "session = current session facts only. " +
                        "descendants = your session facts + shared facts + all facts from your sub-agent sessions (children, grandchildren, etc.).",
                },
            },
        },
        handler: async (
            args: {
                key_pattern?: string;
                tags?: string[];
                session_id?: string;
                agent_id?: string;
                limit?: number;
                scope?: "accessible" | "shared" | "session" | "descendants";
            },
            ctx?: { sessionId?: string },
        ) => {
            // Normalize session_id: LLM may pass orchId format "session-<uuid>"
            // but facts and CMS store raw UUIDs.
            const targetSessionId = args.session_id?.startsWith("session-")
                ? args.session_id.slice("session-".length)
                : args.session_id;

            let grantedSessionIds: string[] = [];

            if (getDescendantSessionIds && ctx?.sessionId) {
                if (args.scope === "descendants") {
                    // Grant access to all descendant sessions
                    grantedSessionIds = await getDescendantSessionIds(ctx.sessionId);
                } else if (targetSessionId && targetSessionId !== ctx.sessionId) {
                    // Targeted read: grant access if the target is a descendant
                    const descendants = await getDescendantSessionIds(ctx.sessionId);
                    if (descendants.includes(targetSessionId)) {
                        grantedSessionIds = [targetSessionId];
                    }
                }
            }

            // Determine effective scope: if we've granted descendant access,
            // force "accessible" so the visibility clause includes granted IDs.
            let effectiveScope = args.scope;
            if (effectiveScope === "descendants" || grantedSessionIds.length > 0) {
                effectiveScope = "accessible";
            }

            return factStore.readFacts({
                keyPattern: args.key_pattern,
                tags: args.tags,
                sessionId: targetSessionId,
                agentId: args.agent_id,
                limit: args.limit,
                scope: effectiveScope,
            }, {
                readerSessionId: ctx?.sessionId ?? null,
                grantedSessionIds,
            });
        },
    });

    const deleteTool = defineTool("delete_fact", {
        description:
            "Delete a fact. By default this deletes the current session's fact for the given key. " +
            "Set shared=true to delete the shared durable fact with that key instead.",
        parameters: {
            type: "object" as const,
            properties: {
                key: {
                    type: "string",
                    description: "Fact key to delete.",
                },
                shared: {
                    type: "boolean",
                    description: "If true, delete the shared fact. Otherwise delete the current session's fact.",
                },
            },
            required: ["key"] as const,
        },
        handler: async (
            args: { key: string; shared?: boolean },
            ctx?: { sessionId?: string },
        ) => {
            return factStore.deleteFact({
                key: args.key,
                shared: args.shared,
                sessionId: ctx?.sessionId ?? null,
            });
        },
    });

    return [storeTool, readTool, deleteTool];
}
