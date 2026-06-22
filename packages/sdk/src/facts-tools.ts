import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { EnhancedFactStore, FactStore } from "./facts-store.js";

// ─── Knowledge Pipeline Namespace Access Control ────────────────────────────
const FACTS_MANAGER_AGENT_ID = "facts-manager";
const TUNER_AGENT_ID = "agent-tuner";
const RESERVED_WRITE_PREFIXES = ["skills/", "asks/", "config/facts-manager/"];
const RESERVED_READ_PREFIXES = ["intake/"];
const RESERVED_DELETE_PREFIXES = ["intake/", "skills/", "asks/", "config/facts-manager/"];

function boundedPreview(value: unknown, max = 80): string | undefined {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return undefined;
    return text.length > max ? text.slice(0, max) : text;
}

function normalizeNamespace(value: unknown): string | null {
    const text = typeof value === "string" ? value.trim().replace(/\/+$/g, "") : "";
    return text.length > 0 ? text : null;
}

function clampTags(tags: unknown): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const out = tags
        .map((tag) => typeof tag === "string" ? tag.trim() : "")
        .filter(Boolean)
        .slice(0, 20);
    return out.length > 0 ? out : undefined;
}

function checkNamespaceWrite(key: string, agentIdentity?: string): string | null {
    if (agentIdentity === TUNER_AGENT_ID) {
        return "Error: agent-tuner sessions are read-only and cannot store facts.";
    }
    for (const prefix of RESERVED_WRITE_PREFIXES) {
        if (key.startsWith(prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is reserved for the Facts Manager. ` +
                `Write observations to 'intake/<topic>/<your-session-id>' instead.`;
        }
    }
    return null;
}

function patternTouchesPrefix(pattern: string, prefix: string): boolean {
    const normalized = pattern.replace(/\*/g, "%");
    const wildcardIndex = normalized.search(/[%_]/);
    const literalPrefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
    return prefix.startsWith(literalPrefix) || literalPrefix.startsWith(prefix);
}

function checkNamespaceRead(keyPattern: string | undefined, agentIdentity?: string): string | null {
    if (!keyPattern) return null;
    // Normalize glob wildcards to SQL pattern for prefix check
    const normalized = keyPattern.replace(/\*/g, "%");
    for (const prefix of RESERVED_READ_PREFIXES) {
        if ((normalized.startsWith(prefix) || normalized.startsWith(prefix.replace("/", "/%"))) &&
            agentIdentity !== FACTS_MANAGER_AGENT_ID && agentIdentity !== TUNER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is not readable by task agents. ` +
                `Read curated skills from 'skills/' or open asks from 'asks/' instead.`;
        }
    }
    return null;
}

function checkNamespaceDelete(key: string, agentIdentity?: string): string | null {
    if (agentIdentity === TUNER_AGENT_ID) {
        return "Error: agent-tuner sessions are read-only and cannot delete facts.";
    }
    for (const prefix of RESERVED_DELETE_PREFIXES) {
        if (key.startsWith(prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            return `Error: the '${prefix}' key namespace is reserved. Only the Facts Manager can delete from it.`;
        }
    }
    return null;
}

function checkNamespaceDeletePattern(keyPattern: string, agentIdentity?: string): string | null {
    if (agentIdentity === TUNER_AGENT_ID) {
        return "Error: agent-tuner sessions are read-only and cannot delete facts.";
    }
    for (const prefix of RESERVED_DELETE_PREFIXES) {
        if (patternTouchesPrefix(keyPattern, prefix) && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
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
    /**
     * Optional fire-and-forget hook invoked from inside tool handlers when
     * a `read_facts` call touches the `skills/` knowledge namespace. Used
     * by SessionManager to record `learned_skill.read` CMS events for
     * skill-usage stats. Errors are swallowed; tool behavior is unaffected.
     */
    recordEvent?: (sessionId: string, eventType: string, data: unknown) => Promise<void>;
    /** Optional hook invoked after a successful shared intake/* write. */
    onSharedIntakeFactStored?: (input: { key: string; sourceSessionId: string | null; agentId: string | null }) => Promise<void>;
    /**
     * When the store is an EnhancedFactStore (search capability), the search
     * tools (`facts_search`, `facts_similar`) and the skills-scoped
     * `search_skills` pull tool are appended (enhancedfactstore 07 P4/§1.6).
     * `search_skills` is omitted for the facts-manager (it owns the namespace).
     */
    enhancedFactStore?: EnhancedFactStore;
}): Tool<any>[] {
    const { factStore, getDescendantSessionIds, getLineageSessionIds, agentIdentity, recordEvent, onSharedIntakeFactStored, enhancedFactStore } = opts;

    const recordRetrievalEvent = (sessionId: string | undefined, eventType: string, data: Record<string, unknown>) => {
        if (!recordEvent || !sessionId) return;
        recordEvent(sessionId, eventType, {
            ...data,
            callerAgentId: agentIdentity ?? null,
        }).catch(() => { /* swallow — best-effort telemetry */ });
    };

    const filterReservedReadFacts = (result: any) => {
        if (agentIdentity === FACTS_MANAGER_AGENT_ID || agentIdentity === TUNER_AGENT_ID) return result;
        if (!result || !Array.isArray(result.facts)) return result;
        const facts = result.facts.filter((fact: any) => {
            const key = String(fact?.key || "");
            return !RESERVED_READ_PREFIXES.some((prefix) => key.startsWith(prefix));
        });
        return {
            ...result,
            facts,
            count: facts.length,
        };
    };

    const storeTool = defineTool("store_fact", {
        description:
            "Store one fact or a batch of facts in the facts table for durable structured memory. " +
            "Facts are session-scoped by default, visible to every session in the same spawn tree (ancestors, descendants, siblings, cousins — anything spawned from a common root), and are deleted when the session is deleted. " +
            "Set shared=true to create shared durable memory visible across all sessions globally; shared facts persist until explicitly deleted. " +
            "For large ingestion, pass facts=[{key,value,tags?,shared?}, ...] instead of a single key/value.",
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
                facts: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            key: { type: "string" },
                            value: {},
                            tags: { type: "array", items: { type: "string" } },
                            shared: { type: "boolean" },
                        },
                        required: ["key", "value"],
                    },
                    description: "Optional batch of facts to store. When provided, top-level key/value are ignored.",
                },
            },
        },
        handler: async (
            args: { key?: string; value?: unknown; tags?: string[]; shared?: boolean; facts?: Array<{ key: string; value: unknown; tags?: string[]; shared?: boolean }> },
            ctx?: { sessionId?: string; agentId?: string },
        ) => {
            const factInputs = Array.isArray(args.facts) && args.facts.length > 0
                ? args.facts
                : (typeof args.key === "string" && "value" in args ? [{ key: args.key, value: args.value, tags: args.tags, shared: args.shared }] : []);
            if (factInputs.length === 0) return { error: "Error: store_fact requires either { key, value } or facts=[{ key, value }, ...]." };
            for (const fact of factInputs) {
                const nsError = checkNamespaceWrite(fact.key, agentIdentity);
                if (nsError) return { error: nsError };
            }

            const result = await factStore.storeFact(factInputs.map((fact) => ({
                key: fact.key,
                value: fact.value,
                tags: fact.tags,
                shared: fact.shared,
                sessionId: ctx?.sessionId ?? null,
                agentId: ctx?.agentId ?? null,
            })));
            for (const fact of result.facts) {
                if (fact.shared && fact.key.startsWith("intake/") && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
                    await onSharedIntakeFactStored?.({
                        key: fact.key,
                        sourceSessionId: ctx?.sessionId ?? null,
                        agentId: ctx?.agentId ?? null,
                    }).catch(() => {});
                }
            }
            if (result.facts.length === 1) {
                const fact = result.facts[0];
                return { ...fact, scope: fact.shared ? "shared" : "session" };
            }
            return {
                stored: result.stored,
                facts: result.facts.map((fact) => ({ ...fact, scope: fact.shared ? "shared" : "session" })),
            };
        },
    });

    const readTool = defineTool("read_facts", {
        description:
            "Read durable facts. By default this returns facts accessible to you now: your current session's facts, plus all session-scoped facts from any other session in the same spawn tree (ancestors, descendants, siblings, cousins), plus globally-shared facts. " +
            "Use scope='shared' to read only globally-shared facts. " +
            "Use scope='descendants' as an explicit family-tree view of spawn-tree facts (same visibility as the default).",
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
                        "Filter by source session. When targeting any session in your spawn tree (ancestor, descendant, sibling, cousin), its session-scoped facts become visible automatically.",
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
                        "accessible = current session facts + spawn-tree facts (ancestors, descendants, siblings, cousins) + globally-shared facts (default). " +
                        "shared = globally-shared facts only. " +
                        "session = current session facts only. " +
                        "descendants = same spawn-tree visibility as accessible, kept as an explicit family-tree view.",
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

            // Tuner is read-only at the namespace level (write/delete gates
            // already block it) but its job is to investigate ANY session,
            // not just its own lineage. Bypass the visibility filter for it
            // — optional filters (key_pattern, session_id, agent_id, tags)
            // still apply so queries remain targeted.
            const isTuner = agentIdentity === TUNER_AGENT_ID;

            let lineageSessionIds: string[] = [];
            let grantedSessionIds: string[] = [];

            if (!isTuner && ctx?.sessionId) {
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
                unrestricted: isTuner,
            }).then((result) => {
                // Emit a learned_skill.read event when the call touched the
                // `skills/` knowledge namespace. Single event per call — we
                // log the request shape, not the per-fact fan-out. Best-effort.
                if (recordEvent && ctx?.sessionId) {
                    const pattern = args.key_pattern ?? "";
                    const normalizedPattern = pattern.replace(/\*/g, "%");
                    if (normalizedPattern.startsWith("skills/")) {
                        recordEvent(ctx.sessionId, "learned_skill.read", {
                            name: pattern,
                            scope: effectiveScope ?? args.scope ?? "accessible",
                            matchCount: result.count,
                            limit: args.limit ?? 50,
                            callerSessionId: ctx.sessionId,
                            callerAgentId: agentIdentity ?? null,
                        }).catch(() => { /* swallow — best-effort */ });
                    }
                }
                return filterReservedReadFacts(result);
            });
        },
    });

    const deleteTool = defineTool("delete_fact", {
        description:
            "Delete facts. By default this deletes the current session's fact for the given exact key. " +
            "Set shared=true to delete the shared durable fact with that key instead. " +
            "For pattern deletes, set pattern=true and pass a key glob such as 'a/b/*'. Pattern deletes are explicit and never enabled by accident.",
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
                pattern: {
                    type: "boolean",
                    description: "Required true to treat key as a pattern. Supports '*' globs or SQL '%' wildcards.",
                },
                scope: {
                    type: "string",
                    enum: ["session", "shared", "all"],
                    description: "Pattern-delete scope. session=current session only, shared=shared facts only, all=Facts Manager unrestricted cleanup.",
                },
            },
            required: ["key"] as const,
        },
        handler: async (
            args: { key: string; shared?: boolean; pattern?: boolean; scope?: "session" | "shared" | "all" },
            ctx?: { sessionId?: string },
        ) => {
            const nsError = args.pattern
                ? checkNamespaceDeletePattern(args.key, agentIdentity)
                : checkNamespaceDelete(args.key, agentIdentity);
            if (nsError) return { error: nsError };

            if (args.pattern) {
                const scope = args.scope ?? (args.shared === true ? "shared" : "session");
                if (scope === "all" && agentIdentity !== FACTS_MANAGER_AGENT_ID) {
                    return { error: "Error: delete_fact scope='all' is reserved for the Facts Manager." };
                }
                return factStore.deleteFact({
                    key: args.key,
                    pattern: true,
                    scope,
                    sessionId: ctx?.sessionId ?? null,
                    unrestricted: agentIdentity === FACTS_MANAGER_AGENT_ID,
                });
            }

            return factStore.deleteFact({
                key: args.key,
                shared: args.shared,
                sessionId: ctx?.sessionId ?? null,
            });
        },
    });

    const managerTools: Tool<any>[] = [];
    if (agentIdentity === FACTS_MANAGER_AGENT_ID) {
        managerTools.push(defineTool("facts_tombstone_stats", {
            description:
                "Read soft-deleted fact tombstone backlog stats. Use during Facts Manager maintenance to monitor " +
                "whether graph reconciliation is keeping up before the TTL backstop purges unresolved tombstones.",
            parameters: {
                type: "object" as const,
                properties: {
                    ttlSeconds: { type: "number", description: "Tombstone TTL in seconds. Default 21600 (6h)." },
                },
            },
            handler: async (a: { ttlSeconds?: number }) => factStore.getFactsTombstoneStats(a.ttlSeconds),
        }));

        managerTools.push(defineTool("facts_purge_tombstones", {
            description:
                "Hard-delete soft-deleted facts that are either already reconciled (last_crawled_at set) or older than the TTL. " +
                "Use during the Facts Manager maintenance pass. ttlSeconds=0 purges all tombstones on this pass.",
            parameters: {
                type: "object" as const,
                properties: {
                    ttlSeconds: { type: "number", description: "Tombstone TTL in seconds. Default 21600 (6h). Use 0 only when no crawler is running." },
                    limit: { type: "number", description: "Maximum rows to purge in this call. Default 1000." },
                },
            },
            handler: async (a: { ttlSeconds?: number; limit?: number }) => ({
                purged: await factStore.purgeExpiredFacts(a.ttlSeconds ?? 21_600, a.limit),
            }),
        }));

        managerTools.push(defineTool("facts_force_purge", {
            description:
                "Dangerous operator-directed cleanup: hard-delete soft-deleted facts older than a cutoff, regardless of TTL or graph reconciliation. " +
                "This can strand graph evidence for unreconciled tombstones. Requires confirm=true and never deletes live facts.",
            parameters: {
                type: "object" as const,
                properties: {
                    cutoff: { type: "string", description: "ISO timestamp. Tombstones older than this are eligible." },
                    onlyUnreconciled: { type: "boolean", description: "If true, purge only tombstones with last_crawled_at IS NULL." },
                    keyPrefix: { type: "string", description: "Optional literal fact-key prefix to bound the purge." },
                    limit: { type: "number", description: "Maximum rows to purge in this call. Default 1000." },
                    confirm: { type: "boolean", description: "Must be true to execute this destructive bypass." },
                },
                required: ["cutoff", "confirm"] as const,
            },
            handler: async (a: { cutoff: string; onlyUnreconciled?: boolean; keyPrefix?: string; limit?: number; confirm?: boolean }) => {
                if (a.confirm !== true) {
                    return { error: "facts_force_purge requires confirm=true because it can strand graph evidence." };
                }
                const cutoff = new Date(a.cutoff);
                if (!Number.isFinite(cutoff.getTime())) {
                    return { error: "facts_force_purge cutoff must be a valid ISO timestamp." };
                }
                return {
                    purged: await factStore.forcePurgeFacts({
                        cutoff,
                        onlyUnreconciled: a.onlyUnreconciled,
                        keyPrefix: a.keyPrefix,
                        limit: a.limit,
                    }),
                };
            },
        }));
    }

    const enhancedTools: Tool<any>[] = [];
    if (enhancedFactStore && enhancedFactStore.capabilities.search) {
        const isTuner = agentIdentity === TUNER_AGENT_ID;
        // Resolve the SAME lineage visibility read_facts uses: the tuner is an
        // unrestricted investigator; everyone else sees their own session plus
        // granted lineage sessions (ancestors/descendants). FAIL CLOSED — with
        // no lineage resolver, a non-tuner sees only its own session.
        const resolveSearchAccess = async (ctx?: { sessionId?: string }) => {
            if (isTuner) return { readerSessionId: ctx?.sessionId ?? null, grantedSessionIds: [] as string[], unrestricted: true };
            let granted: string[] = [];
            if (ctx?.sessionId && getLineageSessionIds) {
                const raw = await getLineageSessionIds(ctx.sessionId);
                granted = [...new Set((raw || []).filter((sid) => Boolean(sid) && sid !== ctx.sessionId))];
            } else if (ctx?.sessionId && getDescendantSessionIds) {
                const raw = await getDescendantSessionIds(ctx.sessionId);
                granted = [...new Set((raw || []).filter((sid) => Boolean(sid) && sid !== ctx.sessionId))];
            }
            return { readerSessionId: ctx?.sessionId ?? null, grantedSessionIds: granted, unrestricted: false };
        };

        // Reserved-namespace gate for SEARCH — the same rule read_facts enforces.
        // Without this, facts_search/facts_similar would be a hole around the
        // intake/* (and skills/asks-write) ACL: a task agent could query
        // namespace:"intake" or a broad term and receive reserved values.
        // Note: the `namespace` arg is a bare key PREFIX (e.g. "intake", not
        // "intake/*"), so match it against the reserved prefixes' leading
        // segment as well as the slash form checkNamespaceRead expects.
        const blockReservedSearch = (namespace?: string) => {
            if (!namespace || agentIdentity === FACTS_MANAGER_AGENT_ID || agentIdentity === TUNER_AGENT_ID) return null;
            const ns = namespace.replace(/\/+$/, "");
            const hitsReserved = RESERVED_READ_PREFIXES.some((p) => {
                const seg = p.replace(/\/+$/, "");
                return ns === seg || ns.startsWith(seg + "/") || seg.startsWith(ns + "/");
            });
            if (hitsReserved) {
                return `Error: the '${ns}' key namespace is not readable by task agents. ` +
                    `Search curated skills (namespace 'skills') or open asks (namespace 'asks') instead.`;
            }
            // Fall back to the shared slash-form check for any other shape.
            return checkNamespaceRead(namespace, agentIdentity);
        };
        const stripReserved = (result: any) => {
            if (agentIdentity === FACTS_MANAGER_AGENT_ID || agentIdentity === TUNER_AGENT_ID) return result;
            if (!result || !Array.isArray(result.facts)) return result;
            const facts = result.facts.filter((f: any) =>
                !RESERVED_READ_PREFIXES.some((p) => String(f?.key || "").startsWith(p)));
            return { ...result, count: facts.length, facts };
        };

        enhancedTools.push(defineTool("facts_search", {
            description:
                "Search your durable facts/memory by relevance (lexical / semantic / hybrid) — often more effective " +
                "than read_facts, which only matches literal keys. Mode selection is independent of graph namespace " +
                "discovery: semantic = natural-language questions; hybrid = a one-shot recheck when semantic hits " +
                "are weak; lexical = exact identifiers, error codes, proper nouns, quoted phrases, or single exact terms. " +
                "If a namespace is already known, pass it here. Returned scopeKey values can seed graph_search_nodes.",
            parameters: {
                type: "object" as const,
                properties: {
                    query: { type: "string", description: "Keywords for lexical, natural language for semantic, keyword-rich phrase for hybrid." },
                    mode: { type: "string", enum: ["lexical", "semantic", "hybrid"], description: "Default semantic when semantic search is available; use hybrid as a weak-semantic recheck and lexical for exact tokens." },
                    namespace: { type: "string", description: "Key-prefix filter over fact keys, matched as '<prefix>/%'. Accepts ANY number of '/'-delimited segments: a reserved namespace ('skills', 'asks') or a domain root ('acme', 'acme/services') to scope a multi-domain corpus to one domain/sub-domain before lexical/semantic/hybrid ranking." },
                    tags: { type: "array", items: { type: "string" } },
                    limit: { type: "number", description: "Max results (default 20)." },
                },
                required: ["query"] as const,
            },
            handler: async (a: { query: string; mode?: any; namespace?: string; tags?: string[]; limit?: number }, ctx?: { sessionId?: string }) => {
                const nsError = blockReservedSearch(a.namespace);
                if (nsError) return { error: nsError };
                const startedAt = Date.now();
                const access = await resolveSearchAccess(ctx);
                const result = stripReserved(await enhancedFactStore.searchFacts(a.query, { mode: a.mode, namespace: a.namespace, tags: a.tags, limit: a.limit }, access));
                recordRetrievalEvent(ctx?.sessionId, "facts.searched", {
                    operation: "facts_search",
                    queryPreview: boundedPreview(a.query),
                    mode: a.mode ?? null,
                    namespace: normalizeNamespace(a.namespace),
                    tags: clampTags(a.tags),
                    limit: a.limit ?? 20,
                    resultCount: Number(result?.count ?? result?.facts?.length ?? 0),
                    durationMs: Date.now() - startedAt,
                });
                return result;
            },
        }));

        enhancedTools.push(defineTool("facts_similar", {
            description:
                "Given a fact you already have, return the semantically nearest other facts (vector kNN over the " +
                "fact's stored embedding — no query text, no re-embedding). Use for clustering, dedup hunting, or " +
                "expanding context around a known fact. Pass namespace to restrict candidates to a fact key-prefix " +
                "subtree before nearest-neighbour ranking, using the same semantics as facts_search.",
            parameters: {
                type: "object" as const,
                properties: {
                    scopeKey: { type: "string", description: "The anchor fact's scopeKey." },
                    namespace: {
                        type: "string",
                        description:
                            "Optional key-prefix filter over candidate fact keys, matched as '<prefix>/%'. Accepts any number of '/'-delimited segments, e.g. 'skills' or 'corpus/acme/services'.",
                    },
                    k: { type: "number", description: "Top-k neighbours (default 8)." },
                    minScore: { type: "number", description: "Drop neighbours below this cosine score (0..1)." },
                },
                required: ["scopeKey"] as const,
            },
            handler: async (a: { scopeKey: string; namespace?: string; k?: number; minScore?: number }, ctx?: { sessionId?: string }) => {
                const nsError = blockReservedSearch(a.namespace);
                if (nsError) return { error: nsError };
                const startedAt = Date.now();
                const access = await resolveSearchAccess(ctx);
                const result = await enhancedFactStore.similarFacts(a.scopeKey, { k: a.k, minScore: a.minScore, namespace: a.namespace }, access);
                // Post-filter reserved keys — similarFacts has no namespace arg, so
                // a kNN from an accessible anchor could still surface reserved
                // near-neighbours for a task agent when namespace is broad/omitted.
                const filtered = stripReserved(result);
                recordRetrievalEvent(ctx?.sessionId, "facts.similar", {
                    operation: "facts_similar",
                    scopeKey: a.scopeKey,
                    namespace: normalizeNamespace(a.namespace),
                    k: a.k ?? 8,
                    minScore: a.minScore ?? null,
                    resultCount: Number(filtered?.count ?? filtered?.facts?.length ?? 0),
                    durationMs: Date.now() - startedAt,
                });
                return filtered;
            },
        }));

        // search_skills — skills-scoped pull (07 §1.6). The facts-manager owns the
        // skills namespace and curates it directly, so it does not get this tool.
        if (agentIdentity !== FACTS_MANAGER_AGENT_ID) {
            enhancedTools.push(defineTool("search_skills", {
                description:
                    "Find the curated skills most relevant to your current task (ranked semantic + lexical search " +
                    "over the shared 'skills' namespace). Call this at the start of a turn with a task-derived query " +
                    "(e.g. 'azure deployments', 'horizondb connection errors', 'terraform s3 backend') — as many times " +
                    "as needed for different facets. Returns ranked skill hints; load a skill's full instructions with " +
                    "read_facts(key_pattern=\"<key>\", scope=\"shared\") before applying it.",
                parameters: {
                    type: "object" as const,
                    properties: {
                        query: { type: "string", description: "What the task is about (natural language or keywords)." },
                        limit: { type: "number", description: "Max skill hints (default 8)." },
                    },
                    required: ["query"] as const,
                },
                handler: async (a: { query: string; limit?: number }, ctx?: { sessionId?: string }) => {
                    const startedAt = Date.now();
                    // Skills are SHARED + curated; access is the shared scope (no
                    // private-session leakage possible — namespace is pinned to
                    // 'skills' and scope to 'shared').
                    const access = await resolveSearchAccess(ctx);
                    const res = await enhancedFactStore.searchFacts(
                        a.query,
                        { mode: "hybrid", namespace: "skills", scope: "shared", limit: a.limit ?? 8 },
                        access,
                    );
                    // Hint shape only — the agent loads full content via read_facts.
                    const out = {
                        count: res.count,
                        skills: res.facts.map((f: any) => {
                            const v = typeof f.value === "string" ? safeParse(f.value) : f.value;
                            return { key: f.key, name: v?.name ?? f.key, description: v?.description ?? "", score: f.score };
                        }),
                    };
                    recordRetrievalEvent(ctx?.sessionId, "skills.searched", {
                        operation: "search_skills",
                        queryPreview: boundedPreview(a.query),
                        mode: "hybrid",
                        namespace: "skills",
                        limit: a.limit ?? 8,
                        resultCount: Number(out.count ?? 0),
                        durationMs: Date.now() - startedAt,
                    });
                    return out;
                },
            }));
        }
    }

    // ── manage_embedder — durable embedder lifecycle (CONTROL PLANE) ─────────
    //   The embedder is the single eternal in-DB batch loop that fills the
    //   `embedding` column so semantic/hybrid search and facts_similar work.
    //   It is a SHARED, durable, fleet-wide resource (one loop per facts schema,
    //   advisory-locked across workers), so its lifecycle is an OPERATOR action,
    //   not a per-task tool. Restrict it to the Facts Manager — the singleton
    //   curator that already owns the knowledge-base control surface. Gate on
    //   `capabilities.embedder` (NOT `.search`): a store can have search without
    //   an embedder (lexical-only), and vice versa.
    if (
        enhancedFactStore &&
        enhancedFactStore.capabilities.embedder &&
        agentIdentity === FACTS_MANAGER_AGENT_ID
    ) {
        enhancedTools.push(defineTool("manage_embedder", {
            description:
                "Inspect and control the durable embedding loop that powers semantic/hybrid facts_search and " +
                "facts_similar. This is a SHARED, fleet-wide resource (one loop per facts schema) — changes affect " +
                "all agents and all sessions, so use it deliberately. Actions: 'status' (current running state — " +
                "always safe), 'start' (idempotently ensure the loop is running; optionally tune batch size / poll " +
                "interval), 'stop' (halt embedding fleet-wide — semantic search degrades to lexical until restarted), " +
                "'configure' (replace the embedding endpoint; rejects a model whose vector dimension differs from the " +
                "column, since that needs a schema migration + full re-embed). Prefer 'status' first; only 'stop' when " +
                "an operator explicitly asks, because new and updated facts stop getting embeddings while it is stopped.",
            parameters: {
                type: "object" as const,
                properties: {
                    action: {
                        type: "string",
                        enum: ["status", "start", "stop", "configure"],
                        description: "status = read-only; start/stop = lifecycle; configure = replace endpoint.",
                    },
                    intervalSeconds: {
                        type: "number",
                        description: "start only: seconds between embed passes (loop poll interval).",
                    },
                    batch: {
                        type: "number",
                        description: "start only: rows embedded per pass.",
                    },
                    reason: {
                        type: "string",
                        description: "stop only: human-readable reason recorded for the cancellation.",
                    },
                    endpoint: {
                        type: "object",
                        description:
                            "configure only: OpenAI/Azure-compatible embeddings endpoint. `dim` MUST match the " +
                            "column dimension fixed at migration time.",
                        properties: {
                            url: { type: "string", description: "Embeddings endpoint URL." },
                            model: { type: "string", description: "Model / deployment name." },
                            dim: { type: "number", description: "Vector dimension (must match the column)." },
                            apiKey: { type: "string", description: "API key (optional)." },
                            apiKeyHeader: { type: "string", description: "Auth header name (default 'api-key')." },
                            bearer: { type: "boolean", description: "Send the key as 'Bearer <key>' (default false)." },
                        },
                        required: ["url", "model", "dim"] as const,
                    },
                },
                required: ["action"] as const,
            },
            handler: async (a: {
                action: "status" | "start" | "stop" | "configure";
                intervalSeconds?: number;
                batch?: number;
                reason?: string;
                endpoint?: { url: string; model: string; dim: number; apiKey?: string; apiKeyHeader?: string; bearer?: boolean };
            }) => {
                try {
                    switch (a.action) {
                        case "status":
                            return { action: "status", ...(await enhancedFactStore.embedderStatus()) };
                        case "start":
                            return {
                                action: "start",
                                ...(await enhancedFactStore.startEmbedder({
                                    intervalSeconds: a.intervalSeconds,
                                    batch: a.batch,
                                })),
                            };
                        case "stop":
                            return { action: "stop", ...(await enhancedFactStore.stopEmbedder(a.reason)) };
                        case "configure": {
                            if (!a.endpoint) {
                                return { error: "configure requires an 'endpoint' object with url, model, and dim." };
                            }
                            return {
                                action: "configure",
                                ...(await enhancedFactStore.configureEmbedder(a.endpoint, { restartIfRunning: true })),
                            };
                        }
                        default:
                            return { error: `Unknown action '${a.action}'. Use status, start, stop, or configure.` };
                    }
                } catch (err) {
                    // Surface the provider's error to the agent (e.g. dim mismatch on
                    // configure) rather than throwing out of the tool call.
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        }));
    }

    return [storeTool, readTool, deleteTool, ...managerTools, ...enhancedTools];
}

function safeParse(s: string): any {
    try { return JSON.parse(s); } catch { return undefined; }
}
