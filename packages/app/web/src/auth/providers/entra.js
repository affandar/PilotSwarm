import { PublicClientApplication } from "@azure/msal-browser";

function isMobileBrowser() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent || "");
}

export function createEntraBrowserAuthProvider() {
    let msal = null;
    let config = null;
    let account = null;
    let accessToken = null;

    async function acquireToken({ interactive = true } = {}) {
        if (!msal || !account || !config?.client?.clientId) return null;
        const scopes = [`${config.client.clientId}/.default`];
        try {
            const response = await msal.acquireTokenSilent({
                scopes,
                account,
            });
            accessToken = response.accessToken || response.idToken || null;
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
            accessToken = response.accessToken || response.idToken || null;
            return accessToken;
        }
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
            return { account, accessToken };
        },
        async signIn() {
            if (!msal) return { account, accessToken };
            if (isMobileBrowser()) {
                await msal.loginRedirect({ scopes: ["openid", "profile"] });
                return { account: null, accessToken: null, redirected: true };
            }

            const result = await msal.loginPopup({ scopes: ["openid", "profile"] });
            account = result.account || msal.getAllAccounts()[0] || null;
            accessToken = await acquireToken({ interactive: true });
            return { account, accessToken };
        },
        async signOut() {
            if (!msal) {
                account = null;
                accessToken = null;
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
            return { account, accessToken };
        },
        async getAccessToken() {
            // Always attempt a silent acquire: MSAL returns the cached access
            // token while it is still valid and transparently uses the refresh
            // token to mint a fresh one once it expires. This is what keeps the
            // session alive past the ~60-90min access-token lifetime instead of
            // pinning it to the token captured at sign-in. We never force an
            // interactive popup here — getAccessToken runs on every background
            // API/WebSocket request; a silent failure returns null and lets the
            // transport's 401 handler drive re-authentication.
            return acquireToken({ interactive: false });
        },
        getAccount() {
            return account;
        },
    };
}

