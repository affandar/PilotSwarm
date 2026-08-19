import type { NextFunction, Request, RequestHandler, Response } from "express";
import { buildWwwAuthenticate } from "pilotswarm-sdk/mcp-auth-discovery";
import { runWithBearer } from "./bearer.js";
import { decodeClaims, isInteractive } from "./jwt.js";

/**
 * Auth policy for the proxy. The proxy advertises a resource identity (the
 * upstream audience) and forwards the caller's delegated bearer; it holds no
 * credentials of its own.
 */
export interface AuthOptions {
    /** Upstream resource audience, e.g. `https://kusto.kusto.windows.net`. */
    resourceId: string;
    /** Upstream scope the caller must acquire, e.g. `${resourceId}/.default`. */
    scope: string;
    /** When true, allow app-only (non-interactive) tokens through the gate. */
    allowAppTokens: boolean;
}

/**
 * Build the `WWW-Authenticate` challenge. Critically this advertises the
 * audience INLINE via `resource_id` + `scope` and emits NO `resource_metadata`:
 * an in-cluster plain-HTTP Service cannot host an https PRM document, and the
 * worker's discovery refuses a non-https PRM fetch (SSRF guard). Inline
 * advertisement lets the worker learn the audience without any fetch.
 */
export function challenge(opts: AuthOptions, error?: string, errorDescription?: string): string {
    return buildWwwAuthenticate({
        resourceId: opts.resourceId,
        scope: opts.scope,
        error,
        errorDescription,
    });
}

function bearerFromHeader(req: Request): string | undefined {
    const h = req.headers["authorization"];
    if (typeof h !== "string") return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : undefined;
}

/**
 * Express middleware enforcing the phase-1 gate:
 *   - a caller bearer must be present (else 401 + challenge)
 *   - the bearer must be interactive/delegated unless app tokens are allowed
 *     (else 403 interactive_credential_required)
 * On success the caller bearer is bound into AsyncLocalStorage for the
 * downstream MCP tool handler to forward upstream.
 */
export function makeAuthMiddleware(opts: AuthOptions): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const bearer = bearerFromHeader(req);
        if (!bearer) {
            res
                .status(401)
                .set("WWW-Authenticate", challenge(opts))
                .json({ error: "unauthorized", error_description: "missing bearer token" });
            return;
        }

        if (!opts.allowAppTokens) {
            const claims = decodeClaims(bearer);
            if (!isInteractive(claims)) {
                res.status(403).json({
                    error: "interactive_credential_required",
                    error_description:
                        "this proxy forwards a delegated user credential; app-only tokens are not accepted",
                });
                return;
            }
        }

        runWithBearer(bearer, () => next());
    };
}

/**
 * GET /.well-known/oauth-protected-resource handler. Provided for RFC 9728
 * completeness / debugging; the worker learns the audience from the inline
 * challenge, not this document.
 */
export function makePrmHandler(opts: AuthOptions): RequestHandler {
    return (_req: Request, res: Response): void => {
        res.json({
            resource: opts.resourceId,
            authorization_servers: [],
            scopes_supported: [opts.scope],
            bearer_methods_supported: ["header"],
        });
    };
}
