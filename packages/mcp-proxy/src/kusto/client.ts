import { randomUUID } from "node:crypto";
import type { KustoConfig } from "./config.js";

/** A Kusto v1 REST response (the subset we consume). */
interface KustoV1Response {
    Tables?: Array<{
        TableName?: string;
        Columns?: Array<{ ColumnName?: string; DataType?: string; ColumnType?: string }>;
        Rows?: unknown[][];
    }>;
}

export interface KustoResult {
    cluster: string;
    database: string;
    query: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
    rowCount: number;
    truncated: boolean;
}

/**
 * Validate a cluster URI against the SSRF allowlist. Strips a trailing slash,
 * requires an `https` `*.kusto.windows.net` host, and requires the host to be
 * in the configured allowlist. Throws on any violation.
 */
export function validateCluster(cluster: string, cfg: KustoConfig): string {
    const trimmed = cluster.replace(/\/+$/, "");
    let host: string;
    try {
        const u = new URL(trimmed);
        if (u.protocol !== "https:") {
            throw new Error(`refusing non-Kusto cluster URI (must be https): ${cluster}`);
        }
        host = u.hostname.toLowerCase();
    } catch (err) {
        if (err instanceof Error && /non-Kusto/.test(err.message)) throw err;
        throw new Error(`refusing non-Kusto cluster URI (unparseable): ${cluster}`);
    }
    if (!host.endsWith(".kusto.windows.net")) {
        throw new Error(`refusing non-Kusto cluster host: ${host}`);
    }
    if (!cfg.allowedClusters.has(host)) {
        throw new Error(`cluster host not in allowlist: ${host}`);
    }
    return trimmed;
}

/** Extract the primary (first non-metadata) result table from a v1 response. */
export function primaryTable(
    resp: KustoV1Response,
): { columns: string[]; rows: unknown[][] } {
    const tables = resp.Tables ?? [];
    if (tables.length === 0) return { columns: [], rows: [] };
    // v1 query responses put the result set first; the trailing tables are
    // QueryStatus/TableOfContents metadata.
    const primary = tables[0];
    const columns = (primary.Columns ?? []).map((c) => c.ColumnName ?? "");
    const rows = primary.Rows ?? [];
    return { columns, rows };
}

export type FetchImpl = typeof fetch;

/**
 * Execute a KQL statement against Kusto, forwarding the caller's bearer. Uses
 * the v1 REST endpoint: `/v1/rest/query` for queries, `/v1/rest/mgmt` for
 * control commands (`.show ...`). Holds NO credentials — the bearer is the
 * caller's delegated token, passed through verbatim.
 */
export async function executeKusto(
    args: {
        cluster: string;
        database: string;
        csl: string;
        bearer: string;
        isControl: boolean;
    },
    cfg: KustoConfig,
    fetchImpl: FetchImpl = fetch,
): Promise<KustoResult> {
    const cluster = validateCluster(args.cluster, cfg);
    const endpoint = args.isControl ? "mgmt" : "query";
    const url = `${cluster}/v1/rest/${endpoint}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let resp: Response;
    try {
        resp = await fetchImpl(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${args.bearer}`,
                Accept: "application/json",
                "Content-Type": "application/json; charset=utf-8",
                "x-ms-client-request-id": `kusto-mcp;${randomUUID()}`,
            },
            body: JSON.stringify({ db: args.database, csl: args.csl }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (resp.status !== 200) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Kusto ${endpoint} failed: HTTP ${resp.status}: ${text.slice(0, 1000)}`);
    }

    const json = (await resp.json()) as KustoV1Response;
    const { columns, rows } = primaryTable(json);
    const truncated = rows.length > cfg.maxRows;
    const capped = truncated ? rows.slice(0, cfg.maxRows) : rows;
    const dictRows = capped.map((row) => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, i) => {
            obj[col] = row[i];
        });
        return obj;
    });

    return {
        cluster,
        database: args.database,
        query: args.csl,
        columns,
        rows: dictRows,
        rowCount: dictRows.length,
        truncated,
    };
}
