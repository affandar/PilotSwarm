import type { Express } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildProxyApp, requireBearer } from "../adapter-host.js";

export interface SyntheticRestConfig {
    apiBaseUrl: string;
    resourceId: string;
    scope: string;
    timeoutMs?: number;
}

export interface BuildSyntheticRestAppOptions {
    config: SyntheticRestConfig;
    fetchImpl?: typeof fetch;
}

function normalizeApiBaseUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:") {
        throw new Error(`synthetic API base URL must use https: ${value}`);
    }
    return url.origin;
}

function registerSyntheticRestTools(
    server: McpServer,
    config: SyntheticRestConfig,
    fetchImpl: typeof fetch,
): void {
    server.registerTool(
        "get_widget",
        {
            title: "Get Widget",
            description:
                "Read one widget from the synthetic REST API as the caller's delegated identity.",
            inputSchema: {
                widget_id: z.string().min(1).describe("Widget identifier"),
            },
        },
        async ({ widget_id }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
            try {
                const response = await fetchImpl(
                    `${config.apiBaseUrl}/v1/widgets/${encodeURIComponent(widget_id)}`,
                    {
                        headers: {
                            Authorization: `Bearer ${requireBearer()}`,
                            Accept: "application/json",
                        },
                        signal: controller.signal,
                    },
                );
                if (!response.ok) {
                    const body = await response.text().catch(() => "");
                    throw new Error(
                        `widget API failed: HTTP ${response.status}: ${body.slice(0, 1000)}`,
                    );
                }

                const widget = await response.json();
                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({ widget }, null, 2),
                    }],
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text" as const, text: `Error: ${message}` }],
                    isError: true,
                };
            } finally {
                clearTimeout(timer);
            }
        },
    );
}

/**
 * Reference adapter for an OAuth-protected REST API that does not expose MCP.
 * Replace the widget tool and REST mapping while retaining the generic host.
 */
export function buildSyntheticRestApp(opts: BuildSyntheticRestAppOptions): Express {
    const config = {
        ...opts.config,
        apiBaseUrl: normalizeApiBaseUrl(opts.config.apiBaseUrl),
    };
    return buildProxyApp({
        auth: {
            resourceId: config.resourceId,
            scope: config.scope,
            allowAppTokens: false,
        },
        serverInfo: {
            name: "synthetic-widget-mcp",
            version: "1.0.0",
            instructions:
                "Use get_widget to read the synthetic widget catalog as your delegated identity.",
        },
        registerTools: (server) =>
            registerSyntheticRestTools(server, config, opts.fetchImpl ?? fetch),
    });
}
