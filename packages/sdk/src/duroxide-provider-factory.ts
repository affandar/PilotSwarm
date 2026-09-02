/**
 * Duroxide orchestration-store provider factory.
 *
 * Mirrors the MI feature switch used by `pg-pool-factory.ts` (CMS +
 * facts), but routes through duroxide's own Postgres provider rather
 * than node-pg. URL parsing and AAD user resolution are shared with
 * pg-pool-factory so the two paths stay aligned.
 *
 * Legacy path (`useManagedIdentity: false`, the default):
 *   `PostgresProvider.connectWithSchema(store, schema)` — unchanged
 *   password-in-URL flow used by the legacy `deploy-aks.sh` script.
 *
 * MI path (`useManagedIdentity: true`):
 *   `PostgresProvider.connectWithSchemaAndEntra(host, port, database,
 *   user, schema)` — duroxide-native AAD path added in
 *   duroxide-node@0.1.25. Duroxide resolves its credential chain in
 *   Rust (WorkloadIdentity → ManagedIdentity → DeveloperTools) so we
 *   do not pass a token callback here.
 *
 * @internal
 */
import { parsePostgresUrl, resolveAadPostgresUser } from "./pg-pool-factory.js";

export interface DuroxideProviderFactoryOptions {
    /** Opt into AAD token auth in duroxide. Defaults to `false`. */
    useManagedIdentity?: boolean;
    /** UAMI display name when the URL doesn't carry the AAD principal. */
    aadUser?: string;
    /**
     * Pool/timeout resiliency options threaded into the duroxide-native
     * Entra path. Defaults to {@link duroxidePgResiliencyConfig}. Only
     * consulted on the MI (`useManagedIdentity: true`) branch.
     */
    entraOptions?: DuroxidePgEntraOptions;
}

/**
 * Subset of duroxide's `PostgresEntraOptions` we tune for connection
 * resiliency. All fields optional; omitted fields fall back to the
 * native defaults (maxConnections 10 / `$DUROXIDE_PG_POOL_MAX`,
 * acquireTimeoutMs 30 000, refreshIntervalMs 300 000).
 */
export interface DuroxidePgEntraOptions {
    maxConnections?: number;
    acquireTimeoutMs?: number;
    refreshIntervalMs?: number;
}

/**
 * Resolve duroxide Postgres pool/timeout options from the environment.
 *
 * The duroxide orchestration pool is a Rust/sqlx pool configured
 * *separately* from the node-pg pools in `pg-pool-factory.ts` — the
 * warm-pool `min` / idle knobs there do NOT apply here (the native
 * provider exposes no pool floor). What it does expose is the acquire
 * timeout and the Entra token refresh lead, plus the pool ceiling.
 *
 * On a remote devbox each cold authenticated connect costs ~14s, so a
 * turn-commit under pool contention can blow past the native 30s
 * acquire timeout and get its orchestrator-queue message redelivered —
 * which burns duroxide's (non-configurable, hard-coded max 10) poison
 * attempts and fails the session. Raising the ceiling and the acquire
 * timeout gives commits room to land before redelivery.
 *
 * Env knobs (blank / non-positive → native default):
 *   DUROXIDE_PG_POOL_MAX          → maxConnections
 *   DUROXIDE_PG_ACQUIRE_TIMEOUT_MS → acquireTimeoutMs (default 60 000)
 *   DUROXIDE_PG_TOKEN_REFRESH_MS   → refreshIntervalMs
 */
export function duroxidePgResiliencyConfig(
    env: NodeJS.ProcessEnv = process.env,
): DuroxidePgEntraOptions {
    const posInt = (name: string): number | undefined => {
        const raw = env[name];
        if (raw === undefined || raw.trim() === "") return undefined;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const opts: DuroxidePgEntraOptions = {
        acquireTimeoutMs: posInt("DUROXIDE_PG_ACQUIRE_TIMEOUT_MS") ?? 60_000,
    };
    const maxConnections = posInt("DUROXIDE_PG_POOL_MAX");
    if (maxConnections !== undefined) opts.maxConnections = maxConnections;
    const refreshIntervalMs = posInt("DUROXIDE_PG_TOKEN_REFRESH_MS");
    if (refreshIntervalMs !== undefined) opts.refreshIntervalMs = refreshIntervalMs;
    return opts;
}

/**
 * Minimal duroxide `PostgresProvider` shape this factory needs. Lets
 * tests substitute a stub without dragging in the real native module.
 */
export interface DuroxidePostgresProviderModule {
    connectWithSchema(connectionString: string, schema: string): Promise<unknown>;
    connectWithSchemaAndEntra(
        host: string,
        port: number,
        database: string,
        user: string,
        schema: string,
        options?: DuroxidePgEntraOptions,
    ): Promise<unknown>;
}

/**
 * Build a duroxide `PostgresProvider` for the orchestration store,
 * honouring the MI feature switch. Throws for non-Postgres URLs — the
 * caller is responsible for routing sqlite stores elsewhere.
 *
 * @internal
 */
export async function createDuroxidePostgresProvider(
    PostgresProvider: DuroxidePostgresProviderModule,
    store: string,
    schema: string,
    opts: DuroxideProviderFactoryOptions = {},
): Promise<unknown> {
    if (!opts.useManagedIdentity) {
        return PostgresProvider.connectWithSchema(store, schema);
    }

    const parsed = parsePostgresUrl(store);
    const user = resolveAadPostgresUser(parsed, opts.aadUser);
    const entraOptions = opts.entraOptions ?? duroxidePgResiliencyConfig();
    return PostgresProvider.connectWithSchemaAndEntra(
        parsed.host,
        parsed.port,
        parsed.database,
        user,
        schema,
        entraOptions,
    );
}
