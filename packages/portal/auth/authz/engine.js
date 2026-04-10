function normalizeRole(role) {
    const normalized = String(role || "").trim().toLowerCase();
    if (normalized === "admin") return "admin";
    if (normalized === "user") return "user";
    if (normalized === "anonymous") return "anonymous";
    return null;
}

function firstRoleMatch(roles = []) {
    for (const role of roles) {
        const normalized = normalizeRole(role);
        if (normalized === "admin") return "admin";
    }
    for (const role of roles) {
        const normalized = normalizeRole(role);
        if (normalized === "user") return "user";
    }
    return null;
}

function normalizeIdentifier(value) {
    return String(value || "").trim().toLowerCase();
}

function intersectIdentifier(value, allowed = []) {
    const normalizedValue = normalizeIdentifier(value);
    if (!normalizedValue) return [];

    const allowedSet = new Set((allowed || []).map(normalizeIdentifier).filter(Boolean));
    return allowedSet.has(normalizedValue) ? [normalizedValue] : [];
}

export function authorizePrincipal(principal, policy = {}) {
    const defaultRole = normalizeRole(policy.defaultRole) || "user";
    const adminGroups = Array.isArray(policy.adminGroups) ? policy.adminGroups : [];
    const userGroups = Array.isArray(policy.userGroups) ? policy.userGroups : [];
    const allowUnauthenticated = policy.allowUnauthenticated === true;

    if (!principal) {
        if (allowUnauthenticated) {
            return {
                allowed: true,
                role: "anonymous",
                reason: "Authentication disabled",
                matchedGroups: [],
            };
        }
        return {
            allowed: false,
            role: null,
            reason: "Authentication required",
            matchedGroups: [],
        };
    }

    const principalEmail = String(principal.email || "").trim();
    const principalRoles = Array.isArray(principal.roles) ? principal.roles : [];
    const matchedAdminGroups = intersectIdentifier(principalEmail, adminGroups);
    const matchedUserGroups = intersectIdentifier(principalEmail, userGroups);

    if (adminGroups.length === 0 && userGroups.length === 0) {
        return {
            allowed: true,
            role: firstRoleMatch(principalRoles) || defaultRole,
            reason: "No email allowlists configured",
            matchedGroups: [],
        };
    }

    if (matchedAdminGroups.length > 0) {
        return {
            allowed: true,
            role: "admin",
            reason: "Matched admin email allowlist",
            matchedGroups: matchedAdminGroups,
        };
    }

    if (matchedUserGroups.length > 0) {
        return {
            allowed: true,
            role: "user",
            reason: "Matched user email allowlist",
            matchedGroups: matchedUserGroups,
        };
    }

    if (!principalEmail) {
        return {
            allowed: false,
            role: null,
            reason: "Authenticated token did not include a usable email claim",
            matchedGroups: [],
        };
    }

    return {
        allowed: false,
        role: null,
        reason: "Authenticated principal email is not in an allowed admin/user list",
        matchedGroups: [],
    };
}

export function getPublicAuthContext(authContext) {
    if (!authContext) {
        return {
            principal: null,
            authorization: {
                allowed: false,
                role: null,
                reason: "Unauthenticated",
                matchedGroups: [],
            },
        };
    }

    const principal = authContext.principal
        ? {
            provider: authContext.principal.provider,
            subject: authContext.principal.subject,
            email: authContext.principal.email ?? null,
            displayName: authContext.principal.displayName ?? null,
            tenantId: authContext.principal.tenantId ?? null,
            groups: [...(authContext.principal.groups || [])],
            roles: [...(authContext.principal.roles || [])],
        }
        : null;

    return {
        principal,
        authorization: {
            allowed: authContext.authorization?.allowed === true,
            role: authContext.authorization?.role ?? null,
            reason: authContext.authorization?.reason ?? null,
            matchedGroups: [...(authContext.authorization?.matchedGroups || [])],
        },
    };
}
