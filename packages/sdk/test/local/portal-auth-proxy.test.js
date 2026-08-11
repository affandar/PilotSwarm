/**
 * Proxy auth provider — identity established by an identity-aware proxy in
 * front of the portal (Cloudflare Access, Google IAP, AWS ALB, Pomerium,
 * oauth2-proxy, Authelia, Authentik).
 *
 * Exercises the provider directly rather than through a server: every
 * behaviour worth pinning is in claim/header handling and in the refusal to
 * trust unsigned headers by default, none of which needs a store or a socket.
 *
 * The signed-assertion path uses a locally generated keypair and an in-process
 * JWKS, so there is no network dependency.
 *
 * Run: npx vitest run test/local/portal-auth-proxy.test.js
 */

import { describe, it, beforeAll } from "vitest";
import * as jose from "jose";
import { createProxyAuthProvider } from "../../../app/web/auth/providers/proxy.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const ISSUER = "https://grimfanda.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";

let privateKey;
let jwksJson;

function reqWith(headers) {
    return { headers };
}

/** Provider configured for the signed-assertion path, JWKS served from a data: URL. */
function jwtProvider(extra = {}) {
    return createProxyAuthProvider({
        env: {
            PORTAL_AUTH_PROXY_MODE: "jwt",
            PORTAL_AUTH_PROXY_JWT_HEADER: "cf-access-jwt-assertion",
            PORTAL_AUTH_PROXY_JWKS_URL: `data:application/json;base64,${Buffer.from(jwksJson).toString("base64")}`,
            PORTAL_AUTH_PROXY_ISSUER: ISSUER,
            PORTAL_AUTH_PROXY_AUDIENCE: AUDIENCE,
            ...extra,
        },
    });
}

async function mintAssertion(claims, { issuer = ISSUER, audience = AUDIENCE } = {}) {
    return new jose.SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("5m")
        .sign(privateKey);
}

describe("portal proxy auth provider", () => {
    beforeAll(async () => {
        const { publicKey, privateKey: pk } = await jose.generateKeyPair("RS256", { extractable: true });
        privateKey = pk;
        const jwk = await jose.exportJWK(publicKey);
        jwk.kid = "test-key";
        jwk.alg = "RS256";
        jwksJson = JSON.stringify({ keys: [jwk] });
    });

    it("accepts a signed assertion and normalizes the principal", async () => {
        const provider = jwtProvider();
        assert(provider.enabled, "provider should be enabled when jwks/issuer/audience are set");

        const token = await mintAssertion({
            sub: "cf-subject-1",
            email: "manny@grimfanda.com",
            name: "Manny Calavera",
        });
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": token }));

        assert(principal, "a valid assertion should produce a principal");
        assertEqual(principal.provider, "proxy", "provider tag");
        assertEqual(principal.subject, "cf-subject-1", "subject comes from the sub claim");
        assertEqual(principal.email, "manny@grimfanda.com", "email claim");
        assertEqual(principal.displayName, "Manny Calavera", "name claim");
    });

    it("rejects an assertion signed for a different audience", async () => {
        const provider = jwtProvider();
        const token = await mintAssertion({ sub: "x", email: "x@y.z" }, { audience: "some-other-app" });
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": token }));
        assertEqual(principal, null, "an audience mismatch must not authenticate");
    });

    it("rejects a garbage assertion", async () => {
        const provider = jwtProvider();
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": "not-a-jwt" }));
        assertEqual(principal, null, "an unparseable assertion must not authenticate");
    });

    it("returns no principal when the proxy header is absent", async () => {
        const provider = jwtProvider();
        const principal = await provider.authenticateRequest(null, reqWith({}));
        assertEqual(principal, null, "a request that never passed through the proxy must not authenticate");
    });

    it("refuses to start in header mode without an explicit trust opt-in", () => {
        let threw = null;
        try {
            createProxyAuthProvider({ env: { PORTAL_AUTH_PROXY_MODE: "header" } });
        } catch (error) {
            threw = error;
        }
        assert(threw, "unsigned header mode must not start silently");
        assert(
            /PORTAL_AUTH_PROXY_TRUST_HEADERS/.test(threw.message),
            "the error should name the opt-in that acknowledges the risk",
        );
    });

    it("reads plain headers once trust is explicitly opted into", async () => {
        const provider = createProxyAuthProvider({
            env: { PORTAL_AUTH_PROXY_MODE: "header", PORTAL_AUTH_PROXY_TRUST_HEADERS: "true" },
        });
        const principal = await provider.authenticateRequest(null, reqWith({
            "x-forwarded-user": "eva",
            "x-forwarded-email": "eva@grimfanda.com",
            "x-forwarded-groups": "staff,records",
        }));
        assert(principal, "headers should authenticate in trusted header mode");
        assertEqual(principal.subject, "eva", "subject header");
        assertEqual(principal.email, "eva@grimfanda.com", "email header");
        assertEqual(principal.groups.join(","), "staff,records", "comma-separated groups are split");
    });

    it("falls back to the email as subject when the proxy supplies no stable id", async () => {
        const provider = jwtProvider();
        const token = await mintAssertion({ email: "glottis@grimfanda.com" });
        const principal = await provider.authenticateRequest(null, reqWith({ "cf-access-jwt-assertion": token }));
        assert(principal, "an email alone is enough to key an identity");
        assertEqual(principal.subject, "glottis@grimfanda.com", "email becomes the subject");
    });

    it("advertises no browser client, because the proxy signs the user in", async () => {
        const provider = jwtProvider();
        const cfg = await provider.getPublicConfig();
        assertEqual(cfg.provider, "proxy", "public config names the provider");
        assertEqual(cfg.enabled, true, "public config reports enabled");
        assertEqual(cfg.client, null, "there is no browser-side client to configure");
    });

    it("declares that it authenticates from the request, not a bearer token", () => {
        const provider = jwtProvider();
        assertEqual(
            provider.authenticatesFromRequest,
            true,
            "the pipeline uses this to skip the bearer-token requirement",
        );
    });
});
