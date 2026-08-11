function toStringArray(value) {
    if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
    if (typeof value === "string") {
        return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
    return [];
}

function first(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

/**
 * Normalize a principal from whatever an identity-aware proxy put in front of
 * us — either the claims of a signed assertion it minted, or plain headers.
 *
 * Claim and header names differ per proxy (Cloudflare Access, Google IAP, AWS
 * ALB, Pomerium, oauth2-proxy, Authelia, Authentik), so every source is
 * configurable and the defaults simply match the most common spelling.
 */
export function normalizeProxyPrincipal(claims = {}, opts = {}) {
    const subjectClaim = opts.subjectClaim || "sub";
    const emailClaim = opts.emailClaim || "email";
    const nameClaim = opts.nameClaim || "name";
    const rolesClaim = opts.rolesClaim || "roles";
    const groupsClaim = opts.groupsClaim || "groups";

    const email = first(claims[emailClaim], claims.email, claims.preferred_username, claims.upn);
    // Fall back to the email when the proxy supplies no stable subject: an
    // identity with no key at all cannot own sessions, and every downstream
    // table is keyed on (provider, subject).
    const subject = first(claims[subjectClaim], claims.sub, email);
    if (!subject) return null;

    return {
        provider: "proxy",
        subject,
        email,
        displayName: first(claims[nameClaim], claims.name),
        groups: toStringArray(claims[groupsClaim]),
        roles: toStringArray(claims[rolesClaim]),
        tenantId: null,
        rawClaims: claims,
    };
}
