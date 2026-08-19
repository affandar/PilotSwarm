import { describe, expect, it, vi } from "vitest";
import type { KustoConfig } from "../src/kusto/config.js";
import { executeKusto, primaryTable, validateCluster } from "../src/kusto/client.js";

const cfg: KustoConfig = {
    defaultCluster: "https://help.kusto.windows.net",
    defaultDatabase: "Samples",
    allowedClusters: new Set(["help.kusto.windows.net"]),
    maxRows: 50,
    timeoutMs: 60_000,
};

describe("validateCluster", () => {
    it("accepts an allowlisted Kusto https cluster and strips a trailing slash", () => {
        expect(validateCluster("https://help.kusto.windows.net/", cfg)).toBe("https://help.kusto.windows.net");
    });

    it("rejects a non-Kusto host", () => {
        expect(() => validateCluster("https://evil.example.com", cfg)).toThrow(/non-Kusto/);
    });

    it("rejects a Kusto host that is not in the allowlist", () => {
        expect(() => validateCluster("https://other.kusto.windows.net", cfg)).toThrow(/allowlist/);
    });

    it("rejects a non-https scheme", () => {
        expect(() => validateCluster("http://help.kusto.windows.net", cfg)).toThrow(/non-Kusto/);
    });
});

describe("primaryTable", () => {
    it("extracts columns and rows from the first table", () => {
        const resp = {
            Tables: [
                { Columns: [{ ColumnName: "A" }, { ColumnName: "B" }], Rows: [[1, 2], [3, 4]] },
                { Columns: [{ ColumnName: "meta" }], Rows: [["ignored"]] },
            ],
        };
        expect(primaryTable(resp)).toEqual({ columns: ["A", "B"], rows: [[1, 2], [3, 4]] });
    });

    it("returns empty columns/rows when there are no tables", () => {
        expect(primaryTable({})).toEqual({ columns: [], rows: [] });
    });
});

/** Build a fake fetch returning a Kusto v1 query response. */
function fakeFetch(status: number, body: unknown): typeof fetch {
    return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("executeKusto", () => {
    it("forwards the caller bearer and shapes rows as dicts", async () => {
        const captured: { url?: string; headers?: Headers; body?: string } = {};
        const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            captured.url = String(url);
            captured.headers = new Headers(init?.headers);
            captured.body = init?.body as string;
            return new Response(
                JSON.stringify({ Tables: [{ Columns: [{ ColumnName: "N" }], Rows: [[1]] }] }),
                { status: 200 },
            );
        }) as unknown as typeof fetch;

        const result = await executeKusto(
            { cluster: cfg.defaultCluster, database: "Samples", csl: "StormEvents | take 1", bearer: "CALLER_TOKEN", isControl: false },
            cfg,
            impl,
        );

        expect(captured.url).toBe("https://help.kusto.windows.net/v1/rest/query");
        expect(captured.headers?.get("authorization")).toBe("Bearer CALLER_TOKEN");
        expect(JSON.parse(captured.body!)).toEqual({ db: "Samples", csl: "StormEvents | take 1" });
        expect(result.columns).toEqual(["N"]);
        expect(result.rows).toEqual([{ N: 1 }]);
        expect(result.rowCount).toBe(1);
        expect(result.truncated).toBe(false);
    });

    it("uses the mgmt endpoint for control commands", async () => {
        const captured: { url?: string } = {};
        const impl = vi.fn(async (url: string | URL | Request) => {
            captured.url = String(url);
            return new Response(JSON.stringify({ Tables: [{ Columns: [{ ColumnName: "TableName" }], Rows: [["StormEvents"]] }] }), { status: 200 });
        }) as unknown as typeof fetch;

        await executeKusto(
            { cluster: cfg.defaultCluster, database: "Samples", csl: ".show tables", bearer: "T", isControl: true },
            cfg,
            impl,
        );
        expect(captured.url).toBe("https://help.kusto.windows.net/v1/rest/mgmt");
    });

    it("caps rows at maxRows and flags truncation", async () => {
        const rows = Array.from({ length: 5 }, (_, i) => [i]);
        const smallCfg: KustoConfig = { ...cfg, maxRows: 3 };
        const result = await executeKusto(
            { cluster: cfg.defaultCluster, database: "Samples", csl: "T", bearer: "T", isControl: false },
            smallCfg,
            fakeFetch(200, { Tables: [{ Columns: [{ ColumnName: "i" }], Rows: rows }] }),
        );
        expect(result.rowCount).toBe(3);
        expect(result.truncated).toBe(true);
    });

    it("throws with the upstream status and body on a non-200", async () => {
        await expect(
            executeKusto(
                { cluster: cfg.defaultCluster, database: "Samples", csl: "T", bearer: "T", isControl: false },
                cfg,
                fakeFetch(403, "Forbidden: token audience mismatch"),
            ),
        ).rejects.toThrow(/Kusto query failed: HTTP 403: Forbidden/);
    });

    it("refuses a non-allowlisted cluster before making any request", async () => {
        const impl = vi.fn() as unknown as typeof fetch;
        await expect(
            executeKusto(
                { cluster: "https://evil.example.com", database: "Samples", csl: "T", bearer: "T", isControl: false },
                cfg,
                impl,
            ),
        ).rejects.toThrow(/non-Kusto/);
        expect(impl).not.toHaveBeenCalled();
    });
});
