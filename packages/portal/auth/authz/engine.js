function normalizeRole(role) {
    const normalized = String(role || "").trim().toLowerCase();
    if (normalized === "admin") return "admin";
    if (normalized === "user") return "user";
    if (normalized === "anonymous") return "anonymous";
    return null;
}

function suffixStripRole(token) {
    const trimmed = String(token || "").trim();
    if (!trimmed) return null;
    const dot = trimmed.lastIndexOf(".");
    const tail = (dot >= 0 ? trimmed.slice(dot + 1) : trimmed).toLowerCase();
    if (tail === "admin") return "admin";
    if (tail === "user") return "user";
    return null;
}

function matchExactCaseInsensitive(token, list = []) {
    const normalized = String(token || "").trim().toLowerCase();
    if (!normalized) return false;
    for (const entry of list) {
        if (String(entry || "").trim().toLowerCase() === normalized) {
            return true;
        }
    }
    return false;
}

// Match `principalRoles` to an engine role using the configured policy.
// See Spec.md FR-001..FR-009.
//
// Order: admin-before-user precedence is preserved (existing behavior — see
// CodeResearch §8a).
//
// For each engine role:
//   - If `policy.roleNames[engineRole]` is a non-empty string, do case-insensitive
//     exact-string comparison against that single value (explicit-name override,
//     FR-006..FR-008). The roles-mode design assumes exactly one canonical
//     `Portal.Admin` and one `Portal.User` app-role per app reg. Additional
//     granularity belongs in new app roles that are checked explicitly in code,
//     not aliased into admin/user here.
//   - Otherwise, fall back to the case-insensitive suffix-strip default: take the
//     substring after the last `.` (or the whole string), lowercase it, and compare
//     to the engine role name (FR-001/FR-002/FR-005).
//
// Empty / whitespace-only role tokens are filtered out before comparison
// (mirrors `toStringArray` semantics in `normalize/entra.js`).
//
// Returns "admin", "user", or null.
//
// Note: `createNoAuthUnknownPrincipal()` produces `roles: ["anonymous"]` but is
// never reachable here — the no-auth path passes `principal=null` to the engine
// (CodeResearch §6). This matcher would correctly return null for "anonymous"
// anyway, since neither "admin" nor "user" suffix-strips from it.
function matchEngineRole(principalRoles, policy = {}) {
    const rawTokens = Array.isArray(principalRoles) ? principalRoles : [];
    const tokens = rawTokens
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean);
    if (tokens.length === 0) return null;

    const policyRoleNames =
        policy.roleNames && typeof policy.roleNames === "object"
            ? policy.roleNames
            : {};
    const adminName = typeof policyRoleNames.admin === "string" ? policyRoleNames.admin.trim() : "";
    const userName = typeof policyRoleNames.user === "string" ? policyRoleNames.user.trim() : "";

    const adminExplicit = adminName.length > 0;
    const userExplicit = userName.length > 0;

    // Admin pass first to preserve admin-before-user precedence.
    for (const token of tokens) {
        if (adminExplicit) {
            if (matchExactCaseInsensitive(token, [adminName])) return "admin";
        } else if (suffixStripRole(token) === "admin") {
            return "admin";
        }
    }
    for (const token of tokens) {
        if (userExplicit) {
            if (matchExactCaseInsensitive(token, [userName])) return "user";
        } else if (suffixStripRole(token) === "user") {
            return "user";
        }
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

    // Role-authoritative branch (Spec.md FR-001..FR-009): when the JWT carries a
    // non-empty `roles[]` claim, decide solely from roles and bypass the email
    // allowlist. Admin-before-user precedence is preserved by `matchEngineRole`.
    const hasRoleTokens = principalRoles.some(
        (t) => typeof t === "string" && t.trim().length > 0,
    );
    if (hasRoleTokens) {
        const matched = matchEngineRole(principalRoles, policy);
        if (matched) {
            return {
                allowed: true,
                role: matched,
                reason: `Matched ${matched} role`,
                matchedGroups: [],
            };
        }
        return {
            allowed: false,
            role: null,
            reason: "Roles present but no admin/user role matched",
            matchedGroups: [],
        };
    }

    if (adminGroups.length === 0 && userGroups.length === 0) {
        // No email allowlists configured and the principal carries no role tokens
        // (the role-authoritative branch above already handled non-empty roles).
        return {
            allowed: true,
            role: defaultRole,
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
