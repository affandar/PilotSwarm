// FR-027: MSAL-based user-access-token acquisition for the
// smoke driver.
//
// Two modes:
//   - `device-code` (default): interactive; prints the code to stderr
//                              and blocks until the user signs in.
//                              Used by local maintainers running the
//                              smoke from their workstation.
//   - `from-env`: reads OBO_SMOKE_USER_ADMISSION_TOKEN and
//                 OBO_SMOKE_USER_DOWNSTREAM_TOKEN from process.env.
//                 Intended for CI where device-code is not feasible.
//                 The operator is responsible for acquiring + injecting
//                 fresh tokens in the workflow secrets.
//
// MSAL `authority` is set explicitly to
// `${authorityHost ?? "https://login.microsoftonline.com"}/${tenantId}`
// to avoid the MSAL default falling through to /common, which would
// produce surprising tenant-mismatch failures (rubber-duck finding
// live-smoke harness #3).
//
// ROPC (resource-owner password credentials) is intentionally NOT
// implemented — see SFI guidance in docs/operations/live-smoke.md.

import { PublicClientApplication } from "@azure/msal-node";

function isJwtShaped(s) {
    return typeof s === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
}

function authorityFor(tenantId, authorityHost) {
    const host = (typeof authorityHost === "string" && authorityHost.trim().length > 0)
        ? authorityHost.trim().replace(/\/+$/, "")
        : "https://login.microsoftonline.com";
    return `${host}/${tenantId}`;
}

/**
 * Acquire a *pair* of access tokens for the smoke driver:
 *   - `admissionToken` — admits the request to the portal's `/api/rpc`
 *     route via the existing `Authorization: Bearer …` middleware
 *     (matches the browser sign-in flow).
 *   - `downstreamToken` — what the portal would have acquired on the
 *     user's behalf for the worker app; the driver attaches this to
 *     the RPC body's `auth` envelope so the portal encrypts and
 *     forwards it (mirroring `browser-transport.js#rpc`).
 *
 * Both are acquired against the portal's own AAD app (the same
 * client-id the browser SPA uses). The downstream scope is the
 * stamp's `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE`.
 *
 * Returns { admissionToken, downstreamToken, downstreamExpiresAt }.
 */
export async function acquireUserAccessTokens({
    tenantId,
    clientId,
    admissionScope,
    downstreamScope,
    mode = "device-code",
    authorityHost = null,
    deps = {},
}) {
    if (mode === "from-env") {
        const admissionToken = (process.env.OBO_SMOKE_USER_ADMISSION_TOKEN ?? "").trim();
        const downstreamToken = (process.env.OBO_SMOKE_USER_DOWNSTREAM_TOKEN ?? "").trim();
        if (!isJwtShaped(admissionToken)) {
            throw new Error("OBO_SMOKE_USER_ADMISSION_TOKEN is missing or not a JWT-shaped string");
        }
        if (!isJwtShaped(downstreamToken)) {
            throw new Error("OBO_SMOKE_USER_DOWNSTREAM_TOKEN is missing or not a JWT-shaped string");
        }
        return {
            admissionToken,
            downstreamToken,
            downstreamExpiresAt: null,
        };
    }
    if (mode !== "device-code") {
        throw new Error(`acquireUserAccessTokens: unsupported mode '${mode}'`);
    }

    const PcaCtor = deps.PublicClientApplication ?? PublicClientApplication;
    const pca = new PcaCtor({
        auth: {
            clientId,
            authority: authorityFor(tenantId, authorityHost),
        },
    });

    const admissionResult = await pca.acquireTokenByDeviceCode({
        scopes: [admissionScope, "offline_access"],
        deviceCodeCallback: (resp) => process.stderr.write(resp.message + "\n"),
    });
    if (!admissionResult?.accessToken) {
        throw new Error("device-code flow returned no admission accessToken");
    }

    // Reuse the cached account from the admission acquisition for the
    // silent downstream acquisition. Falls back to a second device-code
    // flow only if the cache lookup fails (which it shouldn't on the
    // same PCA instance).
    let downstreamResult;
    try {
        const account = admissionResult.account
            ?? (await pca.getTokenCache().getAllAccounts())[0]
            ?? null;
        if (account) {
            downstreamResult = await pca.acquireTokenSilent({
                scopes: [downstreamScope, "offline_access"],
                account,
            });
        }
    } catch {
        // fall through to interactive
    }
    if (!downstreamResult?.accessToken) {
        downstreamResult = await pca.acquireTokenByDeviceCode({
            scopes: [downstreamScope, "offline_access"],
            deviceCodeCallback: (resp) => process.stderr.write(resp.message + "\n"),
        });
    }
    if (!downstreamResult?.accessToken) {
        throw new Error("device-code flow returned no downstream accessToken");
    }

    return {
        admissionToken: admissionResult.accessToken,
        downstreamToken: downstreamResult.accessToken,
        downstreamExpiresAt: downstreamResult.expiresOn instanceof Date
            ? downstreamResult.expiresOn.getTime()
            : null,
    };
}
