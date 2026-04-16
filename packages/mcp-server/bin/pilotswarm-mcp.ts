#!/usr/bin/env node

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { createContext } from "../src/context.js";
import { createMcpServer } from "../src/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { values } = parseArgs({
    options: {
        transport: { type: "string", default: "stdio" },
        port: { type: "string", default: "3100" },
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
} else if (values.transport === "http") {
    const mcpKey = process.env.PILOTSWARM_MCP_KEY;
    if (!mcpKey) {
        console.error("Error: PILOTSWARM_MCP_KEY env var required for HTTP transport.");
        process.exit(1);
    }

    const { WebStandardStreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    const { Hono } = await import("hono");
    const { cors } = await import("hono/cors");
    const { serve } = await import("@hono/node-server");

    const port = parseInt(values.port ?? "3100", 10);
    const app = new Hono();

    // Per-session transport+server map — McpServer.connect() is one-shot
    // per the MCP SDK spec, so each client session gets its own pair.
    const sessions = new Map<string, InstanceType<typeof WebStandardStreamableHTTPServerTransport>>();

    app.use("*", cors({
        origin: "*",
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
        exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }));

    // Bearer token auth middleware
    app.use("/mcp", async (c, next) => {
        const auth = c.req.header("authorization");
        if (auth !== `Bearer ${mcpKey}`) {
            return c.json({ error: "Unauthorized" }, 401);
        }
        await next();
    });

    app.post("/mcp", async (c) => {
        const sessionId = c.req.header("mcp-session-id");

        if (sessionId && sessions.has(sessionId)) {
            return sessions.get(sessionId)!.handleRequest(c.req.raw);
        }

        if (sessionId && !sessions.has(sessionId)) {
            return c.json({ error: "Unknown session" }, 404);
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
        return transport.handleRequest(c.req.raw);
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

    serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
        console.error(`PilotSwarm MCP server listening on http://127.0.0.1:${port}/mcp`);
    });
} else {
    console.error(`Unknown transport: ${values.transport}. Use "stdio" or "http".`);
    process.exit(1);
}
