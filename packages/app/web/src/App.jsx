import React from "react";
import { createWebPilotSwarmController, PilotSwarmWebApp } from "pilotswarm/ui-react";
import { getTheme } from "pilotswarm/ui-core";
import { selectSessionFilterExceptionNotice, selectStatusBar } from "pilotswarm/ui-core";
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
// Deep links stash ?session= in sessionStorage before sign-in because the
// redirect-based sign-in path (mobile Entra loginRedirect) returns to the bare
// redirectUri and drops the query string; popup/dev sign-ins never navigate,
// so the URL param survives those on its own.
const DEEP_LINK_SESSION_STORAGE_KEY = "pilotswarm.portal.deepLinkSession";

/**
 * A deep-link target: `?session=<id>[&artifact=<filename>][&view=full|canvas]`.
 *
 * The artifact form is what the agent's show_artifact tool hands back and what
 * the Files "copy link" button produces, so a link pasted into chat, mailed to
 * a colleague, or opened in a new tab all land on the same preview.
 * `view=canvas` opens the session with its canvas up — the shareable "look at
 * the dashboard" link.
 */
function readDeepLinkTargetFromUrl() {
    if (typeof window === "undefined" || !window.location) return null;
    const params = new URLSearchParams(window.location.search);
    const sessionId = (params.get("session") || "").trim();
    if (!sessionId) return null;
    const artifact = (params.get("artifact") || "").trim();
    const view = (params.get("view") || "").trim().toLowerCase();
    return {
        sessionId,
        artifact: artifact || null,
        fullscreen: view === "full",
        canvas: view === "canvas",
    };
}

function stashDeepLinkTarget() {
    const target = readDeepLinkTargetFromUrl();
    if (!target) return;
    try {
        window.sessionStorage.setItem(DEEP_LINK_SESSION_STORAGE_KEY, JSON.stringify(target));
    } catch {
        // Session storage unavailable; the URL params still cover non-redirect sign-ins.
    }
}

function parseStashedDeepLinkTarget(raw) {
    if (!raw) return null;
    // Older builds stashed a bare session id string. A stash written before an
    // upgrade can still be sitting in this tab when the new bundle loads.
    if (!raw.startsWith("{")) return { sessionId: raw, artifact: null, fullscreen: false };
    try {
        const parsed = JSON.parse(raw);
        const sessionId = String(parsed?.sessionId || "").trim();
        if (!sessionId) return null;
        return {
            sessionId,
            artifact: parsed?.artifact ? String(parsed.artifact) : null,
            canvas: Boolean(parsed?.canvas),
            fullscreen: Boolean(parsed?.fullscreen),
        };
    } catch {
        return null;
    }
}

// Consumed at most once per page load (StrictMode double-invokes render-phase
// callers, and clearing the stash twice would lose a redirect-restored target).
let consumedDeepLinkTarget = null;
let deepLinkConsumed = false;

function consumeDeepLinkTarget() {
    if (deepLinkConsumed) return consumedDeepLinkTarget;
    deepLinkConsumed = true;
    let stashed = null;
    try {
        stashed = window.sessionStorage.getItem(DEEP_LINK_SESSION_STORAGE_KEY);
        window.sessionStorage.removeItem(DEEP_LINK_SESSION_STORAGE_KEY);
    } catch {
        // ignore
    }
    consumedDeepLinkTarget = readDeepLinkTargetFromUrl() || parseStashedDeepLinkTarget(stashed);
    return consumedDeepLinkTarget;
}

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

function derivePortalStatusText(state) {
    // The transient deep-link filter-exception notice shares the header status
    // surface — unobtrusive, ahead of the regular status text when both exist.
    const notice = selectSessionFilterExceptionNotice(state);
    const left = selectStatusBar(state).left || "";
    if (!notice) return left;
    return left ? `${notice} · ${left}` : notice;
}

function usePortalControllerStatusText(controller) {
    const [statusText, setStatusText] = React.useState(() => derivePortalStatusText(controller.getState()));

    React.useEffect(() => controller.subscribe((nextState) => {
        const nextStatusText = derivePortalStatusText(nextState);
        setStatusText((current) => current === nextStatusText ? current : nextStatusText);
    }), [controller]);

    return statusText;
}

/**
 * The active theme's brand mark, or null.
 *
 * A theme may carry its own icon. When it does it OUTRANKS the deployment's
 * logo — a theme that restyles the entire shell and then leaves a foreign logo
 * in the corner reads as broken, and the icon is the one piece of branding the
 * theme is entitled to speak for.
 *
 * The deployment's TITLE is untouched: a layered app is still Waldemort, and
 * renaming it would be a lie. Only the mark follows the theme.
 */
