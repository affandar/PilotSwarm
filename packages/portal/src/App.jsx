import React from "react";
import { createWebPilotSwarmController, PilotSwarmWebApp } from "pilotswarm-ui-react";
import { BrowserPortalTransport } from "./browser-transport.js";
import { usePortalAuth } from "./auth-client.js";

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

function PilotSwarmLogo() {
    return React.createElement("div", { className: "portal-logo-frame", "aria-hidden": "true" },
        React.createElement("svg", {
            className: "portal-logo",
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
        ),
    );
}

function PortalLoadingScreen({ message, shellStyle }) {
    return React.createElement("div", { className: "portal-gate", style: shellStyle },
        React.createElement("div", { className: "portal-gate-card" },
            React.createElement("div", { className: "portal-gate-kicker" }, "PilotSwarm"),
            React.createElement("h1", { className: "portal-gate-title" }, message),
            React.createElement("p", { className: "portal-gate-copy" }, "Connecting the shared PilotSwarm workspace and live session feeds..."),
        ));
}

function PortalSignedOut({ error, onSignIn, shellStyle }) {
    return React.createElement("div", { className: "portal-gate", style: shellStyle },
        React.createElement("div", { className: "portal-gate-card" },
            React.createElement("div", { className: "portal-gate-kicker" }, "Entra ID"),
            React.createElement("h1", { className: "portal-gate-title" }, "Sign in to PilotSwarm"),
            React.createElement("p", { className: "portal-gate-copy" }, error || "Use your corporate Microsoft account to open the browser-native PilotSwarm workspace."),
            React.createElement("button", {
                type: "button",
                className: "portal-primary-button",
                onClick: () => onSignIn().catch(() => {}),
            }, "Sign In"),
        ));
}

function PortalHeader({ account, authEnabled, onSignOut }) {
    const name = account?.name || account?.username || "Signed in";
    const email = account?.username || account?.idTokenClaims?.preferred_username || "";
    return React.createElement("header", { className: "portal-header" },
        React.createElement("div", { className: "portal-header-brand" },
            React.createElement(PilotSwarmLogo, null),
            React.createElement("div", { className: "portal-header-brand-copy" },
                React.createElement("span", { className: "portal-header-kicker" }, "PilotSwarm"),
                authEnabled
                    ? React.createElement("div", { className: "portal-header-identity-stack" },
                        React.createElement("span", { className: "portal-header-name" }, name),
                        email && email !== name
                            ? React.createElement("span", { className: "portal-header-email" }, email)
                            : null)
                    : React.createElement("span", { className: "portal-header-identity is-muted" }, "Auth disabled"))),
        authEnabled
            ? React.createElement("div", { className: "portal-header-user" },
                React.createElement("button", {
                    type: "button",
                    className: "portal-secondary-button",
                    onClick: () => onSignOut().catch(() => {}),
                }, "Sign Out"))
            : null,
    );
}

function PortalWorkspace({ auth, shellStyle }) {
    const transport = React.useMemo(() => new BrowserPortalTransport({
        getAccessToken: auth.getAccessToken,
        onUnauthorized: auth.handleUnauthorized,
    }), [auth.getAccessToken, auth.handleUnauthorized]);
    const controller = React.useMemo(() => createWebPilotSwarmController({
        transport,
        mode: "remote",
        branding: {
            title: "PilotSwarm",
            splash: "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}",
        },
    }), [transport]);

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
            onSignOut: auth.signOut,
        }),
        React.createElement("main", { className: "portal-main" },
            React.createElement(PilotSwarmWebApp, { controller })),
    );
}

export default function App() {
    const auth = usePortalAuth();
    const appHeight = useVisualViewportHeight();
    const shellStyle = appHeight
        ? { "--ps-app-height": `${appHeight}px` }
        : undefined;

    if (auth.loading) {
        return React.createElement(PortalLoadingScreen, {
            message: "Preparing your workspace",
            shellStyle,
        });
    }
    if (!auth.signedIn) {
        return React.createElement(PortalSignedOut, {
            error: auth.error,
            onSignIn: auth.signIn,
            shellStyle,
        });
    }
    return React.createElement(PortalWorkspace, {
        auth,
        shellStyle,
    });
}
