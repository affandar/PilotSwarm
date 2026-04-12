import React from "react";
import { createWebPilotSwarmController, PilotSwarmWebApp } from "pilotswarm-ui-react";
import { BrowserPortalTransport } from "./browser-transport.js";
import { usePortalAuth } from "./auth-client.js";
import { PILOTSWARM_PORTAL_VERSION_LABEL } from "./version.js";

const DEFAULT_PORTAL_LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="#111827"/>
  <path d="M32 9.5C44.4264 9.5 54.5 19.5736 54.5 32C54.5 44.4264 44.4264 54.5 32 54.5C19.5736 54.5 9.5 44.4264 9.5 32C9.5 19.5736 19.5736 9.5 32 9.5Z" stroke="#7dd3fc" stroke-width="3" opacity="0.46"/>
  <path d="M32 17L32 47" stroke="#7dd3fc" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M19 24L45 40" stroke="#7dd3fc" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M19 40L45 24" stroke="#7dd3fc" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="6" fill="#38bdf8"/>
  <circle cx="32" cy="17" r="4" fill="#86efac"/>
  <circle cx="45" cy="24" r="4" fill="#60a5fa"/>
  <circle cx="45" cy="40" r="4" fill="#d8b4fe"/>
  <circle cx="32" cy="47" r="4" fill="#86efac"/>
  <circle cx="19" cy="40" r="4" fill="#60a5fa"/>
  <circle cx="19" cy="24" r="4" fill="#d8b4fe"/>
