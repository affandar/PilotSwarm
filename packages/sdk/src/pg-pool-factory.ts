/**
 * Pg pool factory — feature-switched between connection-string auth and
 * Microsoft Entra (AAD) token auth for the bicep-deploy flow on AKS with
 * workload identity. Used by the CMS + facts pg.Pool paths.
 *
 * The duroxide orchestration store has its own Entra path
 * (`PostgresProvider.connectWithSchemaAndEntra`, available in
 * duroxide-node >= 0.1.25) which uses duroxide's native credential chain
 * in Rust rather than the JS `DefaultAzureCredential` used here; see
 * `duroxide-provider-factory.ts`. URL parsing is shared between both
 * paths via `parsePostgresUrl` / `resolveAadPostgresUser` below.
 *
 * @internal
 */
import type { PoolConfig } from "pg";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

/**
 * AAD scope for Azure Database for PostgreSQL Flexible Server. Constant
 * across all Azure regions / clouds where the resource is offered.
 */
const POSTGRES_AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

/**
 * Cache the AAD credential at module scope. `DefaultAzureCredential`
 * itself caches tokens (~5 min before expiry) and pg invokes the
 * `password` callback only when opening a new physical connection, so
 * the actual `getToken` rate stays low.
 */
let cachedCredential: TokenCredential | null = null;
function getCredential(): TokenCredential {
    if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
    return cachedCredential;
}

/**
 * Replace the cached credential with a custom one. Tests pass a stub
 * here; production code should never call this.
 *
 * @internal
 */
export function _setPgAadCredentialForTests(cred: TokenCredential | null): void {
    cachedCredential = cred;
}

export interface PgPoolFactoryOptions {
    /**
     * Connection string. In MI mode this can be a passwordless URL like
     * `postgresql://<aad-role>@<host>:5432/<db>?sslmode=require`; the
     * password segment (if any) is ignored.
     */
    connectionString: string;
    /**
     * Opt into AAD token auth. When `true` the returned config has a
     * `password` callback that mints AAD tokens via
     * `DefaultAzureCredential` instead of using the URL password.
     *
     * Defaults to `false` (legacy connection-string behaviour).
     */
    useManagedIdentity?: boolean;
    /**
     * Override the Postgres role name (`user` field) when in MI mode.
     * Defaults to the URL's `username` component. Required when the URL
     * encodes the bicep-bootstrap admin login but the worker should
     * authenticate as the federated UAMI's display name.
     */
    aadUser?: string;
    /** Forwarded to pg.Pool. Default 3 to match existing CMS / facts pools. */
    max?: number;
}

/**
 * Parsed components of a `postgres://` / `postgresql://` connection
 * string in the shape both the pg.Pool factory and the duroxide
 * provider factory need. Centralizes the sslmode-stripping and
 * default-port/database behaviour so the two paths stay aligned.
 *
 * @internal
 */
export interface ParsedPgUrl {
    host: string;
    /** Defaults to 5432 when the URL omits a port. */
    port: number;
    /** Defaults to `postgres` when the URL has no pathname. */
    database: string;
    /** Decoded URL `user@` segment, or empty string when absent. */
    urlUsername: string;
    /** True when sslmode is require/prefer/verify-ca/verify-full. */
    needsSsl: boolean;
    /** Connection string with `sslmode` stripped from the query. */
    sanitizedConnectionString: string;
}

/**
 * Parse a Postgres connection string into the parts both the pg.Pool
 * factory (for CMS/facts) and the duroxide provider factory need.
 *
 * @internal
 */
export function parsePostgresUrl(connectionString: string): ParsedPgUrl {
    const url = new URL(connectionString);

    // pg v8 treats sslmode=require as verify-full, which rejects Azure /
    // self-signed certs. Strip sslmode from URL and control SSL via
    // config object — same workaround the existing cms.ts / facts-store.ts
    // pools have used since well before the MI work.
    const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
        .includes(url.searchParams.get("sslmode") ?? "");
    url.searchParams.delete("sslmode");

    return {
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
        urlUsername: url.username ? decodeURIComponent(url.username) : "",
        needsSsl,
        sanitizedConnectionString: url.toString(),
    };
}

/**
 * Resolve the Postgres role to use in managed-identity mode. Prefers
 * the caller-provided `aadUser` (typically the federated UAMI display
 * name), falling back to the URL's `user@` segment.
 *
 * Throws when neither is set so misconfigurations fail loudly at
 * startup rather than producing cryptic auth errors at first query.
 *
 * @internal
 */
export function resolveAadPostgresUser(parsed: ParsedPgUrl, aadUser?: string): string {
    const user = aadUser ?? parsed.urlUsername;
    if (!user) {
        throw new Error(
            "managed-identity mode requires a Postgres user " +
            "(either as the URL `user@` segment or via opts.aadUser). The user " +
            "must match the AAD principal name registered as a Postgres administrator.",
        );
    }
    return user;
}

/**
 * Build a `pg.PoolConfig` honouring the MI feature switch.
 *
 * Implementation note: pg accepts `password` as either `string` or a
 * function returning `string | Promise<string>` and invokes it on every
 * new physical connection. `DefaultAzureCredential` returns a cached
 * token until ~5 min before expiry, so the factory does not need its
 * own token cache.
 *
 * @internal
 */
export function buildPgPoolConfig(opts: PgPoolFactoryOptions): PoolConfig {
    const parsed = parsePostgresUrl(opts.connectionString);
    const sslConfig = parsed.needsSsl ? { ssl: { rejectUnauthorized: false } } : {};
    const max = opts.max ?? 3;

    if (!opts.useManagedIdentity) {
        return {
            connectionString: parsed.sanitizedConnectionString,
            max,
            ...sslConfig,
        };
    }

    // MI mode: discard the URL password entirely and authenticate via
    // AAD token. We pass discrete fields rather than `connectionString`
    // because pg's `password` callback only takes effect when there is
    // no password embedded in the connectionString — pg-protocol picks
    // up an empty URL password before consulting the callback.
    const user = resolveAadPostgresUser(parsed, opts.aadUser);
    const credential = getCredential();

    return {
        host: parsed.host,
        port: parsed.port,
        database: parsed.database,
        user,
        password: async () => {
            const token = await credential.getToken(POSTGRES_AAD_SCOPE);
            if (!token?.token) {
                throw new Error(
                    "Failed to acquire AAD token for Postgres (DefaultAzureCredential.getToken returned no token). " +
                    "Verify workload identity is configured for this pod and the UAMI is registered as a Postgres administrator.",
                );
            }
            return token.token;
        },
        max,
        ...sslConfig,
    };
}

/**
 * Read the `PILOTSWARM_USE_MANAGED_IDENTITY` env flag. Convenience
 * helper so callers don't reimplement the truthy-flag parsing.
 *
 * @internal
 */
export function readManagedIdentityFlag(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
    const v = (env.PILOTSWARM_USE_MANAGED_IDENTITY ?? "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
}
