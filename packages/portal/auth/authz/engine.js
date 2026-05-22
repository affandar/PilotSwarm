function normalizeRole(role) {
    const normalized = String(role || "").trim().toLowerCase();
    if (normalized === "admin") return "admin";
    if (normalized === "user") return "user";
    if (normalized === "anonymous") return "anonymous";
    return null;
}

// Match `principalRoles` to an engine role using case-insensitive equality
// against the two canonical role values `admin` and `user`. See Spec.md
// FR-001..FR-005.
//
// Convention: the PilotSwarm app reg defines exactly two app roles with
// `value: "admin"` and `value: "user"` (see deploy/scripts/auth/Setup-PortalAuth.ps1
// `Build-AppRolesJson`). These are the canonical, prescriptive values —
// the engine matches only these. If you need additional gate-keeping beyond
// admin/user (e.g. an auditor role), define a new app role and check it
// explicitly in code against the JWT `roles` claim — do not alias arbitrary
// role values onto the built-in admin/user buckets here.
//
// Order: admin-before-user precedence is preserved — if a principal carries
// both an admin role and a user role, the engine resolves to `admin`
// (CodeResearch §8a).
//
// Empty / whitespace-only role tokens are filtered out before comparison
// (mirrors `toStringArray` semantics in `normalize/entra.js`).
//
// Returns "admin", "user", or null.
//
// Note: `createNoAuthUnknownPrincipal()` produces `roles: ["anonymous"]` but is
// never reachable here — the no-auth path passes `principal=null` to the engine
// (CodeResearch §6). This matcher correctly returns null for "anonymous"
// since it equals neither "admin" nor "user".
function matchEngineRole(principalRoles) {
    const rawTokens = Array.isArray(principalRoles) ? principalRoles : [];
    const tokens = rawTokens
        .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
        .filter(Boolean);
    if (tokens.length === 0) return null;

    // Admin pass first to preserve admin-before-user precedence.
    if (tokens.includes("admin")) return "admin";
    if (tokens.includes("user")) return "user";
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
        const matched = matchEngineRole(principalRoles);
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
