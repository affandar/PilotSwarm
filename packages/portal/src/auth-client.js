import React from "react";
import { PublicClientApplication } from "@azure/msal-browser";

function isMobileBrowser() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent || "");
}

function buildInitialState(authConfig) {
    return {
        loading: true,
        provider: authConfig?.provider || "none",
        authEnabled: Boolean(authConfig?.enabled),
        signedIn: false,
        account: null,
        accessToken: null,
        error: null,
        config: authConfig || null,
    };
}

export function usePortalAuth(authConfig) {
    const [state, setState] = React.useState(() => buildInitialState(authConfig));
    const msalRef = React.useRef(null);

    const acquireEntraToken = React.useCallback(async () => {
        if (!msalRef.current || !state.account || !state.config?.client?.clientId) return null;
        const scopes = [`${state.config.client.clientId}/.default`];
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
    }, [state.account, state.config?.client?.clientId]);

    React.useEffect(() => {
        let active = true;

        async function initialize() {
            if (!authConfig) {
                setState((current) => ({
                    ...current,
                    loading: true,
                }));
                return;
            }

            if (!authConfig.enabled || authConfig.provider === "none") {
                msalRef.current = null;
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider || "none",
                    authEnabled: false,
                    signedIn: true,
                    account: null,
                    accessToken: null,
                    error: null,
                    config: authConfig,
                });
                return;
            }

            if (authConfig.provider !== "entra") {
                msalRef.current = null;
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    account: null,
                    accessToken: null,
                    error: `Unsupported portal auth provider "${authConfig.provider}"`,
                    config: authConfig,
                });
                return;
            }

            try {
                const clientConfig = authConfig.client || {};
                const msal = new PublicClientApplication({
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
                msalRef.current = msal;
                await msal.initialize();
                const redirectResult = await msal.handleRedirectPromise();
                const account = redirectResult?.account || msal.getAllAccounts()[0] || null;
                let accessToken = null;

                if (account) {
                    try {
                        const response = await msal.acquireTokenSilent({
                            scopes: [`${clientConfig.clientId}/.default`],
                            account,
                        });
                        accessToken = response.accessToken || response.idToken || null;
                    } catch {}
                }

                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: Boolean(account),
                    account,
                    accessToken,
                    error: null,
                    config: authConfig,
                });
            } catch (error) {
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    account: null,
                    accessToken: null,
                    error: error?.message || String(error),
                    config: authConfig,
                });
            }
        }

        initialize();
        return () => {
            active = false;
        };
    }, [
        authConfig?.client?.authority,
        authConfig?.client?.clientId,
        authConfig?.client?.redirectUri,
        authConfig?.enabled,
        authConfig?.provider,
    ]);

    const signIn = React.useCallback(async () => {
        if (!state.authEnabled) return;
        if (state.provider !== "entra") {
            throw new Error(`Unsupported portal auth provider "${state.provider}"`);
        }
        if (!msalRef.current || !state.config?.client?.clientId) return;

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
                    scopes: [`${state.config.client.clientId}/.default`],
                    account,
                });
                token = response.accessToken || response.idToken || null;
            } catch {
                const response = await msalRef.current.acquireTokenPopup({
                    scopes: [`${state.config.client.clientId}/.default`],
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
            error: null,
        }));
    }, [state.authEnabled, state.config?.client?.clientId, state.provider]);

    const signOut = React.useCallback(async () => {
        if (!state.authEnabled) {
            setState((current) => ({
                ...current,
                signedIn: false,
                account: null,
                accessToken: null,
            }));
            return;
        }
        if (state.provider !== "entra") {
            throw new Error(`Unsupported portal auth provider "${state.provider}"`);
        }
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
    }, [state.account, state.authEnabled, state.provider]);

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
        if (state.provider !== "entra") {
            throw new Error(`Unsupported portal auth provider "${state.provider}"`);
        }
        return acquireEntraToken();
    }, [acquireEntraToken, state.accessToken, state.authEnabled, state.provider]);

    return {
        ...state,
        signIn,
        signOut,
        getAccessToken,
        handleUnauthorized,
    };
}
