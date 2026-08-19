import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWwwAuthenticate, parseWwwAuthenticate } from "pilotswarm-sdk";
import { buildKustoApp } from "../src/kusto/app.js";
import { KUSTO_AUDIENCE, KUSTO_SCOPE, type KustoConfig } from "../src/kusto/config.js";
import { APP_TOKEN, USER_TOKEN } from "./tokens.js";

const cfg: KustoConfig = {
    defaultCluster: "https://help.kusto.windows.net",
    defaultDatabase: "Samples",
    allowedClusters: new Set(["help.kusto.windows.net"]),
    maxRows: 50,
    timeoutMs: 60_000,
};

function listen(app: ReturnType<typeof buildKustoApp>): Promise<{ server: Server; base: string }> {
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const { port } = server.address() as AddressInfo;
            resolve({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

describe("proxy WWW-Authenticate contract", () => {
    it("round-trips buildWwwAuthenticate -> parseWwwAuthenticate with NO resource_metadata", () => {
        const header = buildWwwAuthenticate({ resourceId: KUSTO_AUDIENCE, scope: KUSTO_SCOPE });
        const parsed = parseWwwAuthenticate(header);
        expect(parsed.resourceId).toBe(KUSTO_AUDIENCE);
        expect(parsed.scope).toBe(KUSTO_SCOPE);
        // Critical: an in-cluster plain-HTTP service must NOT advertise a PRM URL
        // (the worker refuses a non-https PRM fetch); the audience is inline only.
        expect(parsed.resourceMetadata).toBeUndefined();
    });
});

describe("HTTP surface", () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
        ({ server, base } = await listen(buildKustoApp({ cfg })));
    });
    afterEach(async () => {
        await close(server);
    });

    it("GET /healthz is public and returns ok", async () => {
        const res = await fetch(`${base}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: "ok" });
    });

    it("GET /.well-known/oauth-protected-resource is public and advertises the Kusto audience", async () => {
        const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { resource: string; scopes_supported: string[] };
        expect(body.resource).toBe(KUSTO_AUDIENCE);
        expect(body.scopes_supported).toContain(KUSTO_SCOPE);
    });

    it("POST /mcp with no bearer returns 401 with an inline resource_id challenge (no resource_metadata)", async () => {
        const res = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(res.status).toBe(401);
        const challenge = res.headers.get("www-authenticate") ?? "";
        const parsed = parseWwwAuthenticate(challenge);
        expect(parsed.resourceId).toBe(KUSTO_AUDIENCE);
        expect(parsed.scope).toBe(KUSTO_SCOPE);
        expect(parsed.resourceMetadata).toBeUndefined();
    });

    it("GET /mcp with no bearer hits the auth gate first and returns 401 (probe path)", async () => {
        const res = await fetch(`${base}/mcp`);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain(KUSTO_AUDIENCE);
    });

    it("POST /mcp with an app-only token is rejected 403 interactive_credential_required", async () => {
        const res = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${APP_TOKEN}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: "interactive_credential_required" });
    });

    it("a user (interactive) token passes the auth gate", async () => {
        const res = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${USER_TOKEN}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        // The gate opened: not a 401/403. The MCP transport may still shape the
        // response differently, but auth succeeded — that's what we assert here.
        expect([401, 403]).not.toContain(res.status);
    });
});

describe("ALLOW_APP_TOKENS", () => {
    it("lets an app-only token through the gate when enabled", async () => {
        const { server: s, base: b } = await listen(buildKustoApp({ cfg, allowAppTokens: true }));
        try {
            const res = await fetch(`${b}/mcp`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json, text/event-stream",
                    Authorization: `Bearer ${APP_TOKEN}`,
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
            });
            expect([401, 403]).not.toContain(res.status);
        } finally {
            await close(s);
        }
    });
});

describe("caller bearer is forwarded to Kusto through a tool call", () => {
    let server: Server;
    let base: string;
    let fetchImpl: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        fetchImpl = vi.fn(async () =>
            new Response(JSON.stringify({ Tables: [{ Columns: [{ ColumnName: "N" }], Rows: [[1]] }] }), { status: 200 }),
        );
        ({ server, base } = await listen(buildKustoApp({ cfg, fetchImpl: fetchImpl as unknown as typeof fetch })));
    });
    afterEach(async () => {
        await close(server);
    });

    it("passes the caller's bearer verbatim into the upstream Kusto request", async () => {
        const res = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${USER_TOKEN}`,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "kusto_query", arguments: { query: "StormEvents | take 1" } },
            }),
        });
        expect([401, 403]).not.toContain(res.status);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${USER_TOKEN}`);
    });
});
