import express from "express";
import path from "node:path";
import { API_VERSION, OPERATIONS, coerceQueryValue } from "pilotswarm-sdk/api";
import { getAuthConfig } from "../auth.js";
import { getPublicAuthContext } from "../auth/authz/engine.js";

/**
 * The versioned Web API router (`/api/v1`).
 *
 * Every JSON operation is generated from the pilotswarm-sdk/api
 * operations table and delegates to `runtime.call(name, params, req.auth)` —
 * the same dispatcher the legacy `/api/rpc` uses, so the two surfaces cannot
 * drift. Only health/auth/bootstrap and the binary artifact download are
 * hand-written routes.
 *
 * Error envelope: `{ ok: false, error: { code, message } }`.
 */

const ERROR_STATUS_BY_CODE = {
    INVALID_REQUEST: 400,
    PORTAL_AUTH_REQUIRED: 401,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    // Capability mismatches: the deployment's store doesn't support the op.
    FACTS_ENHANCED_UNSUPPORTED: 409,
    GRAPH_UNSUPPORTED: 409,
    PAYLOAD_TOO_LARGE: 413,
};

// Domain/lifecycle errors the runtime throws with actionable, non-sensitive
// messages. These are client errors (their message is the whole value), so
// they keep their text; everything else that reaches 500 is treated as an
// unexpected fault and gets a generic message.
const CLIENT_ERROR_MESSAGE = /must be|is required|cannot be|Unsupported|is not started|terminal orchestration|cannot accept new messages|not found|already|Unknown model|does not support reasoning effort/i;

function statusForError(error) {
    const byCode = ERROR_STATUS_BY_CODE[error?.code];
    if (byCode) return byCode;
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
    const message = String(error?.message || "");
    if (/is not started|terminal orchestration|cannot accept new messages|already/i.test(message)) return 409;
    if (CLIENT_ERROR_MESSAGE.test(message)) return 400;
    return 500;
}

function sendError(res, error, fallbackStatus) {
    const status = fallbackStatus || statusForError(error);
    const code = error?.code || (status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_REQUEST" : status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL_ERROR");
    // 500s are unexpected server faults; their raw messages can leak
    // connection strings, file paths, or stack detail. Send a generic
    // message and keep the code for correlation. Client-facing errors
    // (4xx: validation, not-found, auth, lifecycle conflicts) keep their
    // message because it is actionable and non-sensitive.
    const message = status >= 500 ? "Internal server error" : (error?.message || String(error));
    res.status(status).json({ ok: false, error: { code, message } });
}

// Session/child id path params must look like ids — never a path fragment.
// This is the trust boundary for the filesystem artifact store, which builds
// paths from these values; anything with a separator or ".." is rejected here
// before it can reach a sink. (Group ids are validated the same way.)
const ID_PARAM_KEYS = new Set(["sessionId", "parentSessionId", "childSessionId", "agentIdOrSessionId", "groupId"]);
const SAFE_ID = /^[\w:.-]{1,200}$/;

function assertSafeIdParams(op, params) {
    for (const key of Object.keys(op.params || {})) {
        if (!ID_PARAM_KEYS.has(key)) continue;
        const value = params[key];
        if (value == null) continue;
        if (!SAFE_ID.test(String(value)) || String(value).includes("..")) {
            throw Object.assign(new Error(`Invalid ${key}`), { code: "INVALID_REQUEST" });
        }
    }
}

// A caller is privileged (admin) when the validated token carries the admin
// role, OR the deployment is no-auth (role "anonymous" — no-auth means a
// trusted/private deployment with full access, consistent with the rest of
// the API's binary admission model).
function isAdminAuth(auth) {
    const role = auth?.authorization?.role;
    return role === "admin" || role === "anonymous";
}

function collectParams(op, req) {
    const params = {};
    for (const [key, spec] of Object.entries(op.params || {})) {
        if (spec.in === "path") {
            params[key] = req.params[spec.name || key];
        } else if (spec.in === "query") {
            const value = coerceQueryValue(req.query[key], spec.type);
            if (value !== undefined) params[key] = value;
        } else if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
            params[key] = req.body[key];
        }
    }
    return params;
}

