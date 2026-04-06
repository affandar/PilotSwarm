import React from "react";
import { PublicClientApplication } from "@azure/msal-browser";

function isMobileBrowser() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent || "");
}

async function fetchAuthConfig() {
    const response = await fetch("/api/auth-config");
    if (!response.ok) {
        throw new Error(`Failed to load auth config (${response.status})`);
    }
    return response.json();
}

export function usePortalAuth() {
    const [state, setState] = React.useState({
        loading: true,
        authEnabled: false,
        signedIn: false,
        account: null,
        accessToken: null,
        error: null,
        config: null,
    });
    const msalRef = React.useRef(null);

    const acquireToken = React.useCallback(async () => {
        if (!msalRef.current || !state.account || !state.config?.clientId) return null;
        const scopes = [`${state.config.clientId}/.default`];
        try {
            const response = await msalRef.current.acquireTokenSilent({
                scopes,
                account: state.account,
            });
            const token = response.accessToken || response.idToken || null;
            setState((current) => ({ ...current, accessToken: token }));
            return token;
        } catch (error) {
            if (isMobileBrowser()) {
                await msalRef.current.acquireTokenRedirect({ scopes, account: state.account });
                return null;
            }
            const response = await msalRef.current.acquireTokenPopup({
                scopes,
                account: state.account,
            });
            const token = response.accessToken || response.idToken || null;
            setState((current) => ({ ...current, accessToken: token }));
            return token;
        }
    }, [state.account, state.config?.clientId]);

    React.useEffect(() => {
        let active = true;
        (async () => {
            try {
                const config = await fetchAuthConfig();
                if (!active) return;
                if (!config.enabled) {
                    setState({
                        loading: false,
                        authEnabled: false,
                        signedIn: true,
                        account: null,
                        accessToken: null,
                        error: null,
                        config,
                    });
                    return;
                }

                const msal = new PublicClientApplication({
                    auth: {
                        clientId: config.clientId,
                        authority: config.authority,
                        redirectUri: config.redirectUri,
                    },
                    cache: {
                        cacheLocation: "sessionStorage",
                        storeAuthStateInCookie: true,
                    },
                });
                msalRef.current = msal;
                await msal.initialize();
                const redirectResult = await msal.handleRedirectPromise();
                const account = redirectResult?.account || msal.getAllAccounts()[0] || null;
                if (!active) return;

                let accessToken = null;
                if (account) {
                    try {
                        accessToken = await (async () => {
                            const scopes = [`${config.clientId}/.default`];
                            const response = await msal.acquireTokenSilent({ scopes, account });
                            return response.accessToken || response.idToken || null;
                        })();
                    } catch {}
                }

                setState({
                    loading: false,
                    authEnabled: true,
                    signedIn: Boolean(account),
                    account,
                    accessToken,
                    error: null,
                    config,
                });
            } catch (error) {
                if (!active) return;
                setState({
                    loading: false,
                    authEnabled: false,
                    signedIn: false,
                    account: null,
                    accessToken: null,
                    error: error?.message || String(error),
                    config: null,
                });
            }
        })();

        return () => {
            active = false;
        };
    }, []);

    const signIn = React.useCallback(async () => {
        if (!msalRef.current || !state.config?.clientId) return;
        if (isMobileBrowser()) {
            await msalRef.current.loginRedirect({ scopes: ["User.Read"] });
            return;
        }
        const result = await msalRef.current.loginPopup({ scopes: ["User.Read"] });
        const account = result.account || msalRef.current.getAllAccounts()[0] || null;
        let token = null;
        if (account) {
            try {
                const response = await msalRef.current.acquireTokenSilent({
                    scopes: [`${state.config.clientId}/.default`],
                    account,
                });
                token = response.accessToken || response.idToken || null;
            } catch {
                const response = await msalRef.current.acquireTokenPopup({
                    scopes: [`${state.config.clientId}/.default`],
                    account,
                });
                token = response.accessToken || response.idToken || null;
            }
        }
        setState((current) => ({
            ...current,
            signedIn: Boolean(account),
            account,
            accessToken: token,
        }));
    }, [state.config?.clientId]);

    const signOut = React.useCallback(async () => {
        if (!msalRef.current) {
            setState((current) => ({
                ...current,
                signedIn: false,
                account: null,
                accessToken: null,
            }));
            return;
        }
        const account = state.account;
        if (isMobileBrowser()) {
            await msalRef.current.logoutRedirect({ account: account || undefined });
            return;
        }
        await msalRef.current.logoutPopup({ account: account || undefined });
        setState((current) => ({
            ...current,
            signedIn: false,
            account: null,
            accessToken: null,
        }));
    }, [state.account]);

    const handleUnauthorized = React.useCallback(() => {
        setState((current) => ({
            ...current,
            signedIn: false,
            account: null,
            accessToken: null,
        }));
    }, []);

    const getAccessToken = React.useCallback(async () => {
        if (!state.authEnabled) return null;
        if (state.accessToken) return state.accessToken;
        return acquireToken();
    }, [acquireToken, state.accessToken, state.authEnabled]);

    return {
        ...state,
        signIn,
        signOut,
        getAccessToken,
        handleUnauthorized,
    };
}
