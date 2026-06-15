import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { AccessContext, FactStore } from "./facts-store.js";
import type { GraphStore } from "./graph-store.js";

// Roles that may HARVEST (crawl-queue + graph write/delete). The app assigns the
// harvester role to its own agent; the facts-manager holds the tools but is
// dormant by default (07 §1.5). agent-tuner is read-only and never harvests.
const TUNER_AGENT_ID = "agent-tuner";
const FACTS_MANAGER_AGENT_ID = "facts-manager";

export interface CreateGraphToolsOptions {
    graphStore: GraphStore;
    /** Base fact store — graph_stats reads crawl-queue counts from it. */
    factStore: FactStore;
    /** The session's agent identity, used for role gating. */
    agentIdentity?: string;
    /**
     * Whether this session holds the app-assigned HARVESTER role (gets the
     * crawl-queue + graph write/delete tools). The facts-manager additionally
     * receives these tools (dormant), and agent-tuner never does.
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
 * every session; crawl-queue + write/delete go to the harvester role and the
 * facts-manager (dormant); `graph_stats` (read-only) goes to facts-manager +
 * agent-tuner. agent-tuner never gets a mutating tool.
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
    // Harvester powers: the app-assigned harvester role OR the facts-manager
    // (which holds them dormant). Never the tuner.
    const canHarvest = !isTuner && (isHarvester === true || isFactsManager);

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
                seeds: { type: "array", items: { type: "string" }, description: "Fact scopeKeys OR node keys to anchor from." },
                depth: { type: "number", description: "Hops to expand from seeds (1..5)." },
                limit: { type: "number" },
            },
        },
        handler: async (a: any, ctx: any) => {
            const access = await resolveAccess(ctx?.sessionId);
            const hits = await graphStore.searchGraphNodes(
                { kind: a.kind, nameLike: a.nameLike, seeds: a.seeds, depth: a.depth, limit: a.limit },
                access,
            );
            recordSearch(ctx?.sessionId, "search_nodes", { kind: a.kind, nameLike: a.nameLike, seeds: a.seeds, depth: a.depth }, hits.length);
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
            },
            required: ["nodeKey", "depth"] as const,
        },
        handler: async (a: any, ctx: any) => {
            const access = await resolveAccess(ctx?.sessionId);
            const sub = await graphStore.graphNeighbourhood(a.nodeKey, a.depth, access);
            recordSearch(ctx?.sessionId, "neighbourhood", { nodeKey: a.nodeKey, depth: a.depth }, sub.nodes.length);
            return sub;
        },
    }));

    // ── graph_stats (read-only) — facts-manager + agent-tuner reporting ──────
    if (isFactsManager || isTuner) {
        tools.push(defineTool("graph_stats", {
            description:
                "Read-only graph report: node + edge counts and crawl-queue status (how many facts remain " +
                "uncrawled, reported up to a bounded probe). Use for status/health reporting — it never mutates the graph.",
            parameters: { type: "object" as const, properties: {} },
            handler: async () => {
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
                const uncrawled = await factStore.readUncrawledFacts({ limit: BACKLOG_PROBE });
                const uncrawledFacts = uncrawled.count;
                const uncrawledFactsCapped = uncrawled.count >= BACKLOG_PROBE;
                if (typeof statsFn === "function") {
                    const s = await statsFn.call(graphStore);
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
                const sample = await graphStore.searchGraphNodes({ limit: SAMPLE }, { unrestricted: true });
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

    if (!canHarvest) return tools;

    // ── Crawl-queue tools (HARVESTER / facts-manager — privileged, all scopes) ─

    tools.push(defineTool("facts_read_uncrawled", {
        description:
            "PRIVILEGED harvester work queue: facts not yet incorporated into the graph (new or edited since the " +
            "last crawl), across ALL scopes. Keep each fact's contentHash — it is the receipt facts_mark_crawled needs.",
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
            "Stamp facts as incorporated so they leave the queue. Pass each fact's scopeKey AND the contentHash you " +
            "read. A skipped stamp means the fact changed under you — it stays queued; just move on.",
        parameters: {
            type: "object" as const,
            properties: {
                stamps: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            scopeKey: { type: "string" },
                            contentHash: { type: "string" },
                        },
                        required: ["scopeKey", "contentHash"],
                    },
                },
            },
            required: ["stamps"] as const,
        },
        handler: (a: any) => factStore.markFactsCrawled(a.stamps),
    }));

    // ── Graph write / delete (HARVESTER / facts-manager) ─────────────────────

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
                reason: { type: "string", description: "Why they're the same (audit)." },
            },
            required: ["fromKey", "intoKey", "reason"] as const,
        },
        handler: async (a: any) => { await graphStore.mergeGraphNodes(a.fromKey, a.intoKey, a.reason); return { merged: true }; },
    }));

    tools.push(defineTool("graph_delete_node", {
        description: "Remove a node and all its edges (DETACH DELETE). No cascade to facts.",
        parameters: {
            type: "object" as const,
            properties: { nodeKey: { type: "string" } },
            required: ["nodeKey"] as const,
        },
        handler: async (a: any) => ({ deleted: await graphStore.deleteGraphNode(a.nodeKey) }),
    }));

    tools.push(defineTool("graph_delete_edge", {
        description: "Remove one exact edge triple. Returns whether something matched.",
        parameters: {
            type: "object" as const,
            properties: {
                fromKey: { type: "string" },
                toKey: { type: "string" },
                predicateKey: { type: "string" },
            },
            required: ["fromKey", "toKey", "predicateKey"] as const,
        },
        handler: async (a: any) => ({ deleted: await graphStore.deleteGraphEdge(a.fromKey, a.toKey, a.predicateKey) }),
    }));

    return tools;
}
