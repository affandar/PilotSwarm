/** Deployment policy, independent of the authenticated admin role. */
export const ADMIN_SCOPE_POLICY_VERSION = 1;
export const ADMIN_SCOPES = Object.freeze(["unrestricted", "cluster"]);

export function loadAdminScope(env = (typeof process !== "undefined" ? process.env : {})) {
    const scope = String(env.AUTHZ_ADMIN_SCOPE ?? "unrestricted").trim().toLowerCase();
    if (!ADMIN_SCOPES.includes(scope)) {
        throw new Error("AUTHZ_ADMIN_SCOPE must be cluster or unrestricted.");
    }
    return scope;
}

/** Workers validate enforcement; the portal additionally validates its actual auth provider. */
export function validateAdminScope(env, { authenticationEnabled } = {}) {
    const scope = loadAdminScope(env);
    if (scope === "cluster") {
        if (!["1", "true", "yes", "on"].includes(String(env.AUTHZ_ENFORCE_OWNERSHIP ?? "").trim().toLowerCase())) {
            throw new Error("AUTHZ_ADMIN_SCOPE=cluster requires AUTHZ_ENFORCE_OWNERSHIP=true.");
        }
        if (authenticationEnabled === false) {
            throw new Error("AUTHZ_ADMIN_SCOPE=cluster requires authentication.");
        }
    }
    return scope;
}

/** System-target access is deliberately unchanged in phase 1. */
export function adminCanAccessResource(isAdmin, adminScope = "unrestricted", isSystem = false) {
    return Boolean(isAdmin && (adminScope === "unrestricted" || isSystem));
}

export function adminCapabilities(isAdmin, adminScope = "unrestricted") {
    return {
        clusterManagement: Boolean(isAdmin),
        fleetAccounting: Boolean(isAdmin),
        userResourceBypass: adminCanAccessResource(isAdmin, adminScope),
        systemSessionAdmin: Boolean(isAdmin),
    };
}
