import { getPluginDirsFromEnv, resolvePortalConfigBundleFromPluginDirs } from "../cli/src/plugin-config.js";

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
