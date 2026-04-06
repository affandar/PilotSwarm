import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAuthConfig, extractToken, validateToken } from "./auth.js";
import { PortalRuntime } from "./runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_DIR = path.join(__dirname, "dist");

function getPortalMode() {
    return process.env.PORTAL_TUI_MODE || process.env.PORTAL_MODE || "local";
}

function createPortalServer({ app }) {
    const certPath = process.env.TLS_CERT_PATH;
    const keyPath = process.env.TLS_KEY_PATH;
    if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return {
            protocol: "https",
            server: https.createServer({
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath),
            }, app),
        };
    }
    return {
        protocol: "http",
        server: http.createServer(app),
    };
}

function isSafeThemeId(value) {
    return /^[\w-]+$/u.test(String(value || ""));
}

function createJsonRpcError(error, status = 500) {
    return {
        status,
        body: {
            ok: false,
            error: error?.message || String(error),
        },
    };
}

async function authenticateRequest(req, authConfig) {
    if (!authConfig) return null;
    const token = extractToken(req);
    if (!token) return null;
    return validateToken(token);
}

export async function startServer(opts = {}) {
    const { port = Number(process.env.PORT) || 3001 } = opts;
    const authConfig = getAuthConfig();
    const mode = getPortalMode();
    const runtime = new PortalRuntime({
        store: process.env.DATABASE_URL || "sqlite::memory:",
        mode,
    });

    const app = express();
    app.set("trust proxy", true);
    app.use(express.json({ limit: "1mb" }));

    const { server, protocol } = createPortalServer({ app });

    async function requireAuth(req, res, next) {
        if (!authConfig) {
            req.authClaims = null;
            next();
            return;
        }
        const claims = await authenticateRequest(req, authConfig);
        if (!claims) {
            res.status(401).json({ ok: false, error: "Unauthorized" });
            return;
        }
        req.authClaims = claims;
        next();
    }

    app.get("/api/health", async (_req, res) => {
        const started = runtime.started;
        res.json({
            ok: true,
            started,
            mode,
        });
    });

    app.get("/api/auth-config", (req, res) => {
        if (!authConfig) {
            res.json({ enabled: false });
            return;
        }
        const host = req.get("x-forwarded-host") || req.get("host");
        res.json({
            enabled: true,
            clientId: authConfig.clientId,
            authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
            redirectUri: `${req.protocol}://${host}`,
        });
    });

    app.get("/api/bootstrap", requireAuth, async (_req, res) => {
        try {
            const bootstrap = await runtime.getBootstrap();
            res.json({ ok: true, ...bootstrap });
        } catch (error) {
            const payload = createJsonRpcError(error, 500);
            res.status(payload.status).json(payload.body);
        }
    });

    app.post("/api/rpc", requireAuth, async (req, res) => {
        const method = String(req.body?.method || "").trim();
        if (!method) {
            res.status(400).json({ ok: false, error: "RPC method is required" });
            return;
        }
        try {
            const result = await runtime.call(method, req.body?.params || {});
            res.json({ ok: true, result });
        } catch (error) {
            const status = /Unsupported portal RPC method/i.test(String(error?.message || ""))
                ? 400
                : 500;
            const payload = createJsonRpcError(error, status);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/sessions/:sessionId/artifacts/:filename/download", requireAuth, async (req, res) => {
        try {
            const sessionId = req.params.sessionId;
            const filename = req.params.filename;
            const content = await runtime.downloadArtifact(sessionId, filename);
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.setHeader("content-disposition", `attachment; filename="${path.basename(filename)}"`);
            res.send(content);
        } catch (error) {
            const payload = createJsonRpcError(error, 404);
            res.status(payload.status).json(payload.body);
        }
    });

    if (fs.existsSync(DIST_DIR)) {
        app.use(express.static(DIST_DIR));
        app.get(/^\/(?!api\/).*/, (_req, res) => {
            res.sendFile(path.join(DIST_DIR, "index.html"));
        });
    }

    const wss = new WebSocketServer({ server, path: "/portal-ws" });
    wss.on("connection", async (ws, req) => {
        if (authConfig) {
            const token = extractToken(req);
            if (!token) {
                ws.close(4401, "Unauthorized");
                return;
            }
            const claims = await validateToken(token);
            if (!claims) {
                ws.close(4401, "Unauthorized");
                return;
            }
        }

        const sessionSubscriptions = new Map();
        let logUnsubscribe = null;

        const send = (message) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(message));
            }
        };

        send({ type: "ready" });

        ws.on("message", async (raw) => {
            let message;
            try {
                message = JSON.parse(String(raw));
            } catch {
                return;
            }

            const type = String(message?.type || "");
            if (type === "subscribeSession") {
                const sessionId = String(message?.sessionId || "").trim();
                if (!sessionId || sessionSubscriptions.has(sessionId)) return;
                try {
                    await runtime.start();
                    const unsubscribe = runtime.subscribeSession(sessionId, (event) => {
                        send({ type: "sessionEvent", sessionId, event });
                    });
                    sessionSubscriptions.set(sessionId, unsubscribe);
                    send({ type: "subscribedSession", sessionId });
                } catch (error) {
                    send({ type: "error", scope: "session", sessionId, error: error?.message || String(error) });
                }
                return;
            }

            if (type === "unsubscribeSession") {
                const sessionId = String(message?.sessionId || "").trim();
                const unsubscribe = sessionSubscriptions.get(sessionId);
                if (unsubscribe) {
                    unsubscribe();
                    sessionSubscriptions.delete(sessionId);
                }
                return;
            }

            if (type === "subscribeLogs") {
                if (logUnsubscribe) return;
                try {
                    await runtime.start();
                    logUnsubscribe = runtime.startLogTail((entry) => {
                        send({ type: "logEntry", entry });
                    });
                    send({ type: "subscribedLogs" });
                } catch (error) {
                    send({ type: "error", scope: "logs", error: error?.message || String(error) });
                }
                return;
            }

            if (type === "unsubscribeLogs") {
                if (logUnsubscribe) {
                    logUnsubscribe();
                    logUnsubscribe = null;
                }
                return;
            }

            if (type === "theme" && isSafeThemeId(message?.themeId)) {
                send({ type: "themeAck", themeId: message.themeId });
            }
        });

        ws.on("close", () => {
            for (const unsubscribe of sessionSubscriptions.values()) {
                try {
                    unsubscribe();
                } catch {}
            }
            sessionSubscriptions.clear();
            if (logUnsubscribe) {
                try {
                    logUnsubscribe();
                } catch {}
                logUnsubscribe = null;
            }
        });
    });

    async function shutdown() {
        for (const client of wss.clients) {
            try {
                client.close();
            } catch {}
        }
        await runtime.stop().catch(() => {});
        server.close();
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
            server.off("error", reject);
            resolve();
        });
    });
    console.log(`[portal] PilotSwarm Web at ${protocol}://localhost:${port}`);

    return server;
}

if (process.argv[1]?.endsWith("server.js") || import.meta.url === `file://${process.argv[1]}`) {
    startServer().catch((error) => {
        console.error("[portal] Failed to start:", error);
        process.exitCode = 1;
    });
}
