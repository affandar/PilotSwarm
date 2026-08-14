import { getPluginDirsFromEnv, resolvePortalConfigBundleFromPluginDirs } from "pilotswarm/host";

let cachedPortalBundle = null;

function getPortalBundle() {
    if (!cachedPortalBundle) {
        cachedPortalBundle = resolvePortalConfigBundleFromPluginDirs(getPluginDirsFromEnv());
    }
    return cachedPortalBundle;
}

export function getPortalConfig() {
    return getPortalBundle().portalConfig;
}

export function getPortalAssetFile(assetName) {
    const key = String(assetName || "").trim();
    if (!key) return null;
    return getPortalBundle().assetFiles?.[key] || null;
}

/**
 * PORTAL_LINK_ORIGINS: named entry points for link generation.
 *
 * Format: comma-separated `Label=Origin` pairs, e.g.
 *   PORTAL_LINK_ORIGINS="Corporate=https://corp.example.com,Private/VPN=https://vpn.example.com"
 *
 * When two or more are configured, every link-producing surface (session
 * copy-link, artifact links, the canvas share dialog) offers one labeled
 * variant per origin — a sender on one network path can hand a recipient
 * on another a link that actually works. This is the platform version of
 * waldemort's dual-session-links deploy patch; deployments plug in with
 * this one env var and delete the patch.
 *
 * Validation is FAIL-LOUD at startup: a malformed value should stop the
 * portal visibly, not silently produce broken links. Rules: 2..6 entries
 * to activate (0 or absent = feature off; exactly 1 is refused as almost
 * certainly a mistake), labels nonempty/unique/<=40 chars, origins bare
 * (no path/query/hash), https required except localhost, all distinct.
 */
export function parsePortalLinkOrigins(raw = process.env.PORTAL_LINK_ORIGINS) {
    const value = String(raw || "").trim();
    if (!value) return [];
    const entries = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (entries.length === 1) {
        throw new Error("PORTAL_LINK_ORIGINS with a single entry is refused — one origin means the feature is off; unset the variable or configure at least two.");
    }
    if (entries.length > 6) {
        throw new Error("PORTAL_LINK_ORIGINS supports at most 6 entries.");
    }
    const seenLabels = new Set();
    const seenOrigins = new Set();
    return entries.map((entry) => {
        const eq = entry.indexOf("=");
        if (eq <= 0) throw new Error(`PORTAL_LINK_ORIGINS entry "${entry}" must be Label=Origin.`);
        const label = entry.slice(0, eq).trim();
        const originRaw = entry.slice(eq + 1).trim();
        if (!label || label.length > 40) throw new Error(`PORTAL_LINK_ORIGINS label "${label}" must be 1-40 characters.`);
        let url;
        try {
            url = new URL(originRaw);
        } catch {
            throw new Error(`PORTAL_LINK_ORIGINS origin "${originRaw}" is not a valid URL.`);
        }
        const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
            throw new Error(`PORTAL_LINK_ORIGINS origin "${originRaw}" must be https (http only for localhost).`);
        }
        if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
            throw new Error(`PORTAL_LINK_ORIGINS origin "${originRaw}" must be a bare origin — no path, query, hash, or credentials.`);
        }
        const origin = url.origin;
        const labelKey = label.toLowerCase();
        if (seenLabels.has(labelKey)) throw new Error(`PORTAL_LINK_ORIGINS label "${label}" is duplicated.`);
        if (seenOrigins.has(origin)) throw new Error(`PORTAL_LINK_ORIGINS origin "${origin}" is duplicated.`);
        seenLabels.add(labelKey);
        seenOrigins.add(origin);
        return { label, origin };
    });
}
