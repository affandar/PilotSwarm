import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPortalAssetFile, getPortalConfig } from "./config.js";
import { authenticateRequest, extractToken, getAuthConfig, authenticateToken } from "./auth.js";
import { getPublicAuthContext } from "./auth/authz/engine.js";
import { PortalRuntime } from "./runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");

function getPortalMode() {
    const explicitMode = process.env.PORTAL_TUI_MODE || process.env.PORTAL_MODE;
    if (explicitMode) return explicitMode;
    return process.env.KUBERNETES_SERVICE_HOST ? "remote" : "local";
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

export async function startServer(opts = {}) {
    const { port = Number(process.env.PORT) || 3001 } = opts;
    const portalConfig = getPortalConfig();
    const mode = getPortalMode();
    const runtime = new PortalRuntime({
        store: process.env.DATABASE_URL || "sqlite::memory:",
        mode,
    });

    const app = express();
    app.set("trust proxy", true);
    app.use(express.json({ limit: "2mb" }));

    const { server, protocol } = createPortalServer({ app });

    async function requireAuth(req, res, next) {
        const auth = await authenticateRequest(req);
        if (!auth.ok) {
            res.status(auth.status).json({ ok: false, error: auth.error || (auth.status === 403 ? "Forbidden" : "Unauthorized") });
            return;
        }
        req.auth = auth;
        req.authClaims = auth.principal?.rawClaims || null;
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

    app.get("/api/portal-config", async (req, res) => {
        try {
            const auth = await getAuthConfig(req);
            res.json({
                ok: true,
                portal: portalConfig,
                auth,
            });
        } catch (error) {
            const payload = createJsonRpcError(error, 500);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/auth-config", async (req, res) => {
        try {
            const auth = await getAuthConfig(req);
            res.json(auth);
        } catch (error) {
            const payload = createJsonRpcError(error, 500);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/auth/me", requireAuth, async (req, res) => {
        res.json({
            ok: true,
            ...getPublicAuthContext(req.auth),
        });
    });

    app.get("/api/bootstrap", requireAuth, async (_req, res) => {
        try {
            const bootstrap = await runtime.getBootstrap();
            res.json({
                ok: true,
                ...bootstrap,
                auth: getPublicAuthContext(_req.auth),
            });
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

    app.get("/api/portal-assets/:assetName", async (req, res) => {
        const assetFile = getPortalAssetFile(req.params.assetName);
        if (!assetFile || !fs.existsSync(assetFile)) {
            res.status(404).end();
            return;
        }
        res.sendFile(assetFile, {
            maxAge: "1h",
        });
    });

    if (fs.existsSync(DIST_DIR)) {
        app.use(express.static(DIST_DIR));
        app.get(/^\/(?!api\/).*/, (_req, res) => {
            res.sendFile(path.join(DIST_DIR, "index.html"));
        });
    }

    const wss = new WebSocketServer({ server, path: "/portal-ws" });
    wss.on("connection", async (ws, req) => {
        const auth = await authenticateToken(extractToken(req), req);
        if (!auth.ok) {
            ws.close(auth.status === 403 ? 4403 : 4401, auth.error || (auth.status === 403 ? "Forbidden" : "Unauthorized"));
            return;
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
