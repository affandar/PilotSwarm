import { describe, it } from "vitest";
import { assertEqual } from "../helpers/assertions.js";
import { authenticateToken, createNoAuthUnknownPrincipal } from "../../../portal/auth/index.js";
import { authorizePrincipal } from "../../../portal/auth/authz/engine.js";
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
});
