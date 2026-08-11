import * as jose from "jose";
import { normalizeProxyPrincipal } from "../normalize/proxy.js";

const JWKS_CACHE = new Map();

/**
 * Identity established by a proxy in front of the portal.
 *
 * Covers Cloudflare Access, Google IAP, AWS ALB, Pomerium, oauth2-proxy,
 * Authelia and Authentik. They differ in only two ways — which header carries
 * the identity, and whether it is signed — so both are configuration rather
 * than separate providers.
 *
 * There is no browser half. The proxy completes the sign-in before the SPA
 * loads, so the browser makes ordinary same-origin requests and PilotSwarm
 * reads the identity off each one. That is the whole reason this provider is
 * ~a tenth the size of an OIDC one: no PKCE, no token cache, no refresh.
 *
 * Two modes, with very different threat models:
 *
 *   jwt     (default) The proxy mints a signed assertion, verified here
 *           against its JWKS with issuer and audience checks. Safe no matter
 *           how the request arrived.
 *
 *   header  Plain, unsigned headers. ONLY safe when the portal is
 *           unreachable except through the proxy — otherwise anyone who can
 *           hit the origin sets the email header and becomes whoever they
 *           like. Opt-in via PORTAL_AUTH_PROXY_TRUST_HEADERS=true, and
 *           refuses to start without it.
 */
function getProxyConfig(env = process.env, pluginAuthConfig = {}) {
    const mode = (env.PORTAL_AUTH_PROXY_MODE || "jwt").trim().toLowerCase();
    const displayName = String(
        pluginAuthConfig?.providers?.proxy?.displayName || pluginAuthConfig?.displayName || "Proxy",
    ).trim() || "Proxy";

    const shared = {
        mode,
        displayName,
        subjectClaim: env.PORTAL_AUTH_PROXY_SUBJECT_CLAIM,
        emailClaim: env.PORTAL_AUTH_PROXY_EMAIL_CLAIM,
        nameClaim: env.PORTAL_AUTH_PROXY_NAME_CLAIM,
        rolesClaim: env.PORTAL_AUTH_PROXY_ROLES_CLAIM,
        groupsClaim: env.PORTAL_AUTH_PROXY_GROUPS_CLAIM,
    };

    if (mode === "header") {
        const trusted = /^(1|true|yes|on)$/i.test(String(env.PORTAL_AUTH_PROXY_TRUST_HEADERS || "").trim());
        if (!trusted) {
            throw new Error(
                "PORTAL_AUTH_PROXY_MODE=header forwards identity in UNSIGNED headers, which anyone who can reach "
                + "the origin directly can forge. Set PORTAL_AUTH_PROXY_TRUST_HEADERS=true to confirm the portal is "
                + "reachable only through the proxy, or use the default signed-assertion mode.",
            );
        }
        return {
            ...shared,
            subjectHeader: (env.PORTAL_AUTH_PROXY_SUBJECT_HEADER || "x-forwarded-user").toLowerCase(),
            emailHeader: (env.PORTAL_AUTH_PROXY_EMAIL_HEADER || "x-forwarded-email").toLowerCase(),
            nameHeader: (env.PORTAL_AUTH_PROXY_NAME_HEADER || "x-forwarded-preferred-username").toLowerCase(),
            groupsHeader: (env.PORTAL_AUTH_PROXY_GROUPS_HEADER || "x-forwarded-groups").toLowerCase(),
        };
    }

    // Default Cloudflare Access, the most common deployment.
    const jwtHeader = (env.PORTAL_AUTH_PROXY_JWT_HEADER || "cf-access-jwt-assertion").toLowerCase();
    const jwksUrl = (env.PORTAL_AUTH_PROXY_JWKS_URL || "").trim();
    const issuer = (env.PORTAL_AUTH_PROXY_ISSUER || "").trim();
    const audience = (env.PORTAL_AUTH_PROXY_AUDIENCE || "").trim();
    if (!jwksUrl || !issuer || !audience) return null;
    return { ...shared, jwtHeader, jwksUrl, issuer, audience };
}

function ensureJwks(jwksUrl) {
    const cached = JWKS_CACHE.get(jwksUrl);
    if (cached) return cached;
    const jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
    JWKS_CACHE.set(jwksUrl, jwks);
    return jwks;
}

function headerValue(req, name) {
    const raw = req?.headers?.[name];
    if (Array.isArray(raw)) return raw[0];
    return typeof raw === "string" ? raw : undefined;
}

export function createProxyAuthProvider({ pluginAuthConfig, env = process.env } = {}) {
    const config = getProxyConfig(env, pluginAuthConfig);

    return {
        id: "proxy",
        enabled: Boolean(config),
        displayName: config?.displayName || "Proxy",

        // The identity rides on the request, not on a bearer token, so the
        // pipeline must not reject the call for having no token.
        authenticatesFromRequest: true,

        async authenticateRequest(_token, req) {
            if (!config || !req) return null;

            if (config.mode === "header") {
                const subject = headerValue(req, config.subjectHeader);
                const email = headerValue(req, config.emailHeader);
                if (!subject && !email) return null;
                return normalizeProxyPrincipal({
                    sub: subject,
                    email,
                    name: headerValue(req, config.nameHeader),
                    groups: headerValue(req, config.groupsHeader),
                }, config);
            }

            const assertion = headerValue(req, config.jwtHeader);
            if (!assertion) return null;
            try {
                const { payload } = await jose.jwtVerify(assertion, ensureJwks(config.jwksUrl), {
                    issuer: config.issuer,
                    audience: config.audience,
                });
                return normalizeProxyPrincipal(payload, config);
            } catch (error) {
                console.error("[portal-auth:proxy] assertion validation failed:", error?.message || String(error));
                return null;
            }
        },

        async getPublicConfig() {
            // No client-side configuration exists to hand out: the browser
            // never talks to an identity provider, so `client` stays null and
            // the SPA simply makes ordinary requests.
            return {
                enabled: Boolean(config),
                provider: "proxy",
                displayName: config?.displayName || "Proxy",
                client: null,
            };
        },
    };
}
