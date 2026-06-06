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

/**
 * Describes an OpenAI/Azure-OpenAI-compatible embeddings endpoint. This is a
 * provider-neutral contract: it is the only embedding-related thing PilotSwarm
 * hands to a fact-store provider, and any provider (HorizonDB, AlloyDB, plain
 * Postgres, …) can consume it.
 *
 * Request  (POST url): { "<inputField>": "text", "model": "<model>" }
 * Response (200):      { "data": [ { "embedding": [..<dim> floats..] } ] }
 *
 * This is the shape used by both Azure OpenAI (`/embeddings?api-version=...`)
 * and OpenAI (`/v1/embeddings`). Override the field/response path if your
 * gateway differs.
 */
export interface EmbeddingEndpointConfig {
    /** Full POST URL of the embeddings endpoint (including any api-version query). */
    url: string;
    /** Model/deployment name sent in the request body. */
    model: string;
    /** Vector dimension; MUST equal the `vector(N)` column dimension. */
    dim: number;
    /** Optional API key. For Azure OpenAI use header "api-key"; for OpenAI use Authorization. */
    apiKey?: string;
    /** Header to carry the key. Default "api-key". Use "Authorization" (with "Bearer ") for OpenAI. */
    apiKeyHeader?: string;
    /** If true, the key value is prefixed with "Bearer " (OpenAI style). Default false. */
    bearer?: boolean;
    /** Request body field carrying the text. Default "input". */
    inputField?: string;
    /** Extra static headers. */
    headers?: Record<string, string>;
    /** Per-request timeout (ms). Default 30_000. */
    timeoutMs?: number;
}

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
     * pipeline. Lexical + graph work without it.
     */
    embedding?: EmbeddingEndpointConfig;
    /**
     * Vector ANN index method. "diskann" uses Azure's pg_diskann (must be
     * allow-listed in the cluster's azure.extensions parameter group); "hnsw"
     * uses pgvector's built-in HNSW; "auto" (default) prefers diskann and falls
     * back to hnsw when pg_diskann is unavailable.
     */
    annIndex?: "diskann" | "hnsw" | "auto";
    /** Max pool connections. Default 3. */
    poolMax?: number;
    /** AAD / managed-identity auth (mirrors PilotSwarm's PgFactStore). */
    useManagedIdentity?: boolean;
    aadUser?: string;
}

export const DEFAULT_SCHEMA = "horizon_facts";
export const DEFAULT_GRAPH = "horizon_facts";
export const DEFAULT_POOL_MAX = 3;

/** Resolve config from explicit values, falling back to HORIZON_* env vars. */
export function resolveConfig(partial: Partial<HorizonFactsConfig> = {}): HorizonFactsConfig {
    const connectionString = partial.connectionString ?? process.env.HORIZON_DATABASE_URL ?? "";
    if (!connectionString) {
        throw new Error(
            "HorizonFactStore requires a connectionString (or HORIZON_DATABASE_URL env var).",
        );
    }

    let embedding = partial.embedding;
    if (!embedding && process.env.HORIZON_EMBED_URL) {
        embedding = {
            url: process.env.HORIZON_EMBED_URL,
            model: process.env.HORIZON_EMBED_MODEL ?? "text-embedding-3-small",
            dim: Number.parseInt(process.env.HORIZON_EMBED_DIM ?? "1536", 10),
            apiKey: process.env.HORIZON_EMBED_API_KEY,
            apiKeyHeader: process.env.HORIZON_EMBED_API_KEY_HEADER ?? "api-key",
        };
    }

    return {
        connectionString,
        schema: partial.schema ?? DEFAULT_SCHEMA,
        graphName: partial.graphName ?? DEFAULT_GRAPH,
        embedding,
        annIndex: partial.annIndex
            ?? (process.env.HORIZON_ANN_INDEX as HorizonFactsConfig["annIndex"])
            ?? "auto",
        poolMax: partial.poolMax ?? DEFAULT_POOL_MAX,
        useManagedIdentity: partial.useManagedIdentity,
        aadUser: partial.aadUser,
    };
}
