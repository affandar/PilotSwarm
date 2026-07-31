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

// Six by default — enough for the layout tests. The perf test asks for a
// realistic fleet size, where per-row cost actually shows up.
const makeSessions = (count) => Array.from({ length: count }, (_, i) => ({
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
    // Real rows carry usage, so the ctx column and the detail box render the
    // same work they do in production.
    contextUsage: { currentTokens: 20_000 + (i * 977), tokenLimit: 200_000 },
}));

// A small but deliberately awkward CSV: a quoted field containing a comma
// (must survive parsing) that needs NO quoting in TSV (only tab/newline/quote
// do), so the copy tests can prove we neither drop it nor over-quote it.
export const CSV_ARTIFACT = {
    filename: "changes.csv",
    contentType: "text/csv",
    content: [
        "commit_hash,date,summary",
        'bd57abbb,2026-06-04,"Bulk pgindent, mechanical"',
        "95b6ec52,2026-06-03,vacuumdb analyze-only",
    ].join("\n"),
};

const ARTIFACT_ENTRIES = [{
    filename: CSV_ARTIFACT.filename,
    contentType: CSV_ARTIFACT.contentType,
    sizeBytes: Buffer.byteLength(CSV_ARTIFACT.content),
    uploadedAt: "2026-06-04T00:00:00.000Z",
    source: "agent",
    isBinary: false,
}];

// A long transcript, for the resize/scroll perf tests. Alternating turns with
// enough prose per message to look like a real agent session — width-dependent
// wrapping is exactly the work being measured.
const PARA = "The CPG migration workflow renamed durably stored disk attach/detach properties. "
    + "Old state may not resume on new code, and new state may not survive rollback to old code. "
    + "Owner responded: migration overlap is rare; failures are recoverable by restarting.";

// `systemEvery`: every Nth assistant message carries an embedded [SYSTEM: …]
// notice, which makes it NON-rich-renderable — so it renders through the
// terminal line builders as a "lines" block. Those are the width-dependent
// ones, and a transcript full of them is the worst case for a resize.
const makeTranscript = (count, systemEvery = 0) => Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    eventType: i % 2 === 0 ? "user.message" : "assistant.message",
    timestamp: 1785000000000 + (i * 1000),
    data: {
        content: (systemEvery && i % systemEvery === 0)
            ? `[SYSTEM: notice ${i}] ${PARA}\n\n${PARA}`
            : i % 2 === 0
                ? `Turn ${i}: please review PR ${2160000 + i} and summarise the blocking risk.`
                : `**Assessment ${i}**\n\n${PARA}\n\n- point one\n- point two\n\n\`\`\`js\nconst x = ${i};\n\`\`\`\n\n${PARA}`,
    },
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

function rpc(method, SESSIONS) {
    switch (method) {
        case "listSessions": return { sessions: SESSIONS, hasMore: false };
        case "listModels": return [];
        case "listArtifacts": return [];
        case "getSessionEvents": return [];
        case "getCurrentUserProfile": return { ok: true, profileSettings: {} };
        default: return {};
    }
}

export function startStubServer(port = 0, { sessionCount = 6, transcriptTurns = 0, systemEvery = 0, groups = [] } = {}) {
    const SESSIONS = makeSessions(Math.max(1, sessionCount));
    const TRANSCRIPT = makeTranscript(Math.max(0, transcriptTurns), systemEvery);
    // Placement calls the drag tests assert against: [{ sessionIds, groupId }].
    const placements = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        if (pathname.startsWith("/api/")) {
            // Session groups: list them, and RECORD placement calls so a test
            // can prove a drag reached the API with the right group id.
            if (/\/management\/session-groups$/.test(pathname) && req.method === "GET") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: groups }));
                return;
            }
            if (/\/management\/session-groups\/place$/.test(pathname)) {
                let raw = "";
                req.on("data", (chunk) => { raw += chunk; });
                req.on("end", () => {
                    let parsed = {};
                    try { parsed = JSON.parse(raw || "{}"); } catch { /* record the attempt anyway */ }
                    placements.push(parsed);
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: (parsed.sessionIds || []).map((id) => ({ rootSessionId: id, placed: true, reason: null })) }));
                });
                return;
            }
            if (/\/events$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: TRANSCRIPT }));
                return;
            }
            // These routes are path-shaped, so the last-segment heuristic below
            // cannot answer them. The client unwraps `result`.
            if (/\/management\/sessions$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { sessions: SESSIONS, hasMore: false, nextCursor: null } }));
                return;
            }
            const sessionMatch = /\/sessions\/([^/]+)$/.exec(pathname);
            if (sessionMatch) {
                const found = SESSIONS.find((s) => s.sessionId === sessionMatch[1]) || SESSIONS[0];
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ...found, messages: [], events: [], pendingMessages: [] } }));
                return;
            }
            if (/\/artifacts$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: ARTIFACT_ENTRIES }));
                return;
            }
            if (/\/artifacts\/[^/]+\/text$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: CSV_ARTIFACT.content }));
                return;
            }
            if (/\/artifacts\/[^/]+\/meta$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: ARTIFACT_ENTRIES[0] }));
                return;
            }

            let body = API[pathname];
            if (body === undefined) {
                // Everything else: derive from the last path segment, which is
                // enough for the read-only surfaces these tests exercise.
                body = { ok: true, ...rpc(pathname.split("/").pop(), SESSIONS) };
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
            resolve({ server, port: server.address().port, placements });
        });
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { port } = await startStubServer(Number(process.env.PORT) || 4173);
    console.log(`stub portal on http://127.0.0.1:${port}`);
}
