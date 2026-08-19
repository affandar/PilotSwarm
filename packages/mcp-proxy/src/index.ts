#!/usr/bin/env node
import { envBool, envInt } from "./proxy/config.js";
import { buildKustoApp } from "./kusto/app.js";
import { kustoConfigFromEnv } from "./kusto/config.js";

/**
 * Entry point for the in-cluster Kusto MCP proxy. Binds the composed express
 * app on PORT (default 8080). No credentials are loaded — the proxy forwards
 * each caller's delegated bearer to Kusto.
 */
function main(): void {
    const cfg = kustoConfigFromEnv();
    const app = buildKustoApp({ cfg, allowAppTokens: envBool("ALLOW_APP_TOKENS", false) });
    const port = envInt("PORT", 8080);
    app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(
            `[pilotswarm-mcp-proxy] kusto proxy listening on :${port} ` +
                `(cluster=${cfg.defaultCluster}, database=${cfg.defaultDatabase})`,
        );
    });
}

main();
