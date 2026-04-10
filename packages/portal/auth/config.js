import path from "node:path";
import { getPluginDirsFromEnv, readPluginMetadata } from "pilotswarm-cli/portal";

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

function parseCsv(value) {
    return String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function parseBoolean(value, defaultValue = false) {
    if (value == null || value === "") return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return defaultValue;
}

function normalizeRole(value, defaultRole = "user") {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "admin" ? "admin" : defaultRole;
}

export function resolvePluginAuthConfigFromPluginDirs(pluginDirs = getPluginDirsFromEnv()) {
    for (const pluginDir of pluginDirs) {
        const pluginMeta = readPluginMetadata(path.resolve(pluginDir));
        if (!pluginMeta) continue;
        const portal = getObject(pluginMeta.portal);
        const portalAuth = getObject(portal.auth);
        if (Object.keys(portalAuth).length === 0 && typeof portal.provider !== "string") {
            continue;
        }
        return portalAuth;
    }
    return {};
}

export function inferAuthProviderId(env = process.env) {
    if (
        env.PORTAL_AUTH_ENTRA_TENANT_ID
        || env.PORTAL_AUTH_ENTRA_CLIENT_ID
    ) {
        return "entra";
    }
    return "none";
}

export function resolveAuthProviderId({
    env = process.env,
    pluginAuthConfig = resolvePluginAuthConfigFromPluginDirs(),
} = {}) {
    const explicitProvider = firstNonEmptyString(env.PORTAL_AUTH_PROVIDER);
    if (explicitProvider) return explicitProvider.toLowerCase();

    const pluginProvider = firstNonEmptyString(pluginAuthConfig?.provider);
    if (pluginProvider) return pluginProvider.toLowerCase();

    return inferAuthProviderId(env);
}

function getProviderScopedGroupEnv({ env, providerId, groupKind }) {
    const normalizedProvider = String(providerId || "").trim().toUpperCase();
    const normalizedKind = String(groupKind || "").trim().toUpperCase();
    return firstNonEmptyString(env[`PORTAL_AUTH_${normalizedProvider}_${normalizedKind}_GROUPS`]);
}

export function loadAuthorizationPolicy({
    env = process.env,
    providerId = resolveAuthProviderId({ env }),
} = {}) {
    const defaultRole = normalizeRole(env.PORTAL_AUTHZ_DEFAULT_ROLE, "user");
    const adminGroups = parseCsv(
        firstNonEmptyString(
            env.PORTAL_AUTHZ_ADMIN_GROUPS,
            getProviderScopedGroupEnv({ env, providerId, groupKind: "ADMIN" }),
        ),
    );
    const userGroups = parseCsv(
        firstNonEmptyString(
            env.PORTAL_AUTHZ_USER_GROUPS,
            getProviderScopedGroupEnv({ env, providerId, groupKind: "USER" }),
        ),
    );
    const allowUnauthenticated = parseBoolean(
        env.PORTAL_AUTH_ALLOW_UNAUTHENTICATED,
        providerId === "none",
    );

    return {
        defaultRole,
        adminGroups,
        userGroups,
        allowUnauthenticated,
    };
}
