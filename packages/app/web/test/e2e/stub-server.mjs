// Hermetic portal server for the layout/theme tests.
//
// Serves the built browser app from packages/app/web/dist and answers every
// /api/* route from fixtures. No database, no worker, no LLM, no auth — so
// these tests run in seconds and can gate every portal change, which the
// LLM-backed test/local suite cannot.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../../dist");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

const SESSIONS = Array.from({ length: 6 }, (_, i) => ({
    sessionId: `1111111${i}-2222-3333-4444-55555555555${i}`,
    title: i === 0
        // A deliberately long title: the pane header must ellipsize it rather
        // than wrap, because the header is a fixed height.
        ? "A deliberately very long session title that must ellipsize rather than wrap the header"
        : `Session ${i}`,
    status: i % 2 ? "idle" : "running",
    model: "github-copilot:claude-sonnet-5",
    agentId: null,
    isSystem: false,
    parentSessionId: null,
    createdAt: 1785000000000,
    updatedAt: 1785000000000 + i,
}));

const API = {
    "/api/health": { ok: true, started: true, mode: "remote" },
    "/api/auth-config": { enabled: false, provider: "none", displayName: "No auth", client: null },
    "/api/auth/me": {
        ok: true,
        principal: { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User", groups: [], roles: ["admin"] },
        authorization: { allowed: true, role: "admin", reason: "Authentication disabled", matchedGroups: [] },
    },
    "/api/portal-config": { ok: true, portal: { branding: { title: "PilotSwarm", pageTitle: "PilotSwarm" } } },
    "/api/bootstrap": {
        ok: true,
        mode: "remote",
        workerCount: 1,
        defaultModel: "github-copilot:claude-sonnet-5",
        modelsByProvider: [],
        logConfig: { available: false, availabilityReason: "test" },
        auth: { principal: { displayName: "Test User", email: "test@example.com" } },
    },
};

function rpc(method) {
    switch (method) {
        case "listSessions": return { sessions: SESSIONS, hasMore: false };
        case "listModels": return [];
        case "listArtifacts": return [];
        case "getSessionEvents": return [];
        case "getCurrentUserProfile": return { ok: true, profileSettings: {} };
        default: return {};
    }
}

export function startStubServer(port = 0) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        if (pathname.startsWith("/api/")) {
            let body = API[pathname];
            if (body === undefined) {
                // Everything else: derive from the last path segment, which is
                // enough for the read-only surfaces these tests exercise.
                body = { ok: true, ...rpc(pathname.split("/").pop()) };
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
            return;
        }

        const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
        const file = path.join(DIST, rel);
        if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            // SPA fallback.
            res.writeHead(200, { "content-type": MIME[".html"] });
            res.end(fs.readFileSync(path.join(DIST, "index.html")));
            return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(fs.readFileSync(file));
    });

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
            resolve({ server, port: server.address().port });
        });
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { port } = await startStubServer(Number(process.env.PORT) || 4173);
    console.log(`stub portal on http://127.0.0.1:${port}`);
}
