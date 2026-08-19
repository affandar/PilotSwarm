import type { Express } from "express";
import { buildProxyApp } from "../proxy/server.js";
import { KUSTO_AUDIENCE, KUSTO_SCOPE, type KustoConfig, kustoConfigFromEnv } from "./config.js";
import { registerKustoTools } from "./adapter.js";
import type { FetchImpl } from "./client.js";

export interface BuildKustoAppOptions {
    /** Kusto adapter config (defaults to env-derived). */
    cfg?: KustoConfig;
    /** Allow app-only tokens through the gate (default false — interactive only). */
    allowAppTokens?: boolean;
    /** Injectable fetch (for tests). */
    fetchImpl?: FetchImpl;
}

/**
 * Compose the generic proxy with the Kusto adapter into a ready express app.
 * The proxy advertises the Kusto audience inline (no PRM fetch needed) and
 * forwards the caller's delegated bearer to Kusto.
 */
export function buildKustoApp(opts: BuildKustoAppOptions = {}): Express {
    const cfg = opts.cfg ?? kustoConfigFromEnv();
    return buildProxyApp({
        auth: {
            resourceId: KUSTO_AUDIENCE,
            scope: KUSTO_SCOPE,
            allowAppTokens: opts.allowAppTokens ?? false,
        },
        serverInfo: {
            name: "pilotswarm-kusto-mcp",
            version: "0.5.37",
            instructions:
                "Adhoc Kusto access proxy. Tools run KQL against the configured cluster as YOUR delegated " +
                "credential (the proxy holds none). Try: kusto_query { query: 'StormEvents | take 1' }.",
        },
        registerTools: (server) => registerKustoTools(server, cfg, opts.fetchImpl),
    });
}
