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
 * Connection-resiliency defaults applied to every `pg.Pool` built here
 * (CMS, facts, and the duroxide schema-preflight pool).
 *
 * Without these, a transient loss of connectivity to Postgres (failover,
 * a NAT/gateway idle-timeout, a network blip) leaves the pool holding
 * half-open sockets, and pg's defaults turn that into a PERMANENT wedge:
 *
 *   - `connectionTimeoutMillis` defaults to 0 → a client acquire (new
 *     connection, or a queued request against an exhausted pool) waits
 *     FOREVER.
 *   - there is no client-side `query_timeout` → a `pool.query` issued on
 *     a half-open socket waits FOREVER for a reply that never comes.
 *   - `keepAlive` is off → the dead peer is never detected at the TCP
 *     layer, so pg keeps handing the broken client back out.
 *
 * Because those calls HANG rather than throw, the worker's heartbeat /
 * CMS work never surfaces an error for the classified retry in
 * `cms-retry.ts` to catch, and only a process restart clears it. Bounding
 * every acquire and query makes the failure a fast REJECT instead, so the
 * retry layer rides out the blip and the worker self-heals once
 * connectivity returns. (The duroxide Rust/sqlx pool already behaves this
 * way via its own acquire timeout + retry; this brings the JS pools in
 * line.)
 *
 * We also keep the pool WARM. Establishing a fresh authenticated
 * connection to an Entra-auth Postgres is expensive (measured ~3-11s for
 * the TLS + server-side token validation, plus token minting), so paying
 * that cost on every query is what turns a brief connectivity blip into a
 * user-visible stall. pg's defaults work against us here: `min` is 0 and
 * `idleTimeoutMillis` is 10s, so a pool drains to zero after 10s idle and
 * the next query eats the full cold-connect tax. We therefore keep a
 * floor of `min` warm connections (never idle-reaped — see pg-pool
 * `_isAboveMin`) and hold burst connections longer via a larger
 * `idleTimeoutMillis`. `keepAlive` keeps those warm sockets from being
 * culled by a NAT/gateway idle-timeout. This does NOT reduce the cost of
 * a cold connect (the first connection, and any opened above `min` during
 * a burst, still pay it) — it just makes us pay it far less often.
 *
 * Every bound is env-overridable; set any to 0 to disable it (`min` 0
 * restores the drain-to-zero behaviour, `idleTimeoutMillis` 0 disables
 * idle reaping entirely). Note the query/statement timeouts also apply to
 * schema migrations run through the pool — raise them (or set 0) if a
 * one-off migration legitimately needs longer than the default.
 *
 * @internal
 */
export function pgResiliencyConfig(
    env: NodeJS.ProcessEnv = process.env,
): Pick<
    PoolConfig,
    | "keepAlive"
    | "keepAliveInitialDelayMillis"
    | "connectionTimeoutMillis"
    | "query_timeout"
    | "statement_timeout"
    | "min"
    | "idleTimeoutMillis"
> {
    const intMs = (name: string, fallback: number): number => {
        const raw = env[name];
        if (raw === undefined || raw.trim() === "") return fallback;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        keepAlive: true,
        keepAliveInitialDelayMillis: intMs("PILOTSWARM_PG_KEEPALIVE_INITIAL_DELAY_MS", 10_000),
        connectionTimeoutMillis: intMs("PILOTSWARM_PG_CONNECTION_TIMEOUT_MS", 15_000),
        query_timeout: intMs("PILOTSWARM_PG_QUERY_TIMEOUT_MS", 60_000),
        statement_timeout: intMs("PILOTSWARM_PG_STATEMENT_TIMEOUT_MS", 60_000),
        min: intMs("PILOTSWARM_PG_POOL_MIN", 1),
        idleTimeoutMillis: intMs("PILOTSWARM_PG_IDLE_TIMEOUT_MS", 60_000),
    };
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
            ...pgResiliencyConfig(),
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
        ...pgResiliencyConfig(),
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
