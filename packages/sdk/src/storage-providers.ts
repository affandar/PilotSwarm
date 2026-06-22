import { createRequire } from "node:module";
import { PgSessionCatalog, type SessionCatalog } from "./cms.js";
import {
    createFactStoreForUrl,
    createGraphStoreForUrl,
    isEnhancedFactStore,
    type EnhancedFactStore,
    type FactStore,
} from "./facts-store.js";
import type { GraphStore } from "./graph-store.js";
import { createDuroxidePostgresProvider } from "./duroxide-provider-factory.js";
import { DEFAULT_DUROXIDE_SCHEMA, type DuroxideStorageConfig, type RuntimeStorageConfig } from "./storage-config.js";

const require = createRequire(import.meta.url);
const { PostgresProvider } = require("duroxide");

export interface RuntimeStorageProvider {
    id: string;
    capabilities: {
        enhancedFactStore?: true;
        graphStore?: true;
        embeddingSupport?: true;
    };
    createSessionCatalog(args: RuntimeStorageConfig): Promise<SessionCatalog>;
    createFactStore(args: RuntimeStorageConfig): Promise<FactStore>;
    getEnhancedFactStore?(store: FactStore): EnhancedFactStore | undefined;
    createGraphStore?(args: RuntimeStorageConfig): Promise<GraphStore | undefined>;
}

export interface DuroxideStorageProvider {
    id: string;
    createDuroxideProvider(args: DuroxideStorageConfig): Promise<unknown>;
}

function assertPostgresUrl(url: string, label: string): void {
    if (!(url.startsWith("postgres://") || url.startsWith("postgresql://"))) {
        throw new Error(`${label} requires a PostgreSQL URL, got ${url}`);
    }
}

async function preflightLegacyDuroxideSchema(args: DuroxideStorageConfig, schema: string): Promise<void> {
    const legacySchema = typeof args.providerOptions?.legacySchema === "string"
        ? args.providerOptions.legacySchema
        : "duroxide";
    if (schema !== DEFAULT_DUROXIDE_SCHEMA && legacySchema === "duroxide") return;

    const { default: pg } = await import("pg");
    const { buildPgPoolConfig } = await import("./pg-pool-factory.js");
    const pool = new pg.Pool(buildPgPoolConfig({
        connectionString: args.url,
        useManagedIdentity: args.useManagedIdentity,
        aadUser: args.aadDbUser,
        max: 1,
    }));
    try {
        const { rows } = await pool.query(`
            SELECT
                EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2) AS legacy_exists,
                EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS target_exists,
                                EXISTS (
                                        SELECT 1
                                        FROM pg_extension e
                                        JOIN pg_namespace n ON n.oid = e.extnamespace
                                        WHERE e.extname = 'pg_durable'
                                              AND n.nspname = $2
                                ) AS legacy_owned_by_pg_durable,
                EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = $2
                      AND table_name IN ('instances', 'executions', 'history', 'orchestrator_queue', 'worker_queue')
                ) AS legacy_has_pilotswarm_tables
        `, [schema, legacySchema]);
        const row = rows[0] ?? {};
        if (row.legacy_exists && row.legacy_has_pilotswarm_tables && !row.legacy_owned_by_pg_durable) {
            throw new Error(
                `Refusing to use ${schema} while legacy PilotSwarm duroxide schema ${legacySchema} exists. ` +
                `Run migrateLegacyDuroxideSchema(), remove the legacy schema after confirming it is obsolete, or pin PILOTSWARM_DUROXIDE_SCHEMA=${legacySchema} until a migration window.`,
            );
        }
    } finally {
        await pool.end();
    }
}

const postgresRuntimeStorageProvider: RuntimeStorageProvider = {
    id: "postgres",
    capabilities: {},
    async createSessionCatalog(args) {
        const url = args.sessionCatalogUrl ?? args.url;
        assertPostgresUrl(url, "postgres runtime session catalog");
        return PgSessionCatalog.create(url, args.cmsSchema, {
            useManagedIdentity: args.useManagedIdentity,
            aadUser: args.aadDbUser,
        });
    },
    async createFactStore(args) {
        const url = args.factStoreUrl ?? args.sessionCatalogUrl ?? args.url;
        return createFactStoreForUrl(url, args.factsSchema, {
            useManagedIdentity: args.useManagedIdentity,
            aadUser: args.aadDbUser,
            provider: "pg",
        });
    },
};

const horizondbRuntimeStorageProvider: RuntimeStorageProvider = {
    id: "horizondb",
    capabilities: {
        enhancedFactStore: true,
        graphStore: true,
        embeddingSupport: true,
    },
    async createSessionCatalog(args) {
        const url = args.sessionCatalogUrl ?? args.url;
        assertPostgresUrl(url, "horizondb runtime session catalog");
        return PgSessionCatalog.create(url, args.cmsSchema, {
            useManagedIdentity: args.useManagedIdentity,
            aadUser: args.aadDbUser,
        });
    },
    async createFactStore(args) {
        const url = args.factStoreUrl ?? args.url;
        return createFactStoreForUrl(url, args.factsSchema, {
            provider: "horizon",
            embedding: args.embedding,
        });
    },
    getEnhancedFactStore(store) {
        return isEnhancedFactStore(store) ? store : undefined;
    },
    async createGraphStore(args) {
        if (!args.graph?.enabled) return undefined;
        const graphUrl = args.graph.url ?? args.url;
        const graphSchema = args.graph.schema ?? "horizon_graph";
        const factsUrl = args.factStoreUrl ?? args.url;
        if (graphUrl === factsUrl && graphSchema === (args.factsSchema ?? "horizon_facts")) {
            throw new Error(
                `graphSchema "${graphSchema}" collides with the facts schema on the same database. ` +
                `Apache AGE creates a PG schema named after the graph; choose a distinct graphSchema.`,
            );
        }
        return createGraphStoreForUrl(graphUrl, graphSchema, {
            registrySchema: args.graph.registrySchema,
            namespaceCacheTtlMs: args.graph.namespaceCacheTtlMs,
        });
    },
};

const postgresDuroxideStorageProvider: DuroxideStorageProvider = {
    id: "postgres",
    async createDuroxideProvider(args) {
        assertPostgresUrl(args.url, "postgres duroxide storage");
        const schema = args.schema ?? DEFAULT_DUROXIDE_SCHEMA;
        await preflightLegacyDuroxideSchema(args, schema);
        return createDuroxidePostgresProvider(PostgresProvider, args.url, schema, {
            useManagedIdentity: args.useManagedIdentity ?? false,
            aadUser: args.aadDbUser,
        });
    },
};

export const runtimeStorageProviders: Record<string, RuntimeStorageProvider> = {
    postgres: postgresRuntimeStorageProvider,
    horizondb: horizondbRuntimeStorageProvider,
};

export const duroxideStorageProviders: Record<string, DuroxideStorageProvider> = {
    postgres: postgresDuroxideStorageProvider,
};

export function getRuntimeStorageProvider(id: string): RuntimeStorageProvider {
    const provider = runtimeStorageProviders[id];
    if (!provider) {
        throw new Error(`Unknown runtime storage provider: ${id}`);
    }
    return provider;
}

export function getDuroxideStorageProvider(id: string): DuroxideStorageProvider {
    const provider = duroxideStorageProviders[id];
    if (!provider) {
        throw new Error(`Unknown duroxide storage provider: ${id}`);
    }
    return provider;
}
