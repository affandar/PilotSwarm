import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { FactStore } from "./facts-store.js";

// ─── Knowledge Pipeline Namespace Access Control ────────────────────────────
const FACTS_MANAGER_AGENT_ID = "facts-manager";
const RESERVED_WRITE_PREFIXES = ["skills/", "asks/", "config/facts-manager/"];
const RESERVED_READ_PREFIXES = ["intake/"];
const RESERVED_DELETE_PREFIXES = ["intake/", "skills/", "asks/", "config/facts-manager/"];

function checkNamespaceWrite(key: string, agentIdentity?: string): string | null {
    for (const prefix of RESERVED_WRITE_PREFIXES) {
        if (key.startsWith(prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is reserved for the Facts Manager. ` +
                `Write observations to 'intake/<topic>/<your-session-id>' instead.`;
        }
    }
    return null;
}

function checkNamespaceRead(keyPattern: string | undefined, agentIdentity?: string): string | null {
    if (!keyPattern) return null;
    // Normalize glob wildcards to SQL pattern for prefix check
    const normalized = keyPattern.replace(/\*/g, "%");
    for (const prefix of RESERVED_READ_PREFIXES) {
        if ((normalized.startsWith(prefix) || normalized.startsWith(prefix.replace("/", "/%"))) &&
            agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is not readable by task agents. ` +
                `Read curated skills from 'skills/' or open asks from 'asks/' instead.`;
        }
    }
    return null;
}

function checkNamespaceDelete(key: string, agentIdentity?: string): string | null {
    for (const prefix of RESERVED_DELETE_PREFIXES) {
        if (key.startsWith(prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is reserved. Only the Facts Manager can delete from it.`;
        }
    }
    return null;
}

export function createFactTools(opts: {
    factStore: FactStore;
    getDescendantSessionIds?: (sessionId: string) => Promise<string[]>;
    getLineageSessionIds?: (sessionId: string) => Promise<string[]>;
    agentIdentity?: string;
}): Tool<any>[] {
    const { factStore, getDescendantSessionIds, getLineageSessionIds, agentIdentity } = opts;

    const storeTool = defineTool("store_fact", {
        description:
            "Store a fact in the facts table for durable structured memory. " +
            "Facts are session-scoped by default, visible to ancestor/descendant sessions in the same spawned-agent lineage, and are deleted when the session is deleted. " +
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
            const nsError = checkNamespaceWrite(args.key, agentIdentity);
            if (nsError) return { error: nsError };

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
            "Read durable facts. By default this returns facts accessible to you now: your current session's facts, lineage facts from ancestor/descendant sessions, plus shared facts. " +
            "Use scope='shared' to read only shared facts. " +
            "Use scope='descendants' as an explicit family-tree view of spawned-agent lineage facts.",
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
                        "Filter by source session. When targeting an ancestor or descendant session in your spawned-agent lineage, its private facts become visible automatically.",
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
                        "accessible = current session facts + lineage facts from ancestor/descendant sessions + shared facts (default). " +
                        "shared = shared facts only. " +
                        "session = current session facts only. " +
                        "descendants = the same family-tree visibility as accessible, kept as an explicit lineage view for parent/child workflows.",
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
            const nsError = checkNamespaceRead(args.key_pattern, agentIdentity);
            if (nsError) return { error: nsError };

            // Normalize session_id: LLM may pass orchId format "session-<uuid>"
            // but facts and CMS store raw UUIDs.
            const targetSessionId = args.session_id?.startsWith("session-")
                ? args.session_id.slice("session-".length)
                : args.session_id;

            let lineageSessionIds: string[] = [];
            let grantedSessionIds: string[] = [];

            if (ctx?.sessionId) {
                const rawLineageSessionIds = getLineageSessionIds
                    ? await getLineageSessionIds(ctx.sessionId)
                    : getDescendantSessionIds
                        ? await getDescendantSessionIds(ctx.sessionId)
                        : [];
                lineageSessionIds = [...new Set((rawLineageSessionIds || []).filter((sessionId) => (
                    Boolean(sessionId) && sessionId !== ctx.sessionId
                )))];

                if (args.scope === "accessible" || args.scope === "descendants" || !args.scope) {
                    grantedSessionIds = lineageSessionIds;
                }

                if (targetSessionId && targetSessionId !== ctx.sessionId) {
                    grantedSessionIds = lineageSessionIds.includes(targetSessionId)
                        ? [targetSessionId]
                        : [];
                }
            }

            // Determine effective scope: if we've granted lineage access,
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
            const nsError = checkNamespaceDelete(args.key, agentIdentity);
            if (nsError) return { error: nsError };

            return factStore.deleteFact({
                key: args.key,
                shared: args.shared,
                sessionId: ctx?.sessionId ?? null,
            });
        },
    });

    return [storeTool, readTool, deleteTool];
}
