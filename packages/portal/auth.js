/**
 * Entra ID token validation for the portal.
 *
 * Uses OIDC discovery + JWKS to validate access tokens server-side.
 * No client secrets needed — the SPA is a public client (PKCE).
 */

import * as jose from "jose";

let _jwks = null;
let _issuer = null;

/**
 * Read auth config from environment.
 * Returns null if auth is not configured (ENTRA_TENANT_ID / ENTRA_CLIENT_ID missing).
 */
export function getAuthConfig() {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  if (!tenantId || !clientId) return null;
  return { tenantId, clientId };
}

/** Initialize JWKS remote key set from Entra OIDC discovery. */
async function ensureJwks(tenantId) {
  if (_jwks) return;
  const issuerUrl = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const jwksUri = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  _jwks = jose.createRemoteJWKSet(new URL(jwksUri));
  _issuer = issuerUrl;
}

/**
 * Validate a Bearer token.
 * Returns the decoded payload on success, or null on failure.
 */
export async function validateToken(token) {
  const config = getAuthConfig();
  if (!config) return null;

  try {
    await ensureJwks(config.tenantId);
    const { payload } = await jose.jwtVerify(token, _jwks, {
      issuer: _issuer,
      audience: config.clientId,
    });
    return payload;
  } catch (err) {
    console.error("[auth] Token validation failed:", err.message);
    return null;
  }
}

/**
 * Extract Bearer token from various sources.
 * Checks: Authorization header, then sec-websocket-protocol header.
 */
export function extractToken(req) {
  // Standard Authorization: Bearer <token>
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // WebSocket sub-protocol: "access_token, <token>"
  const protocols = req.headers["sec-websocket-protocol"];
  if (protocols) {
    const parts = protocols.split(",").map((s) => s.trim());
    const tokenIndex = parts.indexOf("access_token");
    if (tokenIndex >= 0 && parts[tokenIndex + 1]) {
      return parts[tokenIndex + 1];
    }
  }

  return null;
}
