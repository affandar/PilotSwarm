import * as jose from "jose";

let jwks = null;
let issuer = null;

function getEntraConfig() {
    const tenantId = process.env.PORTAL_AUTH_ENTRA_TENANT_ID || process.env.ENTRA_TENANT_ID;
    const clientId = process.env.PORTAL_AUTH_ENTRA_CLIENT_ID || process.env.ENTRA_CLIENT_ID;
    if (!tenantId || !clientId) return null;
    return { tenantId, clientId };
}

async function ensureJwks(tenantId) {
    if (jwks && issuer) return;
    issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    jwks = jose.createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
}

async function validateToken(token, config) {
    await ensureJwks(config.tenantId);
    const { payload } = await jose.jwtVerify(token, jwks, {
        issuer,
        audience: config.clientId,
    });
    return payload;
}

export function createEntraAuthProvider() {
    const config = getEntraConfig();

    return {
        id: "entra",
        enabled: Boolean(config),
        displayName: "Entra ID",
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
                    displayName: "Entra ID",
                    client: null,
                };
            }
            const host = req?.get?.("x-forwarded-host") || req?.get?.("host") || "";
            return {
                enabled: true,
                provider: "entra",
                displayName: "Entra ID",
                client: {
                    clientId: config.clientId,
                    authority: `https://login.microsoftonline.com/${config.tenantId}`,
                    redirectUri: `${req?.protocol || "https"}://${host}`,
                },
            };
        },
    };
}
