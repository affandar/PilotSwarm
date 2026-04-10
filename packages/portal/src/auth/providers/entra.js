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
                await msal.loginRedirect({ scopes: ["User.Read"] });
                return { account: null, accessToken: null, redirected: true };
            }

            const result = await msal.loginPopup({ scopes: ["User.Read"] });
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
            if (accessToken) return accessToken;
            return acquireToken({ interactive: true });
        },
        getAccount() {
            return account;
        },
    };
}

