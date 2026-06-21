// @pilotswarm/horizon-store — provider configuration.
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
import type { PoolConfig } from "pg";

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
    /**
     * Relational schema OWNED BY THE GRAPH PROVIDER for the namespace registry
     * sidecar (graph-fact-search enhancements). MUST differ from the AGE graph
     * name (`graphName`) — `create_graph()` creates a Postgres schema named after
     * the graph, so reusing it would put the sidecar INSIDE the AGE-managed
     * schema (droppable by drop_graph). Also distinct from the facts `schema`,
     * since the graph store may run against a database with no facts schema at
     * all. Defaults to `${graphName}_registry`. Override with
     * HORIZON_GRAPH_REGISTRY_SCHEMA.
     */
    registrySchema?: string;
    /**
     * TTL (ms) for the in-provider namespace-list cache. The namespace set is
     * small and changes rarely; the provider caches a single full snapshot and
     * filters in memory. Writes invalidate the snapshot in-process; other
     * workers converge within the TTL. Default 60000 (one minute). Set 0 to
     * disable caching (always reload) — useful in tests.
     */
    namespaceCacheTtlMs?: number;
}

export const DEFAULT_SCHEMA = "horizon_facts";
export const DEFAULT_GRAPH = "horizon_facts";
export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_NAMESPACE_CACHE_TTL_MS = 60_000;

/** Resolve + validate the namespace cache TTL (ms). Rejects NaN / negative. */
function resolveNamespaceCacheTtl(explicit?: number): number {
    const envRaw = process.env.HORIZON_NAMESPACE_CACHE_TTL_MS;
    const raw = explicit ?? (envRaw != null && envRaw !== "" ? Number(envRaw) : undefined);
    if (raw == null) return DEFAULT_NAMESPACE_CACHE_TTL_MS;
    if (!Number.isFinite(raw) || raw < 0) {
        throw new Error(
            `namespaceCacheTtlMs / HORIZON_NAMESPACE_CACHE_TTL_MS must be a non-negative number, got ${JSON.stringify(envRaw ?? explicit)}`,
        );
    }
    return raw;
}

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

    const graphName = partial.graphName ?? DEFAULT_GRAPH;

    return {
        connectionString,
        schema: partial.schema ?? DEFAULT_SCHEMA,
        graphName,
        registrySchema: partial.registrySchema ?? process.env.HORIZON_GRAPH_REGISTRY_SCHEMA ?? `${graphName}_registry`,
        embedding,
        embeddingDim: partial.embeddingDim ?? embedding?.dim ?? 1536,
        annIndex: partial.annIndex
            ?? (process.env.HORIZON_ANN_INDEX as HorizonFactsConfig["annIndex"])
            ?? "auto",
        poolMax: partial.poolMax
            ?? (process.env.HORIZON_POOL_MAX ? Number(process.env.HORIZON_POOL_MAX) : undefined)
            ?? DEFAULT_POOL_MAX,
        namespaceCacheTtlMs: resolveNamespaceCacheTtl(partial.namespaceCacheTtlMs),
        useManagedIdentity: partial.useManagedIdentity,
        aadUser: partial.aadUser,
    };
}

/** sslmode values that mean "use TLS" (mirrors the PilotSwarm SDK pg-pool-factory). */
const SSL_REQUIRING_MODES = ["require", "prefer", "verify-ca", "verify-full"];

/**
 * Build a `pg.PoolConfig` from a HorizonDB connection string, normalizing TLS
 * the same way the PilotSwarm SDK's `pg-pool-factory` does for the CMS / facts
 * pools, so a HorizonDB URL behaves here exactly like `DATABASE_URL` does there.
 *
 * Why this is needed: HorizonDB requires SSL, but its certificate chain is not in
 * Node's default trust store, and `pg` v8 treats `sslmode=require` (and
 * `prefer` / `verify-ca` / `verify-full`) as `verify-full` — which rejects the
 * chain with `self-signed certificate in certificate chain`. The SDK factory
 * handles this for `DATABASE_URL` by stripping `sslmode` from the URL and setting
 * `ssl: { rejectUnauthorized: false }` on the pool config. This provider builds
 * its OWN raw pools (it keeps its runtime dep surface to `pg` only and does not
 * import the SDK), so without this helper a natural `?sslmode=require` URL fails
 * here while the identical URL works for `DATABASE_URL` — the asymmetry that
 * previously forced callers to hand-append `uselibpqcompat=true`.
 *
 * Encrypt-but-don't-verify matches libpq's `sslmode=require` semantics and the
 * SDK's existing posture (this is not a new weakening — it is the same choice the
 * CMS/facts pools already make). For full CA verification against a non-preview
 * cluster, present a trusted chain and pass a URL without an `sslmode` param.
 */
export function buildPoolConfig(connectionString: string, max: number): PoolConfig {
    let needsSsl = false;
    let sanitized = connectionString;
    try {
        const url = new URL(connectionString);
        needsSsl = SSL_REQUIRING_MODES.includes(url.searchParams.get("sslmode") ?? "");
        if (needsSsl) {
            // Control SSL via the config object, not the URL. Drop sslmode so pg
            // does not re-apply verify-full, and drop the now-redundant
            // uselibpqcompat hint so the effective URL is clean either way.
            url.searchParams.delete("sslmode");
            url.searchParams.delete("uselibpqcompat");
            sanitized = url.toString();
        }
    } catch {
        // Not a parseable URL (unexpected for a real DSN). Leave it untouched and
        // let pg surface a clear connection error rather than masking it here.
    }
    return {
        connectionString: sanitized,
        max,
        ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    };
}
