import { describe, it } from "vitest";
import { assertEqual } from "../helpers/assertions.js";
import { authenticateToken, createNoAuthUnknownPrincipal } from "../../../portal/auth/index.js";
import { authorizePrincipal, getPublicAuthContext } from "../../../portal/auth/authz/engine.js";
import { loadAuthorizationPolicy, resolveAuthProviderId } from "../../../portal/auth/config.js";

describe("portal authz", () => {
    it("prefers explicit env provider over plugin and inference", () => {
        const providerId = resolveAuthProviderId({
            env: {
                PORTAL_AUTH_PROVIDER: "entra",
                PORTAL_AUTH_IAM_MODE: "oidc",
            },
            pluginAuthConfig: {
                provider: "none",
            },
        });

        assertEqual(providerId, "entra", "explicit provider");
    });

    it("uses plugin provider when env does not explicitly override it", () => {
        const providerId = resolveAuthProviderId({
            env: {},
            pluginAuthConfig: {
                provider: "entra",
            },
        });

        assertEqual(providerId, "entra", "plugin-selected provider");
    });

    it("loads provider-neutral admin and user email allowlists", () => {
        const policy = loadAuthorizationPolicy({
            env: {
                PORTAL_AUTHZ_ADMIN_GROUPS: "admin1@contoso.com, admin2@contoso.com",
                PORTAL_AUTHZ_USER_GROUPS: "user1@contoso.com",
            },
            providerId: "entra",
        });

        assertEqual(policy.defaultRole, "user", "default role");
        assertEqual(policy.adminGroups.join(","), "admin1@contoso.com,admin2@contoso.com", "admin allowlist");
        assertEqual(policy.userGroups.join(","), "user1@contoso.com", "user allowlist");
    });

    it("authorizes admin and user roles from configured email allowlists", () => {
        const principal = {
            provider: "entra",
            subject: "user-1",
            email: "Admin2@Contoso.com",
            displayName: "User One",
            groups: [],
            roles: [],
            rawClaims: {},
        };
        const decision = authorizePrincipal(principal, {
            defaultRole: "user",
            adminGroups: ["admin1@contoso.com", "admin2@contoso.com"],
            userGroups: ["user1@contoso.com"],
            allowUnauthenticated: false,
        });

        assertEqual(decision.allowed, true, "allowed");
        assertEqual(decision.role, "admin", "admin wins");
        assertEqual(decision.matchedGroups.join(","), "admin2@contoso.com", "matched admin email");
    });

    it("denies authenticated principals without a usable email claim when email allowlists are configured", () => {
        const decision = authorizePrincipal({
            provider: "entra",
            subject: "user-2",
            email: null,
            displayName: "User Two",
            groups: [],
            roles: [],
            rawClaims: {},
        }, {
            defaultRole: "user",
            adminGroups: ["admin@contoso.com"],
            userGroups: ["user@contoso.com"],
            allowUnauthenticated: false,
        });

        assertEqual(decision.allowed, false, "denied");
        assertEqual(decision.role, null, "denied role");
        assertEqual(decision.reason, "Authenticated token did not include a usable email claim", "missing email reason");
    });

    it("denies authenticated principals whose email is not in an allowed list", () => {
        const decision = authorizePrincipal({
            provider: "entra",
            subject: "user-3",
            email: "outsider@contoso.com",
            displayName: "User Three",
            groups: [],
            roles: [],
            rawClaims: {},
        }, {
            defaultRole: "user",
            adminGroups: ["admin@contoso.com"],
            userGroups: ["user@contoso.com"],
            allowUnauthenticated: false,
        });

        assertEqual(decision.allowed, false, "denied");
        assertEqual(decision.role, null, "denied role");
        assertEqual(decision.reason, "Authenticated principal email is not in an allowed admin/user list", "not allowlisted reason");
    });

    it("maps no-auth portal requests to a stable unknown principal", async () => {
        const originalProvider = process.env.PORTAL_AUTH_PROVIDER;
        const originalAllowUnauthenticated = process.env.PORTAL_AUTH_ALLOW_UNAUTHENTICATED;
        try {
            process.env.PORTAL_AUTH_PROVIDER = "none";
            process.env.PORTAL_AUTH_ALLOW_UNAUTHENTICATED = "true";

            const auth = await authenticateToken(null, { headers: {} });
            const expectedPrincipal = createNoAuthUnknownPrincipal();

            assertEqual(auth.ok, true, "no-auth request should be allowed");
            assertEqual(auth.principal?.provider, expectedPrincipal.provider, "stable provider");
            assertEqual(auth.principal?.subject, expectedPrincipal.subject, "stable subject");
            assertEqual(auth.principal?.displayName, expectedPrincipal.displayName, "display name");
            assertEqual(auth.authorization?.role, "anonymous", "anonymous role");
        } finally {
            if (originalProvider == null) delete process.env.PORTAL_AUTH_PROVIDER;
            else process.env.PORTAL_AUTH_PROVIDER = originalProvider;
            if (originalAllowUnauthenticated == null) delete process.env.PORTAL_AUTH_ALLOW_UNAUTHENTICATED;
            else process.env.PORTAL_AUTH_ALLOW_UNAUTHENTICATED = originalAllowUnauthenticated;
        }
    });

    // ─── Entra App-Roles Modernization (Phase 2.5) ─────────────────────────────
    //
    // The cases below verify role-authoritative authorization (Spec.md
    // FR-001..FR-009). Reason-string contract: only the FR-003 deny string
    // ("Roles present but no admin/user role matched") is a contract — pinned
    // by test #7 and the inverse test #8a. The admin/user reason strings in
    // tests #1 and #2 are operator-debugging text and may be updated freely
    // if wording evolves during implementation.

    const buildPrincipal = (overrides = {}) => ({
        provider: "entra",
        subject: "user-roles",
        email: null,
        displayName: "Roles Test User",
        tenantId: null,
        groups: [],
        roles: [],
        rawClaims: {},
        ...overrides,
    });

    it("1. canonical admin: ['admin'] → role=admin", () => {
        const decision = authorizePrincipal(
            buildPrincipal({ roles: ["admin"] }),
            { defaultRole: "user" },
        );
        assertEqual(decision.allowed, true, "allowed");
        assertEqual(decision.role, "admin", "admin role");
        assertEqual(decision.reason, "Matched admin role", "admin reason (non-contractual)");
    });

    it("2. canonical user: ['user'] → role=user", () => {
        const decision = authorizePrincipal(
            buildPrincipal({ roles: ["user"] }),
            { defaultRole: "user" },
        );
        assertEqual(decision.allowed, true, "allowed");
        assertEqual(decision.role, "user", "user role");
        assertEqual(decision.reason, "Matched user role", "user reason (non-contractual)");
    });

    it("3. case-insensitive: ['ADMIN'] and ['Admin'] both → role=admin", () => {
        const upper = authorizePrincipal(buildPrincipal({ roles: ["ADMIN"] }), {});
        assertEqual(upper.role, "admin", "upper-case admin");

        const mixed = authorizePrincipal(buildPrincipal({ roles: ["Admin"] }), {});
        assertEqual(mixed.role, "admin", "mixed-case admin");
    });

    it("4. non-canonical dotted values are NOT matched (prescriptive admin/user only)", () => {
        const portalAdmin = authorizePrincipal(
            buildPrincipal({ roles: ["Portal.Admin"] }),
            {},
        );
        assertEqual(portalAdmin.allowed, false, "Portal.Admin no longer matches");
        assertEqual(portalAdmin.role, null, "no role");
        assertEqual(
            portalAdmin.reason,
            "Roles present but no admin/user role matched",
            "pinned reason",
        );

        const multiDot = authorizePrincipal(
            buildPrincipal({ roles: ["pilotswarm.portal.admin"] }),
            {},
        );
        assertEqual(multiDot.allowed, false, "multi-dot variant no longer matches");
    });

    it("5. admin wins over user: ['user', 'admin'] → role=admin", () => {
        const decision = authorizePrincipal(
            buildPrincipal({ roles: ["user", "admin"] }),
            {},
        );
        assertEqual(decision.role, "admin", "admin precedence preserved");
    });

    it("6. roles-authoritative deny (FR-003, SC-007): unmatched roles → allowed=false with pinned reason string", () => {
        const decision = authorizePrincipal(
            buildPrincipal({ roles: ["auditor"] }),
            {},
        );
        assertEqual(decision.allowed, false, "denied");
        assertEqual(decision.role, null, "no role");
        // Pinned contract per SC-007. Do not change without updating Spec.
        assertEqual(
            decision.reason,
            "Roles present but no admin/user role matched",
            "pinned FR-003 reason string",
        );
        assertEqual(decision.matchedGroups.length, 0, "no matched groups");
    });

    it("7. roles authoritative bypass allowlist: admin role wins even when allowlist would otherwise match a different email", () => {
        const decision = authorizePrincipal(
            buildPrincipal({
                roles: ["admin"],
                email: "someone-else@contoso.com",
            }),
            {
                adminGroups: ["admin@contoso.com"],
                userGroups: ["user@contoso.com"],
            },
        );
        assertEqual(decision.allowed, true, "allowed via roles");
        assertEqual(decision.role, "admin", "admin from roles, not allowlist");
        assertEqual(decision.matchedGroups.length, 0, "role-path returns empty matchedGroups");
    });

    it("7a. inverse behavior-change boundary (Spec Risk #1): non-matching roles deny even when admin allowlist email matches", () => {
        const decision = authorizePrincipal(
            buildPrincipal({
                roles: ["auditor"],
                email: "admin@contoso.com",
            }),
            {
                adminGroups: ["admin@contoso.com"],
            },
        );
        assertEqual(decision.allowed, false, "denied under new semantics (was allowed pre-change)");
        assertEqual(decision.role, null, "no role");
        assertEqual(
            decision.reason,
            "Roles present but no admin/user role matched",
            "pinned FR-003 reason string",
        );
    });

    it("8. empty roles[] falls through to existing allowlist behavior (FR-004 regression)", () => {
        const decision = authorizePrincipal(
            buildPrincipal({
                roles: [],
                email: "admin@contoso.com",
            }),
            {
                adminGroups: ["admin@contoso.com"],
            },
        );
        assertEqual(decision.allowed, true, "allowed via allowlist");
        assertEqual(decision.role, "admin", "admin via email allowlist");
        assertEqual(decision.reason, "Matched admin email allowlist", "allowlist reason unchanged");
    });

    it("9. allowUnauthenticated=true + principal=null → anonymous (short-circuits before role evaluation)", () => {
        const decision = authorizePrincipal(null, { allowUnauthenticated: true });
        assertEqual(decision.allowed, true, "allowed");
        assertEqual(decision.role, "anonymous", "anonymous role");
        assertEqual(decision.reason, "Authentication disabled", "reason unchanged");
    });

    it("10. whitespace-only role tokens are filtered before comparison", () => {
        const decision = authorizePrincipal(
            buildPrincipal({ roles: ["", "   ", "admin"] }),
            {},
        );
        assertEqual(decision.allowed, true, "allowed");
        assertEqual(decision.role, "admin", "admin from non-whitespace token");
    });

    it("11. provider neutrality: a hypothetical non-entra provider (e.g. 'iam') behaves identically", () => {
        // Avoid provider="none": the real `none` provider never reaches the engine
        // (passes principal=null per CodeResearch §6). Use a clearly hypothetical
        // string to exercise the provider-neutrality property.
        const empty = authorizePrincipal(
            buildPrincipal({ provider: "iam", roles: [], email: "admin@contoso.com" }),
            { adminGroups: ["admin@contoso.com"] },
        );
        assertEqual(empty.role, "admin", "allowlist path works regardless of provider");

        const withRoles = authorizePrincipal(
            buildPrincipal({ provider: "iam", roles: ["admin"] }),
            {},
        );
        assertEqual(withRoles.role, "admin", "role-authoritative path works regardless of provider");
    });

    it("12. AuthorizationDecision shape preservation (SC-006, part 1): role-authoritative decision has exactly the documented keys", () => {
        const decision = authorizePrincipal(
            buildPrincipal({ roles: ["admin"] }),
            {},
        );
        const keys = Object.keys(decision).sort().join(",");
        assertEqual(keys, "allowed,matchedGroups,reason,role", "exact key set");
        assertEqual(typeof decision.allowed, "boolean", "allowed type");
        assertEqual(typeof decision.role, "string", "role type");
        assertEqual(typeof decision.reason, "string", "reason type");
        assertEqual(Array.isArray(decision.matchedGroups), true, "matchedGroups is array");
    });

    // The next four cases verify SC-006 / FR-011 for `getPublicAuthContext`
    // across the three pre-existing configurations plus the new role-authoritative
    // path. Each compares the full public-context JSON to a pinned expected object.

    const buildPublicPrincipal = (overrides = {}) => ({
        provider: "entra",
        subject: "user-public",
        email: null,
        displayName: "Public Test User",
        tenantId: null,
        groups: [],
        roles: [],
        ...overrides,
    });

    it("13. getPublicAuthContext shape — email-allowlist-only config (SC-006, FR-011)", () => {
        const principal = buildPublicPrincipal({ email: "admin@contoso.com" });
        const authorization = authorizePrincipal(principal, {
            adminGroups: ["admin@contoso.com"],
        });
        const out = getPublicAuthContext({ principal, authorization });
        const expected = {
            principal: {
                provider: "entra",
                subject: "user-public",
                email: "admin@contoso.com",
                displayName: "Public Test User",
                tenantId: null,
                groups: [],
                roles: [],
            },
            authorization: {
                allowed: true,
                role: "admin",
                reason: "Matched admin email allowlist",
                matchedGroups: ["admin@contoso.com"],
            },
        };
        assertEqual(
            JSON.stringify(out),
            JSON.stringify(expected),
            "byte-compatible (email-allowlist-only)",
        );
    });

    it("14. getPublicAuthContext shape — no-allowlist config (SC-006, FR-011)", () => {
        const principal = buildPublicPrincipal({ email: "anyone@contoso.com" });
        const authorization = authorizePrincipal(principal, {});
        const out = getPublicAuthContext({ principal, authorization });
        const expected = {
            principal: {
                provider: "entra",
                subject: "user-public",
                email: "anyone@contoso.com",
                displayName: "Public Test User",
                tenantId: null,
                groups: [],
                roles: [],
            },
            authorization: {
                allowed: true,
                role: "user",
                reason: "No email allowlists configured",
                matchedGroups: [],
            },
        };
        assertEqual(
            JSON.stringify(out),
            JSON.stringify(expected),
            "byte-compatible (no-allowlist)",
        );
    });

    it("15. getPublicAuthContext shape — allow-unauthenticated config (SC-006, FR-011)", () => {
        const authorization = authorizePrincipal(null, { allowUnauthenticated: true });
        const out = getPublicAuthContext({ principal: null, authorization });
        const expected = {
            principal: null,
            authorization: {
                allowed: true,
                role: "anonymous",
                reason: "Authentication disabled",
                matchedGroups: [],
            },
        };
        assertEqual(
            JSON.stringify(out),
            JSON.stringify(expected),
            "byte-compatible (allow-unauthenticated)",
        );
    });

    it("16. getPublicAuthContext shape — role-authoritative path (SC-006, FR-011): principal.roles passed through verbatim", () => {
        const principal = buildPublicPrincipal({ roles: ["admin"] });
        const authorization = authorizePrincipal(principal, {});
        const out = getPublicAuthContext({ principal, authorization });
        const expected = {
            principal: {
                provider: "entra",
                subject: "user-public",
                email: null,
                displayName: "Public Test User",
                tenantId: null,
                groups: [],
                roles: ["admin"],
            },
            authorization: {
                allowed: true,
                role: "admin",
                reason: "Matched admin role",
                matchedGroups: [],
            },
        };
        assertEqual(
            JSON.stringify(out),
            JSON.stringify(expected),
            "byte-compatible (role-authoritative)",
        );
    });
});
