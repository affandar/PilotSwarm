import type { EmbeddingEndpointConfig } from "./facts-store.js";

export const DEFAULT_RUNTIME_STORAGE_PROVIDER = "postgres";
export const DEFAULT_DUROXIDE_STORAGE_PROVIDER = "postgres";
export const DEFAULT_DUROXIDE_SCHEMA = "ps_duroxide";
export const DEFAULT_CMS_SCHEMA = "copilot_sessions";
export const DEFAULT_FACTS_SCHEMA = "pilotswarm_facts";
export const DEFAULT_HORIZON_FACTS_SCHEMA = "horizon_facts";

export interface StorageConfig {
    runtime: RuntimeStorageConfig;
    duroxide: DuroxideStorageConfig;
}

export interface RuntimeStorageConfig {
    provider: string;
    url: string;
    sessionCatalogUrl?: string;
    factStoreUrl?: string;
    cmsSchema?: string;
    factsSchema?: string;
    embedding?: EmbeddingEndpointConfig;
    graph?: {
        enabled: boolean;
        url?: string;
        schema?: string;
        registrySchema?: string;
        namespaceCacheTtlMs?: number;
    };
    providerOptions?: Record<string, unknown>;
    useManagedIdentity?: boolean;
    aadDbUser?: string;
}

export interface DuroxideStorageConfig {
    provider: string;
    url: string;
    schema?: string;
    useManagedIdentity?: boolean;
    aadDbUser?: string;
    providerOptions?: Record<string, unknown>;
}

export interface StorageConfigLegacyOptions {
    store?: string;
    storageConfig?: StorageConfig;
    useManagedIdentity?: boolean;
    aadDbUser?: string;
    cmsFactsDatabaseUrl?: string;
    duroxideSchema?: string;
    cmsSchema?: string;
    factsSchema?: string;
    enhancedFactsDatabaseUrl?: string;
    factsProvider?: "pg" | "horizon" | "postgres" | "horizondb";
    enhancedFactsSchema?: string;
    horizonEmbed?: EmbeddingEndpointConfig;
    graphDatabaseUrl?: string;
    graphSchema?: string;
    graphRegistrySchema?: string;
    graphNamespaceCacheTtlMs?: number;
}

export interface ResolveStorageConfigInput {
    env?: Record<string, string | undefined>;
    options?: StorageConfigLegacyOptions;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function trimmed(value: string | undefined): string | undefined {
    const t = value?.trim();
    return t ? t : undefined;
}

function first(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
        const t = trimmed(value);
        if (t) return t;
    }
    return undefined;
}

function boolFromEnv(value: string | undefined): boolean | undefined {
    const t = trimmed(value)?.toLowerCase();
    if (t === undefined) return undefined;
    return TRUE_VALUES.has(t);
}

