import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Knowledge-graph tools (proposal G2b). Registered ONLY when `ctx.graph` is
 * non-null — a separate injection, never derived from the fact store
 * (enhancedfactstore 07 D2). Namespace-registry write tools are [admin].
 *
 * Deliberately absent: mergeGraphNodes and removeGraphEvidence — in-cluster
 * harvester machinery, not a client surface (see WebGraphStore docstring).
 */
export function registerGraphTools(server: McpServer, ctx: ServerContext) {
    const graph = ctx.graph;
    if (!graph) return;

    // ── Read ────────────────────────────────────────────────────────────

    server.registerTool(
        "graph_search_nodes",
        {
            title: "Search Graph Nodes",
            description:
                "Search knowledge-graph nodes. name_like is a lexical match on name/aliases; seeds (fact scope keys "
                + "or node keys) anchor an expansion query. Returns node hits with ACL-filtered evidence.",
            inputSchema: {
                name_like: z.string().optional().describe("Lexical match against node names/aliases (no embeddings)"),
                kind: z.string().optional().describe("Filter by node kind (free text: person, service, file, ...)"),
                seeds: z.array(z.string()).optional().describe("Fact scope keys or node keys anchoring the query"),
                depth: z.number().int().min(1).max(5).optional().describe("Hops to expand from seeds"),
                namespace: z.string().optional().describe("Namespace filter (matches subtree)"),
                min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence"),
                limit: z.number().int().positive().max(200).optional().describe("Max results"),
            },
        },
        withToolErrors(async ({ name_like, kind, seeds, depth, namespace, min_confidence, limit }) => {
            const hits = await graph.searchGraphNodes({
                nameLike: name_like,
                kind,
                seeds,
                depth,
                namespace,
                minConfidence: min_confidence,
                limit,
            });
            return jsonResult({ count: hits.length, nodes: hits });
        }),
    );

    server.registerTool(
        "graph_search_edges",
        {
            title: "Search Graph Edges",
            description:
                "Search knowledge-graph edges (relations). Anchor by endpoint node keys (explore mode) and/or "
                + "predicate — predicate_key is the normalized exact key (preferred), predicate the exact raw text.",
            inputSchema: {
                from_key: z.string().optional().describe("Source node key anchor"),
                to_key: z.string().optional().describe("Target node key anchor"),
                predicate_key: z.string().optional().describe("Exact normalized predicate key (preferred)"),
                predicate: z.string().optional().describe("Exact raw predicate text"),
                namespace: z.string().optional().describe("Namespace filter (edge or either endpoint in subtree)"),
                min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence"),
                limit: z.number().int().positive().max(200).optional().describe("Max results"),
            },
        },
        withToolErrors(async ({ from_key, to_key, predicate_key, predicate, namespace, min_confidence, limit }) => {
            const hits = await graph.searchGraphEdges({
                fromKey: from_key,
                toKey: to_key,
                predicateKey: predicate_key,
                predicate,
                namespace,
                minConfidence: min_confidence,
                limit,
            });
            return jsonResult({ count: hits.length, edges: hits });
        }),
    );

    server.registerTool(
        "graph_neighbourhood",
        {
            title: "Graph Neighbourhood",
            description:
                "Expand the subgraph around a node to a bounded depth — nodes plus connecting edges. "
                + "The go-to tool after graph_search_nodes finds an anchor.",
            inputSchema: {
                node_key: z.string().min(1).describe("Anchor node key"),
                depth: z.number().int().min(1).max(5).optional().describe("Expansion depth (default 1)"),
                namespace: z.string().optional().describe("Graph namespace"),
            },
        },
        withToolErrors(async ({ node_key, depth, namespace }) => {
            const sub = await graph.graphNeighbourhood(node_key, depth ?? 1, undefined, namespace ? { namespace } : undefined);
            return jsonResult(sub);
        }),
    );

    // graph_stats — optional provider method; register iff implemented.
    if (typeof graph.graphStats === "function") {
        server.registerTool(
            "graph_stats",
            {
                title: "Graph Stats",
                description: "Total node/edge counts for a graph namespace (plus uncrawled-facts backlog when reported).",
                inputSchema: {
                    namespace: z.string().optional().describe("Graph namespace (default when omitted)"),
                },
            },
            withToolErrors(async ({ namespace }) => {
                const stats = await graph.graphStats!(namespace ? { namespace } : undefined);
                return jsonResult(stats);
            }),
        );
    }

    // ── Write ───────────────────────────────────────────────────────────

    // Writes carry an agentId (provenance). External MCP writes default to a
    // fixed operator identity so graph provenance distinguishes them from
    // in-loop agent harvesting.
    const DEFAULT_WRITER_ID = "mcp-operator";

    server.registerTool(
        "graph_upsert_node",
        {
            title: "Upsert Graph Node",
            description:
                "Create or update a knowledge-graph node (keyed by kind+name). Aliases and evidence (fact scope keys) "
                + "union in on upsert; re-asserting known evidence is a no-op.",
            inputSchema: {
                kind: z.string().min(1).describe("Node kind (free text: person, service, file, ...)"),
                name: z.string().min(1).describe("Node name"),
                aliases: z.array(z.string()).optional().describe("Alternative names (merged on upsert)"),
                evidence: z.array(z.string()).optional().describe("Fact scope keys supporting this node"),
                namespace: z.string().optional().describe("Graph namespace"),
                agent_id: z.string().optional().describe(`Provenance writer id (default '${DEFAULT_WRITER_ID}')`),
            },
        },
        withToolErrors(async ({ kind, name, aliases, evidence, namespace, agent_id }) => {
            const ref = await graph.upsertGraphNode({
                kind,
                name,
                aliases,
                evidence,
                namespace,
                agentId: agent_id ?? DEFAULT_WRITER_ID,
            });
            return jsonResult({ upserted: true, node: ref });
        }),
    );

    server.registerTool(
        "graph_upsert_edge",
        {
            title: "Upsert Graph Edge",
            description:
                "Create or update a directed edge between two nodes (by node key). Evidence unions in; "
                + "reinforcement counts only novel evidence.",
            inputSchema: {
                from_key: z.string().min(1).describe("Source node key"),
                to_key: z.string().min(1).describe("Target node key"),
                predicate: z.string().min(1).describe("Relation predicate (free text, e.g. 'depends on')"),
                confidence: z.number().min(0).max(1).optional().describe("Assertion confidence (default 1.0)"),
                evidence: z.array(z.string()).optional().describe("Fact scope keys supporting this edge"),
                namespace: z.string().optional().describe("Graph namespace"),
                agent_id: z.string().optional().describe(`Provenance writer id (default '${DEFAULT_WRITER_ID}')`),
            },
        },
        withToolErrors(async ({ from_key, to_key, predicate, confidence, evidence, namespace, agent_id }) => {
            const ref = await graph.upsertGraphEdge({
                fromKey: from_key,
                toKey: to_key,
                predicate,
                confidence,
                evidence,
                namespace,
                agentId: agent_id ?? DEFAULT_WRITER_ID,
            });
            return jsonResult({ upserted: true, edge: ref });
        }),
    );

    server.registerTool(
        "graph_delete_node",
        {
            title: "Delete Graph Node",
            description: "Delete a knowledge-graph node by key. No cross-store cascade (source facts untouched).",
            inputSchema: {
                node_key: z.string().min(1).describe("Node key to delete"),
                namespace: z.string().optional().describe("Graph namespace"),
            },
        },
        withToolErrors(async ({ node_key, namespace }) => {
            const deleted = await graph.deleteGraphNode(node_key, namespace ? { namespace } : undefined);
            return jsonResult({ deleted });
        }),
    );

    server.registerTool(
        "graph_delete_edge",
        {
            title: "Delete Graph Edge",
            description: "Delete a knowledge-graph edge identified by (from, to, predicate).",
            inputSchema: {
                from_key: z.string().min(1).describe("Source node key"),
                to_key: z.string().min(1).describe("Target node key"),
                predicate: z.string().min(1).describe("Relation predicate key"),
                namespace: z.string().optional().describe("Graph namespace"),
            },
        },
        withToolErrors(async ({ from_key, to_key, predicate, namespace }) => {
            const deleted = await graph.deleteGraphEdge(from_key, to_key, predicate, namespace ? { namespace } : undefined);
            return jsonResult({ deleted });
        }),
    );

    // ── Namespace registry (optional provider surface) ──────────────────

    if (typeof graph.listGraphNamespaces === "function") {
        server.registerTool(
            "list_graph_namespaces",
            {
                title: "List Graph Namespaces",
                description: "List registered graph namespaces (corpora). Compact by default.",
                inputSchema: {
                    prefix: z.string().optional().describe("Namespace prefix filter"),
                    include_archived: z.boolean().optional().describe("Include archived namespaces (default false)"),
                    include_details: z.boolean().optional().describe("Include detail fields (default false)"),
                },
            },
            withToolErrors(async ({ prefix, include_archived, include_details }) => {
                const namespaces = await graph.listGraphNamespaces!({
                    prefix,
                    includeArchived: include_archived,
                    includeDetails: include_details,
                });
                return jsonResult({ count: namespaces.length, namespaces });
            }),
        );
    }

    if (typeof graph.getGraphNamespace === "function") {
        server.registerTool(
            "get_graph_namespace",
            {
                title: "Get Graph Namespace",
                description: "Full descriptor for one graph namespace (returned regardless of archived state).",
                inputSchema: {
                    namespace: z.string().min(1).describe("Namespace name"),
                },
            },
            withToolErrors(async ({ namespace }) => {
                const info = await graph.getGraphNamespace!(namespace);
                if (!info) return errorResult("namespace not found", { namespace });
                return jsonResult(info);
            }),
        );
    }

    if (ctx.admin && typeof graph.upsertGraphNamespace === "function") {
        server.registerTool(
            "upsert_graph_namespace",
            {
                title: "Upsert Graph Namespace",
                description: "Register or update a graph namespace (corpus). [admin]",
                inputSchema: {
                    namespace: z.string().min(1).describe("Namespace name"),
                    description: z.string().min(1).describe("When to use this corpus — the discovery hint reader agents see"),
                    name: z.string().optional().describe("Short label (defaults to the namespace)"),
                    source: z.string().optional().describe("Detail: where this corpus comes from"),
                    archived: z.boolean().optional().describe("Set false to un-archive on upsert"),
                },
            },
            withToolErrors(async ({ namespace, description, name, source, archived }) => {
                const info = await graph.upsertGraphNamespace!({
                    namespace,
                    frontmatter: { description, ...(name ? { name } : {}) },
                    source,
                    archived,
                });
                return jsonResult({ upserted: true, namespace: info });
            }),
        );
    }

    if (ctx.admin && typeof graph.deleteGraphNamespace === "function") {
        server.registerTool(
            "delete_graph_namespace",
            {
                title: "Delete Graph Namespace",
                description:
                    "DESTRUCTIVE: drop all graph data for a namespace, then its registry row. Never deletes source "
                    + "facts. The 'default' namespace cannot be deleted. [admin]",
                inputSchema: {
                    namespace: z.string().min(1).describe("Namespace to delete"),
                },
            },
            withToolErrors(async ({ namespace }) => {
                const result = await graph.deleteGraphNamespace!(namespace);
                return jsonResult(result);
            }),
        );
    }
}
