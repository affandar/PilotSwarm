/** Shared JWT test fixtures. Kept out of a `*.test.ts` file so importing the
 * tokens elsewhere doesn't re-register (and re-run) the jwt test suite. */

function b64url(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build a fake JWT: header.payload.sig (signature is unused — never verified). */
export function makeJwt(claims: Record<string, unknown>): string {
    return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
}

export const USER_TOKEN = makeJwt({ idtyp: "user", upn: "alice@contoso.com", scp: "user_impersonation" });
export const APP_TOKEN = makeJwt({ idtyp: "app", oid: "00000000-0000-0000-0000-000000000000", roles: ["Kusto.Read"] });
export const AMBIGUOUS_TOKEN = makeJwt({ oid: "abc" });
