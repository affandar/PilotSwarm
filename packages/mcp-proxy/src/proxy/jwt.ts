/**
 * JWT claim inspection — DECODE ONLY, never verifies signatures.
 *
 * We only peek at claims (`idtyp`, `scp`, `upn`, ...) to classify a caller
 * bearer as interactive (delegated user) vs app-only (managed identity). The
 * upstream resource performs the authoritative validation; this proxy holds no
 * keys and trusts nothing based on these claims beyond the phase-1 gate.
 */

export type JwtClaims = Record<string, unknown>;

/** Best-effort decode of a JWT payload WITHOUT signature verification. Returns
 * {} on any parse failure (matches the strict, fail-closed posture). */
export function decodeClaims(token: string): JwtClaims {
    try {
        const parts = token.split(".");
        if (parts.length < 2) return {};
        let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        b64 += "=".repeat((4 - (b64.length % 4)) % 4);
        const json = Buffer.from(b64, "base64").toString("utf8");
        const claims: unknown = JSON.parse(json);
        return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as JwtClaims) : {};
    } catch {
        return {};
    }
}

/**
 * Classify a token as interactive (delegated user) vs app-only.
 *
 * Preference order:
 *   - explicit `idtyp` claim ("user" -> interactive, "app" -> app-only)
 *   - otherwise: delegated user tokens carry `scp`/`scope` and/or a user
 *     principal (`upn`/`preferred_username`/`email`); app tokens carry
 *     `roles`/no `scp`/no user principal.
 * When interactivity cannot be proven we return false (strict — honors the
 * phase-1 "interactive credential only" requirement).
 */
export function isInteractive(claims: JwtClaims): boolean {
    const idtyp = String(claims["idtyp"] ?? "").toLowerCase();
    if (idtyp === "app") return false;
    if (idtyp === "user") return true;
    if ("scp" in claims || "scope" in claims) return true;
    if (["upn", "preferred_username", "email"].some((k) => k in claims)) return true;
    return false;
}
