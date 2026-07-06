import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

/**
 * Enhanced-facts tools (proposal G2a). Registered ONLY when
 * `ctx.enhancedFacts` is non-null (narrowed once at boot via
 * isEnhancedFactStore). Embedder start/stop are [admin] — additionally gated
 * on ctx.admin.
 *
 * Deliberately absent: configureEmbedder — it carries the embedding endpoint
 * and its secrets; a worker-side concern, never a client surface.
 */
export function registerEnhancedFactTools(server: McpServer, ctx: ServerContext) {
    const store = ctx.enhancedFacts;
    if (!store) return;

    // 1. search_facts — lexical | semantic | hybrid retrieval
    server.registerTool(
        "search_facts",
        {
            title: "Search Facts",
            description:
                "Multi-signal retrieval over the PilotSwarm knowledge store: lexical (BM25), semantic (embeddings), "
                + "or hybrid fusion (default). Returns scored facts with per-signal contributions. "
                + "TRUST NOTE: like read_facts, scope parameters are caller-supplied and not authenticated against client identity.",
            inputSchema: {
                query: z.string().min(1).describe("The search query"),
                mode: z.enum(["lexical", "semantic", "hybrid"]).optional().describe("Retrieval mode (default hybrid)"),
                namespace: z.string().optional().describe("Key-prefix filter, matched as '<prefix>/%' at any depth (e.g. 'skills' or 'acme/services')"),
                tags: z.array(z.string()).optional().describe("Filter by tags"),
                limit: z.number().int().positive().max(200).optional().describe("Max results (default 20)"),
                min_semantic_score: z.number().min(0).max(1).optional().describe("Minimum cosine similarity for semantic candidates"),
            },
        },
        withToolErrors(async ({ query, mode, namespace, tags, limit, min_semantic_score }) => {
            const result = await store.searchFacts(query, {
                mode,
                namespace,
                tags,
                limit,
                minSemanticScore: min_semantic_score,
            });
            return jsonResult(result);
        }),
    );

    // 2. similar_facts — semantic kNN of a known fact
    server.registerTool(
        "similar_facts",
        {
            title: "Similar Facts",
            description:
                "Semantic nearest-neighbours of a known fact (no re-embedding). Anchor is identified by its scope key "
                + "(e.g. 'shared:skills/foo' or 'session:<id>:notes/bar'). An unknown or inaccessible anchor returns empty.",
            inputSchema: {
                scope_key: z.string().min(1).describe("Scope key of the anchor fact"),
                k: z.number().int().positive().max(100).optional().describe("Top-k neighbours (default 8)"),
                min_score: z.number().min(0).max(1).optional().describe("Cosine similarity floor"),
                namespace: z.string().optional().describe("Candidate key-prefix filter"),
            },
        },
        withToolErrors(async ({ scope_key, k, min_score, namespace }) => {
            const result = await store.similarFacts(scope_key, { k, minScore: min_score, namespace });
            return jsonResult(result);
        }),
    );

    // 3. embedder_status — durable embedder lifecycle state (read)
    server.registerTool(
        "embedder_status",
        {
            title: "Embedder Status",
            description: "Current lifecycle state of the durable facts embedder (batch + retry loops).",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await store.embedderStatus())),
    );

    // [admin] start/stop — mutate a shared background loop.
    if (ctx.admin) {
        server.registerTool(
            "start_embedder",
            {
                title: "Start Embedder",
                description: "Start the durable facts-embedder loops (batch + retry). Idempotent. [admin]",
                inputSchema: {
                    interval_seconds: z.number().int().positive().optional().describe("Loop interval"),
                    batch: z.number().int().positive().optional().describe("Batch size"),
                },
            },
            withToolErrors(async ({ interval_seconds, batch }) =>
                jsonResult(await store.startEmbedder({ intervalSeconds: interval_seconds, batch }))),
        );

        server.registerTool(
            "stop_embedder",
            {
                title: "Stop Embedder",
                description: "Stop the durable facts-embedder loops. No-op if already stopped. [admin]",
                inputSchema: {
                    reason: z.string().optional().describe("Reason for stopping"),
                },
            },
            withToolErrors(async ({ reason }) => jsonResult(await store.stopEmbedder(reason))),
        );
    }
}
