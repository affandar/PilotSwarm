import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

/** Graph read resources — registered only when ctx.graph is present. */
export function registerGraphResources(server: McpServer, ctx: ServerContext) {
    const graph = ctx.graph;
    if (!graph) return;

    if (typeof graph.graphStats === "function") {
        server.registerResource(
            "graph-stats",
            "pilotswarm://graph/stats",
            {
                description: "Knowledge-graph node/edge counts (default namespace)",
                mimeType: "application/json",
            },
            async (uri) => {
                try {
                    const stats = await graph.graphStats!();
                    return {
                        contents: [{ uri: uri.href, text: JSON.stringify(stats, null, 2), mimeType: "application/json" }],
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        contents: [{ uri: uri.href, text: JSON.stringify({ error: message }), mimeType: "application/json" }],
                    };
                }
            },
        );
    }

    if (typeof graph.listGraphNamespaces === "function") {
        server.registerResource(
            "graph-namespaces",
            "pilotswarm://graph/namespaces",
            {
                description: "Registered knowledge-graph namespaces (corpora)",
                mimeType: "application/json",
            },
            async (uri) => {
                try {
                    const namespaces = await graph.listGraphNamespaces!();
                    return {
                        contents: [{ uri: uri.href, text: JSON.stringify(namespaces, null, 2), mimeType: "application/json" }],
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        contents: [{ uri: uri.href, text: JSON.stringify({ error: message }), mimeType: "application/json" }],
                    };
                }
            },
        );
    }
}