function parseNonNegativeNumber(value: string | undefined, name: string): number | undefined {
    const t = trimmed(value);
    if (t === undefined) return undefined;
    const parsed = Number(t);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(t)}`);
    }
    return parsed;
}

function embeddingFromEnv(env: Record<string, string | undefined>, prefix: "PILOTSWARM" | "HORIZON"): EmbeddingEndpointConfig | undefined {
    const stem = prefix === "PILOTSWARM" ? "PILOTSWARM_EMBED" : "HORIZON_EMBED";
    const url = trimmed(env[`${stem}_URL`]);
    const model = trimmed(env[`${stem}_MODEL`]);
    const dimRaw = trimmed(env[`${stem}_DIM`]);
    const dim = Number.parseInt(dimRaw ?? "", 10);
    if (!url || !model || !Number.isFinite(dim) || dim <= 0) return undefined;

    const embedding: EmbeddingEndpointConfig = { url, model, dim };
    const apiKey = trimmed(env[`${stem}_API_KEY`]);
    if (apiKey) embedding.apiKey = apiKey;
    const apiKeyHeader = trimmed(env[`${stem}_API_KEY_HEADER`]);
    if (apiKeyHeader) embedding.apiKeyHeader = apiKeyHeader;
    const bearerRaw = trimmed(env[`${stem}_BEARER`])?.toLowerCase();
    if (bearerRaw !== undefined) {
        embedding.bearer = TRUE_VALUES.has(bearerRaw);
    } else if (apiKeyHeader?.toLowerCase() === "authorization") {
        embedding.bearer = true;
    }
    return embedding;
}

function normalizeRuntimeProvider(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    if (raw === "pg") return "postgres";
    if (raw === "horizon") return "horizondb";
    return raw;
}

export function resolveStorageConfig(input: ResolveStorageConfigInput = {}): StorageConfig {
    const env = input.env ?? process.env;
    const options = input.options ?? {};
    if (options.storageConfig) return options.storageConfig;

    const databaseUrl = first(options.store, env.DATABASE_URL);
    if (!databaseUrl) {
        throw new Error("Storage config requires a store URL via options.store or DATABASE_URL.");
    }

    const explicitRuntimeProvider = normalizeRuntimeProvider(first(env.PILOTSWARM_RUNTIME_PROVIDER));
    const legacySelectsHorizon = !explicitRuntimeProvider && (options.factsProvider === "horizon"
        || options.factsProvider === "horizondb"
        || !!trimmed(options.enhancedFactsDatabaseUrl)
        || !!trimmed(env.HORIZON_DATABASE_URL));

    const runtimeProvider = normalizeRuntimeProvider(first(
        explicitRuntimeProvider,
        legacySelectsHorizon ? "horizondb" : undefined,
        DEFAULT_RUNTIME_STORAGE_PROVIDER,
    )) ?? DEFAULT_RUNTIME_STORAGE_PROVIDER;

    const useManagedIdentity = options.useManagedIdentity
        ?? boolFromEnv(env.PILOTSWARM_USE_MANAGED_IDENTITY)
        ?? false;
    const aadDbUser = first(options.aadDbUser, env.PILOTSWARM_AAD_DB_USER, env.AAD_DB_USER);

    const runtimeUrl = first(
        env.PILOTSWARM_RUNTIME_URL,
        databaseUrl,
    )!;

    const sessionCatalogUrl = first(
        options.cmsFactsDatabaseUrl,
        env.PILOTSWARM_SESSION_CATALOG_URL,
        env.PILOTSWARM_RUNTIME_SESSION_CATALOG_URL,
    );

    const explicitFactStoreUrl = first(
        options.enhancedFactsDatabaseUrl,
        env.PILOTSWARM_FACTSTORE_URL,
        env.PILOTSWARM_RUNTIME_FACTS_URL,
        runtimeProvider === "horizondb" ? env.HORIZON_DATABASE_URL : undefined,
    );
    const factStoreUrl = explicitFactStoreUrl ?? first(options.cmsFactsDatabaseUrl);

    const graphUrl = first(
        options.graphDatabaseUrl,
        env.PILOTSWARM_GRAPH_URL,
        env.HORIZON_GRAPH_DATABASE_URL,
    );
    const graphEnabled = options.graphDatabaseUrl != null
        || graphUrl != null
        || boolFromEnv(env.PILOTSWARM_GRAPH_ENABLED) === true;

    const embedding = options.horizonEmbed
        ?? embeddingFromEnv(env, "PILOTSWARM")
        ?? (runtimeProvider === "horizondb" ? embeddingFromEnv(env, "HORIZON") : undefined);

    const runtimeFactsSchema = runtimeProvider === "horizondb"
        ? first(options.enhancedFactsSchema, options.factsSchema, env.PILOTSWARM_FACTS_SCHEMA, env.HORIZON_FACTS_SCHEMA, DEFAULT_HORIZON_FACTS_SCHEMA)
        : first(options.factsSchema, env.PILOTSWARM_FACTS_SCHEMA, DEFAULT_FACTS_SCHEMA);

    const runtime: RuntimeStorageConfig = {
        provider: runtimeProvider,
        url: runtimeUrl,
        ...(sessionCatalogUrl ? { sessionCatalogUrl } : {}),
        ...(factStoreUrl ? { factStoreUrl } : {}),
        cmsSchema: first(options.cmsSchema, env.PILOTSWARM_CMS_SCHEMA, DEFAULT_CMS_SCHEMA),
        factsSchema: runtimeFactsSchema,
        ...(embedding ? { embedding } : {}),
        ...(graphEnabled ? {
            graph: {
                enabled: true,
                ...(graphUrl ? { url: graphUrl } : {}),
                schema: first(options.graphSchema, env.PILOTSWARM_GRAPH_SCHEMA, env.HORIZON_GRAPH_SCHEMA, "horizon_graph"),
                ...(first(options.graphRegistrySchema, env.PILOTSWARM_GRAPH_REGISTRY_SCHEMA, env.HORIZON_GRAPH_REGISTRY_SCHEMA)
                    ? { registrySchema: first(options.graphRegistrySchema, env.PILOTSWARM_GRAPH_REGISTRY_SCHEMA, env.HORIZON_GRAPH_REGISTRY_SCHEMA) }
                    : {}),
                ...(options.graphNamespaceCacheTtlMs != null
                    ? { namespaceCacheTtlMs: options.graphNamespaceCacheTtlMs }
                    : (() => {
                        const parsed = parseNonNegativeNumber(
                            first(env.PILOTSWARM_GRAPH_NAMESPACE_CACHE_TTL_MS, env.HORIZON_NAMESPACE_CACHE_TTL_MS),
                            "PILOTSWARM_GRAPH_NAMESPACE_CACHE_TTL_MS",
                        );
                        return parsed != null ? { namespaceCacheTtlMs: parsed } : {};
                    })()),
            },
        } : {}),
        useManagedIdentity,
        ...(aadDbUser ? { aadDbUser } : {}),
    };

    const duroxide: DuroxideStorageConfig = {
        provider: first(env.PILOTSWARM_DUROXIDE_PROVIDER, DEFAULT_DUROXIDE_STORAGE_PROVIDER)!,
        url: first(env.PILOTSWARM_DUROXIDE_URL, runtime.url)!,
        schema: first(options.duroxideSchema, env.PILOTSWARM_DUROXIDE_SCHEMA, DEFAULT_DUROXIDE_SCHEMA),
        useManagedIdentity,
        ...(aadDbUser ? { aadDbUser } : {}),
    };

    return { runtime, duroxide };
}
