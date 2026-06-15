// @incubator/horizon-facts — provider configuration.
//
// The EnhancedFactStore is configured with a connection string and, optionally,
// an EMBEDDING ENDPOINT. The embedding endpoint is a DATABASE-AGNOSTIC contract:
// it describes an OpenAI/Azure-OpenAI-compatible HTTP embeddings API and says
// nothing about how any particular provider invokes it. A provider records this
// endpoint and embeds facts however it likes — the HorizonDB provider calls it
// in-database via pg_durable's df.http() background loop, but an AlloyDB- or
// any-Postgres-based provider could consume the exact same config and call it
// from a trigger, a sidecar, or host-side code. PilotSwarm only passes the
// endpoint; the mechanism is the provider's concern.
//
// The SAME endpoint config is also usable Node-side (see embedding-client.ts)
// for query-time embedding and for tests that don't depend on any in-database
// HTTP path.

// The endpoint contract type lives in types.ts (02-api-reference §1);
// re-exported here for back-compat with existing imports.
import type { EmbeddingEndpointConfig } from "./types.js";
export type { EmbeddingEndpointConfig } from "./types.js";

export interface HorizonFactsConfig {
    /** PostgreSQL/HorizonDB connection string. */
    connectionString: string;
    /** Relational schema for the facts table + procs. Default "horizon_facts". */
    schema?: string;
    /** AGE graph name. Default "horizon_facts". */
    graphName?: string;
    /**
     * Embedding endpoint (provider-neutral, see EmbeddingEndpointConfig).
     * Required for semantic/hybrid search and for this provider's in-DB embedding
     * pipeline. Lexical + graph work without it. When provided, initialize()
     * configures AND auto-starts the eternal in-DB embed loop (idempotent +
     * advisory-locked, so repeated/concurrent instantiations never duplicate it).
     */
    embedding?: EmbeddingEndpointConfig;
    /**
     * Dimension of the vector(N) column, fixed at migration time. Defaults to
     * embedding?.dim ?? 1536. configureEmbedder() rejects endpoints whose dim
     * differs (a dim change requires a column migration + full re-embed).
     */
    embeddingDim?: number;
    /**
     * Vector ANN index method. "diskann" uses Azure's pg_diskann (must be
     * allow-listed in the cluster's azure.extensions parameter group); "hnsw"
     * uses pgvector's built-in HNSW; "auto" (default) prefers diskann and falls
     * back to hnsw when pg_diskann is unavailable.
     */
    annIndex?: "diskann" | "hnsw" | "auto";
    /**
     * Max pool connections. Default 10. The graph layer issues several
     * sequential Cypher statements per upsert, and the harvester fires graph
     * tool calls in parallel; a small pool serializes those behind a few
     * connections and connection-queue wait dominates latency (a pool of 3 was
     * measured ~2-4x slower than 10 under concurrency=8). Override per-cluster
     * with HORIZON_POOL_MAX, bearing in mind the cluster's max_connections.
     */
    poolMax?: number;
    /** AAD / managed-identity auth (mirrors PilotSwarm's PgFactStore). */
    useManagedIdentity?: boolean;
    aadUser?: string;
}

export const DEFAULT_SCHEMA = "horizon_facts";
export const DEFAULT_GRAPH = "horizon_facts";
export const DEFAULT_POOL_MAX = 10;

/** Resolve config from explicit values, falling back to HORIZON_* env vars. */
export function resolveConfig(partial: Partial<HorizonFactsConfig> = {}): HorizonFactsConfig {
    const connectionString = partial.connectionString ?? process.env.HORIZON_DATABASE_URL ?? "";
    if (!connectionString) {
        throw new Error(
            "HorizonDBFactStore requires a connectionString (or HORIZON_DATABASE_URL env var).",
        );
    }

    // The embedding endpoint must be passed EXPLICITLY (no env-var fallback):
    // an implicit endpoint can silently conflict with the store's vector(N)
    // dimension, and config provenance should be the host's choice (02 §1b).
    const embedding = partial.embedding;

    return {
        connectionString,
        schema: partial.schema ?? DEFAULT_SCHEMA,
        graphName: partial.graphName ?? DEFAULT_GRAPH,
        embedding,
        embeddingDim: partial.embeddingDim ?? embedding?.dim ?? 1536,
        annIndex: partial.annIndex
            ?? (process.env.HORIZON_ANN_INDEX as HorizonFactsConfig["annIndex"])
            ?? "auto",
        poolMax: partial.poolMax
            ?? (process.env.HORIZON_POOL_MAX ? Number(process.env.HORIZON_POOL_MAX) : undefined)
            ?? DEFAULT_POOL_MAX,
        useManagedIdentity: partial.useManagedIdentity,
        aadUser: partial.aadUser,
    };
}
