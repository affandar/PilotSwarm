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
        options?: unknown,
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
    return PostgresProvider.connectWithSchemaAndEntra(
        parsed.host,
        parsed.port,
        parsed.database,
        user,
        schema,
    );
}
