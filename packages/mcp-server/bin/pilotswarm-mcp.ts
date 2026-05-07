#!/usr/bin/env node

import { parseArgs } from "node:util";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createContext } from "../src/context.js";
import { createMcpServer } from "../src/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { values } = parseArgs({
    options: {
        transport: { type: "string", default: "stdio" },
        port: { type: "string", default: "3100" },
        host: { type: "string" },
        "allowed-hosts": { type: "string" },
        "max-sessions": { type: "string" },
        store: { type: "string" },
        plugin: { type: "string", multiple: true },
        "model-providers": { type: "string" },
        "log-level": { type: "string", default: "error" },
    },
});

const store = values.store ?? process.env.DATABASE_URL;
if (!store) {
    console.error("Error: --store <url> or DATABASE_URL env var is required.");
    process.exit(1);
}

const ctx = await createContext({
    store,
    modelProvidersPath: values["model-providers"],
    pluginDirs: values.plugin,
});

if (values.transport === "stdio") {
    const server = createMcpServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);

    const shutdown = async (signal: string) => {
        console.error(`[pilotswarm-mcp] ${signal} received — closing stdio transport`);
        try { await transport.close?.(); } catch { /* ignore */ }
        try { await ctx.client.stop?.(); } catch { /* ignore */ }
        try { await ctx.mgmt.stop?.(); } catch { /* ignore */ }
        try { await ctx.facts.close?.(); } catch { /* ignore */ }
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
} else if (values.transport === "http") {
    const mcpKey = process.env.PILOTSWARM_MCP_KEY;
    if (!mcpKey) {
        console.error("Error: PILOTSWARM_MCP_KEY env var required for HTTP transport.");
        process.exit(1);
    }
    const expectedAuthBuf = Buffer.from(`Bearer ${mcpKey}`);

    const { WebStandardStreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    const { Hono } = await import("hono");
    const { cors } = await import("hono/cors");
    const { serve } = await import("@hono/node-server");

    const port = parseInt(values.port ?? "3100", 10);
    const host =
        values.host ??
        process.env.PILOTSWARM_MCP_HOST ??
        "127.0.0.1";

    // allowedHosts — Host header allowlist to prevent DNS-rebinding attacks.
    // Defaults to localhost-equivalents on the chosen port plus the host:port the
    // server is bound to. Operators bridging through reverse proxies / public DNS
    // must pass --allowed-hosts (or PILOTSWARM_MCP_ALLOWED_HOSTS) explicitly.
    const allowedHostsSrc =
        values["allowed-hosts"] ??
        process.env.PILOTSWARM_MCP_ALLOWED_HOSTS ??
        "";
    const allowedHosts = new Set<string>(
        allowedHostsSrc
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0),
    );
    // Always permit the bound host:port + standard localhost aliases on the
    // configured port so the default `--transport http` invocation works without
    // additional flags.
    allowedHosts.add(`${host}:${port}`.toLowerCase());
    allowedHosts.add(`127.0.0.1:${port}`);
    allowedHosts.add(`localhost:${port}`);
    allowedHosts.add(`[::1]:${port}`);

    // max-sessions — concurrent MCP session cap. New sessions beyond this cap are
    // rejected with a 503 + JSON-RPC service-unavailable shape so memory cannot be
    // exhausted by an unbounded number of long-lived SSE connections.
    const maxSessionsRaw =
        values["max-sessions"] ??
        process.env.PILOTSWARM_MCP_MAX_SESSIONS ??
        "256";
    const parsedMax = parseInt(maxSessionsRaw, 10);
    const maxSessions = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 256;

    const app = new Hono();

    // Per-session transport+server map — McpServer.connect() is one-shot
    // per the MCP SDK spec, so each client session gets its own pair.
    const sessions = new Map<string, InstanceType<typeof WebStandardStreamableHTTPServerTransport>>();

    // Track in-flight HTTP request handlers so SIGTERM can wait for them to drain
    // instead of severing connections mid-response.
    const inFlight = new Set<Promise<unknown>>();
    let shuttingDown = false;

    app.use("*", async (c, next) => {
        if (shuttingDown) {
            return c.json({ error: "Server shutting down" }, 503);
        }
        // DNS-rebinding defense: validate Host header against the allowlist.
        const hostHeader = (c.req.header("host") ?? "").toLowerCase();
        if (!allowedHosts.has(hostHeader)) {
            return c.json({ error: "Host not allowed" }, 403);
        }
        await next();
    });

    app.use("*", cors({
        origin: "*",
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
        exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }));

    // Bearer token auth middleware — constant-time comparison to avoid leaking
    // the token via timing side-channels.
    app.use("/mcp", async (c, next) => {
        const auth = c.req.header("authorization") ?? "";
        const authBuf = Buffer.from(auth);
        const ok =
            authBuf.length === expectedAuthBuf.length &&
            timingSafeEqual(authBuf, expectedAuthBuf);
        if (!ok) {
            return c.json({ error: "Unauthorized" }, 401);
        }
        await next();
    });

    app.post("/mcp", async (c) => {
        const sessionId = c.req.header("mcp-session-id");

        if (sessionId && sessions.has(sessionId)) {
            const p = sessions.get(sessionId)!.handleRequest(c.req.raw);
            inFlight.add(p as Promise<unknown>);
            try { return await p; } finally { inFlight.delete(p as Promise<unknown>); }
        }

        if (sessionId && !sessions.has(sessionId)) {
            return c.json({ error: "Unknown session" }, 404);
        }

        if (sessions.size >= maxSessions) {
            return c.json(
                {
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: `Server at session capacity (${maxSessions}); try again later.`,
                    },
                    id: null,
                },
                503,
            );
        }

        // New session — create per-session server+transport pair
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
                sessions.set(id, transport);
            },
        });
        transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const server = createMcpServer(ctx);
        await server.connect(transport);
        const p = transport.handleRequest(c.req.raw);
        inFlight.add(p as Promise<unknown>);
        try { return await p; } finally { inFlight.delete(p as Promise<unknown>); }
    });

    // SSE stream endpoint
    app.get("/mcp", async (c) => {
        const sessionId = c.req.header("mcp-session-id");
        if (sessionId && sessions.has(sessionId)) {
            return sessions.get(sessionId)!.handleRequest(c.req.raw);
        }
        return c.json({ error: "Invalid or missing session" }, 400);
    });

    // Session cleanup endpoint (per MCP spec)
    app.delete("/mcp", async (c) => {
        const sessionId = c.req.header("mcp-session-id");
        if (!sessionId || !sessions.has(sessionId)) {
            return c.json({ error: "Unknown session" }, 404);
        }
        const transport = sessions.get(sessionId)!;
        await transport.close();
        sessions.delete(sessionId);
        return c.json({ closed: true });
    });

    const httpServer = serve({ fetch: app.fetch, port, hostname: host }, () => {
        console.error(`PilotSwarm MCP server listening on http://${host}:${port}/mcp`);
    });

    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(`[pilotswarm-mcp] ${signal} received — draining ${inFlight.size} in-flight request(s), closing ${sessions.size} session(s)`);

        const drainTimeoutMs = 5_000;
        await Promise.race([
            Promise.allSettled([...inFlight]),
            new Promise((r) => setTimeout(r, drainTimeoutMs)),
        ]);

        for (const transport of sessions.values()) {
            try { await transport.close(); } catch { /* ignore */ }
        }
        sessions.clear();

        await new Promise<void>((resolve) => {
            try { httpServer.close(() => resolve()); } catch { resolve(); }
            setTimeout(() => resolve(), drainTimeoutMs).unref?.();
        });

        try { await ctx.client.stop?.(); } catch { /* ignore */ }
        try { await ctx.mgmt.stop?.(); } catch { /* ignore */ }
        try { await ctx.facts.close?.(); } catch { /* ignore */ }

        console.error(`[pilotswarm-mcp] shutdown complete`);
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
} else {
    console.error(`Unknown transport: ${values.transport}. Use "stdio" or "http".`);
    process.exit(1);
}
