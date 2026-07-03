import express from "express";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_PATH } from "pilotswarm-sdk/api";
import { getPortalAssetFile, getPortalConfig } from "./config.js";
import { authenticateRequest, getAuthConfig } from "./auth.js";
import { getPublicAuthContext } from "./auth/authz/engine.js";
import { PortalRuntime } from "./runtime.js";
import { createApiRouter } from "./api/router.js";
import { attachWebSockets } from "./api/ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const DIST_ASSETS_DIR = path.join(DIST_DIR, "assets");

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

function createJsonRpcError(error, status = 500) {
    return {
        status,
        body: {
            ok: false,
            error: error?.message || String(error),
        },
    };
}

function sendSpaIndex(res) {
    res.set("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(DIST_DIR, "index.html"));
}

export async function startServer(opts = {}) {
    const { port = Number(process.env.PORT) || 3001, workers } = opts;
    if (Number.isFinite(workers) && !process.env.WORKERS) {
        process.env.WORKERS = String(workers);
    }

    // Strip "__PS_UNSET__" sentinels written by deploy seed-secrets and
    // by the portal-config render path so optional env vars (like
    // ANTHROPIC_API_KEY or AZURE_OAI_KEY) appear unset to downstream code.
    // Mirrors the worker's behavior in packages/sdk/examples/worker.js.
    const SEED_SECRETS_UNSET_SENTINEL = "__PS_UNSET__";
    for (const [k, v] of Object.entries(process.env)) {
        if (v === SEED_SECRETS_UNSET_SENTINEL) delete process.env[k];
    }

    const portalConfig = getPortalConfig();
    const mode = getPortalMode();
    const useManagedIdentity = ["1", "true", "yes", "on"].includes(
        String(process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").toLowerCase(),
    );
    const runtime = new PortalRuntime({
        store: process.env.DATABASE_URL || "sqlite::memory:",
        mode,
        useManagedIdentity,
        cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
        aadDbUser: process.env.PILOTSWARM_DB_AAD_USER || undefined,
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

    // The versioned Web API (the supported product surface). The legacy
    // /api/rpc + /portal-ws routes below stay mounted through the same
    // dispatcher during the deprecation window.
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));

    app.post("/api/rpc", requireAuth, async (req, res) => {
        const method = String(req.body?.method || "").trim();
        if (!method) {
            res.status(400).json({ ok: false, error: "RPC method is required" });
            return;
        }
        try {
            const result = await runtime.call(method, req.body?.params || {}, req.auth);
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
            const artifact = await runtime.downloadArtifactBinary(sessionId, filename);
            const contentType = String(artifact?.contentType || "application/octet-stream");
            res.setHeader("content-type", contentType);
            res.setHeader("content-disposition", `attachment; filename="${path.basename(filename)}"`);
            res.send(artifact.body);
        } catch (error) {
            const payload = createJsonRpcError(error, 404);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/sessions/:sessionId/artifacts/:filename/meta", requireAuth, async (req, res) => {
        try {
            const sessionId = req.params.sessionId;
            const filename = req.params.filename;
            const metadata = await runtime.getArtifactMetadata(sessionId, filename);
            if (!metadata) {
                res.status(404).json({ ok: false, error: "Artifact not found" });
                return;
            }
            res.json({ ok: true, ...metadata });
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
        app.use("/assets", express.static(DIST_ASSETS_DIR, {
            immutable: true,
            maxAge: "1y",
            fallthrough: true,
        }));
        app.use("/assets", (_req, res) => {
            res.status(404).type("text/plain").send("Asset not found");
        });
        app.use(express.static(DIST_DIR, { index: false }));
        app.get(/^\/(?!api\/).*/, (_req, res) => {
            sendSpaIndex(res);
        });
    }

    const socketServers = attachWebSockets(server, runtime, [
        { path: "/portal-ws", allowThemeMessages: true },
        { path: WS_PATH },
    ]);

    async function shutdown() {
        for (const socketServer of socketServers) {
            for (const client of socketServer.clients) {
                try {
                    client.close();
                } catch {}
            }
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

    // Test/embedder handle: stops the runtime and closes the server.
    server.stopPortal = shutdown;
    return server;
}

if (process.argv[1]?.endsWith("server.js") || import.meta.url === `file://${process.argv[1]}`) {
    startServer().catch((error) => {
        console.error("[portal] Failed to start:", error);
        process.exitCode = 1;
    });
}
