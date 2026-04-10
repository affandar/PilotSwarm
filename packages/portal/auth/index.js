import { createNoAuthProvider } from "./providers/none.js";
import { createEntraAuthProvider } from "./providers/entra.js";
import { authorizePrincipal } from "./authz/engine.js";
import { loadAuthorizationPolicy, resolveAuthProviderId, resolvePluginAuthConfigFromPluginDirs } from "./config.js";

const PROVIDERS = {
    none: createNoAuthProvider,
    entra: createEntraAuthProvider,
};

let cachedBundle = null;

function getProviderBundle() {
    if (cachedBundle) return cachedBundle;

    const pluginAuthConfig = resolvePluginAuthConfigFromPluginDirs();
    const providerId = resolveAuthProviderId({ pluginAuthConfig });
    const factory = PROVIDERS[providerId];
    if (!factory) {
        throw new Error(`Unsupported portal auth provider: ${providerId}`);
    }

    cachedBundle = {
        providerId,
        pluginAuthConfig,
        provider: factory({ pluginAuthConfig }),
        policy: loadAuthorizationPolicy({ providerId }),
    };
    return cachedBundle;
}

function buildDeniedResult({ status, error, principal = null, authorization = null }) {
    return {
        ok: false,
        status,
        error,
        principal,
        authorization,
    };
}

export function getAuthProvider() {
    return getProviderBundle().provider;
}

export function getAuthorizationPolicy() {
    return getProviderBundle().policy;
}

export function getResolvedAuthProviderId() {
    return getProviderBundle().providerId;
}

export async function getAuthConfig(req) {
    return getAuthProvider().getPublicConfig(req);
}

export async function validateToken(token, req) {
    return getAuthProvider().authenticateRequest(token, req);
}

export async function authenticateToken(token, req) {
    const provider = getAuthProvider();
    const policy = getAuthorizationPolicy();

    if (provider.enabled) {
        if (!token) {
            return buildDeniedResult({
                status: 401,
                error: "Unauthorized",
                authorization: {
                    allowed: false,
                    role: null,
                    reason: "Authentication required",
                    matchedGroups: [],
                },
            });
        }

        const principal = await validateToken(token, req);
        if (!principal) {
            return buildDeniedResult({
                status: 401,
                error: "Unauthorized",
                authorization: {
                    allowed: false,
                    role: null,
                    reason: "Token validation failed",
                    matchedGroups: [],
                },
            });
        }

        const authorization = authorizePrincipal(principal, policy);
        if (!authorization.allowed) {
            return buildDeniedResult({
                status: 403,
                error: authorization.reason || "Forbidden",
                principal,
                authorization,
            });
        }

        return {
            ok: true,
            status: 200,
            principal,
            authorization,
        };
    }

    const authorization = authorizePrincipal(null, policy);
    if (!authorization.allowed) {
        return buildDeniedResult({
            status: 401,
            error: authorization.reason || "Unauthorized",
            authorization,
        });
    }

    return {
        ok: true,
        status: 200,
        principal: null,
        authorization,
    };
}

export async function authenticateRequest(req) {
    return authenticateToken(extractToken(req), req);
}

/**
 * Extract Bearer token from various sources.
 * Checks: Authorization header, then sec-websocket-protocol header.
 */
export function extractToken(req) {
    const authHeader = req.headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice(7);
    }

    const protocols = req.headers["sec-websocket-protocol"];
    if (protocols) {
        const parts = protocols.split(",").map((segment) => segment.trim());
        const tokenIndex = parts.indexOf("access_token");
        if (tokenIndex >= 0 && parts[tokenIndex + 1]) {
            return parts[tokenIndex + 1];
        }
    }

    return null;
}
