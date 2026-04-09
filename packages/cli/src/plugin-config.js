import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const defaultTuiSplashPath = path.join(pkgRoot, "tui-splash.txt");

function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function readOptionalTextFile(filePath) {
    try {
        return fs.readFileSync(filePath, "utf-8").trimEnd();
    } catch {
        return null;
    }
}

function getObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function resolveRelativePath(baseDir, relativePath) {
    if (!baseDir || typeof relativePath !== "string" || !relativePath.trim()) return null;
    const basePath = path.resolve(baseDir);
    const filePath = path.resolve(basePath, relativePath);
    if (filePath !== basePath && !filePath.startsWith(`${basePath}${path.sep}`)) {
        return null;
    }
    return filePath;
}

function readRelativeTextFile(baseDir, relativePath) {
    const filePath = resolveRelativePath(baseDir, relativePath);
    if (!filePath) return null;
    return readOptionalTextFile(filePath);
}

function resolveRelativeAssetFile(baseDir, relativePath) {
    const filePath = resolveRelativePath(baseDir, relativePath);
    if (!filePath || !fileExists(filePath)) return null;
    return filePath;
}

function firstAssetUrl(...values) {
    for (const value of values) {
        if (typeof value !== "string" || !value.trim()) continue;
        const trimmed = value.trim();
        if (/^(https?:\/\/|\/|data:|blob:)/iu.test(trimmed)) {
            return trimmed;
        }
    }
    return null;
}

function resolvePortalAsset(baseDir, { file, url }) {
    const directUrl = firstAssetUrl(url);
    if (directUrl) {
        return { filePath: null, publicUrl: directUrl };
    }
    const filePath = resolveRelativeAssetFile(baseDir, file);
    if (!filePath) {
        return { filePath: null, publicUrl: null };
    }
    return { filePath, publicUrl: null };
}

function readSplashValue(baseDir, config, fallback) {
    if (typeof config?.splash === "string" && config.splash.trim()) {
        return config.splash;
    }
    if (typeof config?.splashFile === "string" && config.splashFile.trim()) {
        const fileText = readRelativeTextFile(baseDir, config.splashFile);
        if (fileText != null) return fileText;
    }
    return fallback;
}

function getDefaultSplash() {
    return readOptionalTextFile(defaultTuiSplashPath) || "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}";
}

export function readPluginMetadata(pluginDir) {
    if (!pluginDir) return null;
    const pluginJsonPath = path.join(pluginDir, "plugin.json");
    if (!fileExists(pluginJsonPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
    } catch (error) {
        throw new Error(`Failed to parse plugin metadata: ${pluginJsonPath}: ${error.message}`);
    }
}

export function getPluginDirsFromEnv() {
    const envDirs = String(process.env.PLUGIN_DIRS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => path.resolve(value));
    if (envDirs.length > 0) return envDirs;

    const cwdPlugin = path.resolve(process.cwd(), "plugins");
    if (fileExists(cwdPlugin)) return [cwdPlugin];

    const bundledPlugin = path.join(pkgRoot, "plugins");
    if (fileExists(bundledPlugin)) return [bundledPlugin];

    return [];
}

export function resolveTuiBranding(pluginDir) {
    const pluginMeta = readPluginMetadata(pluginDir);
    const tui = pluginMeta?.tui;
    const defaultSplash = getDefaultSplash();
    if (!tui || typeof tui !== "object") {
        return { title: "PilotSwarm", splash: defaultSplash };
    }

    const title = firstNonEmptyString(tui.title, "PilotSwarm") || "PilotSwarm";
    const splash = readSplashValue(pluginDir, tui, defaultSplash);
    return { title, splash };
}

export function resolvePortalConfigBundleFromPluginDirs(pluginDirs = []) {
    const defaultSplash = getDefaultSplash();
    const defaults = {
        branding: {
            title: "PilotSwarm",
            pageTitle: "PilotSwarm",
            splash: defaultSplash,
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
    };

    for (const pluginDir of pluginDirs) {
        const absDir = path.resolve(pluginDir);
        const pluginMeta = readPluginMetadata(absDir);
        if (!pluginMeta) continue;

        const portal = getObject(pluginMeta?.portal);
        const portalBranding = getObject(portal.branding);
        const portalUi = getObject(portal.ui);
        const portalAuth = getObject(portal.auth);
        const tui = getObject(pluginMeta?.tui);

        const title = firstNonEmptyString(portalBranding.title, portal.title, tui.title, defaults.branding.title) || defaults.branding.title;
        const pageTitle = firstNonEmptyString(portalBranding.pageTitle, portal.pageTitle, title, defaults.branding.pageTitle) || defaults.branding.pageTitle;
        const splash = readSplashValue(
            absDir,
            portalBranding,
            readSplashValue(absDir, portal, readSplashValue(absDir, tui, defaults.branding.splash)),
        );
        const logoAsset = resolvePortalAsset(absDir, {
            file: firstNonEmptyString(portalBranding.logoFile, portal.logoFile),
            url: firstNonEmptyString(portalBranding.logoUrl, portal.logoUrl),
        });
        const faviconAsset = resolvePortalAsset(absDir, {
            file: firstNonEmptyString(portalBranding.faviconFile, portal.faviconFile, portalBranding.logoFile, portal.logoFile),
            url: firstNonEmptyString(portalBranding.faviconUrl, portal.faviconUrl, portalBranding.logoUrl, portal.logoUrl),
        });

        const assetFiles = {};
        const branding = {
            title,
            pageTitle,
            splash,
            logoUrl: logoAsset.publicUrl || null,
            faviconUrl: faviconAsset.publicUrl || null,
        };

        if (logoAsset.filePath) {
            assetFiles.logo = logoAsset.filePath;
            branding.logoUrl = "/api/portal-assets/logo";
        }
        if (faviconAsset.filePath) {
            assetFiles.favicon = faviconAsset.filePath;
            branding.faviconUrl = "/api/portal-assets/favicon";
        }
        if (!branding.faviconUrl && branding.logoUrl) {
            branding.faviconUrl = branding.logoUrl;
        }

        return {
            portalConfig: {
                branding,
                ui: {
                    loadingMessage: firstNonEmptyString(portalUi.loadingMessage, portal.loadingMessage, defaults.ui.loadingMessage) || defaults.ui.loadingMessage,
                    loadingCopy: firstNonEmptyString(portalUi.loadingCopy, portal.loadingCopy, defaults.ui.loadingCopy) || defaults.ui.loadingCopy,
                },
                auth: {
                    signInTitle: firstNonEmptyString(portalAuth.signInTitle, portal.signInTitle, `Sign in to ${title}`) || `Sign in to ${title}`,
                    signInMessage: firstNonEmptyString(portalAuth.signInMessage, portal.signInMessage, defaults.auth.signInMessage),
                    signInLabel: firstNonEmptyString(portalAuth.signInLabel, defaults.auth.signInLabel) || defaults.auth.signInLabel,
                },
            },
            assetFiles,
        };
    }

    return {
        portalConfig: defaults,
        assetFiles: {},
    };
}

export function resolvePortalConfigFromPluginDirs(pluginDirs = []) {
    return resolvePortalConfigBundleFromPluginDirs(pluginDirs).portalConfig;
}
