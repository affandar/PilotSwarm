import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { AccessContext, FactStore } from "./facts-store.js";
import type { GraphStore } from "./graph-store.js";

// Roles that may run the privileged crawl work queue (`facts_read_uncrawled` /
// `facts_mark_crawled`, which read facts across ALL scopes). The app assigns the
// harvester role to its own agent; the facts-manager holds the queue too but is
// dormant by default (07 §1.5). agent-tuner is read-only and never harvests.
// NOTE: graph write/delete is NOT gated by this role — it is open to every
// non-tuner session (the knowledge graph is shared).
const TUNER_AGENT_ID = "agent-tuner";
const FACTS_MANAGER_AGENT_ID = "facts-manager";

export interface CreateGraphToolsOptions {
    graphStore: GraphStore;
    /** Base fact store — graph_stats reads crawl-queue counts from it. */
    factStore: FactStore;
    /** The session's agent identity, used for role gating. */
    agentIdentity?: string;
    /**
     * Whether this session holds the app-assigned HARVESTER role. This now gates
     * ONLY the crawl work queue (`facts_read_uncrawled` / `facts_mark_crawled`);
     * the facts-manager additionally receives the queue (dormant), and
     * agent-tuner never does. Graph write/delete is NOT gated by this flag — it
     * is available to every non-tuner session (see `canWriteGraph`).
     */
    isHarvester?: boolean;
    /**
     * Resolve the caller's ACL context for graph reads (evidence filtering +
     * seed gating). REQUIRED for correct isolation: without it, a reader would
     * see every session's evidence. Mirrors the read_facts lineage model —
     * returns { readerSessionId, grantedSessionIds } (or { unrestricted: true }
     * for the tuner). If omitted, graph reads FAIL CLOSED to the caller's own
     * session only (never unrestricted).
     */
    resolveAccess?: (sessionId: string | undefined) => Promise<AccessContext>;
    /** Agent id recorded on graph writes. */
    agentId?: string;
    /**
     * Fire-and-forget hook recording a `graph.searched` event (query + result
     * digest) for tuner forensics (07 P4 observability). Errors swallowed.
     */
    recordEvent?: (sessionId: string, eventType: string, data: unknown) => Promise<void>;
}

/**
 * Build the graph + crawl-queue tools (enhancedfactstore 07 P4). Registered
 * ONLY when a `graphStore` is present. Reader tools (search/neighbourhood) go to
 * every session; graph write/delete (`graph_upsert_*` / `graph_merge_nodes` /
 * `graph_delete_*`) go to EVERY session EXCEPT the read-only agent-tuner, so any
 * agent can incorporate into the SHARED graph; the crawl work queue
 * (`facts_read_uncrawled` / `facts_mark_crawled`) stays harvester-role +
 * facts-manager only (it reads facts across ALL scopes, bypassing per-session
 * ACL); `graph_stats` (read-only) goes to facts-manager + agent-tuner.
 * agent-tuner never gets a mutating tool.
 */
