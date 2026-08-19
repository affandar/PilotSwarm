import { envHosts, envInt } from "../proxy/config.js";

/** Azure Data Explorer (Kusto) resource audience — the token audience callers
 * must acquire and that this proxy advertises in its challenge. */
export const KUSTO_AUDIENCE = "https://kusto.kusto.windows.net";
/** The scope callers acquire against the Kusto resource. */
export const KUSTO_SCOPE = `${KUSTO_AUDIENCE}/.default`;

export interface KustoConfig {
    /** Default cluster URI, e.g. `https://help.kusto.windows.net`. */
    defaultCluster: string;
    /** Default database, e.g. `Samples`. */
    defaultDatabase: string;
    /** Allowlisted cluster hostnames (SSRF guard). */
    allowedClusters: Set<string>;
    /** Max rows returned per query (server-side cap). */
    maxRows: number;
    /** Per-request HTTP timeout in ms. */
    timeoutMs: number;
}

const DEFAULT_CLUSTER = "https://help.kusto.windows.net";
const DEFAULT_DATABASE = "Samples";

/** Build the Kusto adapter config from environment variables. */
export function kustoConfigFromEnv(): KustoConfig {
    const defaultCluster = (process.env["KUSTO_DEFAULT_CLUSTER"] ?? DEFAULT_CLUSTER).replace(/\/+$/, "");
    let defaultHost = "";
    try {
        defaultHost = new URL(defaultCluster).hostname.toLowerCase();
    } catch {
        defaultHost = "";
    }
    const allowedClusters = envHosts("KUSTO_ALLOWED_CLUSTERS", defaultHost ? [defaultHost] : []);
    if (defaultHost) allowedClusters.add(defaultHost);
    return {
        defaultCluster,
        defaultDatabase: process.env["KUSTO_DEFAULT_DATABASE"] ?? DEFAULT_DATABASE,
        allowedClusters,
        maxRows: envInt("KUSTO_MAX_ROWS", 50),
        timeoutMs: envInt("KUSTO_HTTP_TIMEOUT_MS", 60_000),
    };
}
