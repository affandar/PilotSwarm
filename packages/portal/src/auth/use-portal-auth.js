import React from "react";
import { createNoBrowserAuthProvider } from "./providers/none.js";
import { createEntraBrowserAuthProvider } from "./providers/entra.js";

function buildInitialState(authConfig) {
    return {
        loading: true,
        provider: authConfig?.provider || "none",
        authEnabled: Boolean(authConfig?.enabled),
        signedIn: false,
        forbidden: false,
        account: null,
        accessToken: null,
        principal: null,
        authorization: null,
        error: null,
        config: authConfig || null,
    };
}

function createBrowserAuthProvider(providerId) {
    if (!providerId || providerId === "none") return createNoBrowserAuthProvider();
    if (providerId === "entra") return createEntraBrowserAuthProvider();
    return null;
}

async function readAuthErrorMessage(response) {
    try {
        const payload = await response.json();
        return payload?.error || payload?.message || response.statusText;
    } catch {
        return response.statusText || `HTTP ${response.status}`;
    }
}

async function fetchAuthContext(token) {
    const headers = new Headers();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch("/api/auth/me", { headers });
    if (response.status === 401) {
        return {
            status: "unauthorized",
            error: "Unauthorized",
        };
    }
    if (response.status === 403) {
        return {
            status: "forbidden",
            error: await readAuthErrorMessage(response),
        };
    }
    if (!response.ok) {
        throw new Error(await readAuthErrorMessage(response));
    }
    const payload = await response.json();
    return {
        status: "authorized",
        principal: payload?.principal || null,
        authorization: payload?.authorization || null,
    };
}