export function createGraphTools(opts: CreateGraphToolsOptions): Tool<any>[] {
    const { graphStore, factStore, agentIdentity, isHarvester, recordEvent } = opts;
    const agentId = opts.agentId ?? agentIdentity ?? "harvester";
    const isTuner = agentIdentity === TUNER_AGENT_ID;
    const isFactsManager = agentIdentity === FACTS_MANAGER_AGENT_ID;
    // ACL resolver. FAIL CLOSED: with no resolver, restrict reads to the
    // caller's own session (readerSessionId only) — never unrestricted. The
    // tuner is always unrestricted (privileged read-only investigator), matching
    // the read_facts model.
    const resolveAccess = async (sessionId: string | undefined): Promise<AccessContext> => {
        if (isTuner) return { unrestricted: true };
        if (opts.resolveAccess) return opts.resolveAccess(sessionId);
        return { readerSessionId: sessionId ?? null, grantedSessionIds: [] };
    };
    // Harvester powers (the crawl work queue): the app-assigned harvester role OR
    // the facts-manager (which holds them dormant). Never the tuner.
    const canHarvest = !isTuner && (isHarvester === true || isFactsManager);
    // Graph write/delete is open to EVERY session that can run tools, so any
    // agent can incorporate into the SHARED knowledge graph. The only exception
    // is the read-only agent-tuner, which never receives a mutating tool.
    const canWriteGraph = !isTuner;

    const tools: Tool<any>[] = [];

    // Record a graph search for tuner forensics — best-effort, never blocks.
    const recordSearch = (sessionId: string | undefined, kind: string, query: unknown, resultCount: number) => {
        if (!recordEvent || !sessionId) return;
        recordEvent(sessionId, "graph.searched", {
            kind,
            query,
            resultCount,
            at: new Date().toISOString(),
        }).catch(() => { /* swallow */ });
    };

    // ── Reader tools (every session) ─────────────────────────────────────────

    tools.push(defineTool("graph_search_nodes", {
        description:
            "Find / expand knowledge-graph nodes. RESOLVE (does this entity exist? — pass kind + nameLike before " +
            "creating anything) and PIVOT (seeds = fact scopeKeys from facts_search, expanded via EVIDENCED_BY; node " +
            "keys expand directly; depth bounds the hops). Each hit carries its evidence fact scopeKeys — feed those " +
            "into read_facts({ scopeKeys }) to get the underlying facts.",
        parameters: {
            type: "object" as const,
            properties: {
                kind: { type: "string", description: "Free-text node kind filter (person, patch, file, …)." },
                nameLike: { type: "string", description: "Lexical match on node name or any alias. The resolve key." },
                namespace: {
                    type: "string",
                    description:
                        "Optional graph namespace subtree. Matches this exact namespace and descendants, e.g. 'corpus/acme' includes 'corpus/acme/services'.",
                },
                seeds: { type: "array", items: { type: "string" }, description: "Fact scopeKeys OR node keys to anchor from." },
                depth: { type: "number", description: "Hops to expand from seeds (1..5)." },
                limit: { type: "number" },
            },
        },
        handler: async (a: any, ctx: any) => {
            const access = await resolveAccess(ctx?.sessionId);
            const hits = await graphStore.searchGraphNodes(
                { kind: a.kind, nameLike: a.nameLike, namespace: a.namespace, seeds: a.seeds, depth: a.depth, limit: a.limit },
                access,
            );
            recordSearch(ctx?.sessionId, "search_nodes", { kind: a.kind, nameLike: a.nameLike, namespace: a.namespace, seeds: a.seeds, depth: a.depth }, hits.length);
            return hits;
        },
    }));

    tools.push(defineTool("graph_search_edges", {
        description:
            "Find graph edges, two ways: anchor-and-explore (set fromKey and/or toKey) or exact-predicate " +
            "(predicate / predicateKey — exact equality, no fuzzy match).",
        parameters: {
            type: "object" as const,
            properties: {
                predicate: { type: "string", description: "EXACT predicate text." },
                predicateKey: { type: "string", description: "EXACT normalized key (preferred)." },
                fromKey: { type: "string" },
                toKey: { type: "string" },
                namespace: {
                    type: "string",
                    description:
                        "Optional graph namespace subtree. An edge matches when the edge itself or either endpoint is in the namespace subtree.",
                },
                minConfidence: { type: "number" },
                limit: { type: "number" },
            },
        },
        handler: async (a: any, ctx: any) => {
            const access = await resolveAccess(ctx?.sessionId);
            const hits = await graphStore.searchGraphEdges(a, access);
            recordSearch(ctx?.sessionId, "search_edges", a, hits.length);
            return hits;
        },
    }));

    tools.push(defineTool("graph_neighbourhood", {
        description: "Bounded subgraph around a node — 'show me everything connected to X'.",
        parameters: {
            type: "object" as const,
            properties: {
                nodeKey: { type: "string" },
                depth: { type: "number", description: "Hops (clamped 1..5)." },
                namespace: {
                    type: "string",
                    description:
                        "Optional graph namespace subtree for returned nodes/edges. Matches exact namespace and descendants.",
                },
            },
            required: ["nodeKey", "depth"] as const,
        },
        handler: async (a: any, ctx: any) => {
            const access = await resolveAccess(ctx?.sessionId);
            const sub = await graphStore.graphNeighbourhood(a.nodeKey, a.depth, access, { namespace: a.namespace });
            recordSearch(ctx?.sessionId, "neighbourhood", { nodeKey: a.nodeKey, depth: a.depth, namespace: a.namespace }, sub.nodes.length);
            return sub;
        },
    }));

    // ── graph_stats (read-only) — facts-manager + agent-tuner reporting ──────
    if (isFactsManager || isTuner) {
        tools.push(defineTool("graph_stats", {
            description:
                "Read-only graph report: node + edge counts and crawl-queue status (how many facts remain " +
                "uncrawled, reported up to a bounded probe). Use for status/health reporting — it never mutates the graph.",
            parameters: {
                type: "object" as const,
                properties: {
                    namespace: {
                        type: "string",
                        description:
                            "Optional graph namespace subtree for node/edge counts and crawl backlog. Matches exact namespace and descendants.",
                    },
                },
            },
            handler: async (a: any = {}) => {
                // Prefer a provider aggregate (single cheap query). If the store
                // does not implement graphStats(), fall back to a BOUNDED count —
                // never a fan-out traversal (that would be a multi-minute DoS on a
                // large graph).
                //
                // Crawl backlog: read a BOUNDED probe of the pending queue and
                // report its size. readUncrawledFacts returns `count = rows
                // returned` (capped by `limit`), so a limit:1 read would always
                // report 0 or 1 — useless as a backlog signal. We probe up to
                // BACKLOG_PROBE and flag `uncrawledFactsCapped` when the queue is
                // at least that deep ("harvester is well behind"); the exact depth
                // beyond the probe is not needed for a health report.
                const BACKLOG_PROBE = 500;
                const statsFn = (graphStore as any).graphStats;
                const uncrawled = await factStore.readUncrawledFacts({ namespace: a.namespace, limit: BACKLOG_PROBE });
                const uncrawledFacts = uncrawled.count;
                const uncrawledFactsCapped = uncrawled.count >= BACKLOG_PROBE;
                if (typeof statsFn === "function") {
                    const s = await statsFn.call(graphStore, { namespace: a.namespace });
                    return {
                        nodeCount: s.nodeCount,
                        edgeCount: s.edgeCount,
                        uncrawledFacts: s.uncrawledFacts ?? uncrawledFacts,
                        uncrawledFactsCapped: s.uncrawledFacts != null ? undefined : uncrawledFactsCapped,
                    };
                }
                // Bounded fallback: report whether the graph is non-empty + the
                // crawl backlog, without an O(N) traversal. nodeCount is a lower
                // bound (capped sample) so callers know it is approximate.
                const SAMPLE = 1000;
                const sample = await graphStore.searchGraphNodes({ namespace: a.namespace, limit: SAMPLE }, { unrestricted: true });
                return {
                    nodeCountAtLeast: sample.length,
                    nodeCountExact: sample.length < SAMPLE ? sample.length : undefined,
                    uncrawledFacts,
                    uncrawledFactsCapped,
                    note: typeof statsFn !== "function"
                        ? "Provider has no graphStats(); nodeCount is a bounded sample. Edge count omitted to avoid fan-out."
                        : undefined,
                };
            },
        }));
    }

    // ── Crawl-queue tools (HARVESTER / facts-manager — privileged, all scopes) ─
    // The crawl work queue reads facts across ALL scopes (bypassing per-session
    // ACL), so it stays restricted to the harvester role and the (dormant)
    // facts-manager — it is NOT opened up to every session.
    if (canHarvest) {
        tools.push(defineTool("facts_read_uncrawled", {
            description:
                "PRIVILEGED harvester work queue: facts not yet incorporated into the graph (new or edited since the " +
                "last crawl), across ALL scopes. Keep each fact's scopeKey and etag — both are the receipt facts_mark_crawled needs.",
            parameters: {
                type: "object" as const,
                properties: {
                    namespace: { type: "string", description: "Restrict the queue to a literal key prefix." },
                    limit: { type: "number", description: "Max facts this batch (default 20)." },
                },
            },
            handler: (a: any) => factStore.readUncrawledFacts({ namespace: a.namespace, limit: a.limit }),
        }));

        tools.push(defineTool("facts_mark_crawled", {
            description:
                "Stamp facts as incorporated so they leave the queue. Pass each fact's scopeKey and etag from facts_read_uncrawled. " +
                "A skipped stamp means the fact was already marked, changed since your read, or no longer exists; re-read if needed.",
            parameters: {
                type: "object" as const,
                properties: {
                    stamps: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                scopeKey: { type: "string" },
                                etag: { type: "number" },
                            },
                            required: ["scopeKey", "etag"],
                        },
                    },
                },
                required: ["stamps"] as const,
            },
            handler: (a: any) => factStore.markFactsCrawled(a.stamps),
        }));

        tools.push(defineTool("graph_remove_evidence", {
            description:
                "Reconcile a soft-deleted fact with the graph: remove this fact scopeKey from node EVIDENCED_BY anchors " +
                "and edge evidence arrays, deleting graph nodes/edges that become evidence-less. Call this for " +
                "facts_read_uncrawled rows where deletedAt/deleted_at is set, then mark the fact crawled with its scopeKey and etag.",
            parameters: {
                type: "object" as const,
                properties: {
                    scopeKey: { type: "string", description: "Deleted fact scopeKey from facts_read_uncrawled." },
                    namespace: { type: "string", description: "Optional graph namespace guard, e.g. corpus/northwind." },
                },
                required: ["scopeKey"] as const,
            },
            handler: (a: any) => graphStore.removeGraphEvidence(a.scopeKey, { namespace: a.namespace }),
        }));
    }

    // ── Graph write / delete — every session EXCEPT the read-only agent-tuner ─
    // The shared knowledge graph is writable by any agent that can run tools;
    // graph population is app-owned and is not a facts-manager-only job.
    if (!canWriteGraph) return tools;

    tools.push(defineTool("graph_upsert_node", {
        description:
            "Create a node, or merge into an existing one (idempotent; aliases + evidence union in). RESOLVE BEFORE " +
            "YOU CREATE: graph_search_nodes by nameLike first. Pass the source fact's scopeKey as evidence — it is " +
            "the provenance and what makes reinforcement dedup work. The graph is SHARED: anything you incorporate " +
            "is visible to every reader.",
        parameters: {
            type: "object" as const,
            properties: {
                kind: { type: "string", description: "Free text: person, patch, code_file, thread…" },
                name: { type: "string", description: "Canonical surface form." },
                namespace: {
                    type: "string",
                    description:
                        "Optional graph namespace, aligned with fact key prefixes (e.g. 'corpus/acme' or 'corpus/acme/services').",
                },
                aliases: { type: "array", items: { type: "string" }, description: "Other observed surface forms." },
                evidence: { type: "array", items: { type: "string" }, description: "Fact scopeKeys justifying this node." },
            },
            required: ["kind", "name"] as const,
        },
        handler: (a: any) => graphStore.upsertGraphNode({ ...a, agentId }),
    }));

    tools.push(defineTool("graph_upsert_edge", {
        description:
            "Assert a free-text relationship, or reinforce an existing one. Re-stating the same (fromKey, predicate, " +
            "toKey) does not duplicate — it bumps observations and combines confidence (noisy-OR) ONLY when you bring " +
            "new evidence; same-evidence replays are harmless no-ops. Pass RESOLVED nodeKeys, not raw names.",
        parameters: {
            type: "object" as const,
            properties: {
                fromKey: { type: "string", description: "Source node key." },
                toKey: { type: "string", description: "Target node key." },
                predicate: { type: "string", description: "Free-text verb, e.g. 'revives argument from'." },
                namespace: {
                    type: "string",
                    description:
                        "Optional graph namespace for this edge assertion. Use the same namespace as the source evidence/domain when known.",
                },
                confidence: { type: "number", description: "0..1 for THIS observation (default 1.0)." },
                evidence: { type: "array", items: { type: "string" }, description: "Fact scopeKeys justifying the edge." },
            },
            required: ["fromKey", "toKey", "predicate"] as const,
        },
        handler: (a: any) => graphStore.upsertGraphEdge({ ...a, agentId }),
    }));

    tools.push(defineTool("graph_merge_nodes", {
        description:
            "Entity resolution: fold a duplicate node into the survivor (union aliases, repoint edges, delete the " +
            "duplicate). Use when you discover two nodes are the same entity after the fact.",
        parameters: {
            type: "object" as const,
            properties: {
                fromKey: { type: "string", description: "Duplicate to remove." },
                intoKey: { type: "string", description: "Survivor to keep." },
                namespace: {
                    type: "string",
                    description: "Optional namespace guard. Merge only when both duplicate and survivor are in this namespace subtree.",
                },
                reason: { type: "string", description: "Why they're the same (audit)." },
            },
            required: ["fromKey", "intoKey", "reason"] as const,
        },
        handler: async (a: any) => { await graphStore.mergeGraphNodes(a.fromKey, a.intoKey, a.reason, { namespace: a.namespace }); return { merged: true }; },
    }));

    tools.push(defineTool("graph_delete_node", {
        description: "Remove a node and all its edges (DETACH DELETE). No cascade to facts.",
        parameters: {
            type: "object" as const,
            properties: {
                nodeKey: { type: "string" },
                namespace: { type: "string", description: "Optional namespace guard. Delete only when the node is in this namespace subtree." },
            },
            required: ["nodeKey"] as const,
        },
        handler: async (a: any) => ({ deleted: await graphStore.deleteGraphNode(a.nodeKey, { namespace: a.namespace }) }),
    }));

    tools.push(defineTool("graph_delete_edge", {
        description: "Remove one exact edge triple. Returns whether something matched.",
        parameters: {
            type: "object" as const,
            properties: {
                fromKey: { type: "string" },
                toKey: { type: "string" },
                predicateKey: { type: "string" },
                namespace: {
                    type: "string",
                    description: "Optional namespace guard. Delete only when the edge itself or either endpoint is in this namespace subtree.",
                },
            },
            required: ["fromKey", "toKey", "predicateKey"] as const,
        },
        handler: async (a: any) => ({ deleted: await graphStore.deleteGraphEdge(a.fromKey, a.toKey, a.predicateKey, { namespace: a.namespace }) }),
    }));

    return tools;
}
