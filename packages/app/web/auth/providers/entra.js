import * as jose from "jose";
import { normalizeEntraPrincipal } from "../normalize/entra.js";

const JWKS_CACHE = new Map();

function getEntraConfig(pluginAuthConfig = {}) {
    const tenantId = process.env.PORTAL_AUTH_ENTRA_TENANT_ID;
    const clientId = process.env.PORTAL_AUTH_ENTRA_CLIENT_ID;
    const displayName = String(
        pluginAuthConfig?.providers?.entra?.displayName
        || pluginAuthConfig?.displayName
        || "Entra ID",
    ).trim() || "Entra ID";
    if (!tenantId || !clientId) return null;
    return { tenantId, clientId, displayName };
}

async function ensureJwks(tenantId) {
    const cached = JWKS_CACHE.get(tenantId);
    if (cached) return cached;

    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const jwks = jose.createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
    const bundle = { issuer, jwks };
    JWKS_CACHE.set(tenantId, bundle);
    return bundle;
}

async function validateToken(token, config) {
    const { issuer, jwks } = await ensureJwks(config.tenantId);
    const { payload } = await jose.jwtVerify(token, jwks, {
        issuer,
        audience: config.clientId,
    });
    return normalizeEntraPrincipal(payload);
}

export function createEntraAuthProvider({ pluginAuthConfig } = {}) {
    const config = getEntraConfig(pluginAuthConfig);

    return {
        id: "entra",
        enabled: Boolean(config),
        displayName: config?.displayName || "Entra ID",
        async authenticateRequest(token) {
            if (!config || !token) return null;
            try {
                return await validateToken(token, config);
            } catch (error) {
                console.error("[portal-auth:entra] Token validation failed:", error?.message || String(error));
                return null;
            }
        },
        async getPublicConfig(req) {
            if (!config) {
                return {
                    enabled: false,
                    provider: "entra",
                    displayName: config?.displayName || "Entra ID",
                    client: null,
                };
            }
            const host = req?.get?.("x-forwarded-host") || req?.get?.("host") || "";
            return {
                enabled: true,
                provider: "entra",
                displayName: config.displayName,
                client: {
                    clientId: config.clientId,
                    authority: `https://login.microsoftonline.com/${config.tenantId}`,
                    redirectUri: `${req?.protocol || "https"}://${host}`,
                },
            };
        },
    };
}
