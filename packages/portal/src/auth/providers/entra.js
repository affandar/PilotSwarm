import { PublicClientApplication } from "@azure/msal-browser";

function isMobileBrowser() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent || "");
}

// User OBO: refresh a downstream-scope token when its remaining
// lifetime drops below this threshold. Five minutes mirrors the spec's
// near-expiry window; the worker performs OBO immediately after RPC arrival
// so a token within 5 minutes of expiry is treated as "about to expire".
const DOWNSTREAM_NEAR_EXPIRY_MS = 5 * 60 * 1000;

function expiresOnToEpochMs(expiresOn) {
    if (!expiresOn) return null;
    if (typeof expiresOn === "number") return expiresOn;
    if (expiresOn instanceof Date) return expiresOn.getTime();
    const parsed = new Date(expiresOn).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

export function createEntraBrowserAuthProvider() {
    let msal = null;
    let config = null;
    let account = null;
    let accessToken = null;
    // Separate cache for the downstream-scope token. Distinct from
    // the admission `accessToken` because the two scopes/audiences differ;
    // mixing them would cause MSAL to refresh-the-wrong-token.
    let downstreamToken = null; // { accessToken, accessTokenExpiresAt } | null

    // The PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE env value is documented as a
    // space-separated list (e.g. `api://<worker-app>/.default offline_access`)
    // to match how MSAL scope strings are commonly written. MSAL.js itself
    // rejects scopes containing whitespace, so we split into discrete scope
    // entries and strip well-knowns (`openid`/`profile`/`offline_access`) that
    // the SPA composes itself.
    const SPA_MANAGED_SCOPES = new Set(["openid", "profile", "offline_access"]);
    function downstreamScopeList() {
        const raw = String(config?.client?.downstreamScope || "").trim();
        if (!raw) return [];
        return raw
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s) => !SPA_MANAGED_SCOPES.has(s.toLowerCase()));
    }
    function downstreamScope() {
        const list = downstreamScopeList();
        return list.length > 0 ? list[0] : null;
    }

    async function acquireToken({ interactive = true } = {}) {
        if (!msal || !account || !config?.client?.clientId) return null;
        // Admission credential is the id_token (audience = portal clientId by
        // OIDC convention), not a self-referencing access token. AAD requires
        // explicit `.default`-scope consent on the portal's own app before it
        // will issue an access token where the portal is both client AND
        // resource, even though openid/profile/offline_access have already
        // been consented. The portal server validates `audience === clientId`
        // (entra.js#verifyToken), which the id_token satisfies. Requesting
        // ["openid", "profile"] is guaranteed silent and returns a fresh
        // id_token (no API access token because openid/profile aren't API
        // scopes).
        const scopes = ["openid", "profile"];
        try {
            const response = await msal.acquireTokenSilent({
                scopes,
                account,
            });
            accessToken = response.idToken || null;
            return accessToken;
        } catch (error) {
            if (!interactive) return null;
            if (isMobileBrowser()) {
                await msal.acquireTokenRedirect({ scopes, account });
                return null;
            }
            const response = await msal.acquireTokenPopup({
                scopes,
                account,
            });
            accessToken = response.idToken || null;
            return accessToken;
        }
    }

    /**
     * User OBO: acquire a token for the configured downstream scope
     * (e.g. api://<worker-app>/.default). Returns `{ accessToken,
     * accessTokenExpiresAt }` or null when the deployment has no downstream
     * scope configured, when MSAL silently fails and `interactive` is false,
     * or when MSAL rejects the scope (Spec A-8 misconfiguration: log and
     * continue with admission-only).
     *
     * Acquired in `["<downstreamScope>", "offline_access"]` so MSAL can
     * silently refresh the token mid-session without interactive prompts.
     * forceRefresh is set when the cached token is within ~5 minutes of
     * expiry; this matches the worker's OBO timing assumption that the
     * incoming user assertion is comfortably valid for the OBO exchange.
     */
    async function acquireDownstreamToken({ interactive = false } = {}) {
        const dsScopes = downstreamScopeList();
        if (dsScopes.length === 0) return null;
        if (!msal || !account) return null;
        const now = Date.now();
        const cached = downstreamToken;
        const nearExpiry = !cached
            || !Number.isFinite(cached.accessTokenExpiresAt)
            || cached.accessTokenExpiresAt - now < DOWNSTREAM_NEAR_EXPIRY_MS;
        if (cached && !nearExpiry) return { ...cached };
        const scopes = [...dsScopes, "offline_access"];
        try {
            const response = await msal.acquireTokenSilent({
                scopes,
                account,
                forceRefresh: nearExpiry,
            });
            const expiresAt = expiresOnToEpochMs(response.expiresOn);
            if (!response.accessToken || !expiresAt) return null;
            downstreamToken = {
                accessToken: response.accessToken,
                accessTokenExpiresAt: expiresAt,
            };
            return { ...downstreamToken };
        } catch (error) {
            if (!interactive) {
                // Spec A-8: misconfigured downstream scope (e.g. invalid app
                // URI) must not break the existing admission flow. Log a
                // metadata-only message — never the token material — and
                // surface null so the envelope ships principal-only.
                // eslint-disable-next-line no-console
                console.warn(
                    "[portal-auth:entra] downstream-scope token acquisition failed:",
                    error?.errorCode || error?.name || "unknown",
                );
                return null;
            }
            if (isMobileBrowser()) {
                await msal.acquireTokenRedirect({ scopes, account });
                return null;
            }
            try {
                const response = await msal.acquireTokenPopup({
                    scopes,
                    account,
                });
                const expiresAt = expiresOnToEpochMs(response.expiresOn);
                if (!response.accessToken || !expiresAt) return null;
                downstreamToken = {
                    accessToken: response.accessToken,
                    accessTokenExpiresAt: expiresAt,
                };
                return { ...downstreamToken };
            } catch (popupError) {
                // eslint-disable-next-line no-console
                console.warn(
                    "[portal-auth:entra] downstream-scope interactive acquisition failed:",
                    popupError?.errorCode || popupError?.name || "unknown",
                );
                return null;
            }
        }
    }

    function loginScopes() {
        const base = ["openid", "profile"];
        const ds = downstreamScopeList();
        if (ds.length === 0) return base;
        // Pre-consent the downstream scope at sign-in so subsequent silent
        // acquisitions don't trigger interactive prompts mid-session.
        return [...base, "offline_access", ...ds];
    }

    return {
        async initialize(authConfig) {
            config = authConfig || null;
            const clientConfig = authConfig?.client || {};
            msal = new PublicClientApplication({
                auth: {
                    clientId: clientConfig.clientId,
                    authority: clientConfig.authority,
                    redirectUri: clientConfig.redirectUri,
                },
                cache: {
                    cacheLocation: "sessionStorage",
                    storeAuthStateInCookie: true,
                },
            });
            await msal.initialize();
            const redirectResult = await msal.handleRedirectPromise();
            account = redirectResult?.account || msal.getAllAccounts()[0] || null;
            accessToken = await acquireToken({ interactive: false });
            // Best-effort silent acquisition of the downstream token at
            // bootstrap; failures here are non-fatal (Spec A-8).
            downstreamToken = null;
            await acquireDownstreamToken({ interactive: false });
            return { account, accessToken };
        },
        async signIn() {
            if (!msal) return { account, accessToken };
            const scopes = loginScopes();
            // prompt: "consent" forces AAD to render the consent screen on
            // first sign-in (and on any subsequent sign-in where consent
            // scope drift exists). select_account only forces the account
            // picker — AAD then silently SSOs through with the existing
            // session, which short-circuits first-time consent capture for
            // the downstream scope. The follow-up acquireTokenSilent call
            // then fails with AADSTS65001 because consent for the full
            // scope set was never granted. Using `consent` ensures the
            // refresh token MSAL caches is good for the requested scopes.
            if (isMobileBrowser()) {
                await msal.loginRedirect({ scopes, prompt: "consent" });
                return { account: null, accessToken: null, redirected: true };
            }

            const result = await msal.loginPopup({ scopes, prompt: "consent" });
            account = result.account || msal.getAllAccounts()[0] || null;
            accessToken = await acquireToken({ interactive: true });
            downstreamToken = null;
            await acquireDownstreamToken({ interactive: false });
            return { account, accessToken };
        },
        async signOut() {
            if (!msal) {
                account = null;
                accessToken = null;
                downstreamToken = null;
                return { account, accessToken };
            }
            const currentAccount = account;
            if (isMobileBrowser()) {
                await msal.logoutRedirect({ account: currentAccount || undefined });
                return { account: null, accessToken: null, redirected: true };
            }
            await msal.logoutPopup({ account: currentAccount || undefined });
            account = null;
            accessToken = null;
            downstreamToken = null;
            return { account, accessToken };
        },
        async getAccessToken() {
            if (accessToken) return accessToken;
            return acquireToken({ interactive: true });
        },
        /**
         * User OBO: returns `{ accessToken, accessTokenExpiresAt }`
         * for the configured downstream scope, or null when no scope is
         * configured / acquisition failed. Never throws — Spec A-8 requires
         * graceful degradation to principal-only envelope.
         *
         * FR-011: accepts optional `{ interactive }`. When the
         * transport observes an `interaction_required` outcome, it calls
         * with `interactive: true`, which falls back to a popup/redirect on
         * silent-acquire failure (e.g., Conditional Access reauth, MFA
         * refresh). After the user re-authenticates, the cached token is
         * populated and the next worker-bound RPC carries it.
         */
        async getDownstreamToken({ interactive = false } = {}) {
            return acquireDownstreamToken({ interactive: Boolean(interactive) });
        },
        getAccount() {
            return account;
        },
    };
}

