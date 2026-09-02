// Portal deep-link targets: the URL contract, and the stash that carries it
// across a redirect sign-in.
//
// Split out of App.jsx so these can be tested for real. App.jsx pulls in React,
// MSAL, the UI packages and a stylesheet, so a test that imported it could only
// ever regex the source; these functions are pure enough to drive directly.

// Deep links stash ?session= in sessionStorage before sign-in because the
// redirect-based sign-in path (mobile Entra loginRedirect) returns to the bare
// redirectUri and drops the query string; popup/dev sign-ins never navigate,
// so the URL param survives those on its own.
export const DEEP_LINK_SESSION_STORAGE_KEY = "pilotswarm.portal.deepLinkSession";

/**
 * A canvas slot from a URL or a stash, or null when the link named none.
 *
 * Guarding the empty cases first is the whole job: `Number(null)` and
 * `Number("")` are both 0, and 0 is an integer, so a bare `Number.isInteger`
 * check turns "no slot" into "slot 0" — which then clamps to 1 and looks
 * correct right up until someone links to slot 2.
 *
 * Anything that survives is passed through UN-clamped: `canvas/flip` already
 * bounds it to 1..5 and falls back to slot 1, and a second clamp here could
 * only ever disagree with that one.
 */
function parseSlot(raw) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const value = Number(text);
    return Number.isInteger(value) ? value : null;
}

/**
 * A deep-link target: `?session=<id>[&artifact=<filename>][&view=full|canvas][&show_chrome=false]`.
 *
 * The artifact form is what the agent's show_artifact tool hands back and what
 * the Files "copy link" button produces, so a link pasted into chat, mailed to
 * a colleague, or opened in a new tab all land on the same preview.
 * `view=canvas` opens the session with its canvas up — the shareable "look at
 * the dashboard" link. `show_chrome=false` additionally strips the portal
 * header so the canvas is the whole page.
 */
export function readDeepLinkTargetFromUrl() {
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
        // ?max=1 with view=canvas: arrive with the canvas COVERING the
        // workspace — the share-link landing experience.
        max: params.get("max") === "1",
        // Which canvas the link points at. The share dialog has always
        // emitted this; nothing read it, so a link to a session's second
        // canvas quietly opened its first.
        slot: parseSlot(params.get("slot")),
        // ?show_chrome=false: land with the portal header suppressed, so the
        // canvas is the whole page. Only the explicit string "false" opts in —
        // absence, "true", or anything else keeps the chrome, which is what
        // makes every link written before this parameter existed behave
        // exactly as it always did.
        hideChrome: params.get("show_chrome") === "false",
    };
}

export function parseStashedDeepLinkTarget(raw) {    if (!raw) return null;
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
            max: Boolean(parsed?.max),
            slot: parseSlot(parsed?.slot),
            // Load-bearing for the common case: a recipient who is NOT already
            // signed in gets stashed here and restored after the redirect, so
            // dropping this field would lose the chromeless mode for exactly
            // the audience a share link is written for.
            hideChrome: Boolean(parsed?.hideChrome),
        };
    } catch {
        return null;
    }
}

/**
 * Rewrite `show_chrome` in the address bar to match what is actually on screen.
 *
 * Toggling chrome back on is a change of VIEW, not a navigation, so this
 * replaces the current entry rather than pushing one: a Back button that
 * undoes a cosmetic toggle, and a history stack that fills up with them, is
 * not what anyone means by Back.
 *
 * The point is refresh consistency. Without this, a viewer who followed a
 * `show_chrome=false` link, clicked "Show chrome", and then reloaded — or
 * copied the URL out of the bar and sent it on — would be thrown back into a
 * chromeless view they had explicitly left. The parameter is written as an
 * explicit `true` rather than deleted so the URL keeps saying, out loud, which
 * mode it is in.
 */
export function writeShowChromeParam(show) {
    if (typeof window === "undefined") return null;
    // A browser too old for replaceState, or a test double without one, simply
    // keeps the stale parameter: the on-screen toggle still works, and this is
    // cosmetic bookkeeping, never a precondition for it.
    if (typeof window.history?.replaceState !== "function" || !window.location?.href) return null;
    try {
        const url = new URL(window.location.href);
        url.searchParams.set("show_chrome", show ? "true" : "false");
        window.history.replaceState(window.history.state ?? null, "", `${url.pathname}${url.search}${url.hash}`);
        return url.search;
    } catch {
        return null;
    }
}
