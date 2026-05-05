/**
 * Pg pool factory — feature-switched between connection-string auth (the
 * legacy and only path until Chunk C) and Microsoft Entra (AAD) token auth
 * for the bicep-deploy flow on AKS with workload identity.
 *
 * Chunk C scope: CMS + facts pools only. Duroxide's `PostgresProvider`
 * accepts a connection-string URL and has no token-callback hook, so it
 * keeps using the password URL (still bicep-managed, server-side AAD is
 * just enabled alongside password auth — see
 * `deploy/services/BaseInfra/bicep/postgres.bicep`). When duroxide gains
 * a token hook upstream we'll move it onto this factory too.
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
    const url = new URL(opts.connectionString);

    // pg v8 treats sslmode=require as verify-full, which rejects Azure /
    // self-signed certs. Strip sslmode from URL and control SSL via
    // config object — same workaround the existing cms.ts / facts-store.ts
    // pools have used since well before Chunk C.
    const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
        .includes(url.searchParams.get("sslmode") ?? "");
    url.searchParams.delete("sslmode");

    const sslConfig = needsSsl ? { ssl: { rejectUnauthorized: false } } : {};
    const max = opts.max ?? 3;

    if (!opts.useManagedIdentity) {
        return {
            connectionString: url.toString(),
            max,
            ...sslConfig,
        };
    }

    // MI mode: discard the URL password entirely and authenticate via
    // AAD token. We pass discrete fields rather than `connectionString`
    // because pg's `password` callback only takes effect when there is
    // no password embedded in the connectionString — pg-protocol picks
    // up an empty URL password before consulting the callback.
    const port = url.port ? Number(url.port) : 5432;
    const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
    const user = opts.aadUser
        ?? (url.username ? decodeURIComponent(url.username) : "");

    if (!user) {
        throw new Error(
            "buildPgPoolConfig: managed-identity mode requires a Postgres user " +
            "(either as the URL `user@` segment or via opts.aadUser). The user " +
            "must match the AAD principal name registered as a Postgres administrator.",
        );
    }

    const credential = getCredential();

    return {
        host: url.hostname,
        port,
        database,
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
