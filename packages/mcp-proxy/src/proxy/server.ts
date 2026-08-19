import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request, type Response } from "express";
import type { AuthOptions } from "./auth.js";
import { makeAuthMiddleware, makePrmHandler } from "./auth.js";

export interface ServerInfo {
    name: string;
    version: string;
    /** Optional model-facing usage guidance handed to the client at initialize. */
    instructions?: string;
}

export interface BuildProxyAppOptions {
    /** Auth policy: advertised resource identity + interactive-token gate. */
    auth: AuthOptions;
    /** MCP server identity. */
    serverInfo: ServerInfo;
    /**
     * Registers the upstream adapter's tools onto a freshly-created McpServer.
     * Called once per request (the transport is stateless), so it must be cheap
     * and side-effect free beyond tool registration.
     */
    registerTools: (server: McpServer) => void;
}

/**
 * Build the generic proxy express app. It is a pure bearer-forwarder:
 *   - GET /healthz .......................... liveness (public)
 *   - GET /.well-known/oauth-protected-resource  PRM (public, RFC 9728)
 *   - auth middleware ....................... 401 challenge / 403 gate, binds bearer
 *   - POST /mcp ............................. stateless MCP (fresh server+transport)
 *   - GET|DELETE /mcp ....................... 405 (no server-initiated streams)
 *
 * The MCP transport is stateless (`sessionIdGenerator: undefined`,
 * `enableJsonResponse: true`) — one McpServer + transport per POST, torn down on
 * response close. This matches the Python proxy's stateless JSON mode.
 */
export function buildProxyApp(opts: BuildProxyAppOptions): Express {
    const app = express();
    app.use(express.json({ limit: "4mb" }));

    // Public probes — registered before the auth middleware so they never
    // require a bearer.
    app.get("/healthz", (_req: Request, res: Response) => {
        res.json({ status: "ok", server: opts.serverInfo.name });
    });
    app.get("/.well-known/oauth-protected-resource", makePrmHandler(opts.auth));

    // Everything past here requires a caller bearer.
    app.use(makeAuthMiddleware(opts.auth));

    app.post("/mcp", async (req: Request, res: Response) => {
        const server = new McpServer(
            { name: opts.serverInfo.name, version: opts.serverInfo.version },
            opts.serverInfo.instructions
                ? { capabilities: { tools: {} }, instructions: opts.serverInfo.instructions }
                : { capabilities: { tools: {} } },
        );
        opts.registerTools(server);

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        res.on("close", () => {
            void transport.close();
            void server.close();
        });

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: String(err) },
                    id: null,
                });
            }
        }
    });

    // Stateless: no server-initiated SSE stream, nothing to resume or delete.
    const methodNotAllowed = (_req: Request, res: Response) => {
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method Not Allowed" },
            id: null,
        });
    };
    app.get("/mcp", methodNotAllowed);
    app.delete("/mcp", methodNotAllowed);

    return app;
}
