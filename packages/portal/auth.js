import { createNoAuthProvider } from "./auth/providers/none.js";
import { createEntraAuthProvider } from "./auth/providers/entra.js";

const PROVIDERS = {
  none: createNoAuthProvider,
  entra: createEntraAuthProvider,
};

let cachedProvider = null;

function resolveProviderId() {
  const explicitProvider = String(process.env.PORTAL_AUTH_PROVIDER || "").trim().toLowerCase();
  if (explicitProvider) return explicitProvider;
  if (process.env.PORTAL_AUTH_ENTRA_TENANT_ID || process.env.ENTRA_TENANT_ID || process.env.PORTAL_AUTH_ENTRA_CLIENT_ID || process.env.ENTRA_CLIENT_ID) {
    return "entra";
  }
  return "none";
}

export function getAuthProvider() {
  if (cachedProvider) return cachedProvider;
  const providerId = resolveProviderId();
  const factory = PROVIDERS[providerId];
  if (!factory) {
    throw new Error(`Unsupported portal auth provider: ${providerId}`);
  }
  cachedProvider = factory();
  return cachedProvider;
}

export async function getAuthConfig(req) {
  return getAuthProvider().getPublicConfig(req);
}

export async function validateToken(token) {
  return getAuthProvider().authenticateRequest(token);
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