export function createApiRouter({ runtime, requireAuth }) {
    const router = express.Router();

    // ── Public routes ───────────────────────────────────────────────────
    router.get("/health", (_req, res) => {
        res.json({ ok: true, started: runtime.started, mode: runtime.mode, apiVersion: API_VERSION });
    });

    router.get("/auth/config", async (req, res) => {
        try {
            res.json(await getAuthConfig(req));
        } catch (error) {
            sendError(res, error);
        }
    });

    // ── Authenticated routes ────────────────────────────────────────────
    router.use(requireAuth);

    router.get("/auth/me", (req, res) => {
        res.json({ ok: true, ...getPublicAuthContext(req.auth) });
    });

    router.get("/bootstrap", async (req, res) => {
        try {
            const bootstrap = await runtime.getBootstrap();
            res.json({ ok: true, ...bootstrap, apiVersion: API_VERSION, auth: getPublicAuthContext(req.auth) });
        } catch (error) {
            sendError(res, error);
        }
    });

    // Binary artifact download (streams; not part of the JSON envelope).
    router.get("/sessions/:sessionId/artifacts/:filename/download", async (req, res) => {
        if (!SAFE_ID.test(String(req.params.sessionId)) || String(req.params.sessionId).includes("..")) {
            sendError(res, Object.assign(new Error("Invalid sessionId"), { code: "INVALID_REQUEST" }), 400);
            return;
        }
        try {
            const artifact = await runtime.downloadArtifactBinary(req.params.sessionId, req.params.filename, req.auth);
            res.setHeader("content-type", String(artifact?.contentType || "application/octet-stream"));
            res.setHeader("content-disposition", `attachment; filename="${path.basename(req.params.filename)}"`);
            res.send(artifact.body);
        } catch (error) {
            sendError(res, error, error?.code === "FORBIDDEN" ? 403 : 404);
        }
    });

    // ── Generated operation routes ──────────────────────────────────────
    for (const op of OPERATIONS) {
        const expressPath = op.path.replace(/:([\w]+)/g, ":$1");
        router[op.method.toLowerCase()](expressPath, async (req, res) => {
            try {
                // Tier-2 operational ops require the admin role — a hard gate
                // regardless of the ownership dark-launch flag. Finer-grained
                // ownership/visibility classes (op.access) are enforced inside
                // runtime.call(), the shared dispatch chokepoint.
                if ((op.admin || op.access === "fleet:admin") && !isAdminAuth(req.auth)) {
                    sendError(res, Object.assign(new Error("This operation requires the admin role."), { code: "FORBIDDEN" }), 403);
                    return;
                }
                const params = collectParams(op, req);
                assertSafeIdParams(op, params);
                const result = await runtime.call(op.name, params, req.auth);
                res.json({ ok: true, result: result === undefined ? null : result });
            } catch (error) {
                sendError(res, error);
            }
        });
    }

    // ── Envelope 404 for unknown API paths ──────────────────────────────
    router.use((req, res) => {
        res.status(404).json({
            ok: false,
            error: { code: "NOT_FOUND", message: `Unknown API route: ${req.method} ${req.baseUrl}${req.path}` },
        });
    });

    // ── Error middleware: body-parser failures (oversized/malformed JSON)
    // reach here as thrown errors rather than route rejections; map them to
    // the same envelope instead of Express's default HTML error page.
    router.use((error, _req, res, _next) => {
        if (res.headersSent) return;
        if (error?.type === "entity.too.large") {
            sendError(res, Object.assign(new Error("Request body too large"), { code: "PAYLOAD_TOO_LARGE" }), 413);
            return;
        }
        if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
            sendError(res, Object.assign(new Error("Malformed JSON body"), { code: "INVALID_REQUEST" }), 400);
            return;
        }
        sendError(res, error);
    });

    return router;
}
