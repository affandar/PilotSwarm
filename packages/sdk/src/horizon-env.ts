/**
 * Convenience: build the optional EnhancedFactStore + knowledge-graph worker
 * config from the canonical `HORIZON_*` environment variables.
 *
 * The `PilotSwarmWorker` intentionally does NOT read `process.env` itself — app
 * entrypoints own env parsing and pass explicit config. This helper exists so the
 * shipped CLI/portal embedded worker, the standalone K8s worker, and the examples
 * all map the same env vars to the same worker fields, with no drift.
 *
 * Returns an EMPTY object when none of the `HORIZON_*` vars are set (the default —
 * plain `PgFactStore`, no enhanced provider, no graph). The enhanced facts store and
 * the knowledge graph are INDEPENDENT axes: setting only `HORIZON_GRAPH_DATABASE_URL`
 * yields a graph over the base fact store (graph tools, no search). Spread the result
 * into the worker options:
 *
 * ```ts
 * const worker = new PilotSwarmWorker({
 *     store: process.env.DATABASE_URL,
 *     githubToken: process.env.GITHUB_TOKEN,
 *     ...horizonConfigFromEnv(),
 * });
 * ```
 *
 * Env vars (all optional except the database URL):
 *   HORIZON_DATABASE_URL        → enhancedFactsDatabaseUrl (enables the enhanced
 *                                 provider; worker infers factsProvider="horizon")
 *   HORIZON_FACTS_SCHEMA        → enhancedFactsSchema (default "horizon_facts")
 *   HORIZON_GRAPH_DATABASE_URL  → graphDatabaseUrl (opt-in graph; unset ⇒ no graph)
 *   HORIZON_GRAPH_SCHEMA        → graphSchema (default "horizon_graph")
 *   HORIZON_GRAPH_REGISTRY_SCHEMA → graphRegistrySchema (default
 *                                 `${graphSchema}_registry`; MUST differ from graphSchema)
 *   HORIZON_NAMESPACE_CACHE_TTL_MS → graphNamespaceCacheTtlMs (default 60000; 0 disables cache)
 *   HORIZON_EMBED_URL/MODEL/DIM → horizonEmbed (durable embedder; all three
 *                                 required, else the embedder is omitted and
 *                                 search runs lexical-only)
 *   HORIZON_EMBED_API_KEY       → horizonEmbed.apiKey
 *   HORIZON_EMBED_API_KEY_HEADER→ horizonEmbed.apiKeyHeader (default "api-key")
 *   HORIZON_EMBED_BEARER        → horizonEmbed.bearer (sends "Bearer <key>");
 *                                 inferred true when the header is "Authorization"
 *
 * @module
 */

import type { EmbeddingEndpointConfig } from "./facts-store.js";

/** The subset of `PilotSwarmWorkerOptions` that the `HORIZON_*` env vars map to. */
export interface HorizonEnvConfig {
    enhancedFactsDatabaseUrl?: string;
    enhancedFactsSchema?: string;
    horizonEmbed?: EmbeddingEndpointConfig;
    graphDatabaseUrl?: string;
    graphSchema?: string;
    graphRegistrySchema?: string;
    graphNamespaceCacheTtlMs?: number;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function trimmed(value: string | undefined): string | undefined {
    const t = value?.trim();
    return t ? t : undefined;
}

/** Assemble the durable embedder endpoint from `HORIZON_EMBED_*`, or `undefined`. */
function embedFromEnv(env: Record<string, string | undefined>): EmbeddingEndpointConfig | undefined {
    const url = trimmed(env.HORIZON_EMBED_URL);
    const model = trimmed(env.HORIZON_EMBED_MODEL);
    const dim = Number.parseInt(env.HORIZON_EMBED_DIM ?? "", 10);
    // The embedder needs all three of url/model/dim. Anything missing ⇒ omit it
    // (search degrades to lexical-only) rather than crashing the worker.
    if (!url || !model || !Number.isFinite(dim) || dim <= 0) return undefined;

    const embed: EmbeddingEndpointConfig = { url, model, dim };

    const apiKey = trimmed(env.HORIZON_EMBED_API_KEY);
    if (apiKey) embed.apiKey = apiKey;

    const apiKeyHeader = trimmed(env.HORIZON_EMBED_API_KEY_HEADER);
    if (apiKeyHeader) embed.apiKeyHeader = apiKeyHeader;

    // `bearer` controls whether the key is sent as "Bearer <key>". Explicit env
    // wins; otherwise infer it for an Authorization header (OpenAI-style), where
    // the bearer prefix is required, but not for the Azure "api-key" default.
    const bearerRaw = trimmed(env.HORIZON_EMBED_BEARER)?.toLowerCase();
    if (bearerRaw !== undefined) {
        embed.bearer = TRUE_VALUES.has(bearerRaw);
    } else if (apiKeyHeader && apiKeyHeader.toLowerCase() === "authorization") {
        embed.bearer = true;
    }

    return embed;
}

/**
 * Map the `HORIZON_*` environment variables to the worker's enhanced-facts /
 * knowledge-graph config. Pure and side-effect-free; safe to call at startup.
 *
 * @param env - Environment source (defaults to `process.env`).
 */
export function horizonConfigFromEnv(
    env: Record<string, string | undefined> = process.env,
): HorizonEnvConfig {
    const config: HorizonEnvConfig = {};

    // Enhanced facts store (+ schema + embedder). The embedder belongs to the
    // enhanced store, so it is only meaningful when the facts URL is present.
    const url = trimmed(env.HORIZON_DATABASE_URL);
    if (url) {
        config.enhancedFactsDatabaseUrl = url;

        const factsSchema = trimmed(env.HORIZON_FACTS_SCHEMA);
        if (factsSchema) config.enhancedFactsSchema = factsSchema;

        const embed = embedFromEnv(env);
        if (embed) config.horizonEmbed = embed;
    }

    // The knowledge graph is a SEPARATE, opt-in provider on its OWN axis — never
    // selected implicitly, and INDEPENDENT of the enhanced facts store (07
    // resolution order: a graph can run over a base fact store, yielding graph
    // tools but no search tools). Wired purely from its own URL.
    const graphUrl = trimmed(env.HORIZON_GRAPH_DATABASE_URL);
    if (graphUrl) {
        config.graphDatabaseUrl = graphUrl;
        const graphSchema = trimmed(env.HORIZON_GRAPH_SCHEMA);
        if (graphSchema) config.graphSchema = graphSchema;
        const registrySchema = trimmed(env.HORIZON_GRAPH_REGISTRY_SCHEMA);
        if (registrySchema) config.graphRegistrySchema = registrySchema;
        const namespaceCacheTtl = trimmed(env.HORIZON_NAMESPACE_CACHE_TTL_MS);
        if (namespaceCacheTtl !== undefined) {
            const parsed = Number(namespaceCacheTtl);
            if (!Number.isFinite(parsed) || parsed < 0) {
                throw new Error(`HORIZON_NAMESPACE_CACHE_TTL_MS must be a non-negative number, got ${JSON.stringify(namespaceCacheTtl)}`);
            }
            config.graphNamespaceCacheTtlMs = parsed;
        }
    }

    return config;
}
