/**
 * Multi-origin portal links.
 *
 * A deployment can be reachable through several entry points at once — a
 * public edge and a private/VPN hostname, say — and a link built from the
 * sender's window.location.origin only works for recipients on the SAME
 * network path. When the portal is configured with named link origins,
 * every link-producing surface offers one variant per origin, labeled.
 *
 * This replaces waldemort's deploy-time monkey patch
 * (patch-pilotswarm-dual-session-links.mjs), which anchor-matched the
 * minified bundle and broke on every release. The plug-in surface is one
 * env var on the portal server: PORTAL_LINK_ORIGINS.
 */

/**
 * Rebase one produced URL onto each configured origin.
 * @param {string} url - a full URL produced against the current origin
 * @param {Array<{label: string, origin: string}>} linkOrigins
 * @returns {Array<{label: string|null, url: string}>} one entry per origin;
 *   with no (or one) configured origin, a single unlabeled entry with the
 *   original URL — zero behavior change for plain deployments.
 */
export function buildPortalLinks(url, linkOrigins) {
    const origins = Array.isArray(linkOrigins) ? linkOrigins.filter((o) => o?.origin && o?.label) : [];
    if (origins.length < 2) return [{ label: null, url: String(url || "") }];
    let suffix;
    try {
        const parsed = new URL(String(url || ""));
        suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return [{ label: null, url: String(url || "") }];
    }
    return origins.map((o) => ({ label: String(o.label), url: `${o.origin}${suffix}` }));
}

/**
 * Clipboard shape: a bare URL for the single-origin case; one labeled line
 * per origin otherwise, so the sender pastes both and the recipient picks
 * the one their network can reach.
 */
export function formatPortalLinksForCopy(links) {
    const list = Array.isArray(links) ? links : [];
    if (list.length <= 1) return String(list[0]?.url || "");
    return list.map((l) => `${l.label}: ${l.url}`).join("\n");
}
