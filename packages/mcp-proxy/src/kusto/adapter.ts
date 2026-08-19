import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { currentBearer } from "../proxy/bearer.js";
import type { KustoConfig } from "./config.js";
import { executeKusto, type FetchImpl, type KustoResult } from "./client.js";

/**
 * Read the caller's delegated bearer bound by the auth middleware. Exported for
 * tests. Throws (rather than falling back to any server credential) when absent
 * — the proxy has nothing of its own to forward.
 */
export function requireBearer(): string {
    const bearer = currentBearer();
    if (!bearer) {
        throw new Error("no caller bearer present on the request (nothing to forward to Kusto)");
    }
    return bearer;
}

function ok(result: KustoResult) {
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/**
 * Register the Kusto adapter's tools onto an McpServer. Each tool forwards the
 * caller's delegated bearer to Kusto; none holds a server credential.
 *   - kusto_query        run a KQL query
 *   - kusto_show_tables  list tables (`.show tables`)
 *   - kusto_show_schema  show a table's schema (`.show table T schema`)
 */
export function registerKustoTools(server: McpServer, cfg: KustoConfig, fetchImpl?: FetchImpl): void {
    server.registerTool(
        "kusto_query",
        {
            title: "Run KQL Query",
            description:
                "Run an adhoc KQL query against the configured Kusto cluster as the CALLER's delegated " +
                `credential. Defaults: cluster=${cfg.defaultCluster}, database=${cfg.defaultDatabase}. ` +
                `Returns up to ${cfg.maxRows} rows.`,
            inputSchema: {
                query: z.string().describe("The KQL query text, e.g. 'StormEvents | take 1'"),
                database: z.string().optional().describe(`Database name (default ${cfg.defaultDatabase})`),
                cluster: z
                    .string()
                    .optional()
                    .describe(`Cluster URI (default ${cfg.defaultCluster}); must be an allowlisted *.kusto.windows.net host`),
            },
        },
        async ({ query, database, cluster }) => {
            try {
                const result = await executeKusto(
                    {
                        cluster: cluster ?? cfg.defaultCluster,
                        database: database ?? cfg.defaultDatabase,
                        csl: query,
                        bearer: requireBearer(),
                        isControl: false,
                    },
                    cfg,
                    fetchImpl,
                );
                return ok(result);
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        "kusto_show_tables",
        {
            title: "List Kusto Tables",
            description:
                "List tables in the configured Kusto database as the CALLER's delegated credential (`.show tables`).",
            inputSchema: {
                database: z.string().optional().describe(`Database name (default ${cfg.defaultDatabase})`),
                cluster: z.string().optional().describe(`Cluster URI (default ${cfg.defaultCluster})`),
            },
        },
        async ({ database, cluster }) => {
            try {
                const result = await executeKusto(
                    {
                        cluster: cluster ?? cfg.defaultCluster,
                        database: database ?? cfg.defaultDatabase,
                        csl: ".show tables",
                        bearer: requireBearer(),
                        isControl: true,
                    },
                    cfg,
                    fetchImpl,
                );
                return ok(result);
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        "kusto_show_schema",
        {
            title: "Show Kusto Table Schema",
            description:
                "Show a table's schema as the CALLER's delegated credential (`.show table <name> schema as json`).",
            inputSchema: {
                table: z.string().describe("The table name to describe"),
                database: z.string().optional().describe(`Database name (default ${cfg.defaultDatabase})`),
                cluster: z.string().optional().describe(`Cluster URI (default ${cfg.defaultCluster})`),
            },
        },
        async ({ table, database, cluster }) => {
            try {
                const result = await executeKusto(
                    {
                        cluster: cluster ?? cfg.defaultCluster,
                        database: database ?? cfg.defaultDatabase,
                        csl: `.show table ${table} schema as json`,
                        bearer: requireBearer(),
                        isControl: true,
                    },
                    cfg,
                    fetchImpl,
                );
                return ok(result);
            } catch (err) {
                return fail(err);
            }
        },
    );
}
