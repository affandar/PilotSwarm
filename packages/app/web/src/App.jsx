import { useMoa, MoaWorkspace, MoaImport, stashMoaLink } from "./moa/MoaWorkspace.jsx";
import React from "react";
import { createPortal } from "react-dom";
import { createWebPilotSwarmController, PilotSwarmWebApp, setPortalLinkOrigins } from "pilotswarm/ui-react";
import { jsonMergePatch } from "pilotswarm-sdk/api";
import { getTheme } from "pilotswarm/ui-core";
import { selectSessionFilterExceptionNotice, selectStatusBar } from "pilotswarm/ui-core";
import { BrowserPortalTransport } from "./browser-transport.js";
import { usePortalAuth } from "./auth-client.js";
import { PILOTSWARM_PORTAL_VERSION_LABEL } from "./version.js";
import {
    DEEP_LINK_SESSION_STORAGE_KEY,
    parseStashedDeepLinkTarget,
    readDeepLinkTargetFromUrl,
    writeShowChromeParam,
} from "./lib/deep-link.js";

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

function stashDeepLinkTarget() {
    const target = readDeepLinkTargetFromUrl();
    if (!target) return;
    try {
        window.sessionStorage.setItem(DEEP_LINK_SESSION_STORAGE_KEY, JSON.stringify(target));
    } catch {
        // Session storage unavailable; the URL params still cover non-redirect sign-ins.
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
            // iOS Safari pans the page to reveal a focused input above the
            // on-screen keyboard; the shell absorbs that by sizing itself to
            // height + offsetTop. But Safari sometimes fails to undo the pan
            // after the keyboard closes, leaving the app stuck half-scrolled.
            // When the visual viewport is back to (near) full height, any
            // remaining window scroll is that stale pan — undo it.
            const viewport = window.visualViewport;
            const keyboardClosed = !viewport
                || (window.innerHeight - viewport.height) < 24;
            if (keyboardClosed && (window.scrollY || window.scrollX)) {
                window.scrollTo(0, 0);
            }
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

function PortalHeader({ account, authEnabled, isAdmin = false, branding, onSignOut, versionLabel = null, statusText = "", themeIcon = null, moaControl = null }) {
    const buildStale = useBuildFreshness();
    // The desktop toolbar (portalled into this header) exposes two slots so
    // the right side reads as ONE cluster: version/status · bug · settings ·
    // sign-out. Found after mount — the toolbar renders in the same commit
    // cycle — and re-sought while absent (mobile has no slots; fall back to
    // the inline layout below).
    const [metaSlot, setMetaSlot] = React.useState(null);
    const [signOutSlot, setSignOutSlot] = React.useState(null);
    React.useEffect(() => {
        let raf = 0;
        const find = () => {
            const m = document.getElementById("ps-toolbar-meta-slot");
            const o = document.getElementById("ps-toolbar-signout-slot");
            setMetaSlot(m || null);
            setSignOutSlot(o || null);
            if (!m || !o) raf = requestAnimationFrame(find);
        };
        find();
        return () => cancelAnimationFrame(raf);
    });
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
        moaControl,
        React.createElement("div", { className: "portal-header-slot", id: "ps-header-toolbar-slot" }),
        (() => {
            const metaNode = (versionLabel || statusText || buildStale)
                ? React.createElement("div", { className: "portal-header-meta" },
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
                        : null)
                : null;
            const signOutNode = authEnabled
                ? React.createElement("button", {
                    type: "button",
                    // Same classes as the bug/settings buttons, so all three
                    // land the exact same size.
                    className: signOutSlot ? "ps-toolbar-button ps-icon-button" : "portal-secondary-button is-icon",
                    onClick: () => onSignOut().catch(() => {}),
                    title: "Sign out",
                    "aria-label": "Sign out",
                }, React.createElement("svg", { viewBox: "0 0 20 20", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
                    React.createElement("path", { d: "M12.5 3.5H5.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h7" }),
                    React.createElement("path", { d: "M13.5 6.8 16.7 10l-3.2 3.2M16.5 10H8" })))
                : null;
            if (metaSlot || signOutSlot) {
                return React.createElement(React.Fragment, null,
                    metaSlot && metaNode ? createPortal(metaNode, metaSlot) : null,
                    signOutSlot && signOutNode ? createPortal(signOutNode, signOutSlot) : null,
                    // Anything the slots could not take stays inline.
                    (!metaSlot && metaNode) || (!signOutSlot && signOutNode)
                        ? React.createElement("div", { className: "portal-header-user" },
                            !metaSlot ? metaNode : null,
                            !signOutSlot ? signOutNode : null)
                        : null);
            }
            return (metaNode || signOutNode)
                ? React.createElement("div", { className: "portal-header-user" }, metaNode, signOutNode)
                : null;
        })(),
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

/**
 * The bare strip that stands in for the portal header when a link asked for
 * `show_chrome=false`.
 *
 * It names the deployment through the SAME `getWorkspaceTitle` the real header
 * kicker uses, so the two can never disagree: a stock deployment reads
 * "PilotSwarm", and one whose plugin sets `portal.title` reads that instead.
 *
 * The restore control is deliberately recessed — near-invisible until hovered
 * or focused — because the whole point of this mode is that nothing competes
 * with the canvas. It stays a real <button> with a visible focus ring so
 * keyboard users can still reach it.
 */
function PortalChromelessStrip({ branding, onShowChrome }) {
    return React.createElement("div", { className: "portal-chromeless-strip" },
        React.createElement("span", { className: "portal-chromeless-strip-label" },
            `${getWorkspaceTitle(branding)} · Live canvas`),
        React.createElement("button", {
            type: "button",
            className: "portal-chromeless-strip-restore",
            onClick: onShowChrome,
            title: "Show the header and workspace chrome",
        }, "Show chrome"));
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
    const moa = useMoa(controller);
    const createPanelTransport = React.useCallback(() => new BrowserPortalTransport({
        getAccessToken: auth.getAccessToken, getResourceToken: auth.getResourceToken,
        onUnauthorized: auth.handleUnauthorized,
    }), [auth.getAccessToken, auth.getResourceToken, auth.handleUnauthorized]);
    const statusText = usePortalControllerStatusText(controller);
    const themeIcon = useThemeIcon(controller);
    // Dismissing hides the mobile status row until a *different* message
    // arrives (a repeat of the same text stays dismissed).
    const [dismissedStatus, setDismissedStatus] = React.useState("");
    const mobileStatusText = statusText && statusText !== dismissedStatus ? statusText : "";
    const deepLinkTarget = React.useMemo(() => consumeDeepLinkTarget(), []);
    const initialSessionId = deepLinkTarget?.sessionId || null;
    // State rather than a bare read of the target, so "Show chrome" can put the
    // header back without a reload (which would re-consume nothing — the deep
    // link is consumed once per page load — and lose the open canvas).
    const [chromeHidden, setChromeHidden] = React.useState(() => Boolean(deepLinkTarget?.hideChrome));

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
                    controller.dispatch({
                        type: "canvas/flip",
                        sessionId: initialSessionId,
                        // Undefined/invalid falls back to slot 1 inside the
                        // reducer, which is the behavior every link had before
                        // this value was read at all.
                        slot: deepLinkTarget?.slot ?? undefined,
                    });
                    if (deepLinkTarget?.max) {
                        controller.dispatch({ type: "ui/canvasMaximized", on: true });
                    }
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

    return React.createElement("div", { className: `portal-app-shell${chromeHidden ? " is-chromeless" : ""}${moa.zen ? " is-moa-zen" : ""}`, style: shellStyle },
        // The dev-auth banner survives chrome hiding on purpose: it warns that
        // the deployment is running an auth mode with no real identity behind
        // it, and a cosmetic display option is not a reason to suppress a
        // security notice.
        auth.provider === "dev"
            ? React.createElement("div", { className: "portal-dev-banner is-fixed" },
                `${auth.config?.banner || "DEV AUTH — not for production"} · signed in as ${auth.account?.name || "?"}`)
            : null,
        chromeHidden
            ? React.createElement(PortalChromelessStrip, {
                branding: portal?.branding,
                onShowChrome: () => {
                    setChromeHidden(false);
                    // Keep the address bar honest: a reload, or the URL copied
                    // out of the bar and passed on, must reproduce the view the
                    // person is actually looking at — not the one they left.
                    // Redirect sign-in returns to a bare URL, so hand the
                    // consumed target back to the writer to restore the link's
                    // session/view/slot fields as well as the chrome flag.
                    writeShowChromeParam(true, deepLinkTarget);
                },
            })
            : null,
        // Keep the real header mounted while chromeless. The desktop toolbar
        // discovers its portal target only after mount; removing the target on
        // a chromeless landing made "Show chrome" restore an empty header and
        // leave the toolbar stranded as a second inline row. CSS removes this
        // mounted header from layout, focus order and the accessibility tree.
        React.createElement(PortalHeader, {
            account: auth.account,
            authEnabled: auth.authEnabled,
            isAdmin: auth.authorization?.role === "admin",
            branding: portal?.branding,
            onSignOut: auth.signOut,
            versionLabel: PILOTSWARM_PORTAL_VERSION_LABEL,
            statusText,
            themeIcon,
            moaControl: moa.desktop && !moa.active ? React.createElement("button", { className: `ps-mini-button ps-moa-launch${moa.returnTo ? " ps-moa-return" : ""}`, disabled: !moa.loaded, onClick: () => { controller.dispatch({ type: "ui/canvasMaximized", on: false }); moa.open(); } }, moa.returnTo ? "← Back to MoA" : "Master of Agents") : null,
        }),
        chromeHidden
            ? null
            : React.createElement(PortalMobileStatus, {
                statusText: mobileStatusText,
                onDismiss: () => setDismissedStatus(statusText),
            }),
        React.createElement("main", { className: "portal-main" },
            React.createElement(PilotSwarmWebApp, { controller, suspended: moa.active }),
            moa.active ? React.createElement(MoaWorkspace, { controller, moa, createTransport: createPanelTransport }) : null,
            moa.shared ? React.createElement(MoaImport, { moa, controller }) : null),
    );
}

/**
 * The "anyone with link" landing: a full-viewport, read-only canvas viewer.
 * No portal identity, no workspace — the token in the URL is the whole
 * capability, honored by exactly two doors (the share doc/live routes and
 * the share-scoped WebSocket). Steering is impossible by construction:
 * this page holds no authenticated write path at all, and canvas-action
 * postMessages from the page are simply dropped here.
 */
function CanvasShareView({ token }) {
    const [doc, setDoc] = React.useState(null);          // { url, docRev }
    const [status, setStatus] = React.useState("loading"); // loading | live | gone
    const iframeRef = React.useRef(null);
    const mirrorRef = React.useRef({ seq: 0, payload: null });
    const docRevRef = React.useRef(0);

    const postState = React.useCallback((patch) => {
        const frame = iframeRef.current;
        const m = mirrorRef.current;
        if (!frame?.contentWindow || m.payload === null) return;
        try {
            frame.contentWindow.postMessage({ type: "canvas-data", data: m.payload, dataRev: m.seq }, "*");
            if (patch) {
                frame.contentWindow.postMessage({ type: "canvas-patch", patch, dataRev: m.seq }, "*");
            }
        } catch { /* frame mid-load */ }
    }, []);

    const refetchLive = React.useCallback(async () => {
        const response = await fetch(`/api/canvas-share/live?t=${encodeURIComponent(token)}`);
        if (!response.ok) throw new Error("gone");
        const state = await response.json();
        const live = state?.live;
        if (live && typeof live === "object") {
            mirrorRef.current = { seq: Number(live.seq) || 0, payload: live.payload ?? {} };
            postState();
            return Number(live.docRev) || 0;
        }
        return 0;
    }, [token, postState]);

    const refetchDoc = React.useCallback(async () => {
        const response = await fetch(`/api/canvas-share/doc?t=${encodeURIComponent(token)}`);
        if (!response.ok) throw new Error("gone");
        const html = await response.text();
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        setDoc((old) => {
            if (old?.url) window.setTimeout(() => URL.revokeObjectURL(old.url), 1000);
            return { url };
        });
    }, [token]);

    React.useEffect(() => {
        let active = true;
        (async () => {
            try {
                docRevRef.current = await refetchLive();
                await refetchDoc();
                if (active) setStatus("live");
            } catch {
                if (active) setStatus("gone");
            }
        })();
        return () => { active = false; };
    }, [refetchLive, refetchDoc]);

    // The live feed: a share-scoped WebSocket. Contiguous patches merge
    // locally; anything else (gap, pointer-only ping, redraw) refetches the
    // row/doc — the same discipline as the workspace mirror, in miniature.
    React.useEffect(() => {
        if (status !== "live") return undefined;
        let socket = null;
        let closed = false;
        let retryMs = 1000;
        const connect = () => {
            if (closed) return;
            const wsUrl = `${window.location.origin.replace(/^http/, "ws")}/api/v1/ws?canvasShare=${encodeURIComponent(token)}`;
            socket = new WebSocket(wsUrl);
            socket.addEventListener("open", () => {
                retryMs = 1000;
                socket.send(JSON.stringify({ type: "subscribeCanvas" }));
            });
            socket.addEventListener("message", (event) => {
                let message;
                try { message = JSON.parse(String(event.data || "")); } catch { return; }
                if (message.type !== "canvasLive") return;
                if (message.kind === "doc") {
                    refetchDoc().then(() => refetchLive()).catch(() => setStatus("gone"));
                    return;
                }
                if (message.kind === "kv") {
                    const frame = iframeRef.current;
                    const deliver = (entry) => {
                        try { frame?.contentWindow?.postMessage({ type: "canvas-kv-change", key: message.key, rev: message.rev, op: message.op, ...(entry ? { v: entry.v, by: entry.by, at: entry.at } : {}) }, "*"); } catch { /* frame mid-load */ }
                    };
                    if (message.op === "delete") { deliver(null); return; }
                    if (message.value && typeof message.value === "object") { deliver({ v: message.value.v, by: message.value.by, at: message.value.at }); return; }
                    fetch(`/api/canvas-share/kv?t=${encodeURIComponent(token)}&key=${encodeURIComponent(message.key)}`)
                        .then((r) => (r.ok ? r.json() : null))
                        .then((read) => deliver(read?.entries?.[0] ?? null))
                        .catch(() => { /* the page's next list catches up */ });
                    return;
                }
                const m = mirrorRef.current;
                const seq = Number(message.seq);
                if (message.patch && m.payload !== null && seq === m.seq + 1) {
                    mirrorRef.current = { seq, payload: jsonMergePatch(m.payload, message.patch) };
                    postState(message.patch);
                } else if (!Number.isFinite(seq) || seq !== m.seq) {
                    refetchLive().catch(() => { /* next ping retries */ });
                }
            });
            socket.addEventListener("close", () => {
                if (closed) return;
                window.setTimeout(connect, retryMs);
                retryMs = Math.min(retryMs * 2, 15_000);
            });
        };
        connect();
        return () => {
            closed = true;
            try { socket?.close(); } catch { /* going away */ }
        };
    }, [status, token, refetchDoc, refetchLive, postState]);

    // The KV bridge through the link door — READ ONLY (a read/write link is
    // phase 4). The page asks (`canvas-kv` ready/get/list); writes are
    // refused here so the page can lock its UI honestly. Live changes reach
    // the page as `canvas-kv-change` off the same share socket.
    React.useEffect(() => {
        if (status !== "live") return undefined;
        const post = (message) => {
            try { iframeRef.current?.contentWindow?.postMessage(message, "*"); } catch { /* frame mid-load */ }
        };
        const onMessage = (event) => {
            const frame = iframeRef.current;
            if (!frame || !event.source || event.source !== frame.contentWindow) return;
            const payload = event.data;
            if (!payload || typeof payload !== "object" || payload.type !== "canvas-kv") return;
            const id = payload.id;
            const op = String(payload.op || "");
            if (op === "put" || op === "delete") {
                post({ type: "canvas-kv-result", id, ok: false, code: "FORBIDDEN", error: "this link is view-only" });
                return;
            }
            const q = new URLSearchParams({ t: token });
            if (op === "get" && payload.key) q.set("key", String(payload.key));
            if ((op === "list" || op === "ready") && payload.prefix) q.set("prefix", String(payload.prefix));
            if (payload.after) q.set("after", String(payload.after));
            if (payload.limit) q.set("limit", String(payload.limit));
            fetch(`/api/canvas-share/kv?${q.toString()}`)
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error("gone"))))
                .then((read) => {
                    if (op === "get") {
                        post({ type: "canvas-kv-result", id, ok: true, entry: read?.entries?.[0] ?? null });
                        return;
                    }
                    post({
                        type: op === "ready" ? "canvas-kv-ready" : "canvas-kv-result",
                        id, ok: true,
                        entries: read?.entries ?? [], nextAfter: read?.nextAfter ?? null,
                        me: read?.me ?? null, canWrite: false, policy: read?.policy ?? "owner",
                    });
                })
                .catch(() => post({ type: "canvas-kv-result", id, ok: false, code: "UNAVAILABLE", error: "the canvas KV store is not available" }));
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [status, token]);

    if (status === "gone") {
        return React.createElement("div", { className: "ps-share-view ps-share-view-gone" },
            React.createElement("p", null, "This canvas link is no longer valid."),
            React.createElement("p", { className: "ps-share-view-sub" }, "The owner may have reset or removed it."));
    }
    return React.createElement("div", { className: "ps-share-view" },
        React.createElement("div", { className: "ps-share-view-strip" },
            React.createElement("span", null, "Shared canvas — live, view only")),
        doc
            ? React.createElement("iframe", {
                ref: iframeRef,
                className: "ps-share-view-frame",
                src: doc.url,
                sandbox: "allow-scripts",
                title: "Shared canvas",
                onLoad: () => postState(),
            })
            : React.createElement("div", { className: "ps-share-view-loading" }, "Loading canvas..."));
}

export default function App() {
    const publicConfig = usePortalPublicConfig();
    const auth = usePortalAuth(publicConfig.config?.auth || null);
    const appHeight = useVisualViewportHeight();

    // Stash only while the sign-in gate is up — a signed-in load consumes the
    // URL param directly, and stashing then would leave a stale id behind.
    const showSignInGate = !publicConfig.loading && !auth.loading && !auth.signedIn;
    React.useEffect(() => {
        if (showSignInGate) { stashDeepLinkTarget(); stashMoaLink(); }
    }, [showSignInGate]);
    const shellStyle = appHeight
        ? { "--ps-app-height": `${appHeight}px` }
        : undefined;

    // "Anyone with link": the token IS the identity. Render the read-only
    // viewer with none of the auth gating — a bearer needs no account, and
    // showing them a sign-in screen would be wrong twice over.
    // Multi-origin link generation: hand the configured entry points to the
    // link builders as soon as the portal config lands.
    React.useEffect(() => {
        setPortalLinkOrigins(publicConfig.config?.portal?.linkOrigins || []);
    }, [publicConfig.config?.portal?.linkOrigins]);

    const canvasShareToken = React.useMemo(() => {
        if (typeof window === "undefined" || !window.location) return null;
        return new URLSearchParams(window.location.search).get("canvasShare");
    }, []);
    if (canvasShareToken) {
        return React.createElement(CanvasShareView, { token: canvasShareToken });
    }

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