</svg>
`.trim();

const DEFAULT_PORTAL_FAVICON_URL = `data:image/svg+xml,${encodeURIComponent(DEFAULT_PORTAL_LOGO_SVG)}`;
const GENERIC_SIGN_IN_MESSAGE = "Use your organization's identity provider to open the browser-native PilotSwarm workspace.";

const DEFAULT_PORTAL_CONFIG = {
    portal: {
        branding: {
            title: "PilotSwarm",
            pageTitle: "PilotSwarm",
            splash: "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}",
            logoUrl: null,
            faviconUrl: null,
        },
        ui: {
            loadingMessage: "Preparing your workspace",
            loadingCopy: "Connecting the shared workspace and live session feeds...",
        },
        auth: {
            signInTitle: "Sign in to PilotSwarm",
            signInMessage: null,
            signInLabel: "Sign In",
        },
    },
    auth: {
        enabled: false,
        provider: "none",
        displayName: "No auth",
        client: null,
    },
};

function getWorkspaceTitle(branding) {
    return branding?.title || "PilotSwarm";
}

function getDefaultSignInMessage({ providerId, branding }) {
    if (providerId === "entra") {
        return `Use Entra ID authentication with your Microsoft work account to open the browser-native ${getWorkspaceTitle(branding)} workspace.`;
    }
    return GENERIC_SIGN_IN_MESSAGE;
}

function resolveSignInMessage({ authUi, authConfig, branding, error }) {
    if (error) return error;
    if (typeof authUi?.signInMessage === "string" && authUi.signInMessage.trim()) {
        return authUi.signInMessage;
    }
    return getDefaultSignInMessage({
        providerId: authConfig?.provider,
        branding,
    });
}

function ensureFaviconLink(href) {
    if (typeof document === "undefined") return;
    const resolvedHref = href || DEFAULT_PORTAL_FAVICON_URL;
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
        link = document.createElement("link");
        link.setAttribute("rel", "icon");
        document.head.appendChild(link);
    }
    link.setAttribute("href", resolvedHref);
}

async function fetchPortalConfig() {
    const response = await fetch("/api/portal-config");
    if (!response.ok) {
        throw new Error(`Failed to load portal config (${response.status})`);
    }
    const payload = await response.json();
    if (payload?.ok === false) {
        throw new Error(payload.error || "Failed to load portal config");
    }
    return {
        portal: payload?.portal || DEFAULT_PORTAL_CONFIG.portal,
        auth: payload?.auth || DEFAULT_PORTAL_CONFIG.auth,
    };
}

function usePortalPublicConfig() {
    const [state, setState] = React.useState({
        loading: true,
        error: null,
        config: DEFAULT_PORTAL_CONFIG,
    });

    React.useEffect(() => {
        let active = true;
        fetchPortalConfig()
            .then((config) => {
                if (!active) return;
                setState({
                    loading: false,
                    error: null,
                    config,
                });
            })
            .catch((error) => {
                if (!active) return;
                setState({
                    loading: false,
                    error: error?.message || String(error),
                    config: DEFAULT_PORTAL_CONFIG,
                });
            });
        return () => {
            active = false;
        };
    }, []);

    React.useEffect(() => {
        if (typeof document === "undefined") return;
        document.title = state.config?.portal?.branding?.pageTitle || state.config?.portal?.branding?.title || "PilotSwarm";
    }, [state.config?.portal?.branding?.pageTitle, state.config?.portal?.branding?.title]);

    React.useEffect(() => {
        ensureFaviconLink(state.config?.portal?.branding?.faviconUrl || state.config?.portal?.branding?.logoUrl || DEFAULT_PORTAL_FAVICON_URL);
    }, [state.config?.portal?.branding?.faviconUrl, state.config?.portal?.branding?.logoUrl]);

    return state;
}

function useVisualViewportHeight() {
    const readHeight = React.useCallback(() => {
        if (typeof window === "undefined") return null;
        const viewport = window.visualViewport;
        const rawHeight = viewport?.height || window.innerHeight || 0;
        const offsetTop = viewport?.offsetTop || 0;
        return Math.round(rawHeight + offsetTop);
    }, []);

    const [height, setHeight] = React.useState(() => readHeight());

    React.useLayoutEffect(() => {
        if (typeof window === "undefined") return undefined;

        const update = () => {
            setHeight(readHeight());
        };

        const viewport = window.visualViewport;
        update();
        window.addEventListener("resize", update);
        viewport?.addEventListener("resize", update);
        viewport?.addEventListener("scroll", update);

        return () => {
            window.removeEventListener("resize", update);
            viewport?.removeEventListener("resize", update);
            viewport?.removeEventListener("scroll", update);
        };
    }, [readHeight]);

    return height;
}

function DefaultPortalLogo({ className = "portal-logo" }) {
    return React.createElement("svg", {
        className,
        viewBox: "0 0 64 64",
        fill: "none",
    },
    React.createElement("path", {
        className: "portal-logo-ring",
        d: "M32 9.5C44.4264 9.5 54.5 19.5736 54.5 32C54.5 44.4264 44.4264 54.5 32 54.5C19.5736 54.5 9.5 44.4264 9.5 32C9.5 19.5736 19.5736 9.5 32 9.5Z",
    }),
    React.createElement("path", { className: "portal-logo-link", d: "M32 17L32 47" }),
    React.createElement("path", { className: "portal-logo-link", d: "M19 24L45 40" }),
    React.createElement("path", { className: "portal-logo-link", d: "M19 40L45 24" }),
    React.createElement("circle", { className: "portal-logo-core", cx: "32", cy: "32", r: "6" }),
    React.createElement("circle", { className: "portal-logo-node portal-logo-node-a", cx: "32", cy: "17", r: "4" }),
    React.createElement("circle", { className: "portal-logo-node portal-logo-node-b", cx: "45", cy: "24", r: "4" }),
    React.createElement("circle", { className: "portal-logo-node portal-logo-node-c", cx: "45", cy: "40", r: "4" }),
    React.createElement("circle", { className: "portal-logo-node portal-logo-node-d", cx: "32", cy: "47", r: "4" }),
    React.createElement("circle", { className: "portal-logo-node portal-logo-node-e", cx: "19", cy: "40", r: "4" }),
    React.createElement("circle", { className: "portal-logo-node portal-logo-node-f", cx: "19", cy: "24", r: "4" }),
    );
}

function PortalBrandMark({ branding, size = "compact" }) {
    const logoUrl = branding?.logoUrl || null;
    const frameClassName = `portal-logo-frame${size === "large" ? " is-large" : ""}${logoUrl ? " has-image" : ""}`;
    return React.createElement("div", {
        className: frameClassName,
        "aria-hidden": "true",
    },
    logoUrl
        ? React.createElement("img", {
            className: "portal-logo-image",
            src: logoUrl,
            alt: "",
        })
        : React.createElement(DefaultPortalLogo, {
            className: "portal-logo",
        }));
}

function PortalLoadingScreen({ branding, ui, shellStyle, error = null }) {
    return React.createElement("div", { className: "portal-gate", style: shellStyle },
        React.createElement("div", { className: "portal-gate-card" },
            React.createElement("div", { className: "portal-gate-brand" },
                React.createElement(PortalBrandMark, { branding, size: "large" }),
                React.createElement("div", { className: "portal-gate-kicker" }, getWorkspaceTitle(branding))),
            React.createElement("h1", { className: "portal-gate-title" }, error ? "Portal startup failed" : (ui?.loadingMessage || "Preparing your workspace")),
            React.createElement("p", { className: "portal-gate-copy" }, error || ui?.loadingCopy || "Connecting the shared workspace and live session feeds..."),
        ));
}

function PortalSignedOut({ branding, authUi, authConfig, error, onSignIn, shellStyle }) {
    const providerDisplayName = authConfig?.displayName || branding?.title || "Authentication";
    return React.createElement("div", { className: "portal-gate", style: shellStyle },
        React.createElement("div", { className: "portal-gate-card" },
            React.createElement("div", { className: "portal-gate-brand" },
                React.createElement(PortalBrandMark, { branding, size: "large" }),
                React.createElement("div", { className: "portal-gate-kicker" }, providerDisplayName)),
            React.createElement("h1", { className: "portal-gate-title" }, authUi?.signInTitle || `Sign in to ${getWorkspaceTitle(branding)}`),
            React.createElement("p", { className: "portal-gate-copy" }, resolveSignInMessage({
                authUi,
                authConfig,
                branding,
                error,
            })),
            React.createElement("button", {
                type: "button",
                className: "portal-primary-button",
                onClick: () => onSignIn().catch(() => {}),
            }, authUi?.signInLabel || "Sign In"),
        ));
}

function PortalForbidden({ branding, authUi, authConfig, error, onSignOut, shellStyle }) {
    const providerDisplayName = authConfig?.displayName || branding?.title || "Authentication";
    return React.createElement("div", { className: "portal-gate", style: shellStyle },
        React.createElement("div", { className: "portal-gate-card" },
            React.createElement("div", { className: "portal-gate-brand" },
                React.createElement(PortalBrandMark, { branding, size: "large" }),
                React.createElement("div", { className: "portal-gate-kicker" }, providerDisplayName)),
            React.createElement("h1", { className: "portal-gate-title" }, `Access denied for ${getWorkspaceTitle(branding)}`),
            React.createElement("p", { className: "portal-gate-copy" }, error || "This signed-in account is not authorized to access this workspace."),
            React.createElement("button", {
                type: "button",
                className: "portal-primary-button",
                onClick: () => onSignOut().catch(() => {}),
            }, "Sign Out"),
        ));
}

function PortalHeader({ account, authEnabled, branding, onSignOut, versionLabel = null }) {
    const name = account?.name || account?.username || "Signed in";
    const email = account?.username || account?.idTokenClaims?.preferred_username || "";
    return React.createElement("header", { className: "portal-header" },
        React.createElement("div", { className: "portal-header-brand" },
            React.createElement(PortalBrandMark, { branding }),
            React.createElement("div", { className: "portal-header-brand-copy" },
                React.createElement("span", { className: "portal-header-kicker" }, getWorkspaceTitle(branding)),
                authEnabled
                    ? React.createElement("div", { className: "portal-header-identity-stack" },
                        React.createElement("span", { className: "portal-header-name" }, name),
                        email && email !== name
                            ? React.createElement("span", { className: "portal-header-email" }, email)
                            : null)
                    : React.createElement("span", { className: "portal-header-identity is-muted" }, "Auth disabled"))),
        (authEnabled || versionLabel)
            ? React.createElement("div", { className: "portal-header-user" },
                versionLabel
                    ? React.createElement("span", { className: "portal-header-version" }, versionLabel)
                    : null,
                authEnabled
                    ? React.createElement("button", {
                        type: "button",
                        className: "portal-secondary-button",
                        onClick: () => onSignOut().catch(() => {}),
                    }, "Sign Out")
                    : null)
            : null,
    );
}

function PortalWorkspace({ auth, portal, shellStyle }) {
    const transport = React.useMemo(() => new BrowserPortalTransport({
        getAccessToken: auth.getAccessToken,
        onUnauthorized: auth.handleUnauthorized,
        onForbidden: auth.handleForbidden,
    }), [auth.getAccessToken, auth.handleForbidden, auth.handleUnauthorized]);
    const controller = React.useMemo(() => createWebPilotSwarmController({
        transport,
        mode: "remote",
        branding: {
            title: portal?.branding?.title || "PilotSwarm",
            splash: portal?.branding?.splash || "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}",
        },
    }), [portal?.branding?.splash, portal?.branding?.title, transport]);

    React.useEffect(() => {
        let active = true;
        controller.start().catch((error) => {
            if (!active) return;
            controller.dispatch({
                type: "connection/error",
                error: error?.message || String(error),
                statusText: `Startup failed: ${error?.message || String(error)}`,
            });
        });
        return () => {
            active = false;
            controller.stop().catch(() => {});
            transport.stop().catch(() => {});
        };
    }, [controller, transport]);

    return React.createElement("div", { className: "portal-app-shell", style: shellStyle },
        React.createElement(PortalHeader, {
            account: auth.account,
            authEnabled: auth.authEnabled,
            branding: portal?.branding,
            onSignOut: auth.signOut,
            versionLabel: PILOTSWARM_PORTAL_VERSION_LABEL,
        }),
        React.createElement("main", { className: "portal-main" },
            React.createElement(PilotSwarmWebApp, { controller })),
    );
}

export default function App() {
    const publicConfig = usePortalPublicConfig();
    const auth = usePortalAuth(publicConfig.config?.auth || null);
    const appHeight = useVisualViewportHeight();
    const shellStyle = appHeight
        ? { "--ps-app-height": `${appHeight}px` }
        : undefined;

    if (publicConfig.loading || auth.loading) {
        return React.createElement(PortalLoadingScreen, {
            branding: publicConfig.config?.portal?.branding,
            ui: publicConfig.config?.portal?.ui,
            shellStyle,
            error: publicConfig.error,
        });
    }
    if (publicConfig.error) {
        return React.createElement(PortalLoadingScreen, {
            branding: publicConfig.config?.portal?.branding,
            ui: publicConfig.config?.portal?.ui,
            shellStyle,
            error: publicConfig.error,
        });
    }
    if (!auth.signedIn) {
        return React.createElement(PortalSignedOut, {
            branding: publicConfig.config?.portal?.branding,
            authUi: publicConfig.config?.portal?.auth,
            authConfig: publicConfig.config?.auth,
            error: auth.error,
            onSignIn: auth.signIn,
            shellStyle,
        });
    }
    if (auth.forbidden) {
        return React.createElement(PortalForbidden, {
            branding: publicConfig.config?.portal?.branding,
            authUi: publicConfig.config?.portal?.auth,
            authConfig: publicConfig.config?.auth,
            error: auth.error,
            onSignOut: auth.signOut,
            shellStyle,
        });
    }
    return React.createElement(PortalWorkspace, {
        auth,
        portal: publicConfig.config?.portal,
        shellStyle,
    });
}