export function usePortalAuth(authConfig) {
    const [state, setState] = React.useState(() => buildInitialState(authConfig));
    const providerRef = React.useRef(null);

    const applyAuthorizedState = React.useCallback(({ account, accessToken, principal, authorization }) => {
        setState((current) => ({
            ...current,
            loading: false,
            signedIn: true,
            forbidden: false,
            account,
            accessToken: accessToken ?? current.accessToken ?? null,
            principal: principal ?? null,
            authorization: authorization ?? null,
            error: null,
        }));
    }, []);

    const applyForbiddenState = React.useCallback(({ account, accessToken, error }) => {
        setState((current) => ({
            ...current,
            loading: false,
            signedIn: Boolean(account),
            forbidden: true,
            account: account ?? current.account ?? null,
            accessToken: accessToken ?? current.accessToken ?? null,
            principal: null,
            authorization: null,
            error: error || "This account is not authorized to access the portal.",
        }));
    }, []);

    const syncAuthContext = React.useCallback(async ({ account, accessToken }) => {
        const result = await fetchAuthContext(accessToken);
        if (result.status === "authorized") {
            applyAuthorizedState({
                account,
                accessToken,
                principal: result.principal,
                authorization: result.authorization,
            });
            return result;
        }
        if (result.status === "forbidden") {
            applyForbiddenState({
                account,
                accessToken,
                error: result.error,
            });
            return result;
        }
        setState((current) => ({
            ...current,
            loading: false,
            signedIn: false,
            forbidden: false,
            account: null,
            accessToken: null,
            principal: null,
            authorization: null,
            error: null,
        }));
        return result;
    }, [applyAuthorizedState, applyForbiddenState]);

    React.useEffect(() => {
        let active = true;

        async function initialize() {
            if (!authConfig) {
                setState((current) => ({ ...current, loading: true }));
                return;
            }

            const provider = createBrowserAuthProvider(authConfig.provider);
            if (!provider) {
                providerRef.current = null;
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    forbidden: false,
                    account: null,
                    accessToken: null,
                    principal: null,
                    authorization: null,
                    error: `Unsupported portal auth provider "${authConfig.provider}"`,
                    config: authConfig,
                });
                return;
            }

            providerRef.current = provider;

            if (!authConfig.enabled && authConfig.provider && authConfig.provider !== "none") {
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    forbidden: false,
                    account: null,
                    accessToken: null,
                    principal: null,
                    authorization: null,
                    error: `Portal auth provider "${authConfig.provider}" is selected but not fully configured.`,
                    config: authConfig,
                });
                return;
            }

            if (!authConfig.enabled || authConfig.provider === "none") {
                try {
                    await provider.initialize(authConfig);
                    const result = await fetchAuthContext(null);
                    if (!active) return;
                    if (result.status === "authorized") {
                        setState({
                            loading: false,
                            provider: authConfig.provider || "none",
                            authEnabled: false,
                            signedIn: true,
                            forbidden: false,
                            account: null,
                            accessToken: null,
                            principal: result.principal || null,
                            authorization: result.authorization || null,
                            error: null,
                            config: authConfig,
                        });
                        return;
                    }
                    setState({
                        loading: false,
                        provider: authConfig.provider || "none",
                        authEnabled: false,
                        signedIn: false,
                        forbidden: result.status === "forbidden",
                        account: null,
                        accessToken: null,
                        principal: null,
                        authorization: null,
                        error: result.error || null,
                        config: authConfig,
                    });
                } catch (error) {
                    if (!active) return;
                    setState({
                        loading: false,
                        provider: authConfig.provider || "none",
                        authEnabled: false,
                        signedIn: false,
                        forbidden: false,
                        account: null,
                        accessToken: null,
                        principal: null,
                        authorization: null,
                        error: error?.message || String(error),
                        config: authConfig,
                    });
                }
                return;
            }

            try {
                const initialized = await provider.initialize(authConfig);
                const account = initialized?.account || provider.getAccount() || null;
                const accessToken = initialized?.accessToken || null;
                if (!active) return;
                if (!account) {
                    setState({
                        loading: false,
                        provider: authConfig.provider,
                        authEnabled: true,
                        signedIn: false,
                        forbidden: false,
                        account: null,
                        accessToken: null,
                        principal: null,
                        authorization: null,
                        error: null,
                        config: authConfig,
                    });
                    return;
                }

                const result = await fetchAuthContext(accessToken);
                if (!active) return;
                if (result.status === "authorized") {
                    setState({
                        loading: false,
                        provider: authConfig.provider,
                        authEnabled: true,
                        signedIn: true,
                        forbidden: false,
                        account,
                        accessToken,
                        principal: result.principal || null,
                        authorization: result.authorization || null,
                        error: null,
                        config: authConfig,
                    });
                    return;
                }

                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: Boolean(account),
                    forbidden: result.status === "forbidden",
                    account,
                    accessToken,
                    principal: null,
                    authorization: null,
                    error: result.error || null,
                    config: authConfig,
                });
            } catch (error) {
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    forbidden: false,
                    account: null,
                    accessToken: null,
                    principal: null,
                    authorization: null,
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
        syncAuthContext,
    ]);

    const signIn = React.useCallback(async () => {
        if (!state.authEnabled) return;
        if (!providerRef.current) {
            throw new Error(`Unsupported portal auth provider "${state.provider}"`);
        }

        const result = await providerRef.current.signIn();
        if (result?.redirected) return;

        const account = result?.account || providerRef.current.getAccount() || null;
        const accessToken = result?.accessToken || await providerRef.current.getAccessToken();

        if (!account) {
            setState((current) => ({
                ...current,
                signedIn: false,
                forbidden: false,
                account: null,
                accessToken: null,
                principal: null,
                authorization: null,
                error: null,
            }));
            return;
        }

        await syncAuthContext({ account, accessToken });
    }, [state.authEnabled, state.provider, syncAuthContext]);

    const signOut = React.useCallback(async () => {
        if (!providerRef.current) {
            setState((current) => ({
                ...current,
                signedIn: false,
                forbidden: false,
                account: null,
                accessToken: null,
                principal: null,
                authorization: null,
            }));
            return;
        }

        const result = await providerRef.current.signOut();
        if (result?.redirected) return;

        setState((current) => ({
            ...current,
            signedIn: false,
            forbidden: false,
            account: null,
            accessToken: null,
            principal: null,
            authorization: null,
            error: null,
        }));
    }, []);

    const handleUnauthorized = React.useCallback(() => {
        setState((current) => ({
            ...current,
            signedIn: false,
            forbidden: false,
            account: null,
            accessToken: null,
            principal: null,
            authorization: null,
            error: null,
        }));
    }, []);

    const handleForbidden = React.useCallback((error) => {
        setState((current) => ({
            ...current,
            forbidden: true,
            principal: null,
            authorization: null,
            error: error || "This account is not authorized to access the portal.",
        }));
    }, []);

    const getAccessToken = React.useCallback(async () => {
        if (!state.authEnabled) return null;
        if (state.accessToken) return state.accessToken;
        if (!providerRef.current) {
            throw new Error(`Unsupported portal auth provider "${state.provider}"`);
        }
        return providerRef.current.getAccessToken();
    }, [state.accessToken, state.authEnabled, state.provider]);

    return {
        ...state,
        signIn,
        signOut,
        getAccessToken,
        handleUnauthorized,
        handleForbidden,
    };
}