function useThemeIcon(controller) {
    const read = React.useCallback(
        () => getTheme(controller.getState()?.ui?.themeId)?.icon || null,
        [controller],
    );
    const [icon, setIcon] = React.useState(read);
    React.useEffect(() => controller.subscribe(() => {
        const next = read();
        setIcon((current) => (current === next ? current : next));
    }), [controller, read]);
    return icon;
}

function ThemeIconMark({ icon, className = "portal-logo" }) {
    return React.createElement("svg", {
        className: `${className} portal-logo-theme`,
        viewBox: icon.viewBox,
        "aria-hidden": "true",
    }, icon.paths.map((path, index) => React.createElement("path", {
        key: index, d: path.d, fill: path.fill,
    })));
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

function PortalBrandMark({ branding, size = "compact", themeIcon = null }) {
    // Precedence: the theme's own mark, then the deployment's logo, then the
    // built-in swarm. The theme wins because it owns every other pixel of the
    // shell; the deployment still owns the name beside it.
    const logoUrl = !themeIcon && branding?.logoUrl ? branding.logoUrl : null;
    const frameClassName = `portal-logo-frame${size === "large" ? " is-large" : ""}${logoUrl ? " has-image" : ""}${themeIcon ? " has-theme-icon" : ""}`;
    return React.createElement("div", {
        className: frameClassName,
        "aria-hidden": "true",
    },
    themeIcon
        ? React.createElement(ThemeIconMark, { icon: themeIcon })
        : logoUrl
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

function DevPersonaPicker({ authConfig, onSignIn }) {
    const users = authConfig?.client?.users || [];
    return React.createElement("div", { className: "portal-dev-persona-list" },
        users.map((user) => React.createElement("button", {
            key: user.id,
            type: "button",
            className: "portal-dev-persona-button",
            onClick: () => onSignIn(user.id).catch(() => {}),
        },
        React.createElement("span", { className: "portal-dev-persona-initials" },
            (user.displayName || user.id).split(/\s+/).map((part) => part.charAt(0)).join("").slice(0, 2).toLowerCase()),
        React.createElement("span", { className: "portal-dev-persona-name" }, user.displayName || user.id),
        React.createElement("span", { className: `portal-dev-persona-role is-${user.role}` }, user.role),
        )));
}

function PortalSignedOut({ branding, authUi, authConfig, error, onSignIn, shellStyle }) {
    const providerDisplayName = authConfig?.displayName || branding?.title || "Authentication";
    const isDevProvider = authConfig?.provider === "dev";
    return React.createElement("div", { className: "portal-gate", style: shellStyle },
        React.createElement("div", { className: "portal-gate-card" },
            isDevProvider
                ? React.createElement("div", { className: "portal-dev-banner" }, authConfig?.banner || "DEV AUTH — not for production")
                : null,
            React.createElement("div", { className: "portal-gate-brand" },
                React.createElement(PortalBrandMark, { branding, size: "large" }),
                React.createElement("div", { className: "portal-gate-kicker" }, providerDisplayName)),
            React.createElement("h1", { className: "portal-gate-title" }, isDevProvider
                ? `Sign in to ${getWorkspaceTitle(branding)} as…`
                : (authUi?.signInTitle || `Sign in to ${getWorkspaceTitle(branding)}`)),
            React.createElement("p", { className: "portal-gate-copy" }, isDevProvider
                ? (error || "Pick a test persona. Each browser tab can sign in as a different persona.")
                : resolveSignInMessage({
                    authUi,
                    authConfig,
                    branding,
                    error,
                })),
            isDevProvider
                ? React.createElement(DevPersonaPicker, { authConfig, onSignIn })
                : React.createElement("button", {
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

/**
 * This tab's build id: the hash Vite baked into the chunk this module lives
 * in. Compared against what the server currently serves so a stale tab can
 * offer a reload. Not displayed — it is a diagnostic, not product copy.
 */
/**
 * This tab's own bundle filename, e.g. "index-B-TEKrRB.js".
 *
 * The WHOLE filename, deliberately. This used to parse the content hash out
 * and compare six characters of it, with one regex for our own filename and a
 * different one for the hashes in index.html — and the two disagreed whenever
 * the hash itself contained a hyphen, which Vite's base64url alphabet emits
 * routinely. For "index-B-TEKrRB.js" the self-regex matched from the FIRST
 * hyphen ("B-TEKr") while the served-regex backtracked to the LAST ("TEKrRB"),
 * so the tab could never find itself in the served list and every user saw
 * "New build — reload" forever, on a build that was already current. Reloading
 * could not clear it, because the next load hit the same mismatch.
 *
 * Comparing filenames needs no hash grammar at all, so no alphabet change can
 * reintroduce this.
 */
const BUILD_FILE = (() => {
    try {
        const file = new URL(import.meta.url).pathname.split("/").pop() || "";
        return /\.js$/.test(file) ? file : "dev";
    } catch {
        return "dev";
    }
})();

/**
 * A long-lived tab keeps running the JS it loaded, so a deploy is invisible
 * until a reload — which reads as "the fix didn't ship". index.html is
 * served no-store, so its current asset hashes are the truth: poll it and
 * offer a reload when they no longer match this tab's.
 */
function useBuildFreshness() {
    const [stale, setStale] = React.useState(false);
    React.useEffect(() => {
        if (BUILD_FILE === "dev" || typeof window === "undefined") return undefined;
        let cancelled = false;
        const check = async () => {
            try {
                const response = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
                if (!response.ok) return;
                const html = await response.text();
                // Entry filenames only — same shape as BUILD_FILE, no hash parsing.
                const served = [...html.matchAll(/assets\/([A-Za-z0-9_.-]+\.js)/g)]
                    .map((match) => match[1]);
                // Only ever ADVERTISE staleness, never retract it: a flaky poll
                // that briefly returns a partial document must not flip the
                // banner off while the tab really is behind.
                if (!cancelled && served.length > 0 && !served.includes(BUILD_FILE)) setStale(true);
            } catch { /* offline or blocked — try again next tick */ }
        };
        void check();
        const timer = window.setInterval(check, 60_000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, []);
    return stale;
}

function PortalHeader({ account, authEnabled, isAdmin = false, branding, onSignOut, versionLabel = null, statusText = "", themeIcon = null }) {
    const buildStale = useBuildFreshness();
    // Admins are marked with a leading "(*)" so elevated rights are visible at a glance.
    const baseName = account?.name || account?.username || "Signed in";
    const name = isAdmin ? `(*) ${baseName}` : baseName;
    const email = account?.username || account?.idTokenClaims?.preferred_username || "";
    return React.createElement("header", { className: "portal-header" },
        React.createElement("div", { className: "portal-header-brand" },
            React.createElement(PortalBrandMark, { branding, themeIcon }),
            React.createElement("div", { className: "portal-header-brand-copy" },
                React.createElement("span", { className: "portal-header-kicker" }, getWorkspaceTitle(branding)),
                authEnabled
                    ? React.createElement("div", { className: "portal-header-identity-stack" },
                        React.createElement("span", { className: "portal-header-name" }, name),
                        email && email !== name
                            ? React.createElement("span", { className: "portal-header-email" }, email)
                            : null)
                    : React.createElement("span", { className: "portal-header-identity is-muted" }, "Auth disabled"))),
        // Slot the workspace toolbar portals into when the rich UI is on, so
        // the app has ONE top bar instead of a header plus a button strip.
        // Always rendered (empty otherwise) so the portal target is stable.
        React.createElement("div", { className: "portal-header-slot", id: "ps-header-toolbar-slot" }),
        (authEnabled || versionLabel || statusText)
            ? React.createElement("div", { className: "portal-header-user" },
                React.createElement("div", { className: "portal-header-meta" },
                    versionLabel
                        ? React.createElement("span", { className: "portal-header-version" }, versionLabel)
                        : null,
                    buildStale
                        ? React.createElement("button", {
                            type: "button",
                            className: "portal-header-refresh",
                            title: "A newer build is deployed — this tab is still running the one it loaded",
                            onClick: () => window.location.reload(),
                        }, "↻ New build — reload")
                        : null,
                    statusText
                        ? React.createElement("span", { className: "portal-header-status" }, statusText)
                        : null),
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

// On narrow screens the header can't fit the identity, version, and a
// transient status message on one line, so the status is lifted into its own
// dismissible row between the header and the toolbar (CSS hides this on
// desktop, where the header placement is fine).
function PortalMobileStatus({ statusText, onDismiss }) {
    if (!statusText) return null;
    return React.createElement("div", { className: "portal-mobile-status" },
        React.createElement("span", { className: "portal-mobile-status-text" }, statusText),
        React.createElement("button", {
            type: "button",
            className: "portal-mobile-status-dismiss",
            "aria-label": "Dismiss message",
            title: "Dismiss",
            onClick: onDismiss,
        }, "✕"));
}

function PortalWorkspace({ auth, portal, shellStyle }) {
    const transport = React.useMemo(() => new BrowserPortalTransport({
        getAccessToken: auth.getAccessToken,
        getResourceToken: auth.getResourceToken,
        onUnauthorized: auth.handleUnauthorized,
        onForbidden: auth.handleForbidden,
    }), [auth.getAccessToken, auth.getResourceToken, auth.handleForbidden, auth.handleUnauthorized]);
    const controller = React.useMemo(() => createWebPilotSwarmController({
        transport,
        mode: "remote",
        branding: {
            title: portal?.branding?.title || "PilotSwarm",
            splash: portal?.branding?.splash || "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}",
            splashMobile: portal?.branding?.splashMobile || null,
        },
        // A layered deployment ships its own agent-authoring guide; the link
        // in the Add/Update package dialog follows it.
        docs: portal?.docs || null,
    }), [portal?.branding?.splash, portal?.branding?.splashMobile, portal?.branding?.title, portal?.docs, transport]);
    const statusText = usePortalControllerStatusText(controller);
    const themeIcon = useThemeIcon(controller);
    // Dismissing hides the mobile status row until a *different* message
    // arrives (a repeat of the same text stays dismissed).
    const [dismissedStatus, setDismissedStatus] = React.useState("");
    const mobileStatusText = statusText && statusText !== dismissedStatus ? statusText : "";
    const deepLinkTarget = React.useMemo(() => consumeDeepLinkTarget(), []);
    const initialSessionId = deepLinkTarget?.sessionId || null;

    React.useEffect(() => {
        let active = true;
        controller.start({ initialSessionId })
            .then(() => {
                // An artifact deep link opens the chat AND the artifact, side by
                // side — the transcript is the context that makes the artifact
                // mean something, so landing on the file alone loses half of
                // what was shared. Runs AFTER start() so the session is loaded
                // and its artifact list is reachable.
                //
                // A phone has no room for both and gets the full-viewport
                // overlay instead.
                if (!active || !initialSessionId) return null;
                // ?view=canvas: land with the canvas up. Desktop flips the
                // right column; the phone follows the flip tick into its
                // canvas tab (the same path an agent-driven flip takes).
                if (deepLinkTarget?.canvas) {
                    controller.dispatch({ type: "canvas/flip", sessionId: initialSessionId });
                    return null;
                }
                if (!deepLinkTarget?.artifact) return null;
                const isPhone = typeof window !== "undefined"
                    && typeof window.matchMedia === "function"
                    && window.matchMedia("(max-width: 920px)").matches;
                return controller.revealArtifact(initialSessionId, deepLinkTarget.artifact, isPhone
                    ? { fullscreen: true }
                    : { pane: true }).catch(() => null);
            })
            .catch((error) => {
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
    }, [controller, deepLinkTarget, initialSessionId, transport]);

    return React.createElement("div", { className: "portal-app-shell", style: shellStyle },
        auth.provider === "dev"
            ? React.createElement("div", { className: "portal-dev-banner is-fixed" },
                `${auth.config?.banner || "DEV AUTH — not for production"} · signed in as ${auth.account?.name || "?"}`)
            : null,
        React.createElement(PortalHeader, {
            account: auth.account,
            authEnabled: auth.authEnabled,
            isAdmin: auth.authorization?.role === "admin",
            branding: portal?.branding,
            onSignOut: auth.signOut,
            versionLabel: PILOTSWARM_PORTAL_VERSION_LABEL,
            statusText,
            themeIcon,
        }),
        React.createElement(PortalMobileStatus, {
            statusText: mobileStatusText,
            onDismiss: () => setDismissedStatus(statusText),
        }),
        React.createElement("main", { className: "portal-main" },
            React.createElement(PilotSwarmWebApp, { controller })),
    );
}

export default function App() {
    const publicConfig = usePortalPublicConfig();
    const auth = usePortalAuth(publicConfig.config?.auth || null);
    const appHeight = useVisualViewportHeight();

    // Stash only while the sign-in gate is up — a signed-in load consumes the
    // URL param directly, and stashing then would leave a stale id behind.
    const showSignInGate = !publicConfig.loading && !auth.loading && !auth.signedIn;
    React.useEffect(() => {
        if (showSignInGate) stashDeepLinkTarget();
    }, [showSignInGate]);
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
