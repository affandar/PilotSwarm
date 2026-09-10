#!/usr/bin/env node

import {
    loadProviderPlugins,
    parseProviderPluginDefinitions,
} from "./loader.js";
import { closeProviders, shutdownProviderHost } from "./runtime.js";
import { createProviderHostServer } from "./server.js";

function positiveInteger(
    value: string | undefined,
    fallback: number,
    name: string,
): number {
    if (!value?.trim()) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

async function main(): Promise<void> {
    const host = process.env.HOST?.trim() || "0.0.0.0";
    const port = positiveInteger(process.env.PORT, 8080, "PORT");
    if (port > 65_535) throw new Error("PORT must be at most 65535");
    const authToken = process.env.JOBGEN_PROVIDER_HOST_AUTH_TOKEN?.trim();
    if (!authToken) {
        throw new Error("JOBGEN_PROVIDER_HOST_AUTH_TOKEN is required");
    }
    const bodyLimitBytes = positiveInteger(
        process.env.JOBGEN_PROVIDER_HOST_BODY_LIMIT_BYTES,
        1024 * 1024,
        "JOBGEN_PROVIDER_HOST_BODY_LIMIT_BYTES",
    );
    const evaluateTimeoutMs = positiveInteger(
        process.env.JOBGEN_PROVIDER_HOST_EVALUATE_TIMEOUT_MS,
        60_000,
        "JOBGEN_PROVIDER_HOST_EVALUATE_TIMEOUT_MS",
    );
    const shutdownTimeoutMs = positiveInteger(
        process.env.JOBGEN_PROVIDER_HOST_SHUTDOWN_TIMEOUT_MS,
        30_000,
        "JOBGEN_PROVIDER_HOST_SHUTDOWN_TIMEOUT_MS",
    );
    const definitions = parseProviderPluginDefinitions(
        process.env.JOBGEN_PROVIDER_PLUGINS_JSON,
    );
    if (definitions.length === 0) {
        throw new Error("JOBGEN_PROVIDER_PLUGINS_JSON must register at least one provider");
    }

    const providers = await loadProviderPlugins(definitions);
    const server = createProviderHostServer({
        providers,
        authToken,
        previousAuthToken:
            process.env.JOBGEN_PROVIDER_HOST_PREVIOUS_AUTH_TOKEN,
        bodyLimitBytes,
        evaluateTimeoutMs,
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, host, () => {
                server.off("error", reject);
                resolve();
            });
        });
    } catch (error) {
        await closeProviders(
            providers.values(),
            Date.now() + shutdownTimeoutMs,
        ).catch((cleanupError) => {
            console.error("[provider-host] startup cleanup failed", cleanupError);
        });
        throw error;
    }

    console.info(
        `[provider-host] listening on http://${host}:${port}`
        + ` providers=${[...providers.keys()].join(",")}`,
    );

    let shuttingDown = false;
    const handleSignal = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.info(`[provider-host] received ${signal}; stopping`);
        void shutdownProviderHost(
            server,
            providers.values(),
            shutdownTimeoutMs,
        ).then(
            () => process.exit(0),
            (error) => {
                console.error("[provider-host] shutdown failed", error);
                process.exit(1);
            },
        );
    };
    process.once("SIGINT", () => handleSignal("SIGINT"));
    process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

main().catch((error) => {
    console.error("[provider-host] fatal", error);
    process.exit(1);
});
